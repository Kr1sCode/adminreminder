/**
 * Conversions for the Active Directory attribute formats that bite people.
 * Pure functions, no LDAP client involved — unit-testable in isolation.
 */

/** userAccountControl bit flags (the ones we actually act on). */
export const UAC = {
  ACCOUNTDISABLE: 0x0002,
  LOCKOUT: 0x0010,
  PASSWD_NOTREQD: 0x0020,
  NORMAL_ACCOUNT: 0x0200,
  DONT_EXPIRE_PASSWORD: 0x10000,
  SMARTCARD_REQUIRED: 0x40000,
  TRUSTED_FOR_DELEGATION: 0x80000,
  DONT_REQ_PREAUTH: 0x400000,
} as const;

export const hasFlag = (uac: number, flag: number): boolean => (uac & flag) !== 0;

export const isDisabled = (uac: number) => hasFlag(uac, UAC.ACCOUNTDISABLE);
export const passwordNeverExpires = (uac: number) => hasFlag(uac, UAC.DONT_EXPIRE_PASSWORD);

/** Windows FILETIME epoch (1601-01-01) offset from the Unix epoch, in milliseconds. */
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;

/** Both of these mean "never" in AD, depending on the attribute. */
const NEVER_MAX = 9223372036854775807n; // 0x7FFFFFFFFFFFFFFF
const NEVER_ZERO = 0n;

/**
 * Converts a FILETIME string (100-nanosecond intervals since 1601) to a Date.
 * Returns null for the two sentinel values AD uses to mean "never expires",
 * which is why `accountExpires` of 0 must not be read as 1601-01-01.
 */
export function filetimeToDate(value: string | number | undefined | null): Date | null {
  if (value === undefined || value === null || value === "") return null;

  let ticks: bigint;
  try {
    ticks = BigInt(value);
  } catch {
    return null;
  }

  if (ticks === NEVER_ZERO || ticks >= NEVER_MAX) return null;

  const ms = ticks / 10000n - FILETIME_EPOCH_OFFSET_MS;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * objectGUID arrives as a 16-byte buffer whose first three groups are
 * little-endian, so a naive hex dump produces a GUID that matches nothing
 * in Active Directory Users and Computers.
 */
export function formatObjectGuid(buffer: Buffer | Uint8Array): string {
  const b = Buffer.from(buffer);
  if (b.length !== 16) throw new Error(`objectGUID ma ${b.length} bajtów, oczekiwano 16`);

  const hex = (start: number, end: number, reverse: boolean) => {
    const slice = b.subarray(start, end);
    const bytes = reverse ? Buffer.from(slice).reverse() : slice;
    return bytes.toString("hex");
  };

  return [
    hex(0, 4, true),
    hex(4, 6, true),
    hex(6, 8, true),
    hex(8, 10, false),
    hex(10, 16, false),
  ].join("-");
}

/** Strips the leftmost RDN, yielding the container the object lives in. */
export function parentDn(distinguishedName: string): string {
  // Respect escaped commas (\,) inside an RDN value.
  const parts = distinguishedName.match(/(?:[^,\\]|\\.)+/g) ?? [];
  return parts.slice(1).join(",");
}

/** Escapes a value for safe interpolation into an LDAP filter (RFC 4515). */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0/]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
    return `\\${hex}`;
  });
}

/** Escapes a DN for use inside a filter value, e.g. a memberOf comparison. */
export const escapeDnForFilter = escapeFilterValue;
