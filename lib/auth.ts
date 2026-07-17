import { db } from "./db";
import { users, type User } from "@/db/schema";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAdConfigured } from "./ad/resolve";
import { authenticateAgainstAd } from "./ad/auth";
import { setMfaPending } from "./mfa";
import { cookieSecure } from "./cookie-security";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "ar-adminreminder-dev-secret-change-in-production-please"
);

const SESSION_COOKIE = "ar_session";
// Idle timeout: the session lasts 15 minutes and is renewed on every request by
// the proxy (see proxy.ts), so an unattended session clears itself but active
// work is never interrupted.
export const SESSION_MAX_AGE = 60 * 15; // 15 minutes
export const SESSION_TTL = "15m";

export type SessionUser = {
  id: number;
  username: string;
  role: "admin" | "viewer";
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 2 ** 16,
    timeCost: 3,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function createSession(user: User): Promise<string> {
  const token = await new SignJWT({
    sub: user.id.toString(),
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(JWT_SECRET);

  return token;
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return {
      id: parseInt(payload.sub as string),
      username: payload.username as string,
      role: payload.role as "admin" | "viewer",
    };
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    redirect("/dashboard?error=unauthorized");
  }
  return user;
}

/** Placeholder stored for AD-backed rows; argon2.verify always rejects it. */
const AD_PASSWORD_PLACEHOLDER = "!ad-authenticated-externally";

async function startSession(user: User) {
  const token = await createSession(user);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

/** Starts the real session for a user resolved elsewhere (e.g. after the MFA
 *  code step). Returns false if the user vanished between the two steps. */
export async function startSessionById(userId: number): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return false;
  await startSession(user);
  return true;
}

/**
 * Mirrors a domain user into the local table so sessions, roles and foreign
 * keys keep working. The role always follows current group membership, so a
 * demotion in AD takes effect on the next login.
 */
async function upsertAdUser(username: string, role: "admin" | "viewer"): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({ role, authSource: "ad" })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(users)
    .values({
      username,
      passwordHash: AD_PASSWORD_PLACEHOLDER,
      authSource: "ad",
      role,
    })
    .returning();
  return created;
}

/**
 * Local accounts are tried first so a break-glass admin can still sign in when
 * the domain controller is unreachable. Domain accounts never fall through to
 * the local password check.
 */
export type LoginResult = {
  success: boolean;
  error?: string;
  /** Set when the password was accepted but a second factor is still owed:
   *  "verify" for an enrolled user, "enroll" when MFA is required but not set up. */
  mfa?: "verify" | "enroll";
};

export async function login(username: string, password: string): Promise<LoginResult> {
  const trimmed = username.toLowerCase().trim();
  const invalid = { success: false, error: "Nieprawidłowa nazwa użytkownika lub hasło" };

  if (!password) return invalid;

  const [user] = await db.select().from(users).where(eq(users.username, trimmed)).limit(1);

  if (user && user.authSource === "local") {
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) return invalid;

    // Password is correct — but do not issue a session yet if a second factor
    // is owed. The pending cookie carries only the user id to the code step.
    if (user.mfaEnabled) {
      await setMfaPending(user.id, "verify");
      return { success: false, mfa: "verify" };
    }
    if (user.mfaRequired) {
      await setMfaPending(user.id, "enroll");
      return { success: false, mfa: "enroll" };
    }

    await startSession(user);
    return { success: true };
  }

  if (!(await isAdConfigured())) return invalid;

  try {
    const result = await authenticateAgainstAd(trimmed, password);
    if (!result.ok || !result.identity) {
      return { success: false, error: result.error ?? invalid.error };
    }

    const adUser = await upsertAdUser(
      result.identity.samAccountName.toLowerCase(),
      result.identity.role
    );
    await startSession(adUser);
    return { success: true };
  } catch (err: any) {
    console.error("AD login failed:", err);
    return { success: false, error: "Nie udało się połączyć z kontrolerem domeny" };
  }
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function createUser(
  username: string,
  password: string,
  role: "admin" | "viewer" = "viewer"
): Promise<{ success: boolean; error?: string; user?: User }> {
  const trimmed = username.toLowerCase().trim();

  if (trimmed.length < 3) {
    return { success: false, error: "Nazwa użytkownika musi mieć minimum 3 znaki" };
  }
  if (password.length < 6) {
    return { success: false, error: "Hasło musi mieć minimum 6 znaków" };
  }

  const existing = await db.select().from(users).where(eq(users.username, trimmed)).limit(1);
  if (existing.length > 0) {
    return { success: false, error: "Użytkownik o takiej nazwie już istnieje" };
  }

  const passwordHash = await hashPassword(password);

  const [newUser] = await db
    .insert(users)
    .values({
      username: trimmed,
      passwordHash,
      role,
    })
    .returning();

  return { success: true, user: newUser };
}

/**
 * Returns true if there are no users yet (first-run setup mode)
 */
export async function needsSetup(): Promise<boolean> {
  const result = await db.select({ count: users.id }).from(users).limit(1);
  return result.length === 0;
}
