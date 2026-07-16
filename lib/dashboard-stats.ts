/**
 * Dashboard header counters, computed per item (row) — not per expiry date.
 *
 * An item can track two expiries (a certificate and a domain registration). The
 * counters used to sum both sides, so a page with a valid cert and a valid
 * domain counted as 2 — the header total then didn't match the number of rows.
 * Here each item folds down to a single, most-urgent status so the total equals
 * the row count and the buckets add up to it.
 */
export type ItemStatus = "ok" | "expiring" | "expired" | "error";

// Most urgent first: an expired side outranks an expiring one, etc.
const RANK: Record<ItemStatus, number> = { expired: 3, expiring: 2, error: 1, ok: 0 };

/** The more urgent of an item's certificate and domain statuses. */
export function itemStatus(cert: ItemStatus, domain?: ItemStatus | null): ItemStatus {
  if (!domain) return cert;
  return RANK[domain] > RANK[cert] ? domain : cert;
}

export function computeStats(
  items: { computedStatus: ItemStatus; domainStatus?: ItemStatus | null }[],
) {
  const folded = items.map((i) => itemStatus(i.computedStatus, i.domainStatus));
  return {
    total: items.length,
    expired: folded.filter((s) => s === "expired").length,
    expiring: folded.filter((s) => s === "expiring").length,
    valid: folded.filter((s) => s === "ok").length,
  };
}
