import { CertCheckError } from "../cert-checker";

/**
 * Domain registration expiry via RDAP (RFC 9083), the machine-readable successor
 * to WHOIS. The registry for each TLD is discovered through IANA's bootstrap
 * file rather than hardcoded, so every TLD that publishes an RDAP endpoint works
 * — .pl is served by rdap.dns.pl.
 *
 * Scraping dns.pl/whois would mean defeating a CAPTCHA, and port-43 WHOIS
 * returns free text whose layout differs per registry. RDAP returns JSON with a
 * typed "expiration" event, so there is nothing to parse by hand.
 *
 * Server-side only.
 */

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

// A single blip — the DC's resolver stalling, the registry dropping a
// connection under load — should not permanently mark a row red until someone
// clicks "check" again. One retry with a short pause turns most transient
// network faults into a slower success. Only the network-level throw is retried;
// a 404 or 429 is an answer, not a fault.
const NETWORK_RETRIES = 1;
const RETRY_DELAY_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * undici collapses every transport fault into the same `TypeError: fetch failed`
 * and hides the real reason in `.cause`. Unwrap it so the row records
 * "getaddrinfo EAI_AGAIN rdap.dns.pl" or "ETIMEDOUT" instead of a message that
 * says nothing. AbortSignal.timeout surfaces as a TimeoutError DOMException.
 */
function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "przekroczono limit czasu";
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      return code ? `${code} (${cause.message})` : cause.message;
    }
    if (cause) return String(cause);
    return err.message;
  }
  return String(err);
}

interface Bootstrap {
  services: [tlds: string[], urls: string[]][];
}

let bootstrapCache: { fetchedAt: number; services: Bootstrap["services"] } | null = null;

/** IANA publishes one entry per registry, listing every TLD it serves. */
async function loadBootstrap(timeoutMs: number): Promise<Bootstrap["services"]> {
  if (bootstrapCache && Date.now() - bootstrapCache.fetchedAt < BOOTSTRAP_TTL_MS) {
    return bootstrapCache.services;
  }

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(timeoutMs) });
      break;
    } catch (err) {
      if (attempt < NETWORK_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new CertCheckError(`Nie udało się pobrać listy rejestrów RDAP: ${describeFetchError(err)}`, "RDAP_BOOTSTRAP");
    }
  }
  if (!res.ok) {
    throw new CertCheckError(`Nie udało się pobrać listy rejestrów RDAP (HTTP ${res.status})`, "RDAP_BOOTSTRAP");
  }

  const data: Bootstrap = await res.json();
  bootstrapCache = { fetchedAt: Date.now(), services: data.services };
  return data.services;
}

/** Longest matching suffix wins, so "co.uk" beats "uk" when both are listed. */
async function resolveRdapBase(domain: string, timeoutMs: number): Promise<string> {
  const services = await loadBootstrap(timeoutMs);
  const labels = domain.split(".");

  let best: { length: number; url: string } | null = null;
  for (const [tlds, urls] of services) {
    for (const tld of tlds) {
      const suffix = `.${tld.toLowerCase()}`;
      if (`.${domain}`.endsWith(suffix) && tld.split(".").length < labels.length) {
        if (!best || tld.split(".").length > best.length) {
          best = { length: tld.split(".").length, url: urls[0] };
        }
      }
    }
  }

  if (!best) {
    const tld = labels[labels.length - 1];
    throw new CertCheckError(
      `Rejestr domeny .${tld} nie udostępnia RDAP — daty trzeba wpisać ręcznie.`,
      "RDAP_NO_REGISTRY"
    );
  }
  return best.url.replace(/\/$/, "");
}

interface RdapEvent {
  eventAction: string;
  eventDate: string;
}

export interface DomainInfo {
  expiryDate: Date;
  registrationDate?: Date;
  registrar?: string;
}

export async function getDomainExpiry(domain: string, timeoutMs: number = 10000): Promise<DomainInfo> {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!name.includes(".")) {
    throw new CertCheckError("Podaj pełną nazwę domeny, np. przyklad.pl", "RDAP_BAD_NAME");
  }

  const base = await resolveRdapBase(name, timeoutMs);

  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${base}/domain/${encodeURIComponent(name)}`, {
        headers: { Accept: "application/rdap+json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      break;
    } catch (err) {
      if (attempt < NETWORK_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw new CertCheckError(`Rejestr nie odpowiedział: ${describeFetchError(err)}`, "RDAP_UNREACHABLE");
    }
  }

  if (res.status === 404) {
    throw new CertCheckError("Rejestr nie zna tej domeny (404)", "RDAP_NOT_FOUND");
  }
  if (res.status === 429) {
    throw new CertCheckError("Rejestr ograniczył liczbę zapytań (429) — spróbuj później", "RDAP_RATE_LIMIT");
  }
  if (!res.ok) {
    throw new CertCheckError(`Rejestr zwrócił HTTP ${res.status}`, "RDAP_HTTP");
  }

  const data: { events?: RdapEvent[]; entities?: unknown[] } = await res.json();
  const expiration = data.events?.find((e) => e.eventAction === "expiration");

  if (!expiration) {
    // Some registries withhold the expiry date for privacy; that is a fact about
    // the registry, not a transient failure, so say so plainly.
    throw new CertCheckError("Rejestr nie ujawnia daty wygaśnięcia tej domeny", "RDAP_NO_EXPIRY");
  }

  const expiryDate = new Date(expiration.eventDate);
  if (Number.isNaN(expiryDate.getTime())) {
    throw new CertCheckError(`Nieczytelna data z rejestru: ${expiration.eventDate}`, "RDAP_BAD_DATE");
  }

  const registration = data.events?.find((e) => e.eventAction === "registration");
  return {
    expiryDate,
    registrationDate: registration ? new Date(registration.eventDate) : undefined,
  };
}
