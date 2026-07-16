import { db } from "@/lib/db";
import { services, type Service } from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { getCertificateExpiry, probeTlsEndpoint, normalizeFingerprint, EKU_SERVER_AUTH } from "./cert";
import { getDomainExpiry } from "./domain";
import { registrableDomainFor } from "./companion";
import { isAutoCheckable } from "./expiry";

export interface RefreshResult {
  certChecked: boolean;
  domainChecked: boolean;
  errors: string[];
}

/**
 * Brings one item up to date. A website carries two independent expiries — the
 * TLS certificate and the registration of the domain behind it — and each is
 * refreshed and recorded on its own, so a registry outage never overwrites what
 * we know about the certificate.
 */
export async function refreshService(item: Service): Promise<RefreshResult> {
  const { expiringSoonDays } = await getThresholds();
  const result: RefreshResult = { certChecked: false, domainChecked: false, errors: [] };
  const patch: Partial<typeof services.$inferInsert> = { updatedAt: new Date() };

  if (item.type === "tls_endpoint") {
    // A TLS service is judged on more than its expiry date: an expired, swapped
    // or self-signed cert on a live port is exactly what this type exists to
    // catch. Dates set the badge; unresolved defects add a red sub-line, and a
    // pinned-fingerprint mismatch — the "someone replaced the cert" signal —
    // overrides everything.
    try {
      const cd = item.customData || {};
      const probe = await probeTlsEndpoint(item.identifier, item.port, { sni: cd.sni });
      patch.expiryDate = probe.expiryDate;
      patch.lastCheckedAt = new Date();

      const pin = cd.pin ? normalizeFingerprint(cd.pin) : "";
      if (pin && pin !== normalizeFingerprint(probe.fingerprint256)) {
        patch.lastCheckStatus = "error";
        patch.lastCheckError =
          `Odcisk certyfikatu nie zgadza się z przypiętym — możliwa podmiana ` +
          `(oczekiwano ${cd.pin}, otrzymano ${probe.fingerprint256}).`;
      } else {
        const base = computeStatus(probe.expiryDate, expiringSoonDays).status;
        const advisories: string[] = [];
        if (probe.selfSigned) advisories.push("certyfikat samopodpisany");
        if (!probe.eku.includes(EKU_SERVER_AUTH)) advisories.push("brak EKU serverAuth");
        if (!probe.nameMatches) {
          advisories.push(
            `nazwa ${cd.sni?.trim() || item.identifier} nie występuje w certyfikacie ` +
              `(SAN: ${probe.sanNames.join(", ") || "brak"})`
          );
        }
        // A cert with valid dates but real defects must not read as a clean
        // green; amber says "attention" while the sub-line says why.
        patch.lastCheckStatus = advisories.length && base === "ok" ? "expiring" : base;
        patch.lastCheckError = advisories.length ? advisories.join("; ") : null;
      }
      result.certChecked = true;
    } catch (err: any) {
      patch.lastCheckedAt = new Date();
      patch.lastCheckStatus = "error";
      patch.lastCheckError = err.message || "Nie udało się sprawdzić punktu TLS";
      result.errors.push(patch.lastCheckError as string);
    }
  } else if (isAutoCheckable(item.type)) {
    try {
      const expiryDate =
        item.type === "domain"
          ? (await getDomainExpiry(item.identifier)).expiryDate
          : (await getCertificateExpiry(item.identifier, item.port)).expiryDate;

      patch.expiryDate = expiryDate;
      patch.lastCheckedAt = new Date();
      patch.lastCheckStatus = computeStatus(expiryDate, expiringSoonDays).status;
      patch.lastCheckError = null;
      result.certChecked = true;
    } catch (err: any) {
      patch.lastCheckedAt = new Date();
      patch.lastCheckStatus = "error";
      patch.lastCheckError = err.message || "Nie udało się sprawdzić pozycji";
      result.errors.push(patch.lastCheckError as string);
    }
  }

  // domainName is derived from the identifier, never chosen by hand, so a
  // mismatch means the identifier was edited while the derived value went stale.
  // Correcting it here heals rows written before PATCH learned to repoint them.
  let domainName = item.domainName;
  if (domainName) {
    try {
      const expected = registrableDomainFor(item.identifier);
      if (expected !== domainName) {
        domainName = expected;
        patch.domainName = expected;
        patch.domainExpiryDate = null;
      }
    } catch {
      // An identifier with no registrable domain keeps whatever it had; the
      // lookup below will report the failure on the row.
    }
  }

  if (domainName) {
    try {
      const { expiryDate } = await getDomainExpiry(domainName);
      patch.domainExpiryDate = expiryDate;
      patch.domainLastCheckedAt = new Date();
      patch.domainLastCheckStatus = computeStatus(expiryDate, expiringSoonDays).status;
      patch.domainLastCheckError = null;
      result.domainChecked = true;
    } catch (err: any) {
      patch.domainLastCheckedAt = new Date();
      patch.domainLastCheckStatus = "error";
      patch.domainLastCheckError = err.message || "Nie udało się sprawdzić domeny";
      result.errors.push(patch.domainLastCheckError as string);
    }
  }

  await db.update(services).set(patch).where(eq(services.id, item.id));
  return result;
}
