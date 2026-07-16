import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP, implemented on node:crypto so two-factor needs no third-party
 * dependency. Compatible with Google Authenticator, Aegis, 1Password, etc.:
 * SHA-1, 6 digits, 30-second period — the defaults every authenticator assumes.
 */

const PERIOD = 30;
const DIGITS = 6;
const ALGORITHM = "SHA1";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — the encoding authenticator apps expect. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 20-byte (160-bit) secret, base32-encoded for the authenticator. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // JS bitwise ops are 32-bit; write the counter as two 32-bit halves.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac(ALGORITHM, key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/**
 * Verifies a code against the secret, allowing ±`window` steps so a slightly
 * slow reader or a clock a few seconds off still succeeds. Constant-time
 * comparison keeps the check from leaking how close a guess was.
 */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const cleaned = (token || "").replace(/\D/g, "");
  if (cleaned.length !== DIGITS) return false;

  const counter = Math.floor(Date.now() / 1000 / PERIOD);
  for (let error = -window; error <= window; error++) {
    const expected = hotp(secret, counter + error);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * The otpauth:// URI encoded into the enrolment QR. `label` identifies the
 * account (shown in the app), `issuer` names the service.
 */
export function otpauthUri(secret: string, label: string, issuer = "Admin Redminer"): string {
  const enc = encodeURIComponent;
  const account = `${issuer}:${label}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: ALGORITHM,
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${enc(account)}?${params.toString()}`;
}
