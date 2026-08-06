import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adAccounts, adNotifyPolicies, AD_NOTIFY_SCOPES, type AdNotifyScope } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { getAdThresholds } from "@/lib/settings";
import { recordAudit } from "@/lib/audit";
import { accountKey, type AdSide } from "@/lib/ad/notify-scope";
import { and, eq } from "drizzle-orm";

const MAX_DAYS = 3650;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The whole policy set is a handful of rows; the client resolves per account. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [policies, globalDays] = await Promise.all([
    db.select().from(adNotifyPolicies),
    getAdThresholds(),
  ]);

  return NextResponse.json({ policies, globalDays });
}

/**
 * Clears the marks of one side on the accounts a policy governs, so a threshold
 * that was just added — or a side that was just switched back on — is allowed to
 * fire, and a removed one stops lingering. An OU covers its whole subtree, which
 * the DN suffix identifies; the table mirrors a directory, small enough to filter
 * in memory. Scoped to one directoryId: two forests can share an OU's exact DN,
 * and a reset for one must never touch the other's identically-named OU.
 */
async function resetFiredThresholds(directoryId: number, scope: AdNotifyScope, target: string, sides: AdSide[]) {
  if (sides.length === 0) return;

  const rows = await db.select().from(adAccounts).where(eq(adAccounts.directoryId, directoryId));
  const needle = target.toLowerCase();

  const affected = rows.filter((row) => {
    if (scope === "account") return accountKey(row).toLowerCase() === needle;
    const ou = row.ouPath.toLowerCase();
    return ou === needle || ou.endsWith(`,${needle}`);
  });

  for (const row of affected) {
    const fired = row.notifiedThresholds ?? [];
    const kept = fired.filter((mark) => !sides.some((s) => mark.startsWith(`${s}:`)));
    if (kept.length === fired.length) continue;
    await db.update(adAccounts).set({ notifiedThresholds: kept }).where(eq(adAccounts.id, row.id));
  }
}

/** Null means "inherit the global thresholds"; a list must be days within range. */
function parseThresholds(
  days: number[] | null | undefined,
  current: string | null
): { value: string | null; error?: string } {
  if (days === undefined) return { value: current };
  if (days === null || days.length === 0) return { value: null };

  const invalid = days.filter((d) => !Number.isInteger(d) || d < 1 || d > MAX_DAYS);
  if (invalid.length > 0) {
    return {
      value: current,
      error: `Nieprawidłowe progi: ${invalid.join(", ")}. Podaj liczbę dni od 1 do ${MAX_DAYS}.`,
    };
  }

  return { value: [...new Set(days)].sort((a, b) => a - b).join(",") };
}

interface Body {
  directoryId?: number;
  scope?: string;
  target?: string;
  /** false records an explicit silence; pass remove:true to inherit again. */
  enabled?: boolean;
  /** true deletes the policy, so the OU above (or nothing) governs the target again. */
  remove?: boolean;
  notifyPassword?: boolean;
  passwordDays?: number[] | null;
  notifyAccount?: boolean;
  accountDays?: number[] | null;
  mutedUntil?: string | null;
  recipients?: string | null;
}

/**
 * Sets the notification policy for one OU or one account. Unlike the inventory,
 * where every item is watched by default, a target with no policy is silent —
 * so creating a row here is the act of subscribing to it. The password expiry and
 * the account expiry are configured apart: two switches, two sets of thresholds.
 */
