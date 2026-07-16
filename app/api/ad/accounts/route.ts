import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adAccounts } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getThresholds } from "@/lib/settings";
import { buildOuTree } from "@/lib/ad/tree";
import { computeStatus } from "@/lib/cert-checker";

/**
 * An account runs two independent clocks and the table must not blend them: the
 * password expires every few weeks and the user resets it themselves, while the
 * account expires once, on the day a contract ends, and someone else has to act.
 * Each side is computed on its own. A missing date is a fact, not an error —
 * "never" when the directory says the password never expires, "unknown" when no
 * end date was ever set.
 */
function side(expiry: Date | null, expiringSoonDays: number, neverExpires = false) {
  if (!expiry) {
    return { status: neverExpires ? "never" : "unknown", daysLeft: null };
  }
  const { status, daysLeft } = computeStatus(expiry, expiringSoonDays);
  return { status, daysLeft };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { expiringSoonDays } = await getThresholds();
  const rows = await db.select().from(adAccounts);

  const accounts = rows.map((row) => {
    const password = side(row.passwordExpiresAt, expiringSoonDays, row.passwordNeverExpires);
    const account = side(row.accountExpiresAt, expiringSoonDays);

    return {
      ...row,
      passwordStatus: password.status,
      passwordDaysLeft: password.daysLeft,
      accountStatus: account.status,
      accountDaysLeft: account.daysLeft,
    };
  });

  const tree = buildOuTree(
    rows.map((row) => ({
      ouPath: row.ouPath,
      kind: row.kind,
      passwordExpiresAt: row.passwordExpiresAt,
      accountExpiresAt: row.accountExpiresAt,
    })),
    expiringSoonDays
  );

  const attention = (status: string) => status === "expiring" || status === "expired";

  const summary = {
    total: rows.length,
    ad: rows.filter((r) => r.source === "ad").length,
    entra: rows.filter((r) => r.source === "entra").length,
    technical: rows.filter((r) => r.kind === "technical").length,
    functional: rows.filter((r) => r.kind === "functional").length,
    disabled: rows.filter((r) => !r.enabled).length,
    passwordNeverExpires: rows.filter((r) => r.passwordNeverExpires).length,
    // Counted apart, because they call for different action: a password the user
    // resets in a minute, an account someone has to decide to extend.
    passwordAttention: accounts.filter((a) => a.enabled && attention(a.passwordStatus)).length,
    accountAttention: accounts.filter((a) => a.enabled && attention(a.accountStatus)).length,
    lastSyncedAt: rows.reduce<Date | null>(
      (latest, r) => (!latest || r.lastSyncedAt > latest ? r.lastSyncedAt : latest),
      null
    ),
  };

  return NextResponse.json({ accounts, tree, summary });
}
