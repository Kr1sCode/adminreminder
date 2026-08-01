import { jwtVerify, importSPKI } from "jose";
import { getSetting } from "./settings";

/**
 * Items tracked for free before a license key is required. Deliberately not
 * configurable at runtime — a value an operator could edit away would not be
 * a limit. Applies to every deployment (public "homelab" release included):
 * five items covers a real homelab; a paid key is what unlocks more.
 */
export const FREE_TIER_LIMIT = 5;

/**
 * Public half of the Ed25519 keypair that signs license keys. Safe to ship in
 * source — only the matching private key (kept by the vendor, never in this
 * repo) can mint a token this verifies. A license key an operator could forge
 * themselves by reading the app's code would not be a license.
 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEABq5ebAiTL3dTH4+BVThU1odbDwAk/F1ZUYGtv09QqfQ=
-----END PUBLIC KEY-----`;

export interface LicenseInfo {
  customer: string;
  maxItems: number;
  issuedAt: Date;
  expiresAt: Date;
}

export class LicenseError extends Error {}

/**
 * Verifies a license key's signature and expiry. Throws with an
 * operator-readable reason on anything invalid; never returns a partial or
 * unverified result.
 */
export async function verifyLicenseToken(token: string): Promise<LicenseInfo> {
  let key;
  try {
    key = await importSPKI(LICENSE_PUBLIC_KEY_PEM, "EdDSA");
  } catch {
    // Only reachable if LICENSE_PUBLIC_KEY_PEM itself is malformed — a build
    // problem, not something a token value could ever cause.
    throw new LicenseError("Blad wewnetrzny weryfikacji licencji.");
  }

  try {
    const { payload } = await jwtVerify(token.trim(), key);
    const customer = payload.sub;
    const maxItems = payload.maxItems;
    if (typeof customer !== "string" || typeof maxItems !== "number" || !payload.exp || !payload.iat) {
      throw new LicenseError("Klucz licencyjny ma nieprawidlowy format.");
    }
    return {
      customer,
      maxItems,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch (err: any) {
    if (err instanceof LicenseError) throw err;
    if (err?.code === "ERR_JWT_EXPIRED") {
      throw new LicenseError("Licencja wygasla.");
    }
    throw new LicenseError("Klucz licencyjny jest nieprawidlowy lub uszkodzony.");
  }
}

/**
 * The stored key, verified fresh on every call — no caching. A tampered or
 * expired key must stop counting as a license on the very next check, not
 * whenever some cache happens to expire.
 */
export async function getActiveLicense(): Promise<LicenseInfo | null> {
  const token = await getSetting("license_key");
  if (!token) return null;
  try {
    return await verifyLicenseToken(token);
  } catch {
    return null;
  }
}

export async function getItemLimit(): Promise<number> {
  const license = await getActiveLicense();
  return license ? license.maxItems : FREE_TIER_LIMIT;
}
