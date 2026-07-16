import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adAccounts } from "@/db/schema";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { withApiKey } from "@/lib/api-guard";

/**
 * GET /api/v1/accounts — read-only directory accounts (AD + Entra).
 * Query params: source=ad|entra, kind=user|technical|functional, expiring=<days>.
 */
export const GET = withApiKey("read", async (req) => {
  const { expiringSoonDays } = await getThresholds();
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const kind = url.searchParams.get("kind");
  const expiringWithin = url.searchParams.get("expiring");

  const rows = await db.select().from(adAccounts);

  let accounts = rows.map((row) => {
    const expiry =
      row.passwordExpiresAt && row.accountExpiresAt
        ? row.passwordExpiresAt < row.accountExpiresAt
          ? row.passwordExpiresAt
          : row.accountExpiresAt
        : row.passwordExpiresAt ?? row.accountExpiresAt;
    const { status, daysLeft } = computeStatus(expiry, expiringSoonDays);
    return {
      id: row.id,
      source: row.source,
      samAccountName: row.samAccountName,
      displayName: row.displayName,
      userPrincipalName: row.userPrincipalName,
      kind: row.kind,
      enabled: row.enabled,
      passwordNeverExpires: row.passwordNeverExpires,
      passwordExpiresAt: row.passwordExpiresAt ? new Date(row.passwordExpiresAt).toISOString() : null,
      accountExpiresAt: row.accountExpiresAt ? new Date(row.accountExpiresAt).toISOString() : null,
      status: expiry ? status : row.passwordNeverExpires ? "never" : "unknown",
      daysLeft: expiry ? daysLeft : null,
    };
  });

  if (source) accounts = accounts.filter((a) => a.source === source);
  if (kind) accounts = accounts.filter((a) => a.kind === kind);
  if (expiringWithin !== null) {
    const days = Number(expiringWithin);
    if (!Number.isNaN(days)) {
      accounts = accounts.filter((a) => a.daysLeft !== null && a.daysLeft <= days);
    }
  }

  return NextResponse.json({ count: accounts.length, accounts });
});
