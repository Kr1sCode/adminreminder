import { getSetting, setSetting } from "@/lib/settings";
import { getAdConfig } from "./resolve";
import { withServiceBind } from "./client";
import { AdConfigError } from "./config";

/**
 * Background watchdog for the AD service-account bind, independent of
 * "Testuj połączenie" and of the automation toggle: an admin who never opens
 * Ustawienia -> Active Directory should still see a red light the moment the
 * password rotates out from under the service account, not just after they
 * happen to click the button again.
 */
const HEALTH_INTERVAL_MS = 5 * 60_000;

export interface AdHealth {
  status: "ok" | "error";
  message: string;
  checkedAt: number;
}

/** Binds and unbinds only — no search, no writes. Cheapest possible liveness probe. */
export async function checkAdHealthNow(): Promise<AdHealth | null> {
  let config;
  try {
    config = await getAdConfig();
  } catch (e) {
    config = null;
    if (e instanceof AdConfigError) {
      return { status: "error", message: e.message, checkedAt: Date.now() };
    }
  }
  if (!config) return null; // AD not configured: nothing to watch.

  try {
    await withServiceBind(config, async () => {});
    return { status: "ok", message: "Połączono z kontrolerem domeny.", checkedAt: Date.now() };
  } catch (e: any) {
    return { status: "error", message: e.message || "Nie udało się połączyć z kontrolerem domeny", checkedAt: Date.now() };
  }
}

export async function recordAdHealth(status: "ok" | "error", message: string) {
  const checkedAt = Date.now();
  await setSetting("ad_health_status", status);
  await setSetting("ad_health_message", message);
  await setSetting("ad_health_at", String(checkedAt));
}

export async function getAdHealth(): Promise<AdHealth | null> {
  const status = await getSetting("ad_health_status");
  if (status !== "ok" && status !== "error") return null;
  const message = (await getSetting("ad_health_message")) || "";
  const checkedAt = Number((await getSetting("ad_health_at")) || 0);
  return { status, message, checkedAt };
}

/** Called from the scheduler tick, unconditionally — see lib/scheduler.ts. */
export async function refreshAdHealthIfStale(): Promise<void> {
  const lastAt = Number((await getSetting("ad_health_at")) || 0);
  if (Date.now() - lastAt < HEALTH_INTERVAL_MS) return;

  const result = await checkAdHealthNow();
  if (!result) return; // not configured: leave any previous cached status as-is
  await recordAdHealth(result.status, result.message);
}
