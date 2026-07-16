import { db } from "@/lib/db";
import { services } from "@/db/schema";
import type { ItemType } from "@/db/schema";
import { eq } from "drizzle-orm";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { companionFor } from "./companion";
import { refreshService } from "./refresh";

export interface NewServiceInput {
  type: ItemType;
  name: string;
  identifier: string;
  port?: number;
  owner?: string | null;
  notes?: string | null;
  renewalUrl?: string | null;
  expiryDate?: Date | null;
  /** Free-form per-type config; for tls_endpoint: role, sni, pin. */
  customData?: Record<string, string> | null;
  /** Also watch the registration of the domain behind this host. */
  trackDomain?: boolean;
}

/**
 * Keeps only string values, trims them and drops the empties, so a form that
 * sends `{ role: "", sni: "", pin: "" }` stores `{}` rather than blank keys.
 * Anything that is not a flat string map collapses to `{}`.
 */
export function sanitizeCustomData(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/**
 * Inserts one tracked item and fills in whatever expiry it can discover.
 *
 * A website is a single row: the certificate lives in expiryDate, the domain
 * registration in the domain_* columns. Asking for domain tracking on a plain
 * `domain` item therefore promotes it to an https_cert row — the two dates
 * belong to one thing, and the operator sees one line for it.
 */
export async function createService(input: NewServiceInput) {
  const { expiringSoonDays } = await getThresholds();
  const identifier = input.identifier.trim().toLowerCase();
  const port = Number(input.port) || 443;
  const manualExpiry = input.expiryDate ?? null;

  let type = input.type;
  let domainName: string | null = null;

  if (input.trackDomain) {
    const companion = companionFor(type === "domain" ? "https_cert" : type, identifier);
    if (companion) {
      domainName = companion.type === "domain" ? companion.identifier : identifier;
      type = "https_cert";
    }
  }

  const [row] = await db
    .insert(services)
    .values({
      type,
      name: input.name.trim(),
      identifier,
      port,
      owner: input.owner?.trim() || null,
      notes: input.notes?.trim() || null,
      renewalUrl: input.renewalUrl?.trim() || null,
      expiryDate: manualExpiry,
      lastCheckStatus: manualExpiry ? computeStatus(manualExpiry, expiringSoonDays).status : null,
      customData: input.customData ?? {},
      domainName,
    })
    .returning();

  // Failures land on the row rather than throwing: the item exists, and the
  // operator needs to see why a side could not be checked.
  await refreshService(row);

  const [fresh] = await db.select().from(services).where(eq(services.id, row.id)).limit(1);
  return fresh ?? row;
}

export function isDuplicateError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}
