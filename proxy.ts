import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SignJWT, jwtVerify } from "jose";
import { cookieSecure } from "./lib/cookie-security";

/**
 * Sliding session: every request with a still-valid session cookie gets it
 * re-issued with a fresh 15-minute window, so active use never logs you out
 * while an idle session lapses on its own. (Next 16 renamed `middleware` to
 * `proxy`; it runs on the Node.js runtime, so `jose` works here.)
 */

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "ar-adminreminder-dev-secret-change-in-production-please"
);

const SESSION_COOKIE = "ar_session";
const SESSION_MAX_AGE = 60 * 15;

// These set or clear the session cookie themselves; refreshing here would race
// with them (e.g. undo a logout), so leave their responses untouched.
const SKIP_PREFIXES = ["/api/login", "/api/logout", "/api/mfa", "/api/setup"];

// Public read-only showcase: block every mutating API call in one place, so a
// visitor can browse the whole app (including settings) but change nothing.
// Only the auth flows that need POST stay open — notably NOT /api/mfa/enroll or
// /api/mfa/confirm, which would let anyone attach MFA to the shared demo account.
const DEMO_MODE = process.env.DEMO_MODE === "true";
const DEMO_WRITE_ALLOW = ["/api/login", "/api/logout", "/api/mfa/verify"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (DEMO_MODE) {
    const method = request.method;
    const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (isWrite && pathname.startsWith("/api/") && !DEMO_WRITE_ALLOW.some((p) => pathname.startsWith(p))) {
      return NextResponse.json({ error: "Tryb demonstracyjny — tylko do odczytu." }, { status: 403 });
    }
  }

  const res = NextResponse.next();

  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return res;

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return res;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const refreshed = await new SignJWT({ username: payload.username, role: payload.role })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(payload.sub as string)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(JWT_SECRET);

    res.cookies.set(SESSION_COOKIE, refreshed, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  } catch {
    // Expired or invalid — drop the stale cookie so it stops being sent.
    res.cookies.delete(SESSION_COOKIE);
  }

  return res;
}

export const config = {
  // Everything except static assets and image optimization.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)"],
};
