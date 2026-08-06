import { db } from "@/lib/db";
import { services, directories as directoriesTable } from "@/db/schema";
import { computeStatus } from "@/lib/cert-checker";
import { getThresholds } from "@/lib/settings";
import { eq } from "drizzle-orm";
import {
  getAzureConfigById,
  listEntraDirectories,
  listApplications,
  listServicePrincipals,
  type GraphCredential,
  type GraphDirectoryObject,
} from "./graph";

/** Marks rows this module owns, so a manual entry is never touched by the sync. */
const MANAGED_BY = "azure-sync";

type Source = "application" | "servicePrincipal";

interface DiscoveredCredential {
  syncKey: string;
  type: "azure_secret" | "azure_cert";
  name: string;
  identifier: string;
  expiryDate: Date;
  customData: Record<string, string>;
}

const SOURCE_LABEL: Record<Source, string> = {
  application: "App registration",
  servicePrincipal: "Service principal",
};

function collect(obj: GraphDirectoryObject, source: Source): DiscoveredCredential[] {
  const owner = obj.displayName || obj.appId;

  const fromList = (
    creds: GraphCredential[] | undefined,
    type: "azure_secret" | "azure_cert"
  ): DiscoveredCredential[] =>
    (creds ?? [])
      .filter((c) => c.endDateTime && c.keyId)
      .map((c) => ({
        syncKey: `${source}:${c.keyId}`,
        type,
        name: `${owner} — ${c.displayName || (type === "azure_secret" ? "sekret" : "certyfikat")}`,
        identifier: obj.appId,
        expiryDate: new Date(c.endDateTime),
        customData: {
          managedBy: MANAGED_BY,
          syncKey: `${source}:${c.keyId}`,
          keyId: c.keyId,
          appId: obj.appId,
          objectId: obj.id,
          source: SOURCE_LABEL[source],
        },
      }));

  return [
    ...fromList(obj.passwordCredentials, "azure_secret"),
    ...fromList(obj.keyCredentials, "azure_cert"),
  ];
}

export interface SyncResult {
  created: number;
  updated: number;
  removed: number;
  scanned: number;
}

/**
 * Pulls every app registration and service principal credential from one
 * tenant and mirrors them into the services table. Rows created by a previous
 * run whose credential no longer exists in Entra ID are deleted; rows added by
 * hand in the UI are left alone.
 *
 * Matching is by syncKey (source:keyId) across ALL tenants, not scoped by
 * directoryId — a Graph keyId is a GUID, collision across two different
 * tenants is not a realistic risk, unlike OU distinguishedNames. directoryId
 * is still stamped on every row so the UI can attribute it to a tenant.
 */
export async function syncAzureCredentials(directoryId: number): Promise<SyncResult> {
  const [directory] = await db
    .select()
    .from(directoriesTable)
    .where(eq(directoriesTable.id, directoryId))
    .limit(1);
  if (!directory || directory.type !== "entra") {
    throw new Error(`Katalog ${directoryId} nie istnieje albo nie jest typu Entra ID.`);
  }

  const config = await getAzureConfigById(directoryId);
  if (!config) {
    throw new Error(`Integracja z Entra ID „${directory.label}” nie jest skonfigurowana poprawnie.`);
  }

  const { expiringSoonDays } = await getThresholds();

  const discovered: DiscoveredCredential[] = [];
  let scanned = 0;

  for await (const app of listApplications(config)) {
    scanned++;
    discovered.push(...collect(app, "application"));
  }
  for await (const sp of listServicePrincipals(config)) {
    scanned++;
    discovered.push(...collect(sp, "servicePrincipal"));
  }

  const existing = await db.select().from(services);
  const managed = new Map(
    existing
      .filter((row) => row.customData?.managedBy === MANAGED_BY && row.customData?.syncKey)
      .map((row) => [row.customData!.syncKey, row])
  );

  const now = new Date();
  let created = 0;
  let updated = 0;

  for (const cred of discovered) {
    const { status } = computeStatus(cred.expiryDate, expiringSoonDays);
    const row = managed.get(cred.syncKey);

    if (row) {
      await db
        .update(services)
        .set({
          type: cred.type,
          name: cred.name,
          identifier: cred.identifier,
          expiryDate: cred.expiryDate,
          customData: cred.customData,
          directoryId,
          lastCheckedAt: now,
          lastCheckStatus: status,
          lastCheckError: null,
          updatedAt: now,
        })
        .where(eq(services.id, row.id));
      updated++;
    } else {
      await db.insert(services).values({
        type: cred.type,
        name: cred.name,
        identifier: cred.identifier,
        expiryDate: cred.expiryDate,
        customData: cred.customData,
        directoryId,
        lastCheckedAt: now,
        lastCheckStatus: status,
      });
      created++;
    }
  }

  // Credentials rotated out of Entra ID should not linger on the dashboard.
  const seen = new Set(discovered.map((c) => c.syncKey));
  let removed = 0;
  for (const [syncKey, row] of managed) {
    if (!seen.has(syncKey)) {
      await db.delete(services).where(eq(services.id, row.id));
      removed++;
    }
  }

  return { created, updated, removed, scanned };
}

export interface AzureCredentialSyncOutcome {
  directoryId: number;
  label: string;
  result?: SyncResult;
  error?: string;
}

/** Syncs Azure app-registration credentials for every enabled Entra directory. */
export async function syncAllAzureCredentials(): Promise<AzureCredentialSyncOutcome[]> {
  const dirs = await listEntraDirectories();
  const outcomes: AzureCredentialSyncOutcome[] = [];
  for (const dir of dirs) {
    try {
      const result = await syncAzureCredentials(dir.id);
      outcomes.push({ directoryId: dir.id, label: dir.label, result });
    } catch (e) {
      outcomes.push({
        directoryId: dir.id,
        label: dir.label,
        error: e instanceof Error ? e.message : "błąd synchronizacji",
      });
    }
  }
  return outcomes;
}
