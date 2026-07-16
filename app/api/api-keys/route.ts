import { NextRequest, NextResponse } from "next/server";
import { recordAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/auth";
import { createApiKey, listApiKeys } from "@/lib/api-keys";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }
  return NextResponse.json({ keys: await listApiKeys() });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name : "";

  const { record, token } = await createApiKey(name, ["read"], user.username);

  // The token itself is never logged: the entry records that a key was minted.
  await recordAudit({
    actor: user,
    action: "apikey.create",
    entityType: "apikey",
    entityId: record.id,
    entityName: name,
    details: { prefiks: record.prefix, zakresy: record.scopes },
  });

  // The token is returned exactly once; the client must show/copy it now.
  return NextResponse.json({
    key: { id: record.id, name: record.name, prefix: record.prefix, scopes: record.scopes },
    token,
  });
}
