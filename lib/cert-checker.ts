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
} {
  if (!expiryDate) {
    return { status: "error", daysLeft: null };
  }

  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    return { status: "expired", daysLeft };
  }
  if (daysLeft <= expiringSoonDays) {
    return { status: "expiring", daysLeft };
  }
  return { status: "ok", daysLeft };
}

/**
 * Formats days left nicely in Polish.
 * Safe to use on client.
 */
export function formatDaysLeft(days: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `wygasł ${Math.abs(days)} dni temu`;
  if (days === 0) return "wygasa dzisiaj";
  if (days === 1) return "wygasa jutro";
  return `wygasa za ${days} dni`;
}

/**
 * Just the time part, for places where the surrounding label already says what
 * expires — a table column headed "Domena" does not need "domenę odnów za" in
 * every cell, and the long form overflows narrow columns.
 * Safe to use on client.
 */
export function formatDaysShort(days: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `${Math.abs(days)} dni temu`;
  if (days === 0) return "dzisiaj";
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
export function describeExpiry(type: string, days: number | null): string {
  if (days === null) return "—";

  if (type === "domain") {
    if (days < 0) return `domena nieopłacona od ${Math.abs(days)} dni`;
    if (days === 0) return "domenę odnów dzisiaj";
    if (days === 1) return "domenę odnów jutro";
    return `domenę odnów za ${days} dni`;
  }

  return formatDaysLeft(days);
}
