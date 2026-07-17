import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "@/db/schema";
import { encryptSecret, decryptSecret, isEncrypted } from "./crypto";
import { generateTotpSecret, verifyTotp, otpauthUri } from "./totp";
import { cookieSecure } from "./cookie-security";

/**
 * Two-factor server logic. Kept apart from lib/auth.ts to avoid an import cycle:
 * auth.ts issues the login session, this module only handles enrolment, code
 * verification and the short-lived "password accepted, awaiting code" cookie.
 */

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "ar-adminreminder-dev-secret-change-in-production-please"
);

const MFA_PENDING_COOKIE = "ar_mfa";
const PENDING_MAX_AGE = 5 * 60; // the code step must be finished within 5 minutes

export type MfaStage = "verify" | "enroll";

/** Marks that a password was accepted but the second factor is still owed. This
 *  cookie is NOT a session: it only names the user and what step remains. */
export async function setMfaPending(userId: number, stage: MfaStage): Promise<void> {
  const token = await new SignJWT({ stage })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(JWT_SECRET);

  const store = await cookies();
  store.set(MFA_PENDING_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: PENDING_MAX_AGE,
  });
}

export async function readMfaPending(): Promise<{ userId: number; stage: MfaStage } | null> {
  const store = await cookies();
  const token = store.get(MFA_PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return { userId: parseInt(payload.sub as string), stage: payload.stage as MfaStage };
  } catch {
    return null;
  }
}

export async function clearMfaPending(): Promise<void> {
  const store = await cookies();
  store.delete(MFA_PENDING_COOKIE);
}

function decodeSecret(stored: string): string {
  return isEncrypted(stored) ? decryptSecret(stored) : stored;
}

/**
 * Issues a fresh secret and stores it (encrypted, still disabled). Returns the
 * otpauth URI for the QR and the raw secret for manual entry. Enrolment is only
 * complete once a code is confirmed.
 */
export async function beginEnrollment(
  userId: number,
  label: string
): Promise<{ secret: string; otpauth: string }> {
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ mfaSecret: encryptSecret(secret), mfaEnabled: false })
    .where(eq(users.id, userId));
  return { secret, otpauth: otpauthUri(secret, label) };
}

/** Verifies the first code against the pending secret and, if valid, enables MFA. */
export async function confirmEnrollment(userId: number, code: string): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.mfaSecret) return false;
  if (!verifyTotp(decodeSecret(user.mfaSecret), code)) return false;
  await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, userId));
  return true;
}

/** Verifies a login-time code against an already-enrolled secret. */
export async function verifyLoginCode(userId: number, code: string): Promise<boolean> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.mfaEnabled || !user.mfaSecret) return false;
  return verifyTotp(decodeSecret(user.mfaSecret), code);
}

/** Admin recovery for a lost device: wipe the secret and disable MFA. */
export async function resetMfa(userId: number): Promise<void> {
  await db.update(users).set({ mfaSecret: null, mfaEnabled: false }).where(eq(users.id, userId));
}
