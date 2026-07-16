import { readFileSync } from "node:fs";

export interface AdConfig {
  url: string;
  /** ldaps:// or ldap:// upgraded via StartTLS. False only when explicitly allowed. */
  encrypted: boolean;
  startTls: boolean;
  rejectUnauthorized: boolean;
  caCertPath?: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  adminGroupDn?: string;
  viewerGroupDn?: string;
  timeoutMs: number;
}

export class AdConfigError extends Error {}

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|tak)$/i.test(value.trim());
};

/** Raw, unvalidated values as they arrive from the environment or the database. */
export interface AdSettingsInput {
  url?: string;
  startTls?: string;
  allowInsecure?: string;
  rejectUnauthorized?: string;
  caCertPath?: string;
  bindDn?: string;
  bindPassword?: string;
  baseDn?: string;
  adminGroupDn?: string;
  viewerGroupDn?: string;
  timeoutMs?: string;
}

/**
 * Validates raw settings into a usable config. Returns null when the integration
 * is not configured at all, and throws when it is configured but incoherent —
 * the difference matters, because a half-configured directory must fail loudly
 * rather than silently skip the sync.
 *
 * Pure: takes its input rather than reading the environment, so it is testable.
 */
export function buildAdConfig(input: AdSettingsInput): AdConfig | null {
  const url = input.url?.trim();
  const bindDn = input.bindDn?.trim();
  const bindPassword = input.bindPassword;
  const baseDn = input.baseDn?.trim();

  if (!url && !bindDn && !baseDn) return null;

  if (!url || !bindDn || !bindPassword || !baseDn) {
    throw new AdConfigError(
      "Niekompletna konfiguracja AD: wymagane są adres serwera, DN konta serwisowego, jego hasło oraz Base DN."
    );
  }

  const scheme = url.split(":")[0].toLowerCase();
  if (scheme !== "ldap" && scheme !== "ldaps") {
    throw new AdConfigError(`Adres serwera musi zaczynać się od ldap:// lub ldaps:// (otrzymano "${url}").`);
  }

  const isLdaps = scheme === "ldaps";
  const startTls = bool(input.startTls, false);
  const allowInsecure = bool(input.allowInsecure, false);
  const encrypted = isLdaps || startTls;

  // A simple bind over plaintext LDAP puts the bind password — and later every
  // user's password — on the wire in the clear. Allowed, but never by accident.
  if (!encrypted && !allowInsecure) {
    throw new AdConfigError(
      "Połączenie ldap:// bez szyfrowania wysyła hasła otwartym tekstem. " +
        "Włącz StartTLS, użyj ldaps://, albo świadomie dopuść to zaznaczając „Zezwól na nieszyfrowane połączenie”."
    );
  }

  if (isLdaps && startTls) {
    throw new AdConfigError("StartTLS nie ma zastosowania do ldaps:// — połączenie jest już szyfrowane.");
  }

  const caCertPath = input.caCertPath?.trim() || undefined;
  if (caCertPath) {
    try {
      readFileSync(caCertPath);
    } catch {
      throw new AdConfigError(`Nie mogę odczytać certyfikatu CA ze ścieżki: ${caCertPath}`);
    }
  }

  return {
    url,
    encrypted,
    startTls,
    rejectUnauthorized: bool(input.rejectUnauthorized, true),
    caCertPath,
    bindDn,
    bindPassword,
    baseDn,
    adminGroupDn: input.adminGroupDn?.trim() || undefined,
    viewerGroupDn: input.viewerGroupDn?.trim() || undefined,
    timeoutMs: Number(input.timeoutMs) || 15000,
  };
}

/** Warnings worth showing in the UI even when the connection works. */
export function adSecurityWarnings(config: AdConfig): string[] {
  const warnings: string[] = [];
  if (!config.encrypted) {
    warnings.push("Połączenie nie jest szyfrowane — hasła są przesyłane otwartym tekstem.");
  }
  if (config.encrypted && !config.rejectUnauthorized) {
    warnings.push(
      "Weryfikacja certyfikatu kontrolera domeny jest wyłączona (AD_TLS_REJECT_UNAUTHORIZED=false) — połączenie jest podatne na atak man-in-the-middle."
    );
  }
  return warnings;
}
