import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { diffFields, recordAudit } from "@/lib/audit";
import { registrableDomainFor } from "@/lib/server/companion";
import { isAutoCheckable } from "@/lib/server/expiry";
import { refreshService } from "@/lib/server/refresh";
import { isDuplicateError, sanitizeCustomData } from "@/lib/server/create-service";

const AUDITED_FIELDS = ["type", "name", "identifier", "port", "owner", "notes", "renewalUrl", "expiryDate", "domainName"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id } = await params;
  const serviceId = parseInt(id);

  try {
    const body = await request.json();
    const { type, name, identifier, port, owner, notes, renewalUrl, expiryDate, customData } = body;

    const expiry = expiryDate ? new Date(expiryDate) : null;
    if (expiry && Number.isNaN(expiry.getTime())) {
      return NextResponse.json({ error: "Nieprawidłowa data ważności" }, { status: 400 });
    }

    // Needed for the audit diff, and to tell a rename from a renewal.
    const [before] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    if (!before) return NextResponse.json({ error: "Pozycja nie istnieje" }, { status: 404 });

    const { expiringSoonDays } = await getThresholds();

    // Only touch what the caller sent. The "+rok" button submits nothing but a
    // date, and an unconditional `owner: owner?.trim() || null` wiped the owner,
    // the notes and the renewal link on every renewal.
    await db
      .update(services)
      .set({
        ...(type !== undefined ? { type } : {}),
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(identifier !== undefined ? { identifier: identifier.trim().toLowerCase() } : {}),
        ...(port !== undefined ? { port: Number(port) || 443 } : {}),
        ...(owner !== undefined ? { owner: owner?.trim() || null } : {}),
        ...(notes !== undefined ? { notes: notes?.trim() || null } : {}),
        ...(renewalUrl !== undefined ? { renewalUrl: renewalUrl?.trim() || null } : {}),
        ...(customData !== undefined ? { customData: sanitizeCustomData(customData) } : {}),
        ...(expiryDate !== undefined
          ? { expiryDate: expiry, lastCheckStatus: expiry ? computeStatus(expiry, expiringSoonDays).status : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(services.id, serviceId));

    let [after] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);

    // Everything we knew belonged to the old host: the certificate, and the
    // registrable domain derived from it. Repoint both, then look them up again.
    //
    // Only for items that discover their own dates. A licence whose identifier
    // is a free-text note carries a hand-typed expiry, and wiping it because the
    // note was reworded would destroy the only data the row has.
    const identifierChanged = after.identifier !== before.identifier;
    if (identifierChanged && (isAutoCheckable(after.type) || before.domainName)) {
      let domainName: string | null = null;
      if (before.domainName) {
        try {
          domainName = registrableDomainFor(after.identifier);
        } catch {
          domainName = null; // an IP or intranet name has no registration to watch
        }
      }

      await db
        .update(services)
        .set({
          domainName,
          expiryDate: null,
          lastCheckedAt: null,
          lastCheckStatus: null,
          lastCheckError: null,
          domainExpiryDate: null,
          domainLastCheckedAt: null,
          domainLastCheckStatus: null,
          domainLastCheckError: null,
          // A different host means a different renewal cycle; old alerts are void.
          notifiedThresholds: [],
        })
        .where(eq(services.id, serviceId));

      [after] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
      await refreshService(after);
      [after] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    } else if (after.type === "tls_endpoint" && customData !== undefined) {
      // Editing the SNI or the pinned fingerprint changes the verdict without
      // touching the identifier, so re-probe here rather than waiting for the
      // next scheduled check.
      await refreshService(after);
      [after] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);
    }

    // The "+rok" button sends nothing but a new date; a full edit sends the form.
    const isRenew = Object.keys(body).length === 1 && body.expiryDate !== undefined;
    const changes = diffFields(before, after, AUDITED_FIELDS);

    if (Object.keys(changes).length > 0) {
      await recordAudit({
        actor: user,
        action: isRenew ? "item.renew" : "item.update",
        entityType: "service",
        entityId: serviceId,
        entityName: after.name,
        details: { zmiany: changes },
      });
    }

    return NextResponse.json({ success: true });
  } catch (e) {
    // Renaming a host onto one that is already tracked hits the unique index.
    if (isDuplicateError(e)) {
      return NextResponse.json({ error: "Taka pozycja już istnieje na liście." }, { status: 409 });
    }
    console.error("Update error:", e);
    return NextResponse.json({ error: "Błąd aktualizacji" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const { id } = await params;
  const serviceId = parseInt(id);

  try {
    // Read before deleting: the name is what makes the log entry legible later.
    const [before] = await db.select().from(services).where(eq(services.id, serviceId)).limit(1);

    const result = await db.delete(services).where(eq(services.id, serviceId));
    if (result.changes === 0) {
      return NextResponse.json({ error: "Pozycja nie znaleziona" }, { status: 404 });
    }

    await recordAudit({
      actor: user,
      action: "item.delete",
      entityType: "service",
      entityId: serviceId,
      entityName: before?.name,
      details: {
        typ: before?.type,
        identyfikator: before?.identifier,
        data_waznosci: before?.expiryDate ? new Date(before.expiryDate).toISOString() : null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error("Delete error:", e);
    return NextResponse.json({ error: "Błąd podczas usuwania: " + (e.message || e) }, { status: 500 });
  }
}
