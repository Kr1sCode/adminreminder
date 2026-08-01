import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services, ITEM_TYPES, ITEM_TYPE_LABELS } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { and, count, desc, eq } from "drizzle-orm";
import { computeStatus } from "@/lib/cert-checker";
import { createService, isDuplicateError, sanitizeCustomData } from "@/lib/server/create-service";
import { getThresholds } from "@/lib/settings";
import { getItemLimit } from "@/lib/license";
import { recordAudit } from "@/lib/audit";

/**
 * The dashboard renders from this payload after every refresh, so it has to
 * agree with the server-rendered page (app/dashboard/page.tsx): same expiry
 * threshold, same ordering, same derived fields.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { expiringSoonDays } = await getThresholds();
  const all = await db.select().from(services).orderBy(desc(services.expiryDate));

  const enriched = all.map((item) => {
    // The two sides of a website are independent: a valid certificate says
    // nothing about whether the domain is still paid for.
    const cert = computeStatus(item.expiryDate ? new Date(item.expiryDate) : null, expiringSoonDays);
    const domain = item.domainName
      ? computeStatus(item.domainExpiryDate ? new Date(item.domainExpiryDate) : null, expiringSoonDays)
      : null;

    return {
      ...item,
      computedStatus: cert.status,
      daysLeft: cert.daysLeft,
      domainStatus: domain?.status ?? null,
      domainDaysLeft: domain?.daysLeft ?? null,
      typeLabel: ITEM_TYPE_LABELS[item.type as keyof typeof ITEM_TYPE_LABELS] || item.type,
    };
  });

  return NextResponse.json(enriched);
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator może dodawać pozycje" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const {
      type = 'https_cert',
      name,
      identifier,
      port = 443,
      owner,
      notes,
      renewalUrl,
      expiryDate,
      customData,
      alsoTrack = false
    } = body;

    if (!name || !identifier) {
      return NextResponse.json({ error: "Nazwa i identyfikator są wymagane" }, { status: 400 });
    }

    if (!ITEM_TYPES.includes(type as any)) {
      return NextResponse.json({ error: "Nieprawidłowy typ pozycji" }, { status: 400 });
    }

    const manualExpiry = expiryDate ? new Date(expiryDate) : null;
    if (manualExpiry && Number.isNaN(manualExpiry.getTime())) {
      return NextResponse.json({ error: "Nieprawidłowa data ważności" }, { status: 400 });
    }

    const normalizedIdentifier = identifier.trim().toLowerCase();
    const normalizedPort = Number(port) || 443;
    // Asking for domain tracking makes the row a website, i.e. an https_cert row
    // carrying both dates — so the duplicate check has to look for that type.
    const effectiveType = alsoTrack ? "https_cert" : type;

    // The free tier is a hard cap on how many items exist, not a feature flag —
    // checked here, before the row is created, rather than filtered out of a
    // list after the fact.
    const limit = await getItemLimit();
    const [{ value: currentCount }] = await db.select({ value: count() }).from(services);
    if (currentCount >= limit) {
      return NextResponse.json(
        {
          error:
            `Osiagnieto limit ${limit} pozycji w wersji darmowej. ` +
            "Wprowadz klucz licencyjny w Ustawienia -> Licencja, zeby dodawac wiecej.",
        },
        { status: 402 }
      );
    }

    // Answers the common case — the same item submitted twice — with a message
    // the operator can act on. The unique index behind it is what actually
    // prevents the row from being written twice when two requests race.
    const [duplicate] = await db
      .select({ id: services.id })
      .from(services)
      .where(
        and(
          eq(services.type, effectiveType),
          eq(services.identifier, normalizedIdentifier),
          eq(services.port, normalizedPort)
        )
      )
      .limit(1);

    if (duplicate) {
      return NextResponse.json({ error: "Taka pozycja już istnieje na liście." }, { status: 409 });
    }

    const newItem = await createService({
      type,
      name,
      identifier: normalizedIdentifier,
      port: normalizedPort,
      owner,
      notes,
      renewalUrl,
      expiryDate: manualExpiry,
      customData: sanitizeCustomData(customData),
      trackDomain: Boolean(alsoTrack),
    });

    await recordAudit({
      actor: user,
      action: "item.create",
      entityType: "service",
      entityId: newItem.id,
      entityName: newItem.name,
      details: {
        typ: newItem.type,
        identyfikator: newItem.identifier,
        sledzi_domene: newItem.domainName ?? null,
      },
    });

    return NextResponse.json({ success: true, id: newItem.id });
  } catch (error) {
    if (isDuplicateError(error)) {
      return NextResponse.json({ error: "Taka pozycja już istnieje na liście." }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json({ error: "Błąd podczas dodawania pozycji" }, { status: 500 });
  }
}
