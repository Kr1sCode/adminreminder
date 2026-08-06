export interface CertInfo {
  expiryDate: Date;
  validFrom?: Date;
  subject?: string;
  issuer?: string;
}

export class CertCheckError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "CertCheckError";
  }
}

/**
 * Computes a human-friendly status from an expiry date.
 * Safe to use on client and server.
 * 
 * @param expiringSoonDays - number of days before expiry to consider "expiring" (default 30)
 */
export function computeStatus(
  expiryDate: Date | null | undefined,
  expiringSoonDays: number = 30
): {
  status: "ok" | "expiring" | "expired" | "error";
  daysLeft: number | null;
  /** Only meaningful (0-23) when daysLeft is 0 — less than a day remains but
   *  it hasn't expired yet. A whole-day count alone reads as "today" for
   *  anything from 1 minute to 23h59m left, which is both imprecise and, by
   *  rounding up, off by a day from any external tool that floors instead
   *  (a cert with 57 days and a few hours left is "57 days" everywhere else,
   *  not 58) — flooring here fixes that, and hoursLeft recovers the
   *  precision floor would otherwise throw away for the final day. */
  hoursLeft: number | null;
} {
  if (!expiryDate) {
    return { status: "error", daysLeft: null, hoursLeft: null };
  }

  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  const daysLeft = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hoursLeft = daysLeft === 0 ? Math.max(0, Math.floor(diffMs / (1000 * 60 * 60))) : null;

  if (daysLeft < 0) {
    return { status: "expired", daysLeft, hoursLeft: null };
  }
  if (daysLeft <= expiringSoonDays) {
    return { status: "expiring", daysLeft, hoursLeft };
  }
  return { status: "ok", daysLeft, hoursLeft };
}

/** "0 dni" covers anywhere from 1 minute to 23h59m left — under an hour's
 *  column that reads as "dzisiaj" no matter how urgent it actually is.
 *  hoursLeft (from computeStatus, only set when days===0) recovers that. */
function hoursPhrase(hoursLeft: number | null | undefined): string | null {
  if (hoursLeft == null) return null;
  if (hoursLeft <= 0) return "za mniej niż godzinę";
  if (hoursLeft === 1) return "za 1 godzinę";
  if (hoursLeft >= 2 && hoursLeft <= 4) return `za ${hoursLeft} godziny`;
  return `za ${hoursLeft} godzin`;
}

/**
 * Formats days left nicely in Polish.
 * Safe to use on client.
 */
export function formatDaysLeft(days: number | null, hoursLeft?: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `wygasł ${Math.abs(days)} dni temu`;
  if (days === 0) {
    const hours = hoursPhrase(hoursLeft);
    return hours ? `wygasa ${hours}` : "wygasa dzisiaj";
  }
  if (days === 1) return "wygasa jutro";
  return `wygasa za ${days} dni`;
}

/**
 * Just the time part, for places where the surrounding label already says what
 * expires — a table column headed "Domena" does not need "domenę odnów za" in
 * every cell, and the long form overflows narrow columns.
 * Safe to use on client.
 */
export function formatDaysShort(days: number | null, hoursLeft?: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `${Math.abs(days)} dni temu`;
  if (days === 0) {
    const hours = hoursPhrase(hoursLeft);
    return hours ?? "dzisiaj";
  }
  // Under a column headed "Ile dni pozostało" the answer is a count, not a
  // calendar word: "jutro" forces the reader to convert it back to a number.
  if (days === 1) return "za 1 dzień";
  return `za ${days} dni`;
}

/**
 * A domain does not "expire", it stops being paid for — and the remedy is a
 * renewal at the registrar, not a reissue. Saying the same sentence about both
 * hides that difference, so the wording follows the item type.
 * Safe to use on client.
 */
export function describeExpiry(type: string, days: number | null, hoursLeft?: number | null): string {
  if (days === null) return "—";

  if (type === "domain") {
    if (days < 0) return `domena nieopłacona od ${Math.abs(days)} dni`;
    if (days === 0) {
      const hours = hoursPhrase(hoursLeft);
      return hours ? `domenę odnów ${hours}` : "domenę odnów dzisiaj";
    }
    if (days === 1) return "domenę odnów jutro";
    return `domenę odnów za ${days} dni`;
  }

  return formatDaysLeft(days, hoursLeft);
}
