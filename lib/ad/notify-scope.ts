/**
 * Which notification policy governs an account, and what it says about each of
 * the account's two expiries.
 *
 * The directory is opt-in, the opposite of the inventory: a domain holds
 * hundreds of accounts nobody wants mail about, so an account no policy reaches
 * stays silent. Resolution walks outwards from the account:
 *
 *   1. the account's own policy, if it has one — including one that is switched
 *      off, which is how a single noisy account is excluded from a watched OU;
 *   2. otherwise the nearest ancestor OU with a policy, its own OU first;
 *   3. otherwise nothing.
 *
 * Only the nearest policy applies — thresholds are not merged across levels, so
 * what the operator sees in the panel is what actually fires.
 *
 * The password and the account expire on different clocks and are governed
 * apart: each side has its own switch and its own thresholds, both gated by the
 * policy's `enabled`.
 *
 * Pure: no database, no clock beyond what is passed in. Safe to unit test.
 */

import { parseDays } from "@/lib/notify-policy";

export type AdSide = "password" | "account";

export interface PolicyRow {
  directoryId: number;
  scope: "ou" | "account";
  target: string;
  enabled: boolean;
  notifyPassword: boolean;
  passwordDays: string | null;
  notifyAccount: boolean;
  accountDays: string | null;
  mutedUntil: Date | string | null;
  notifyRecipients: string | null;
}

/** Global fallbacks, one list per side (settings: ad_password_days, ad_account_days). */
export type GlobalDays = Record<AdSide, number[]>;

export interface SidePolicy {
  enabled: boolean;
  thresholds: number[];
  /** True when the thresholds come from the global setting rather than this policy. */
  inherited: boolean;
}

export interface EffectivePolicy {
  /** Where the policy came from, for the bell icon and the panel's hint. */
  from: "account" | "ou";
  /** The OU the policy sits on, when it was inherited from one. */
  fromTarget: string;
  /** The policy as a whole. False silences both sides. */
  enabled: boolean;
  password: SidePolicy;
  account: SidePolicy;
  mutedUntil: Date | null;
  recipients: string[];
}

/** The account's own key. The GUID, not the row id: a resync recreates rows. */
export const accountKey = (account: { source: string; objectGuid: string }) =>
  `${account.source}:${account.objectGuid}`;

/**
 * Every DN from the account's own OU up to the root, nearest first.
 * "OU=Konta,OU=IT,DC=corp,DC=local" -> [that, "OU=IT,DC=corp,DC=local", "DC=corp,DC=local"].
 *
 * Splits on unescaped commas only: an OU may legitimately be named
 * `OU=Dział IT\, Warszawa`, and cutting that in half would lose the chain.
 */
export function ancestorDns(ouPath: string): string[] {
  const parts: string[] = [];
  let current = "";

  for (let i = 0; i < ouPath.length; i++) {
    const char = ouPath[i];
    if (char === "\\" && i + 1 < ouPath.length) {
      current += char + ouPath[i + 1];
      i++;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map((_, index) => parts.slice(index).join(",").trim())
    .filter(Boolean);
}

/** Case-insensitive: AD hands the same DN back with varying case. */
const norm = (dn: string) => dn.trim().toLowerCase();

/** Every key below is qualified by directoryId: two different client forests
 *  can and do reuse the same OU naming convention (e.g. both have
 *  "OU=Service Accounts,DC=corp,DC=local"), and without this a policy meant
 *  for one would silently also govern the other's identically-named OU. */
const scopedKey = (directoryId: number, target: string) => `${directoryId}:${norm(target)}`;

export function indexPolicies(rows: PolicyRow[]) {
  const byAccount = new Map<string, PolicyRow>();
  const byOu = new Map<string, PolicyRow>();

  for (const row of rows) {
    const key = scopedKey(row.directoryId, row.target);
    if (row.scope === "account") byAccount.set(key, row);
    else byOu.set(key, row);
  }

  return { byAccount, byOu };
}

export function resolvePolicy(
  account: { directoryId: number; source: string; objectGuid: string; ouPath: string },
  index: ReturnType<typeof indexPolicies>,
  globalDays: GlobalDays
): EffectivePolicy | null {
  const own = index.byAccount.get(scopedKey(account.directoryId, accountKey(account)));
  if (own) return shape(own, "account", globalDays);

  for (const dn of ancestorDns(account.ouPath)) {
    const ou = index.byOu.get(scopedKey(account.directoryId, dn));
    if (ou) return shape(ou, "ou", globalDays);
  }

  return null;
}

function side(enabled: boolean, days: string | null, fallback: number[]): SidePolicy {
  return {
    enabled,
    thresholds: parseDays(days, fallback),
    inherited: !days,
  };
}

function shape(row: PolicyRow, from: "account" | "ou", globalDays: GlobalDays): EffectivePolicy {
  return {
    from,
    fromTarget: row.target,
    enabled: row.enabled,
    password: side(row.notifyPassword, row.passwordDays, globalDays.password),
    account: side(row.notifyAccount, row.accountDays, globalDays.account),
    mutedUntil: row.mutedUntil ? new Date(row.mutedUntil) : null,
    recipients: (row.notifyRecipients || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
  };
}

/** True when the policy would alert on this side at all. */
export const sideActive = (policy: EffectivePolicy | null, which: AdSide): boolean =>
  !!policy && policy.enabled && policy[which].enabled;
