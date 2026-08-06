import { X509Certificate } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { services, directories as directoriesTable } from "@/db/schema";
import { getThresholds } from "@/lib/settings";
import { computeStatus, CertCheckError } from "@/lib/cert-checker";
import { getAdConfigById } from "./resolve";
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
   *  holds what a client needs to build a chain — normally the issuing CAs.
   *  "nt-auth" is the fallback source for a standalone (non-enterprise) CA: it
   *  never registers itself under Certification Authorities/AIA — an admin
   *  trusts it by hand via certutil -dspublish, which only ever lands it in
   *  NTAuthCertificates. */
  container: "certification-authorities" | "aia" | "nt-auth";
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

/** Extracts the CN from an X.509 subject string ("CN=foo,DC=bar" -> "foo") —
 *  NTAuthCertificates carries no per-cert AD object of its own to read a cn
 *  attribute from, so the certificate's own subject is the only name available. */
function cnFromSubject(subject: string | undefined): string {
  return subject?.match(/CN=([^,]+)/)?.[1]?.trim() || "CA";
}

/**
 * NTAuthCertificates is not a container of per-CA child objects like the two
 * above — it is a single object whose own (multi-valued) cACertificate
 * attribute lists every CA trusted for client authentication, standalone CAs
 * included. An enterprise CA publishes itself here too, alongside
 * Certification Authorities/AIA (caught by the fingerprint dedup below); a
 * standalone CA — added by hand via `certutil -dspublish -f ca.cer NTAuthCA`,
 * never through autoenrollment — exists ONLY here, which is exactly the case
 * discoverAdcsCertificates would otherwise miss entirely.
 */
async function discoverNtAuthCertificates(client: Client, configNC: string): Promise<AdcsCertificate[]> {
  const dn = `CN=NTAuthCertificates,CN=Public Key Services,CN=Services,${configNC}`;
  let entry;
  try {
    const { searchEntries } = await client.search(dn, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: [],
      explicitBufferAttributes: ["cACertificate"],
    });
    entry = searchEntries[0];
  } catch {
    return []; // No AD CS ever installed: this object does not exist either.
  }
  if (!entry) return [];

  const certs: AdcsCertificate[] = [];
  for (const buf of asBufferArray(entry.cACertificate)) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(buf);
    } catch {
      continue;
    }
    certs.push(toAdcsCertificate("nt-auth", cnFromSubject(cert.subject), dn, cert));
  }
  return certs;
}

/**
 * Walks CN=Certification Authorities and CN=AIA under the Configuration NC,
 * then falls back to CN=NTAuthCertificates for whatever those two missed, and
 * returns every CA certificate found. A CA published in more than one of
 * these (common for a root CA — Certification Authorities AND NTAuth) is
 * deduplicated by fingerprint, keeping the "Certification Authorities" copy:
 * that container is the authoritative trust list and gives each CA its own
 * AD object (a stable per-CA DN), where NTAuthCertificates only ever offers
 * one shared object for however many CAs it lists.
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

    for (const parsed of await discoverNtAuthCertificates(client, configNC)) {
      if (!seen.has(parsed.fingerprint256)) {
        seen.set(parsed.fingerprint256, parsed);
      }
    }

    return [...seen.values()];
  });
}

/**
 * Re-reads a single CA by identifier — the per-item "Sprawdź teraz" path, and
 * what a hand-added row (e.g. a CA in another forest) is checked against.
 *
 * A plain DN identifies exactly one cert everywhere except NTAuthCertificates,
 * which shares one AD object across however many CAs it lists — sync (above)
 * stores those as "dn#fingerprint256" so a refresh can pick out the one this
 * row actually represents, instead of "whichever happens to be on that object
 * now". A bare NTAuthCertificates DN with no "#" (a hand-added row predating
 * this, or someone pasting the container DN directly) falls back to the old
 * "soonest expiring on this object" behaviour — correct as long as it holds
 * only the one CA, same limitation manual entries already had.
 */
export async function probeAdcsCertificateByDn(config: AdConfig, identifier: string): Promise<AdcsCertificate> {
  const hashIdx = identifier.indexOf("#");
  const dn = hashIdx === -1 ? identifier : identifier.slice(0, hashIdx);
  const wantFingerprint = hashIdx === -1 ? null : identifier.slice(hashIdx + 1);

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
    const foundDn = first(entry.distinguishedName) ?? entry.dn ?? dn;

    if (wantFingerprint) {
      const match = buffers
        .map((buf) => {
          try {
            return new X509Certificate(buf);
          } catch {
            return null;
          }
        })
        .find((c) => c?.fingerprint256 === wantFingerprint);
      if (!match) {
        throw new CertCheckError(
          "Ten certyfikat CA zniknął z NTAuthCertificates w AD (odcisk już tam nie występuje).",
          "NO_CERT"
        );
      }
      return toAdcsCertificate("nt-auth", cnFromSubject(match.subject), foundDn, match);
    }

    const cert = pickCertificate(buffers);
    if (!cert) {
      throw new CertCheckError("Obiekt istnieje, ale nie ma atrybutu cACertificate.", "NO_CERT");
    }
    const cn = first(entry.cn) ?? "CA";
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
 *
 * Scoped to one directory: the lookup only ever compares against THIS
 * forest's previously-synced rows, so client A's sync never touches or
 * deletes client B's CA rows. Two different forests whose CA distinguishedName
 * happens to collide (same generic domain suffix, e.g. both "DC=corp,DC=local")
 * is a known, narrow edge case left unhandled — the second forest's insert
 * would hit services' (type, identifier, port) unique index and surface as a
 * per-directory sync error rather than corrupt either forest's data.
 */
export async function syncAdcsCertificates(directoryId: number): Promise<AdcsSyncResult> {
  const [directory] = await db
    .select()
    .from(directoriesTable)
    .where(eq(directoriesTable.id, directoryId))
    .limit(1);
  if (!directory || directory.type !== "ad") {
    throw new AdError(`Katalog ${directoryId} nie istnieje albo nie jest typu AD.`);
  }

  const config = await getAdConfigById(directoryId);
  if (!config) {
    throw new AdError(
      `Integracja z Active Directory „${directory.label}” nie jest skonfigurowana poprawnie.`
    );
  }

  const { expiringSoonDays } = await getThresholds();
  const now = new Date();
  const found = await discoverAdcsCertificates(config);

  const existing = await db
    .select()
    .from(services)
    .where(and(eq(services.type, "adcs"), eq(services.directoryId, directoryId)));
  const byDn = new Map(existing.map((row) => [row.identifier, row]));

  const seen = new Set<string>();
  const result: AdcsSyncResult = { created: 0, updated: 0, removed: 0, total: found.length };

  for (const cert of found) {
    // NTAuthCertificates shares one AD object across every CA it lists, so the
    // DN alone cannot tell two of them apart the way it can for a CA with its
    // own object under Certification Authorities/AIA — the fingerprint makes
    // the identifier unique per certificate. probeAdcsCertificateByDn (above)
    // is what parses this back apart on every "Sprawdź teraz".
    const identifier =
      cert.container === "nt-auth"
        ? `${cert.dn.trim().toLowerCase()}#${cert.fingerprint256}`
        : cert.dn.trim().toLowerCase();
    seen.add(identifier);

    const values = {
      type: "adcs" as const,
      name: cert.cn,
      identifier,
      directoryId,
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
