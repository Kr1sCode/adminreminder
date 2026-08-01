import { NextRequest, NextResponse } from "next/server";
import { count } from "drizzle-orm";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getSetting, setSetting } from "@/lib/settings";
import { verifyLicenseToken, getActiveLicense, FREE_TIER_LIMIT, LicenseError } from "@/lib/license";
import { recordAudit } from "@/lib/audit";

async function status() {
  const license = await getActiveLicense();
  const [{ value: currentCount }] = await db.select({ value: count() }).from(services);
  return {
    active: !!license,
    customer: license?.customer ?? null,
    maxItems: license?.maxItems ?? null,
    expiresAt: license?.expiresAt ?? null,
    freeLimit: FREE_TIER_LIMIT,
    currentCount,
    limit: license?.maxItems ?? FREE_TIER_LIMIT,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }
  return NextResponse.json(await status());
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key.trim() : "";

  // An empty key clears the license and falls back to the free tier — the
  // one operation that never needs verifying.
  if (!key) {
    const hadOne = !!(await getSetting("license_key"));
    await setSetting("license_key", "");
    if (hadOne) {
      await recordAudit({
        actor: user,
        action: "settings.update",
        entityType: "license",
        entityName: "license_key",
        details: { usunieto: true },
      });
    }
    return NextResponse.json(await status());
  }

  try {
    const license = await verifyLicenseToken(key);
    await setSetting("license_key", key);
    await recordAudit({
      actor: user,
      action: "settings.update",
      entityType: "license",
      entityName: "license_key",
      details: { klient: license.customer, limit: license.maxItems, wazna_do: license.expiresAt.toISOString() },
    });
    return NextResponse.json(await status());
  } catch (err) {
    const message = err instanceof LicenseError ? err.message : "Nieprawidlowy klucz licencyjny.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
