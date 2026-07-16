import type { AdAccountKind } from "@/db/schema";

export interface OuNode {
  /** Full DN of this container, e.g. "OU=Serwis,OU=IT,DC=corp,DC=local" */
  dn: string;
  /** Just the RDN value, e.g. "Serwis" */
  name: string;
  children: OuNode[];
  /** Accounts directly in this container. */
  accountCount: number;
  /** Accounts here and in every descendant. */
  totalAccountCount: number;
  /** Totals per classification, including descendants. */
  counts: Record<AdAccountKind, number>;
  expiringSoon: number;
  expired: number;
}

export interface TreeAccount {
  ouPath: string;
  kind: AdAccountKind;
  passwordExpiresAt: Date | null;
  accountExpiresAt: Date | null;
}

const emptyCounts = (): Record<AdAccountKind, number> => ({
  user: 0,
  technical: 0,
  functional: 0,
});

/** Splits a DN into its RDN components, honouring escaped commas. */
function splitDn(dn: string): string[] {
  return dn.match(/(?:[^,\\]|\\.)+/g) ?? [];
}

const rdnValue = (rdn: string) => rdn.slice(rdn.indexOf("=") + 1).trim();

/**
 * The soonest of the two dates decides how urgent an account is: a password
 * that expires next week matters even if the account itself never expires.
 */
function soonestExpiry(account: TreeAccount): Date | null {
  const dates = [account.passwordExpiresAt, account.accountExpiresAt].filter(
    (d): d is Date => d instanceof Date
  );
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a < b ? a : b));
}

/**
 * Builds the OU hierarchy from the accounts' DNs. Containers with no accounts
 * of their own still appear when a descendant has them, so the tree never has
 * a hole in the middle.
 */
export function buildOuTree(accounts: TreeAccount[], expiringSoonDays = 30): OuNode[] {
  const nodes = new Map<string, OuNode>();

  const ensureNode = (dn: string): OuNode => {
    const existing = nodes.get(dn);
    if (existing) return existing;

    const rdns = splitDn(dn);
    const node: OuNode = {
      dn,
      name: rdns.length > 0 ? rdnValue(rdns[0]) : dn,
      children: [],
      accountCount: 0,
      totalAccountCount: 0,
      counts: emptyCounts(),
      expiringSoon: 0,
      expired: 0,
    };
    nodes.set(dn, node);

    // Stop climbing once we reach the domain root (only DC= components left).
    const parentRdns = rdns.slice(1);
    if (parentRdns.length > 0 && !parentRdns.every((r) => /^dc=/i.test(r.trim()))) {
      const parent = ensureNode(parentRdns.join(","));
      parent.children.push(node);
    }
    return node;
  };

  const now = Date.now();
  const soonMs = expiringSoonDays * 24 * 60 * 60 * 1000;

  for (const account of accounts) {
    const node = ensureNode(account.ouPath);
    node.accountCount++;

    // Walk from this container up to the root, accumulating totals.
    let rdns = splitDn(account.ouPath);
    while (rdns.length > 0) {
      const dn = rdns.join(",");
      const ancestor = nodes.get(dn);
      if (ancestor) {
        ancestor.totalAccountCount++;
        ancestor.counts[account.kind]++;

        const expiry = soonestExpiry(account);
        if (expiry) {
          const delta = expiry.getTime() - now;
          if (delta < 0) ancestor.expired++;
          else if (delta <= soonMs) ancestor.expiringSoon++;
        }
      }
      if (rdns.every((r) => /^dc=/i.test(r.trim()))) break;
      rdns = rdns.slice(1);
    }
  }

  const sortRecursive = (node: OuNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, "pl"));
    node.children.forEach(sortRecursive);
  };

  const roots = [...nodes.values()].filter(
    (node) => !nodes.get(splitDn(node.dn).slice(1).join(","))
  );
  roots.forEach(sortRecursive);
  roots.sort((a, b) => a.name.localeCompare(b.name, "pl"));

  return roots;
}
