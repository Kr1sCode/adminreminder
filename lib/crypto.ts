import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Symmetric encryption for secrets kept in the settings table.
 *
 * The key comes from SETTINGS_KEY when present; otherwise it is derived from
 * JWT_SECRET, which a production deployment must already set to something long
 * and random. Rotating either one makes existing ciphertexts undecryptable —
 * the affected fields simply have to be re-entered.
 */

const PREFIX = "enc:v1";
const SALT = "ar-settings-v1";

function getKey(): Buffer {
  const material = process.env.SETTINGS_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error(
      "Brak klucza szyfrowania: ustaw SETTINGS_KEY albo JWT_SECRET, zanim zapiszesz sekret w ustawieniach."
    );
  }
  return scryptSync(material, SALT, 32);
}

export function encryptSecret(plaintext: string): string {
  if (plaintext === "") return "";

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

/**
 * Values written before encryption existed are stored as plaintext. Returning
 * them unchanged keeps an upgraded install working; they get encrypted the next
 * time the admin saves that field.
 */
export function decryptSecret(value: string): string {
  if (value === "") return "";
  if (!isEncrypted(value)) return value;

  // PREFIX itself contains a colon, so the payload starts at index 2.
  const parts = value.split(":");
  if (parts.length !== 5) {
    throw new Error("Uszkodzony format zaszyfrowanego sekretu w ustawieniach.");
  }
  const [, , ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Nie udało się odszyfrować sekretu z ustawień. Czy zmienił się SETTINGS_KEY lub JWT_SECRET? Wprowadź wartość ponownie."
    );
  }
}
