import { readFileSync } from "node:fs";
import { Client, type Entry } from "ldapts";
import type { AdConfig } from "./config";

export class AdError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AdError";
  }
}

/**
 * AD answers every failed bind with the same LDAP code 49, and hides the real
 * reason in a "data <hex>" sub-code inside the message. Without it, a disabled
 * account and a wrong password look identical, which sends people hunting for a
 * typo in a password that was never the problem.
 */
const BIND_REASONS: Record<string, string> = {
  "525": "konto o podanym DN nie istnieje w katalogu — sprawdź DN konta serwisowego",
  "52e": "kontroler odrzucił hasło — sprawdź hasło konta serwisowego",
  "530": "konto nie ma prawa logować się o tej porze",
  "531": "konto nie ma prawa logować się z tej stacji",
  "532": "hasło konta wygasło — ustaw nowe i włącz „Password never expires”",
  "533": "konto jest wyłączone w AD — włącz je (ADUC → konto → Enable Account)",
  "701": "konto wygasło (Account expires)",
  "773":
    "konto ma zaznaczone „User must change password at next logon” — odznacz to " +
    "(ADUC → konto → Account) i włącz „Password never expires”; konto serwisowe " +
    "nigdy nie zmieni hasła interaktywnie",
  "775": "konto jest zablokowane po nieudanych logowaniach (Account locked out)",
};

export function bindFailureMessage(err: unknown): string {
  const kod = String((err as Error)?.message ?? "").match(/data ([0-9a-f]{3})/i)?.[1]?.toLowerCase();
  const powod = kod ? BIND_REASONS[kod] : undefined;

  if (powod) {
    return `Nie udało się zalogować kontem serwisowym do AD: ${powod}. ` +
      `(kod AD ${kod}) Po poprawce użyj „Testuj połączenie” w Ustawieniach → Active Directory.`;
  }
  return (
    "Nie udało się zalogować kontem serwisowym do AD. Sprawdź DN i hasło konta w " +
    "Ustawieniach → Active Directory i użyj „Testuj połączenie”. " +
    "(Jeśli konfigurujesz przez środowisko: AD_BIND_DN i AD_BIND_PASSWORD.)"
  );
}

function tlsOptions(config: AdConfig) {
  return {
    rejectUnauthorized: config.rejectUnauthorized,
    ...(config.caCertPath ? { ca: readFileSync(config.caCertPath) } : {}),
  };
}

/** Opens a connection and upgrades it to TLS when configured to do so. */
async function connect(config: AdConfig): Promise<Client> {
  // ldapts opens the socket with TLS as soon as tlsOptions is present, whatever
  // the scheme says. Passing it on a plain ldap:// url sends a ClientHello to
  // port 389, which the directory resets. StartTLS gets its options separately
  // below, so the constructor may only see them for ldaps://.
  const client = new Client({
    url: config.url,
    timeout: config.timeoutMs,
    connectTimeout: config.timeoutMs,
    ...(config.url.toLowerCase().startsWith("ldaps:") ? { tlsOptions: tlsOptions(config) } : {}),
  });

  if (config.startTls) {
    try {
      await client.startTLS(tlsOptions(config));
    } catch (err) {
      await client.unbind().catch(() => {});
      throw new AdError(
        `Nie udało się nawiązać StartTLS z ${config.url}. Sprawdź certyfikat kontrolera domeny.`,
        err
      );
    }
  }

  return client;
}

/** Runs `fn` against a bound client and always unbinds, even on failure. */
export async function withServiceBind<T>(
  config: AdConfig,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = await connect(config);
  try {
    await client.bind(config.bindDn, config.bindPassword);
  } catch (err) {
    await client.unbind().catch(() => {});
    throw new AdError(bindFailureMessage(err), err);
  }

  try {
    return await fn(client);
  } finally {
    await client.unbind().catch(() => {});
  }
}

/**
 * Verifies a user's password by binding as that user. A successful bind is the
 * only trustworthy password check — never compare hashes read from the directory.
 *
 * An empty password makes most LDAP servers fall back to an *anonymous* bind,
 * which succeeds and would otherwise be read as "correct password". Callers must
 * not reach here with one, but we refuse it again as a last line of defence.
 */
export async function verifyUserPassword(
  config: AdConfig,
  userDn: string,
  password: string
): Promise<boolean> {
  if (!password) return false;

  const client = await connect(config);
  try {
    await client.bind(userDn, password);
    return true;
  } catch {
    return false;
  } finally {
    await client.unbind().catch(() => {});
  }
}

/** AD caps a search at 1000 entries unless the paged results control is used. */
export async function searchPaged(
  client: Client,
  baseDn: string,
  filter: string,
  attributes: string[],
  explicitBufferAttributes: string[] = []
): Promise<Entry[]> {
  const { searchEntries } = await client.search(baseDn, {
    scope: "sub",
    filter,
    attributes,
    explicitBufferAttributes,
    paged: { pageSize: 1000 },
  });
  return searchEntries;
}

type EntryValue = Entry[string];

/** LDAP attributes are multi-valued; collapse to the first string value. */
export function first(value: EntryValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
}

export function asArray(value: EntryValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v)));
}

export function firstBuffer(value: EntryValue | undefined): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return Buffer.isBuffer(raw) ? raw : undefined;
}

/**
 * All binary values of a multi-valued attribute. cACertificate is normally
 * single-valued, but holds two entries during an active CA key-rollover
 * window (old key + new key) — both need to be seen, not just the first.
 */
export function asBufferArray(value: EntryValue | undefined): Buffer[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is Buffer => Buffer.isBuffer(v));
}
