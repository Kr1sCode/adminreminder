import { db } from "@/lib/db";
import { adAccounts } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { eq } from "drizzle-orm";
import { getAdConfig } from "./resolve";
import { AdError, withServiceBind, searchPaged, first, asArray, firstBuffer } from "./client";
import { filetimeToDate, formatObjectGuid, parentDn, isDisabled, passwordNeverExpires } from "./attrs";
import { classifyAccount, parseList, type ClassificationRules } from "./classify";

/**
 * `msDS-UserPasswordExpiryTimeComputed` is a *constructed* attribute: Active
 * Directory only returns it when it is named explicitly, never under "*". It
 * already accounts for Fine-Grained Password Policies, which is why we read it
 * instead of deriving expiry from pwdLastSet plus the domain policy.
 */
const ATTRIBUTES = [
  "objectGUID",
  "sAMAccountName",
  "distinguishedName",
  "displayName",
  "userPrincipalName",
  "userAccountControl",
  "accountExpires",
  "lastLogonTimestamp",
  "servicePrincipalName",
  "msDS-UserPasswordExpiryTimeComputed",
];

/** Real user accounts only: excludes computers, contacts and krbtgt-style objects. */
const USER_FILTER = "(&(objectCategory=person)(objectClass=user))";

export interface AdSyncResult {
  created: number;
  updated: number;
  removed: number;
  technical: number;
  functional: number;
  users: number;
}

async function loadRules(): Promise<ClassificationRules> {
  const [technicalOus, technicalPatterns, functionalOus, functionalPatterns] = await Promise.all([
    getSetting("ad_technical_ous", ""),
    getSetting("ad_technical_patterns", "svc-*,svc_*,sa-*,sa_*,srv-*"),
    getSetting("ad_functional_ous", ""),
    getSetting("ad_functional_patterns", "func-*,role-*"),
  ]);

  return {
    technicalOus: parseList(technicalOus),
    technicalPatterns: parseList(technicalPatterns),
    functionalOus: parseList(functionalOus),
    functionalPatterns: parseList(functionalPatterns),
  };
}

export async function syncAdAccounts(): Promise<AdSyncResult> {
  const config = await getAdConfig();
  if (!config) {
    throw new AdError("Integracja z Active Directory nie jest skonfigurowana. Uzupełnij dane w Ustawieniach → Active Directory.");
  }

  const rules = await loadRules();
  const now = new Date();

  const entries = await withServiceBind(config, (client) =>
    searchPaged(client, config.baseDn, USER_FILTER, ATTRIBUTES, ["objectGUID"])
  );

  const existing = await db.select().from(adAccounts).where(eq(adAccounts.source, "ad"));
  const byGuid = new Map(existing.map((row) => [row.objectGuid, row]));

  const seen = new Set<string>();
  const result: AdSyncResult = {
    created: 0, updated: 0, removed: 0, technical: 0, functional: 0, users: 0,
  };

  for (const entry of entries) {
    const guidBuffer = firstBuffer(entry.objectGUID);
    const samAccountName = first(entry.sAMAccountName);
    // dn is the entry's own DN; distinguishedName may be absent from the payload.
    const distinguishedName = first(entry.distinguishedName) ?? entry.dn;

    if (!guidBuffer || !samAccountName || !distinguishedName) continue;

    const objectGuid = formatObjectGuid(guidBuffer);
    seen.add(objectGuid);

    const uac = Number(first(entry.userAccountControl) ?? 0);
    const { kind, reason } = classifyAccount({ samAccountName, distinguishedName }, rules);
    result[kind === "user" ? "users" : kind]++;

    const values = {
      source: "ad" as const,
      objectGuid,
      samAccountName,
      distinguishedName,
      ouPath: parentDn(distinguishedName),
      displayName: first(entry.displayName) ?? null,
      userPrincipalName: first(entry.userPrincipalName) ?? null,
      kind,
      kindReason: reason,
      enabled: !isDisabled(uac),
      userAccountControl: uac,
      passwordNeverExpires: passwordNeverExpires(uac),
      passwordExpiresAt: filetimeToDate(first(entry["msDS-UserPasswordExpiryTimeComputed"])),
      accountExpiresAt: filetimeToDate(first(entry.accountExpires)),
      lastLogonAt: filetimeToDate(first(entry.lastLogonTimestamp)),
      spnCount: asArray(entry.servicePrincipalName).length,
      lastSyncedAt: now,
    };

    const row = byGuid.get(objectGuid);
    if (row) {
      await db.update(adAccounts).set(values).where(eq(adAccounts.id, row.id));
      result.updated++;
    } else {
      await db.insert(adAccounts).values(values);
      result.created++;
    }
  }

  // Accounts deleted from the directory should not linger in the mirror.
  for (const [guid, row] of byGuid) {
    if (!seen.has(guid)) {
      await db.delete(adAccounts).where(eq(adAccounts.id, row.id));
      result.removed++;
    }
  }

  return result;
}
