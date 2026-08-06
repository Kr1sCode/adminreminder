import { db } from "@/lib/db";
import { directories as directoriesTable, type Directory } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAdConfigById, listAdDirectories } from "./resolve";
import { getPrimaryAdDirectory } from "@/lib/directories";
import { withServiceBind } from "./client";
import { AdConfigError } from "./config";

/**
 * Background watchdog for the AD service-account bind, independent of
 * "Testuj połączenie" and of the automation toggle: an admin who never opens
 * Ustawienia -> Active Directory should still see a red light the moment the
 * password rotates out from under the service account, not just after they
 * happen to click the button again. State lives on each directory's own row
 * now — one light per configured forest, not one global flag.
 */
const HEALTH_INTERVAL_MS = 5 * 60_000;

export interface AdHealth {
  status: "ok" | "error";
  message: string;
  checkedAt: number;
}

/** Binds and unbinds only — no search, no writes. Cheapest possible liveness probe. */
export async function checkAdHealthNow(directoryId: number): Promise<AdHealth | null> {
  let config;
  try {
    config = await getAdConfigById(directoryId);
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

export async function recordAdHealth(directoryId: number, status: "ok" | "error", message: string) {
  await db
    .update(directoriesTable)
    .set({ healthStatus: status, healthMessage: message, healthCheckedAt: new Date() })
    .where(eq(directoriesTable.id, directoryId));
}

function toAdHealth(row: Directory): AdHealth | null {
  if (row.healthStatus !== "ok" && row.healthStatus !== "error") return null;
  return {
    status: row.healthStatus,
    message: row.healthMessage || "",
    checkedAt: row.healthCheckedAt ? row.healthCheckedAt.getTime() : 0,
  };
}

/** Health of the primary (login) AD — what the Settings strip and
 *  GET /api/ad/health have always shown, unaffected by client directories. */
export async function getAdHealth(): Promise<AdHealth | null> {
  const primary = await getPrimaryAdDirectory();
  return primary ? toAdHealth(primary) : null;
}

/** Called from the scheduler tick, unconditionally — see lib/scheduler.ts.
 *  Every enabled AD directory is probed on its own 5-minute staleness gate. */
export async function refreshAdHealthIfStale(): Promise<void> {
  const dirs = await listAdDirectories();
  for (const dir of dirs) {
    const lastAt = dir.healthCheckedAt ? dir.healthCheckedAt.getTime() : 0;
    if (Date.now() - lastAt < HEALTH_INTERVAL_MS) continue;

    const result = await checkAdHealthNow(dir.id);
    if (!result) continue; // misconfigured mid-flight: leave any previous status as-is
    await recordAdHealth(dir.id, result.status, result.message);
  }
}
