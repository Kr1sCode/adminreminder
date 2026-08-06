import { db } from "@/lib/db";
import { directories, type Directory, type DirectorySource } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { MASK_CHAR, isMasked } from "@/lib/settings";
import { buildAdConfig, AdConfigError } from "@/lib/ad/config";

/**
 * Shared reads over the `directories` table (configured AD forests / Entra
 * tenants). lib/ad/resolve.ts and lib/azure/graph.ts build their domain-specific
 * config shapes on top of these; app/api/directories/* builds the admin UI on
 * top of these too, so the query logic lives in exactly one place.
 */

/** Every configured connection of one type, enabled or not — for the settings UI list. */
export async function listDirectories(type?: DirectorySource): Promise<Directory[]> {
  if (!type) return db.select().from(directories);
  return db.select().from(directories).where(eq(directories.type, type));
}

/** Only the enabled connections of one type — what sync/health fan-out iterates over. */
export async function listEnabledDirectories(type: DirectorySource): Promise<Directory[]> {
  return db
    .select()
    .from(directories)
    .where(and(eq(directories.type, type), eq(directories.enabled, true)));
}

export async function getDirectory(id: number): Promise<Directory | null> {
  const [row] = await db.select().from(directories).where(eq(directories.id, id)).limit(1);
  return row ?? null;
}

/** The one AD directory AdminReminder itself binds against to authenticate a
 *  login (lib/ad/auth.ts). Every other directory is read-only inventory. */
export async function getPrimaryAdDirectory(): Promise<Directory | null> {
  const [row] = await db
    .select()
    .from(directories)
    .where(and(eq(directories.type, "ad"), eq(directories.isPrimary, true)))
    .limit(1);
  return row ?? null;
}

/** What the settings UI actually receives: secrets collapse to a mask (as
 *  many mask characters as the real secret is long, so it reads like a real
 *  password field), same convention as lib/settings.ts getAllSettings(). */
export function toPublicDirectory(row: Directory) {
  const { bindPasswordEnc, clientSecretEnc, ...rest } = row;
  return {
    ...rest,
    bindPassword: bindPasswordEnc ? MASK_CHAR.repeat(decryptSecret(bindPasswordEnc).length) : "",
    clientSecret: clientSecretEnc ? MASK_CHAR.repeat(decryptSecret(clientSecretEnc).length) : "",
  };
}

export class DirectoryValidationError extends Error {}

export interface DirectoryInput {
  type?: DirectorySource;
  label?: string;
  enabled?: boolean;
  url?: string;
  startTls?: boolean;
  allowInsecure?: boolean;
  rejectUnauthorized?: boolean;
  caCertPath?: string | null;
  bindDn?: string;
  /** Raw secret, or a run of MASK_CHAR meaning "leave the stored one alone". */
  bindPassword?: string;
  baseDn?: string;
  /** Login role mapping — only meaningful/used on the isPrimary row. */
  adminGroupDn?: string | null;
  viewerGroupDn?: string | null;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  technicalOus?: string | null;
  technicalPatterns?: string | null;
  functionalOus?: string | null;
  functionalPatterns?: string | null;
  passwordDays?: string | null;
  accountDays?: string | null;
  syncCron?: string | null;
}

function resolveSecret(incoming: string | undefined, currentEnc: string | null): string | null {
  if (incoming === undefined) return currentEnc;
  if (isMasked(incoming)) return currentEnc;
  return incoming === "" ? null : encryptSecret(incoming);
}

/**
 * Builds the row values for a create or update. AD connection fields are
 * validated through the same buildAdConfig() the login path trusts, so a
 * saved row is guaranteed bindable rather than just "some fields were typed".
 * `existing` is null for a create; every field not present in `body` then
 * falls back to a sane default instead of the previous row's value.
 */
export function buildDirectoryValues(existing: Directory | null, body: DirectoryInput) {
  const type = body.type ?? existing?.type;
  if (type !== "ad" && type !== "entra") {
    throw new DirectoryValidationError("Typ katalogu musi być 'ad' albo 'entra'.");
  }

  const label = (body.label ?? existing?.label ?? "").trim();
  if (!label) throw new DirectoryValidationError("Nazwa katalogu jest wymagana.");

  const base = {
    label,
    enabled: body.enabled ?? existing?.enabled ?? true,
    technicalOus: body.technicalOus ?? existing?.technicalOus ?? null,
    technicalPatterns: body.technicalPatterns ?? existing?.technicalPatterns ?? null,
    functionalOus: body.functionalOus ?? existing?.functionalOus ?? null,
    functionalPatterns: body.functionalPatterns ?? existing?.functionalPatterns ?? null,
    passwordDays: body.passwordDays ?? existing?.passwordDays ?? null,
    accountDays: body.accountDays ?? existing?.accountDays ?? null,
    syncCron: body.syncCron ?? existing?.syncCron ?? null,
  };

  if (type === "ad") {
    const bindPasswordEnc = resolveSecret(body.bindPassword, existing?.bindPasswordEnc ?? null);

    try {
      buildAdConfig({
        url: body.url ?? existing?.url ?? undefined,
        startTls: String(body.startTls ?? existing?.startTls ?? false),
        allowInsecure: String(body.allowInsecure ?? existing?.allowInsecure ?? false),
        rejectUnauthorized: String(body.rejectUnauthorized ?? existing?.rejectUnauthorized ?? true),
        caCertPath: body.caCertPath ?? existing?.caCertPath ?? undefined,
        bindDn: body.bindDn ?? existing?.bindDn ?? undefined,
        bindPassword: bindPasswordEnc ? decryptSecret(bindPasswordEnc) : undefined,
        baseDn: body.baseDn ?? existing?.baseDn ?? undefined,
      });
    } catch (e) {
      throw e instanceof AdConfigError ? new DirectoryValidationError(e.message) : e;
    }

    return {
      ...base,
      type: "ad" as const,
      url: body.url ?? existing?.url ?? null,
      startTls: body.startTls ?? existing?.startTls ?? false,
      allowInsecure: body.allowInsecure ?? existing?.allowInsecure ?? false,
      rejectUnauthorized: body.rejectUnauthorized ?? existing?.rejectUnauthorized ?? true,
      caCertPath: body.caCertPath ?? existing?.caCertPath ?? null,
      bindDn: body.bindDn ?? existing?.bindDn ?? null,
      bindPasswordEnc,
      baseDn: body.baseDn ?? existing?.baseDn ?? null,
      adminGroupDn: body.adminGroupDn ?? existing?.adminGroupDn ?? null,
      viewerGroupDn: body.viewerGroupDn ?? existing?.viewerGroupDn ?? null,
      tenantId: null,
      clientId: null,
      clientSecretEnc: null,
    };
  }

  const tenantId = (body.tenantId ?? existing?.tenantId ?? "").trim();
  const clientId = (body.clientId ?? existing?.clientId ?? "").trim();
  const clientSecretEnc = resolveSecret(body.clientSecret, existing?.clientSecretEnc ?? null);
  if (!tenantId || !clientId || !clientSecretEnc) {
    throw new DirectoryValidationError("Uzupełnij Tenant ID, Client ID i Client Secret.");
  }

  return {
    ...base,
    type: "entra" as const,
    url: null,
    startTls: false,
    allowInsecure: false,
    rejectUnauthorized: true,
    caCertPath: null,
    bindDn: null,
    bindPasswordEnc: null,
    baseDn: null,
    adminGroupDn: null,
    viewerGroupDn: null,
    tenantId,
    clientId,
    clientSecretEnc,
  };
}
