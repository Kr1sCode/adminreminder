import psl from "psl";
import type { ItemType } from "@/db/schema";
import { CertCheckError } from "../cert-checker";

/**
 * Deriving the registrable domain from a hostname needs the Public Suffix List:
 * "com.pl" is a public suffix while "dns.pl" is a registrable domain, and no
 * amount of label-counting tells them apart. Hence psl, and hence server-only.
 */

export interface Companion {
  type: ItemType;
  identifier: string;
  port: number;
  nameSuffix: string;
}

/** Throws when the host has no registrable domain (an IP, an intranet name). */
export function registrableDomainFor(host: string): string {
  const clean = host.trim().toLowerCase().replace(/\.$/, "");
  const parsed = psl.parse(clean);
  if (parsed.error || !parsed.domain) {
    throw new CertCheckError(
      `Nie udało się ustalić domeny rejestrowalnej dla „${clean}”.`,
      "NO_REGISTRABLE_DOMAIN"
    );
  }
  return parsed.domain;
}

export function companionFor(type: string, identifier: string): Companion | null {
  if (type !== "https_cert") return null;
  return {
    type: "domain",
    identifier: registrableDomainFor(identifier),
    port: 443,
    nameSuffix: "domena",
  };
}
