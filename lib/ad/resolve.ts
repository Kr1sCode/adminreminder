import { getSetting, getSecret } from "@/lib/settings";
import { buildAdConfig, type AdConfig } from "./config";

/**
 * Environment variables win over the settings table, so a container can pin its
 * credentials without anyone being able to change them from the web UI.
 *
 * Kept apart from config.ts so that the validation logic stays free of database
 * imports and can be unit-tested without opening SQLite.
 */
export async function getAdConfig(): Promise<AdConfig | null> {
  return buildAdConfig({
    url: process.env.AD_URL || (await getSetting("ad_url")),
    startTls: process.env.AD_START_TLS || (await getSetting("ad_start_tls")),
    allowInsecure: process.env.AD_ALLOW_INSECURE || (await getSetting("ad_allow_insecure")),
    rejectUnauthorized:
      process.env.AD_TLS_REJECT_UNAUTHORIZED || (await getSetting("ad_tls_reject_unauthorized")),
    caCertPath: process.env.AD_CA_CERT_PATH || (await getSetting("ad_ca_cert_path")),
    bindDn: process.env.AD_BIND_DN || (await getSetting("ad_bind_dn")),
    bindPassword: process.env.AD_BIND_PASSWORD || (await getSecret("ad_bind_password")),
    baseDn: process.env.AD_BASE_DN || (await getSetting("ad_base_dn")),
    adminGroupDn: process.env.AD_ADMIN_GROUP_DN || (await getSetting("ad_admin_group_dn")),
    viewerGroupDn: process.env.AD_VIEWER_GROUP_DN || (await getSetting("ad_viewer_group_dn")),
    timeoutMs: process.env.AD_TIMEOUT_MS || (await getSetting("ad_timeout_ms")),
  });
}

export async function isAdConfigured(): Promise<boolean> {
  try {
    return (await getAdConfig()) !== null;
  } catch {
    // Misconfigured counts as "configured": the caller should surface the error.
    return true;
  }
}
