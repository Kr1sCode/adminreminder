import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { and, eq, ne } from "drizzle-orm";
import { registrableDomainFor } from "@/lib/server/companion";
import { isDuplicateError } from "@/lib/server/create-service";
import { refreshService } from "@/lib/server/refresh";
import { recordAudit } from "@/lib/audit";

/**
 * Starts watching the other half of a website on an item that already exists.
 *
 * For a certificate row this fills in the domain columns. For a domain-only row
 * it promotes the row to a full website entry — same identifier, the old expiry
 * kept as the registration date, the certificate fetched fresh.
 */
export async function POST(
  _request: NextRequest,
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
  if (item.type !== "https_cert" && item.type !== "domain") {
    return NextResponse.json(
      { error: "Ten typ pozycji nie ma odpowiednika do śledzenia." },
      { status: 400 }
    );
  }
  if (item.domainName) {
    return NextResponse.json({ error: "Ta pozycja już śledzi rejestrację domeny." }, { status: 409 });
  }

  let domainName: string;
  try {
    domainName = registrableDomainFor(item.identifier);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }

  // Promoting a domain row to https_cert can collide with a certificate row that
  // already exists for the same host; the unique index would reject it anyway,
  // but a 409 with a sentence beats a constraint error.
  if (item.type === "domain") {
    const [clash] = await db
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.type, "https_cert"),
          eq(services.identifier, item.identifier),
          eq(services.port, item.port),
          ne(services.id, item.id)
        )
      )
      .limit(1);

    if (clash) {
      return NextResponse.json(
        { error: "Certyfikat dla tego hosta jest już śledzony w innej pozycji." },
        { status: 409 }
      );
    }
  }

  try {
    await db
      .update(services)
      .set({
        type: "https_cert",
        domainName,
        // A domain-only row already knows its registration date; keep it rather
        // than leaving the column empty until the next registry lookup.
        ...(item.type === "domain"
          ? {
              domainExpiryDate: item.expiryDate,
              domainLastCheckedAt: item.lastCheckedAt,
              domainLastCheckStatus: item.lastCheckStatus,
              expiryDate: null,
              lastCheckedAt: null,
              lastCheckStatus: null,
              lastCheckError: null,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));

    const [updated] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    await refreshService(updated);

    await recordAudit({
      actor: user,
      action: "item.track_domain",
      entityType: "service",
      entityId: serviceId,
      entityName: item.name,
      details: { domena: domainName, awans_z_typu: item.type },
    });

    return NextResponse.json({ success: true, domainName });
  } catch (e) {
    if (isDuplicateError(e)) {
      return NextResponse.json(
        { error: "Certyfikat dla tego hosta jest już śledzony w innej pozycji." },
        { status: 409 }
      );
    }
    console.error("companion enable failed:", e);
    return NextResponse.json({ error: "Nie udało się włączyć śledzenia domeny." }, { status: 500 });
  }
}
