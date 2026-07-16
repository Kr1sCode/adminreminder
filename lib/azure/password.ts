import type { GraphDomain, GraphUser } from "./graph";

/**
 * Entra ID has no "password expires on" attribute; it must be derived from the
 * user's last password change plus the password validity of their domain.
 *
 * Microsoft's defaults and sentinels:
 *  - a domain with no explicit policy expires passwords after 90 days;
 *  - passwordValidityPeriodInDays of 2147483647 (Int32 max) means "never";
 *  - a user whose passwordPolicies contains "DisablePasswordExpiration" never
 *    expires, regardless of the domain policy.
 */
const DEFAULT_VALIDITY_DAYS = 90;
const NEVER_SENTINEL = 2147483647;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Maps each verified domain suffix to its validity in days, or null for "never". */
export function buildDomainPolicyMap(domains: GraphDomain[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const d of domains) {
    const days = d.passwordValidityPeriodInDays;
    const validity = days == null ? DEFAULT_VALIDITY_DAYS : days >= NEVER_SENTINEL ? null : days;
    map.set(d.id.toLowerCase(), validity);
  }
  return map;
}

function domainOf(userPrincipalName: string | null): string | null {
  if (!userPrincipalName) return null;
  const at = userPrincipalName.lastIndexOf("@");
  return at === -1 ? null : userPrincipalName.slice(at + 1).toLowerCase();
}

export interface EntraPasswordInfo {
  neverExpires: boolean;
  expiresAt: Date | null;
}

export function computeEntraPasswordExpiry(
  user: GraphUser,
  domainPolicy: Map<string, number | null>
): EntraPasswordInfo {
  const policies = (user.passwordPolicies ?? "").toLowerCase();
  if (policies.includes("disablepasswordexpiration")) {
    return { neverExpires: true, expiresAt: null };
  }

  const domain = domainOf(user.userPrincipalName);
  // Unknown domain (e.g. guest #EXT#) falls back to the Microsoft default.
  const validityDays = domain && domainPolicy.has(domain)
    ? domainPolicy.get(domain)!
    : DEFAULT_VALIDITY_DAYS;

  if (validityDays === null) return { neverExpires: true, expiresAt: null };

  if (!user.lastPasswordChangeDateTime) {
    return { neverExpires: false, expiresAt: null };
  }

  const changed = new Date(user.lastPasswordChangeDateTime);
  if (Number.isNaN(changed.getTime())) {
    return { neverExpires: false, expiresAt: null };
  }

  return { neverExpires: false, expiresAt: new Date(changed.getTime() + validityDays * DAY_MS) };
}
