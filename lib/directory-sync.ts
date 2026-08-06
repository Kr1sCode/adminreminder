import { db } from "@/lib/db";
import { directories as directoriesTable, type Directory } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listDirectories } from "@/lib/directories";
import { syncAdAccounts } from "@/lib/ad/sync";
import { syncAdcsCertificates } from "@/lib/ad/adcs";
import { syncEntraUsers } from "@/lib/azure/users-sync";
import { syncAzureCredentials } from "@/lib/azure/sync";

/**
 * The single place that knows how to sync "one directory, whatever its type"
 * end-to-end and record the outcome on its own row — shared by the scheduler's
 * per-directory cron loop and by "sync everything right now" (manual button,
 * external cron endpoint). Never throws: a failed directory is recorded as
 * such and the caller moves on, same spirit as lib/check.ts's runOptional.
 */
export async function runDirectorySync(directory: Directory): Promise<void> {
  try {
    if (directory.type === "ad") {
      const accounts = await syncAdAccounts(directory.id);
      let note = `konta: +${accounts.created}/-${accounts.removed}, zaktualizowano ${accounts.updated}`;
      try {
        const adcs = await syncAdcsCertificates(directory.id);
        note += `; adcs: +${adcs.created}/-${adcs.removed}`;
      } catch (e) {
        // AD CS is optional — most forests never had it installed, and its
        // failure must not mark the whole directory's sync as failed.
        note += `; adcs błąd: ${e instanceof Error ? e.message : String(e)}`;
      }
      await recordOutcome(directory.id, "ok", note);
    } else {
      const accounts = await syncEntraUsers(directory.id);
      let note = `konta: +${accounts.created}/-${accounts.removed}, zaktualizowano ${accounts.updated}`;
      try {
        const cred = await syncAzureCredentials(directory.id);
        note += `; sekrety: +${cred.created}/-${cred.removed}`;
      } catch (e) {
        note += `; sekrety błąd: ${e instanceof Error ? e.message : String(e)}`;
      }
      await recordOutcome(directory.id, "ok", note);
    }
  } catch (e) {
    await recordOutcome(directory.id, "error", e instanceof Error ? e.message : String(e));
  }
}

async function recordOutcome(directoryId: number, status: "ok" | "error", detail: string) {
  await db
    .update(directoriesTable)
    .set({ lastSyncedAt: new Date(), lastSyncStatus: status, lastSyncDetail: detail })
    .where(eq(directoriesTable.id, directoryId));
}

/**
 * Force-syncs every enabled directory right now, ignoring each one's own
 * syncCron — this is what "run now" always means, whether a human clicked a
 * button or an external cron hit /api/cron/check-and-notify. The autonomous
 * per-directory cadence (lib/scheduler.ts) is a separate, additional trigger
 * for directories that want a different rhythm than that.
 */
export async function syncAllDirectoriesNow(): Promise<void> {
  const dirs = await listDirectories();
  for (const dir of dirs.filter((d) => d.enabled)) {
    await runDirectorySync(dir);
  }
}
