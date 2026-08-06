import type { Directory } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { decryptSecret } from "@/lib/crypto";
import { getPrimaryAdDirectory, getDirectory, listEnabledDirectories } from "@/lib/directories";
import { buildAdConfig, type AdConfig, type AdSettingsInput } from "./config";

const boolStr = (v: boolean | null | undefined): string | undefined => (v == null ? undefined : v ? "true" : "false");

/**
 * Maps one `directories` row onto buildAdConfig's raw-input shape. envOverride
 * is only ever true for the primary (login) directory — env vars exist to let
 * a container operator pin AdminReminder's OWN AD without anyone changing it
 * from the web UI; a client directory added through the UI has no env-var
 * equivalent, and shouldn't (there could be many of them).
 */
function toAdSettingsInput(row: Directory | null, envOverride: boolean): AdSettingsInput {
  const env = envOverride
    ? {
        url: process.env.AD_URL,
        startTls: process.env.AD_START_TLS,
        allowInsecure: process.env.AD_ALLOW_INSECURE,
        rejectUnauthorized: process.env.AD_TLS_REJECT_UNAUTHORIZED,
        caCertPath: process.env.AD_CA_CERT_PATH,
        bindDn: process.env.AD_BIND_DN,
        bindPassword: process.env.AD_BIND_PASSWORD,
        baseDn: process.env.AD_BASE_DN,
        adminGroupDn: process.env.AD_ADMIN_GROUP_DN,
        viewerGroupDn: process.env.AD_VIEWER_GROUP_DN,
      }
    : ({} as Record<string, string | undefined>);

  return {
    url: env.url || row?.url || undefined,
    startTls: env.startTls || boolStr(row?.startTls),
    allowInsecure: env.allowInsecure || boolStr(row?.allowInsecure),
    rejectUnauthorized: env.rejectUnauthorized || boolStr(row?.rejectUnauthorized),
    caCertPath: env.caCertPath || row?.caCertPath || undefined,
    bindDn: env.bindDn || row?.bindDn || undefined,
    bindPassword: env.bindPassword || (row?.bindPasswordEnc ? decryptSecret(row.bindPasswordEnc) : undefined),
    baseDn: env.baseDn || row?.baseDn || undefined,
    adminGroupDn: env.adminGroupDn || row?.adminGroupDn || undefined,
    viewerGroupDn: env.viewerGroupDn || row?.viewerGroupDn || undefined,
  };
}

/** The bind timeout is a network-tuning knob, not something that plausibly
 *  differs between client forests — kept global rather than per directory. */
async function timeoutMs(): Promise<string | undefined> {
  return process.env.AD_TIMEOUT_MS || (await getSetting("ad_timeout_ms"));
}

/**
 * Config for the ONE directory AdminReminder itself binds against at login
 * (lib/ad/auth.ts) — never a client directory added for inventory purposes.
 * Env vars win over the DB row, exactly as before this table existed.
 */
export async function getAdConfig(): Promise<AdConfig | null> {
  const primary = await getPrimaryAdDirectory();
  return buildAdConfig({
    ...toAdSettingsInput(primary, true),
    timeoutMs: await timeoutMs(),
  });
}

/** Config for one specific directory — read-only inventory sync, never login.
 *  No env-var override: those exist only to lock down the primary directory. */
export async function getAdConfigById(directoryId: number): Promise<AdConfig | null> {
  const row = await getDirectory(directoryId);
  if (!row || row.type !== "ad") return null;
  return buildAdConfig({
    ...toAdSettingsInput(row, false),
    timeoutMs: await timeoutMs(),
  });
}

/** Every enabled AD directory — what sync/health fan-out iterates over. */
export async function listAdDirectories(): Promise<Directory[]> {
  return listEnabledDirectories("ad");
}

export async function isAdConfigured(): Promise<boolean> {
  try {
    return (await getAdConfig()) !== null;
  } catch {
    // Misconfigured counts as "configured": the caller should surface the error.
    return true;
  }
}
