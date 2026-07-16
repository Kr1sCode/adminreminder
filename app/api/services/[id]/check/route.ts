import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { isAutoCheckable } from "@/lib/server/expiry";
import { refreshService } from "@/lib/server/refresh";
import { recordAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }
  const { id } = await params;
  const serviceId = parseInt(id);

  const [item] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
  if (!item) {
    return NextResponse.json({ error: "Pozycja nie istnieje" }, { status: 404 });
  }

  if (!isAutoCheckable(item.type) && !item.domainName) {
    return NextResponse.json({
      success: false,
      error: "Automatyczne sprawdzanie dostępne tylko dla certyfikatów HTTPS i domen",
    }, { status: 400 });
  }

  // Both sides are refreshed and recorded independently, so a registry outage
  // does not discard what we just learned about the certificate.
  const result = await refreshService(item);

  // Only the manual button lands here; the cron calls runChecks() directly.
  await recordAudit({
    actor: user,
    action: "item.check",
    entityType: "service",
    entityId: item.id,
    entityName: item.name,
    details: { certyfikat: result.certChecked, domena: result.domainChecked, bledy: result.errors },
  });

  return NextResponse.json({
    success: result.errors.length === 0,
    certChecked: result.certChecked,
    domainChecked: result.domainChecked,
    error: result.errors[0] ?? null,
  });
}
