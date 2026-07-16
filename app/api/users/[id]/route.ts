import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { resetMfa } from "@/lib/mfa";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

/**
 * Admin controls for a user's two-factor state:
 *   { mfaRequired: boolean }  — demand MFA (forces enrolment at next login)
 *   { resetMfa: true }        — device-lost recovery: wipe the secret, disable
 *                               and un-require, so the user gets back in with a
 *                               password and can enrol a new device later.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getCurrentUser();
  if (!admin || admin.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id } = await params;
  const userId = parseInt(id);

  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return NextResponse.json({ error: "Użytkownik nie istnieje" }, { status: 404 });

  const body = await request.json().catch(() => ({}));

  if (body?.resetMfa === true) {
    await resetMfa(userId);
    await db.update(users).set({ mfaRequired: false }).where(eq(users.id, userId));
    await recordAudit({
      actor: admin,
      action: "user.mfa_reset",
      entityType: "user",
      entityId: userId,
      entityName: target.username,
    });
    return NextResponse.json({ success: true });
  }

  if (typeof body?.mfaRequired === "boolean") {
    if (target.authSource !== "local") {
      return NextResponse.json(
        { error: "MFA dotyczy tylko kont lokalnych (konta domenowe uwierzytelnia AD/Entra)." },
        { status: 400 }
      );
    }
    await db.update(users).set({ mfaRequired: body.mfaRequired }).where(eq(users.id, userId));
    await recordAudit({
      actor: admin,
      action: body.mfaRequired ? "user.mfa_required" : "user.mfa_unrequired",
      entityType: "user",
      entityId: userId,
      entityName: target.username,
    });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Brak zmian" }, { status: 400 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getCurrentUser();
  if (!admin || admin.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }
  const { id } = await params;
  const userId = parseInt(id);

  // Prevent deleting yourself
  if (admin.id === userId) {
    return NextResponse.json({ error: "Nie możesz usunąć samego siebie" }, { status: 400 });
  }

  // Name read before deletion: the entry has to remain legible afterwards.
  const [victim] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  await db.delete(users).where(eq(users.id, userId));

  await recordAudit({
    actor: admin,
    action: "user.delete",
    entityType: "user",
    entityId: userId,
    entityName: victim?.username,
    details: { rola: victim?.role, zrodlo: victim?.authSource },
  });

  return NextResponse.json({ success: true });
}
