import { db } from "./db";
import { services } from "@/db/schema";
import { isAutoCheckable } from "./server/expiry";
import { refreshService } from "./server/refresh";

/**
 * Checks the core inventory (certs, domains, warranties, ...). Directory sync
 * (AD/Entra accounts, AD CS, Azure app-registration credentials) used to run
 * unconditionally at the top of this function, back when there was only ever
 * one AD and one Entra tenant to sync. Now that a deployment can have many —
 * each wanting its own cadence — that fan-out lives in lib/directory-sync.ts
 * and lib/scheduler.ts's per-directory loop instead; forcing every directory
 * to sync every time this function runs would defeat a directory's own
 * syncCron override. "Sync everything right now" (manual button, external
 * cron) calls lib/directory-sync.ts's syncAllDirectoriesNow() alongside this.
 */
export async function runChecks() {
  const allItems = await db.select().from(services);

  let checked = 0;
  let errors = 0;
  let skipped = 0;

  for (const item of allItems) {
    // Certificates and domain registrations expose their expiry; the rest carry
    // a manually entered date that nothing out there can confirm.
    if (!isAutoCheckable(item.type) && !item.domainName) {
      skipped++;
      continue;
    }

    const result = await refreshService(item);
    if (result.errors.length > 0) errors++;
    else checked++;
  }

  return { checked, errors, skipped };
}
