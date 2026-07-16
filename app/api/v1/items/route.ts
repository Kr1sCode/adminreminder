import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { withApiKey } from "@/lib/api-guard";

/**
 * GET /api/v1/items — read-only list of monitored items for external systems.
 * Query params:
 *   expiring=<days>  only items expiring within N days (includes already expired)
 *   status=ok|expiring|expired|error
 */
export const GET = withApiKey("read", async (req) => {
  const { expiringSoonDays } = await getThresholds();
  const url = new URL(req.url);
  const expiringWithin = url.searchParams.get("expiring");
  const statusFilter = url.searchParams.get("status");

  const rows = await db.select().from(services).orderBy(services.expiryDate);

  let items = rows.map((row) => {
    const { status, daysLeft } = computeStatus(
      row.expiryDate ? new Date(row.expiryDate) : null,
      expiringSoonDays
    );
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      identifier: row.identifier,
      owner: row.owner,
      status,
      daysLeft,
      expiryDate: row.expiryDate ? new Date(row.expiryDate).toISOString() : null,
      renewalUrl: row.renewalUrl,
      lastCheckedAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
    };
  });

  if (statusFilter) {
    items = items.filter((i) => i.status === statusFilter);
  }
  if (expiringWithin !== null) {
    const days = Number(expiringWithin);
    if (!Number.isNaN(days)) {
      items = items.filter((i) => i.daysLeft !== null && i.daysLeft <= days);
    }
  }

  return NextResponse.json({ count: items.length, items });
});
