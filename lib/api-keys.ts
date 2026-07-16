import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { apiKeys, type ApiKey, type ApiScope } from "@/db/schema";
import { eq } from "drizzle-orm";

const TOKEN_PREFIX = "ar_";
const PREFIX_DISPLAY_LEN = TOKEN_PREFIX.length + 6;

/** Deterministic lookup hash. The token has full entropy, so a plain SHA-256
 *  (no salt) is appropriate here and lets us index by it. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedApiKey {
  record: ApiKey;
  /** Full token — returned once, never stored, never retrievable again. */
  token: string;
}

export async function createApiKey(
  name: string,
  scopes: ApiScope[],
  createdBy: string
): Promise<CreatedApiKey> {
  const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const [record] = await db
    .insert(apiKeys)
    .values({
      name: name.trim() || "Klucz API",
      keyHash: hashToken(token),
      prefix: token.slice(0, PREFIX_DISPLAY_LEN),
      scopes: scopes.length ? scopes : ["read"],
      createdBy,
    })
    .returning();
  return { record, token };
}

export interface VerifiedKey {
  id: number;
  name: string;
  scopes: ApiScope[];
}

/**
 * Resolves a bearer token to a key record. Constant-time compare against the
 * stored hash, updates last-used, and rejects revoked keys.
 */
export async function verifyApiKey(token: string | undefined): Promise<VerifiedKey | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const hash = hashToken(token);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  if (!row || row.revoked) return null;

  // The DB lookup already matched on the hash; this guards against any future
  // change that widens the query, and keeps the comparison explicit.
  const a = Buffer.from(hash);
  const b = Buffer.from(row.keyHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return { id: row.id, name: row.name, scopes: row.scopes };
}

/** Extracts a bearer token from an Authorization header. */
export function bearerToken(headers: Headers): string | undefined {
  const auth = headers.get("authorization");
  if (!auth) return undefined;
  const [scheme, value] = auth.split(" ");
  return scheme?.toLowerCase() === "bearer" ? value : undefined;
}

export async function listApiKeys(): Promise<Omit<ApiKey, "keyHash">[]> {
  const rows = await db.select().from(apiKeys).orderBy(apiKeys.createdAt);
  return rows.map(({ keyHash: _keyHash, ...rest }) => rest);
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const result = await db.update(apiKeys).set({ revoked: true }).where(eq(apiKeys.id, id));
  return result.changes > 0;
}

export async function deleteApiKey(id: number): Promise<boolean> {
  const result = await db.delete(apiKeys).where(eq(apiKeys.id, id));
  return result.changes > 0;
}
