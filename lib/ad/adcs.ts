import { X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { services } from "@/db/schema";
import { getThresholds } from "@/lib/settings";
import { computeStatus, CertCheckError } from "@/lib/cert-checker";
import { getAdConfig } from "./resolve";
import { AdError, withServiceBind, searchPaged, first, asBufferArray } from "./client";
import type { AdConfig } from "./config";
import type { Client } from "ldapts";

/**
 * Autoenrollment keeps a DC's own (leaf) certificate fresh, but nobody rotates
 * the Root CA or the Issuing CA it descends from — those are typically set to
 * expire five or twenty years out and then forgotten. lib/server/cert.ts only
 * ever reads the leaf a TLS server presents; this file is the other half:
 * reading the CA certificates directly out of Active Directory, which is the
 * only place a Root CA's own validity is recorded (a TLS handshake practically
 * never sends the root, so probing a live endpoint could never see it).
 */

export interface AdcsCertificate {
  /** "Certification Authorities" holds the trusted (usually root) CAs; "AIA"
   *  holds what a client needs to build a chain — normally the issuing CAs. */
  container: "certification-authorities" | "aia";
  cn: string;
  dn: string;
  subject?: string;
  issuer?: string;
  /** subject === issuer, i.e. this CA vouches for itself — a root, not an issuing CA. */
  selfSigned: boolean;
  expiryDate: Date;
  validFrom?: Date;
  serial: string;
  fingerprint256: string;
}

const CONTAINERS: { key: AdcsCertificate["container"]; rdn: string }[] = [
  { key: "certification-authorities", rdn: "CN=Certification Authorities" },
  { key: "aia", rdn: "CN=AIA" },
];

/** Root DSE carries the forest's Configuration NC — reading it beats guessing
 *  the container's DN from AD_BASE_DN, which may point at an OU, not the domain. */
async function getConfigurationNamingContext(client: Client): Promise<string> {
  const { searchEntries } = await client.search("", {
    scope: "base",
    filter: "(objectClass=*)",
    attributes: ["configurationNamingContext"],
  });
  const ncDn = first(searchEntries[0]?.configurationNamingContext);
  if (!ncDn) {
    throw new AdError("Nie udało się odczytać configurationNamingContext z rootDSE.");
  }
  return ncDn;
}

/** During key rollover a CA object briefly carries two certificates; the one
 *  expiring soonest is the one a monitoring tool must not miss. */
function pickCertificate(buffers: Buffer[]): X509Certificate | null {
  const parsed = buffers
    .map((buf) => {
      try {
        return new X509Certificate(buf);
      } catch {
        return null;
      }
    })
    .filter((x): x is X509Certificate => x !== null);
  if (parsed.length === 0) return null;
  return parsed.reduce((soonest, x) =>
    new Date(x.validTo).getTime() < new Date(soonest.validTo).getTime() ? x : soonest
  );
}

function toAdcsCertificate(
  container: AdcsCertificate["container"],
  cn: string,
  dn: string,
  cert: X509Certificate
): AdcsCertificate {
  return {
    container,
    cn,
    dn,
    subject: cert.subject,
    issuer: cert.issuer,
    selfSigned: cert.subject === cert.issuer,
    expiryDate: new Date(cert.validTo),
    validFrom: cert.validFrom ? new Date(cert.validFrom) : undefined,
    serial: cert.serialNumber,
    fingerprint256: cert.fingerprint256,
  };
}

function roleLabel(cert: AdcsCertificate): string {
  return cert.selfSigned ? "Root CA" : "CA pośredni (Issuing)";
}

/**
 * Walks CN=Certification Authorities and CN=AIA under the Configuration NC and
 * returns every CA certificate found. A CA published in both containers (common
 * for a root CA) is deduplicated by fingerprint, keeping the
 * "Certification Authorities" copy — that container is the authoritative
 * trust list, AIA is just where clients fetch certs for chain-building.
 */
export async function discoverAdcsCertificates(config: AdConfig): Promise<AdcsCertificate[]> {
  return withServiceBind(config, async (client) => {
    const configNC = await getConfigurationNamingContext(client);
    const seen = new Map<string, AdcsCertificate>();

    for (const { key, rdn } of CONTAINERS) {
      const containerDn = `${rdn},CN=Public Key Services,CN=Services,${configNC}`;
      let entries;
      try {
        entries = await searchPaged(
          client,
          containerDn,
          "(objectClass=certificationAuthority)",
          ["cn", "distinguishedName"],
          ["cACertificate"]
        );
      } catch {
        // No AD CS ever installed means these containers do not exist at all —
        // that is an expected, silent zero, not a failure.
        continue;
      }

      for (const entry of entries) {
        const buffers = asBufferArray(entry.cACertificate);
        if (buffers.length === 0) continue;
        const cert = pickCertificate(buffers);
        if (!cert) continue;

        const cn = first(entry.cn) ?? "CA";
        const dn = first(entry.distinguishedName) ?? entry.dn;
        const parsed = toAdcsCertificate(key, cn, dn, cert);

        if (!seen.has(parsed.fingerprint256)) {
          seen.set(parsed.fingerprint256, parsed);
        }
      }
    }

    return [...seen.values()];
  });
}

/** Re-reads a single CA object by DN — the per-item "Sprawdź teraz" path, and
 *  what a hand-added row (e.g. a CA in another forest) is checked against. */
export async function probeAdcsCertificateByDn(config: AdConfig, dn: string): Promise<AdcsCertificate> {
  return withServiceBind(config, async (client) => {
    const { searchEntries } = await client.search(dn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: ["cn", "distinguishedName"],
      explicitBufferAttributes: ["cACertificate"],
    });
    const entry = searchEntries[0];
    if (!entry) {
      throw new CertCheckError(`Obiekt CA nie istnieje pod DN: ${dn}`, "NO_CERT");
    }

    const buffers = asBufferArray(entry.cACertificate);
    const cert = pickCertificate(buffers);
    if (!cert) {
      throw new CertCheckError("Obiekt istnieje, ale nie ma atrybutu cACertificate.", "NO_CERT");
    }

    const cn = first(entry.cn) ?? "CA";
    const foundDn = first(entry.distinguishedName) ?? entry.dn ?? dn;
    // The container is unknown when probing by bare DN; role is still derivable.
    return toAdcsCertificate("certification-authorities", cn, foundDn, cert);
  });
}

