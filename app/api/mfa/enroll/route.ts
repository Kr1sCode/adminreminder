import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { readMfaPending, beginEnrollment } from "@/lib/mfa";

/**
 * Starts TOTP enrolment and returns a QR (data URI) plus the raw secret for
 * manual entry. Two callers: a signed-in operator setting up their own MFA, or
 * a user forced to enrol at login (identified by the pending cookie). In both
 * cases only the caller's OWN account is ever enrolled.
 */
export async function POST() {
  const current = await getCurrentUser();
  let userId: number | null = current?.id ?? null;

  if (userId === null) {
    const pending = await readMfaPending();
    if (pending?.stage === "enroll") userId = pending.userId;
  }
  if (userId === null) {
    return NextResponse.json({ error: "Brak uprawnień" }, { status: 401 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return NextResponse.json({ error: "Użytkownik nie istnieje" }, { status: 404 });

  const { secret, otpauth } = await beginEnrollment(userId, user.username);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });

  return NextResponse.json({ qr, otpauth, secret });
}
