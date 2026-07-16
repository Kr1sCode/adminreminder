/**
 * Decides whether an expiry deserves an alert right now.
 *
 * The old rule was `days.some(d => daysLeft <= d)`, which is true for every day
 * below the highest threshold — thresholds 3,7,21 meant "mail every day from day
 * 21", throttled only by a 20-hour dedup. Here a threshold fires exactly once,
 * and the fact that it fired is recorded per side of the item.
 *
 * Pure: no database, no clock beyond what is passed in. Safe to unit test.
 */

/** An item's certificate or the domain behind it; an account's password or the
 *  account itself. One item may expire on several sides, each alerted apart. */
export type SideKey = "cert" | "domain" | "password" | "account";

export interface SideDecision {
  /** Send an alert for this side now. */
  notify: boolean;
  /** Why, for the caller's dedup rules and for the log. */
  reason: "threshold" | "critical" | null;
  /** Thresholds recorded as fired after this decision, for the whole item. */
  fired: string[];
}

export function parseDays(csv: string | null | undefined, fallback: number[]): number[] {
  if (!csv) return fallback;
  const parsed = csv
    .split(",")
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d) && d > 0);
  return parsed.length > 0 ? parsed : fallback;
}

const mark = (side: SideKey, day: number) => `${side}:${day}`;

export function decideSide(params: {
  side: SideKey;
  daysLeft: number | null;
  status: string;
  thresholds: number[];
  fired: string[];
}): SideDecision {
  const { side, daysLeft, status, thresholds, fired } = params;

  if (status === "error" || daysLeft === null || thresholds.length === 0) {
    return { notify: false, reason: null, fired };
  }

  const others = fired.filter((f) => !f.startsWith(`${side}:`));
  const mine = fired.filter((f) => f.startsWith(`${side}:`));
  const highest = Math.max(...thresholds);

  // Renewed: the date jumped back beyond every threshold, so the next approach
  // must alert again. Without this, a renewed certificate would stay silent.
  if (daysLeft > highest) {
    return { notify: false, reason: null, fired: others };
  }

  // Expires today, or already has. Not a threshold but a standing fault: it
  // keeps reminding until fixed. The caller throttles it (20-hour dedup).
  // Day zero belongs here — every threshold has already fired by then, so a
  // threshold rule would let the last day pass in silence.
  if (daysLeft <= 0) {
    return { notify: true, reason: "critical", fired };
  }

  // Every threshold the item has reached. Catches up after a missed cron run:
  // at daysLeft=5 with thresholds 3,7,21 the "7" alert still goes out.
  const crossed = thresholds.filter((t) => daysLeft <= t);
  const pending = crossed.filter((t) => !mine.includes(mark(side, t)));

  if (pending.length === 0) {
    return { notify: false, reason: null, fired };
  }

  const nextFired = [...others, ...crossed.map((t) => mark(side, t))];
  return { notify: true, reason: "threshold", fired: [...new Set(nextFired)] };
}