export interface AdcsSyncResult {
  created: number;
  updated: number;
  removed: number;
  total: number;
}

/**
 * Mirrors syncAdAccounts's shape: discover what AD actually has, upsert it
 * into `services` as type "adcs", and drop rows this sync created that no
 * longer exist. A hand-added row (customData.managed !== "sync") is never
 * touched by the removal pass — it might point at a CA in another forest that
 * this discovery pass cannot see at all.
 */
export async function syncAdcsCertificates(): Promise<AdcsSyncResult> {
  const config = await getAdConfig();
  if (!config) {
    throw new AdError(
      "Integracja z Active Directory nie jest skonfigurowana. Uzupełnij dane w Ustawieniach → Active Directory."
    );
  }

  const { expiringSoonDays } = await getThresholds();
  const now = new Date();
  const found = await discoverAdcsCertificates(config);

  const existing = await db.select().from(services).where(eq(services.type, "adcs"));
  const byDn = new Map(existing.map((row) => [row.identifier, row]));

  const seen = new Set<string>();
  const result: AdcsSyncResult = { created: 0, updated: 0, removed: 0, total: found.length };

  for (const cert of found) {
    const identifier = cert.dn.trim().toLowerCase();
    seen.add(identifier);

    const values = {
      type: "adcs" as const,
      name: cert.cn,
      identifier,
      customData: {
        role: roleLabel(cert),
        container: cert.container,
        managed: "sync",
      },
      expiryDate: cert.expiryDate,
      lastCheckedAt: now,
      lastCheckStatus: computeStatus(cert.expiryDate, expiringSoonDays).status,
      lastCheckError: null,
      updatedAt: now,
    };

    const row = byDn.get(identifier);
    if (row) {
      await db.update(services).set(values).where(eq(services.id, row.id));
      result.updated++;
    } else {
      await db.insert(services).values({ ...values, owner: null, notes: null });
      result.created++;
    }
  }

  for (const [identifier, row] of byDn) {
    if (!seen.has(identifier) && row.customData?.managed === "sync") {
      await db.delete(services).where(eq(services.id, row.id));
      result.removed++;
    }
  }

  return result;
}
