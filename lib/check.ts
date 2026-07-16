import { db } from "./db";
import { services } from "@/db/schema";
import { isAutoCheckable } from "./server/expiry";
import { refreshService } from "./server/refresh";
import { isAzureConfigured } from "./azure/graph";
import { syncAzureCredentials } from "./azure/sync";
import { syncEntraUsers } from "./azure/users-sync";
import { isAdConfigured } from "./ad/resolve";
import { syncAdAccounts } from "./ad/sync";

/** Runs an optional sync, capturing rather than throwing so one failure does
 *  not abort the others or the certificate checks. */
async function runOptional<T>(
  enabled: boolean,
  label: string,
  fn: () => Promise<T>
): Promise<{ result: T | null; error: string | null }> {
  if (!enabled) return { result: null, error: null };
  try {
    return { result: await fn(), error: null };
  } catch (err: any) {
    console.error(`${label} sync failed during runChecks:`, err);
    return { result: null, error: err.message || String(err) };
  }
}

export async function runChecks() {
  // Directory syncs run first and write fresh expiry dates for their own rows.
  const azureConfigured = await isAzureConfigured();
  const adConfigured = await isAdConfigured();

  const azureSync = await runOptional(azureConfigured, "Azure credentials", syncAzureCredentials);
  const entraSync = await runOptional(azureConfigured, "Entra users", syncEntraUsers);
  const adSync = await runOptional(adConfigured, "Active Directory", syncAdAccounts);

  const azure = azureSync.result;
  const azureError = azureSync.error;

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

  return {
    checked,
    errors,
    skipped,
    azure,
    azureError,
    entra: entraSync.result,
    entraError: entraSync.error,
    ad: adSync.result,
    adError: adSync.error,
  };
}
