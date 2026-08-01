import type { ItemType } from "@/db/schema";
import { getCertificateExpiry } from "./cert";
import { getDomainExpiry } from "./domain";

/**
 * Item types whose expiry AR can discover on its own. Everything else carries a
 * date the operator typed in. Kept here so the three call sites that check items
 * (POST /api/services, POST /api/services/[id]/check, runChecks) agree on what
 * is checkable and how.
 *
 * Server-side only: pulls in tls and RDAP.
 */
export const AUTO_CHECKABLE_TYPES = ["https_cert", "tls_endpoint", "adcs", "domain"] as const;

export function isAutoCheckable(type: string): boolean {
  return (AUTO_CHECKABLE_TYPES as readonly string[]).includes(type);
}

/** Throws CertCheckError with an operator-readable message on every failure. */
export async function fetchExpiryDate(
  type: ItemType,
  identifier: string,
  port: number
): Promise<Date> {
  if (type === "domain") {
    return (await getDomainExpiry(identifier)).expiryDate;
  }
  // tls_endpoint shares the certificate path here; refreshService applies the
  // richer endpoint validation (SNI, chain, EKU, pin) when it stores the row.
  return (await getCertificateExpiry(identifier, port)).expiryDate;
}
