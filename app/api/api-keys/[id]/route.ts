import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth";
import { deleteApiKey } from "@/lib/api-keys";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id } = await params;
  const ok = await deleteApiKey(parseInt(id));
  if (!ok) return NextResponse.json({ error: "Klucz nie znaleziony" }, { status: 404 });

  await recordAudit({
    actor: user,
    action: "apikey.revoke",
    entityType: "apikey",
    entityId: parseInt(id),
  });

  return NextResponse.json({ success: true });
}
