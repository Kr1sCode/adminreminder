import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { getCurrentUser, startSessionById } from "@/lib/auth";
import { readMfaPending, confirmEnrollment, clearMfaPending } from "@/lib/mfa";

/**
 * Confirms the first TOTP code and enables MFA. Self-enrolment (signed in) just
 * turns it on; login-time enrolment also completes the sign-in and drops the
 * pending cookie.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const code = typeof body?.code === "string" ? body.code : "";

  const current = await getCurrentUser();
  if (current) {
    const ok = await confirmEnrollment(current.id, code);
    if (!ok) return NextResponse.json({ error: "Nieprawidłowy kod" }, { status: 400 });
    await recordAudit({ actor: current, action: "mfa.enrolled" });
    return NextResponse.json({ success: true });
  }

  const pending = await readMfaPending();
  if (pending?.stage === "enroll") {
    const ok = await confirmEnrollment(pending.userId, code);
    if (!ok) return NextResponse.json({ error: "Nieprawidłowy kod" }, { status: 400 });
    await startSessionById(pending.userId);
    await clearMfaPending();
    const user = await getCurrentUser();
    await recordAudit({
      actor: user ?? { username: `#${pending.userId}` },
      action: "mfa.enrolled",
    });
    return NextResponse.json({ success: true, loggedIn: true });
  }

  return NextResponse.json({ error: "Brak kontekstu MFA" }, { status: 401 });
}
