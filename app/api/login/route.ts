import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { login } from "@/lib/auth";
import { rateLimit, resetRateLimit, clientIp } from "@/lib/rate-limit";

// Brute-force ceiling: 10 attempts per IP per 5 minutes.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const key = `login:${ip}`;
  const limit = rateLimit(key, MAX_ATTEMPTS, WINDOW_MS);

  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Zbyt wiele prób logowania. Spróbuj ponownie później." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  try {
    const body = await request.json().catch(() => null);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json({ error: "Podaj nazwę użytkownika i hasło" }, { status: 400 });
    }

    const result = await login(username, password);

    // Password correct but a second factor is owed: not a success, not a
    // failure. The client advances to the code step; the pending cookie is set.
    if (result.mfa) {
      return NextResponse.json({ mfa: result.mfa });
    }

    if (!result.success) {
      // Failed attempts are the point of an audit log, not an afterthought.
      await recordAudit({
        actor: { username: username || "(brak nazwy)" },
        action: "auth.login_failed",
      });
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    // A valid login should not be penalised by earlier failed attempts.
    resetRateLimit(key);
    await recordAudit({
      actor: { username },
      action: "auth.login",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Login route error:", error);
    return NextResponse.json({ error: "Wewnętrzny błąd serwera" }, { status: 500 });
  }
}
