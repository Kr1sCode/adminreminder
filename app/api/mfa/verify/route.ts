import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { startSessionById } from "@/lib/auth";
import { readMfaPending, verifyLoginCode, clearMfaPending } from "@/lib/mfa";
import { rateLimit, resetRateLimit, clientIp } from "@/lib/rate-limit";

// A TOTP code is six digits: cap guesses so a stolen password cannot be paired
// with a brute-forced code.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

/** Second login step: verifies the TOTP code for a password that already
 *  passed, then issues the real session. */
export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const key = `mfa:${ip}`;
  const limit = rateLimit(key, MAX_ATTEMPTS, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Zbyt wiele prób. Spróbuj ponownie później." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const pending = await readMfaPending();
  if (pending?.stage !== "verify") {
    return NextResponse.json({ error: "Sesja logowania wygasła — zaloguj się ponownie." }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code : "";

  const ok = await verifyLoginCode(pending.userId, code);
  if (!ok) {
    await recordAudit({ actor: { username: `#${pending.userId}` }, action: "auth.mfa_failed" });
    return NextResponse.json({ error: "Nieprawidłowy kod" }, { status: 400 });
  }

  await startSessionById(pending.userId);
  await clearMfaPending();
  resetRateLimit(key);
  return NextResponse.json({ success: true });
}
