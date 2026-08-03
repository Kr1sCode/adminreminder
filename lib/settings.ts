import { db } from "./db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "./crypto";

export const DEFAULT_SETTINGS: Record<string, string> = {
  expiring_soon_days: "30",
  urgent_days: "7",
  ad_technical_patterns: "svc-*,svc_*,sa-*,sa_*,srv-*",
  ad_functional_patterns: "func-*,role-*",
  // The directory's two clocks default apart on purpose. A password is fixed by
  // the user in a minute, so late reminders work; an expiring account needs a
  // decision from someone else — HR, a manager — and that takes weeks.
  ad_password_days: "3,7,14",
  ad_account_days: "7,14,30",
  automation_enabled: "false",
  automation_cron: "0 */6 * * *",
};

/**
 * Values encrypted at rest and never sent to the browser. `getAllSettings()`
 * replaces each of these with MASK when it is set, so the settings form can show
 * "already configured" without ever transporting the secret itself.
 */
export const SECRET_KEYS = new Set([
  "resend_api_key",
  "smtp_pass",
  "azure_client_secret",
  "ad_bind_password",
  "webhook_secret",
]);

/**
 * The UI echoes back a string of this character to mean "unchanged"; must
 * never be persisted. Its length varies per secret — see getAllSettings —
 * so "unchanged" is detected by composition (all mask char), not by a fixed
 * string. isMasked() below is the single source of truth for that check.
 */
export const MASK_CHAR = "•";

/** True for anything that is only the mask character — i.e. an untouched secret field. */
export function isMasked(value: string): boolean {
  return value.length > 0 && [...value].every((c) => c === MASK_CHAR);
}

export async function getSetting(key: string, defaultValue?: string): Promise<string | undefined> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (row.length > 0 && row[0].value != null) {
    return SECRET_KEYS.has(key) ? decryptSecret(row[0].value) : row[0].value;
  }
  return defaultValue ?? DEFAULT_SETTINGS[key];
}

/** Reads a secret, returning undefined when unset rather than throwing. */
export async function getSecret(key: string): Promise<string | undefined> {
  const value = await getSetting(key);
  return value ? value : undefined;
}

/**
 * Settings safe to hand to an admin's browser: secrets collapse to a mask
 * when present (as many mask characters as the real secret is long, so the
 * field reads like a genuine password field) and to "" when unset.
 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  const result: Record<string, string> = { ...DEFAULT_SETTINGS };

  for (const row of rows) {
    if (row.value == null) continue;
    if (SECRET_KEYS.has(row.key)) {
      result[row.key] = row.value ? MASK_CHAR.repeat(decryptSecret(row.value).length) : "";
    } else {
      result[row.key] = row.value;
    }
  }

  for (const key of SECRET_KEYS) {
    if (!(key in result)) result[key] = "";
  }

  return result;
}

export async function setSetting(key: string, value: string) {
  // Echoing the mask back means "leave this secret alone".
  if (SECRET_KEYS.has(key) && isMasked(value)) return;

  const stored = SECRET_KEYS.has(key) && value !== "" ? encryptSecret(value) : value;

  await db
    .insert(settings)
    .values({ key, value: stored, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: stored, updatedAt: new Date() },
    });
}

export async function getThresholds() {
  const soon = parseInt(await getSetting("expiring_soon_days", "30") || "30", 10);
  const urgent = parseInt(await getSetting("urgent_days", "7") || "7", 10);
  return { expiringSoonDays: soon, urgentDays: urgent };
}

const parseDayList = (csv: string | undefined, fallback: string): number[] => {
  const days = (csv || fallback)
    .split(",")
    .map((d) => parseInt(d.trim(), 10))
    .filter((d) => Number.isFinite(d) && d > 0);
  return days.length > 0 ? days : fallback.split(",").map(Number);
};

/** Fallback thresholds for accounts whose policy sets none of its own. */
export async function getAdThresholds() {
  const [password, account] = await Promise.all([
    getSetting("ad_password_days", DEFAULT_SETTINGS.ad_password_days),
    getSetting("ad_account_days", DEFAULT_SETTINGS.ad_account_days),
  ]);

  return {
    password: parseDayList(password, DEFAULT_SETTINGS.ad_password_days),
    account: parseDayList(account, DEFAULT_SETTINGS.ad_account_days),
  };
}