export async function PATCH(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Tylko administrator" }, { status: 403 });
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Nieprawidłowe żądanie" }, { status: 400 });
  }

  const directoryId = body.directoryId;
  const scope = body.scope as AdNotifyScope;
  const target = (body.target || "").trim();

  if (!directoryId || !AD_NOTIFY_SCOPES.includes(scope) || !target) {
    return NextResponse.json({ error: "Nieprawidłowy zakres powiadomień" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(adNotifyPolicies)
    .where(
      and(
        eq(adNotifyPolicies.directoryId, directoryId),
        eq(adNotifyPolicies.scope, scope),
        eq(adNotifyPolicies.target, target)
      )
    )
    .limit(1);

  if (body.remove) {
    if (existing) await db.delete(adNotifyPolicies).where(eq(adNotifyPolicies.id, existing.id));
    // The target may now fall under a different policy, so nothing it recorded
    // as "already sent" can be trusted.
    await resetFiredThresholds(directoryId, scope, target, ["password", "account"]);

    await recordAudit({
      actor: user,
      action: "ad.notifications",
      entityType: scope === "ou" ? "ad_ou" : "ad_account",
      entityName: target,
      details: { usunieto_polityke: true },
    });
    return NextResponse.json({ success: true, removed: true });
  }

  const password = parseThresholds(body.passwordDays, existing?.passwordDays ?? null);
  if (password.error) return NextResponse.json({ error: password.error }, { status: 400 });

  const account = parseThresholds(body.accountDays, existing?.accountDays ?? null);
  if (account.error) return NextResponse.json({ error: account.error }, { status: 400 });

  const notifyPassword = body.notifyPassword ?? existing?.notifyPassword ?? true;
  const notifyAccount = body.notifyAccount ?? existing?.notifyAccount ?? true;

  if (!notifyPassword && !notifyAccount) {
    return NextResponse.json(
      { error: "Włącz powiadomienia o wygaśnięciu hasła, konta albo obu — inaczej polityka nic nie robi." },
      { status: 400 }
    );
  }

  // --- wyciszenie ---
  let mutedUntil: Date | null = existing?.mutedUntil ?? null;
  if (body.mutedUntil !== undefined) {
    if (!body.mutedUntil) {
      mutedUntil = null;
    } else {
      // The picker yields a day and the operator means "quiet through that day",
      // so the mute expires as it ends rather than as it begins.
      const parsed = new Date(`${body.mutedUntil}T23:59:59.999Z`);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "Nieprawidłowa data wyciszenia" }, { status: 400 });
      }
      mutedUntil = parsed;
    }
  }

  // --- dodatkowi odbiorcy ---
  let notifyRecipients: string | null = existing?.notifyRecipients ?? null;
  if (body.recipients !== undefined) {
    const list = (body.recipients || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const bad = list.filter((e) => !EMAIL.test(e));
    if (bad.length > 0) {
      return NextResponse.json({ error: `Nieprawidłowy adres: ${bad[0]}` }, { status: 400 });
    }
    notifyRecipients = list.length > 0 ? list.join(",") : null;
  }

  const enabled = body.enabled ?? existing?.enabled ?? true;
  const now = new Date();

  // Whatever changed about a side invalidates what that side already sent.
  const dirty: AdSide[] = [];
  if (password.value !== (existing?.passwordDays ?? null) || notifyPassword !== (existing?.notifyPassword ?? true)) {
    dirty.push("password");
  }
  if (account.value !== (existing?.accountDays ?? null) || notifyAccount !== (existing?.notifyAccount ?? true)) {
    dirty.push("account");
  }
  await resetFiredThresholds(directoryId, scope, target, dirty);

  const values = {
    enabled,
    notifyPassword,
    passwordDays: password.value,
    notifyAccount,
    accountDays: account.value,
    mutedUntil,
    notifyRecipients,
    updatedAt: now,
  };

  if (existing) {
    await db.update(adNotifyPolicies).set(values).where(eq(adNotifyPolicies.id, existing.id));
  } else {
    await db.insert(adNotifyPolicies).values({ directoryId, scope, target, ...values, createdAt: now });
  }

  await recordAudit({
    actor: user,
    action: "ad.notifications",
    entityType: scope === "ou" ? "ad_ou" : "ad_account",
    entityName: target,
    details: {
      wlaczone: enabled,
      haslo: notifyPassword ? password.value ?? "(globalne)" : "wyłączone",
      konto: notifyAccount ? account.value ?? "(globalne)" : "wyłączone",
      wyciszone_do: mutedUntil?.toISOString() ?? null,
      dodatkowi_odbiorcy: notifyRecipients ?? null,
    },
  });

  return NextResponse.json({
    success: true,
    policy: { directoryId, scope, target, ...values, mutedUntil: mutedUntil?.toISOString() ?? null },
  });
}
