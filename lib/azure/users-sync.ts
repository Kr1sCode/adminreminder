import { db } from "@/lib/db";
import { adAccounts, directories as directoriesTable } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { eq } from "drizzle-orm";
import { getAzureConfigById, listEntraDirectories, listUsers, listDomains } from "./graph";
import { computeEntraPasswordExpiry, buildDomainPolicyMap } from "./password";
import { classifyAccount, parseList } from "@/lib/ad/classify";

/**
 * Entra has no OU tree, so we synthesise one from the user's department. That
 * lets the same tree/table UI render cloud accounts: they appear under an
 * "Entra ID" root, grouped by department. rdnValue() in lib/ad/tree.ts strips
 * the "OU=" prefix, so the labels show the plain department name.
 */
const ENTRA_ROOT = "OU=Entra ID";

function synthPath(department: string | null): string {
  const dept = department?.trim();
  return dept ? `OU=${dept.replace(/,/g, "\\,")},${ENTRA_ROOT}` : ENTRA_ROOT;
}

export interface EntraSyncResult {
  created: number;
  updated: number;
  removed: number;
  technical: number;
  functional: number;
  users: number;
}

export async function syncEntraUsers(directoryId: number): Promise<EntraSyncResult> {
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

  const [technicalPatterns, functionalPatterns] = await Promise.all([
    directory.technicalPatterns ?? (await getSetting("ad_technical_patterns", "svc-*,svc_*,sa-*,sa_*,srv-*")),
    directory.functionalPatterns ?? (await getSetting("ad_functional_patterns", "func-*,role-*")),
  ]);
  const rules = {
    technicalOus: [] as string[],
    technicalPatterns: parseList(technicalPatterns),
    functionalOus: [] as string[],
    functionalPatterns: parseList(functionalPatterns),
  };

  const domainPolicy = buildDomainPolicyMap(await listDomains(config));

  const now = new Date();
  const existing = await db.select().from(adAccounts).where(eq(adAccounts.directoryId, directoryId));
  const byGuid = new Map(existing.map((row) => [row.objectGuid, row]));
  const seen = new Set<string>();

  const result: EntraSyncResult = {
    created: 0, updated: 0, removed: 0, technical: 0, functional: 0, users: 0,
  };

  for await (const user of listUsers(config)) {
    if (!user.id) continue;
    seen.add(user.id);

    const login = user.userPrincipalName || user.displayName || user.id;
    const { neverExpires, expiresAt } = computeEntraPasswordExpiry(user, domainPolicy);

    // Only naming-convention rules apply; there is no OU or userAccountControl.
    const { kind, reason } = classifyAccount(
      { samAccountName: login.split("@")[0], distinguishedName: synthPath(user.department) },
      rules
    );
    result[kind === "user" ? "users" : kind]++;

    const values = {
      source: "entra" as const,
      directoryId,
      objectGuid: user.id,
      samAccountName: login,
      distinguishedName: `CN=${(user.displayName || login).replace(/,/g, "\\,")},${synthPath(user.department)}`,
      ouPath: synthPath(user.department),
      displayName: user.displayName ?? null,
      userPrincipalName: user.userPrincipalName ?? null,
      kind,
      kindReason: reason,
      enabled: user.accountEnabled ?? true,
      userAccountControl: 0,
      passwordNeverExpires: neverExpires,
      passwordExpiresAt: expiresAt,
      accountExpiresAt: null,
      lastLogonAt: null,
      spnCount: 0,
      lastSyncedAt: now,
    };

    const row = byGuid.get(user.id);
    if (row) {
      await db.update(adAccounts).set(values).where(eq(adAccounts.id, row.id));
      result.updated++;
    } else {
      await db.insert(adAccounts).values(values);
      result.created++;
    }
  }

  for (const [guid, row] of byGuid) {
    if (!seen.has(guid)) {
      await db.delete(adAccounts).where(eq(adAccounts.id, row.id));
      result.removed++;
    }
  }

  return result;
}

export interface EntraDirectorySyncOutcome {
  directoryId: number;
  label: string;
  result?: EntraSyncResult;
  error?: string;
}

/** Syncs every enabled Entra directory; one tenant's failure never blocks another's. */
export async function syncAllEntraDirectories(): Promise<EntraDirectorySyncOutcome[]> {
  const dirs = await listEntraDirectories();
  const outcomes: EntraDirectorySyncOutcome[] = [];
  for (const dir of dirs) {
    try {
      const result = await syncEntraUsers(dir.id);
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
