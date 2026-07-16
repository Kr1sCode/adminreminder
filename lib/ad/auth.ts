import { type AdConfig } from "./config";
import { getAdConfig } from "./resolve";
import { AdError, withServiceBind, verifyUserPassword, searchPaged, first } from "./client";
import { escapeFilterValue } from "./attrs";

/**
 * Without this matching rule, `memberOf` lists only *direct* group membership:
 * a user who is an admin through a nested group would be silently denied.
 * OID 1.2.840.113556.1.4.1941 = LDAP_MATCHING_RULE_IN_CHAIN.
 */
const IN_CHAIN = "1.2.840.113556.1.4.1941";

export interface AdIdentity {
  dn: string;
  samAccountName: string;
  displayName?: string;
  role: "admin" | "viewer";
}

/** Accepts either `jkowalski` or `jkowalski@corp.local`. */
function userFilter(login: string): string {
  const value = escapeFilterValue(login);
  return `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${value})(userPrincipalName=${value})))`;
}

async function resolveRole(
  config: AdConfig,
  userDn: string
): Promise<"admin" | "viewer" | null> {
  // No groups configured means group-based authorisation is off entirely.
  if (!config.adminGroupDn && !config.viewerGroupDn) return null;

  return withServiceBind(config, async (client) => {
    const isMemberOf = async (groupDn: string): Promise<boolean> => {
      const filter = `(memberOf:${IN_CHAIN}:=${escapeFilterValue(groupDn)})`;
      const entries = await client.search(userDn, {
        scope: "base",
        filter,
        attributes: ["distinguishedName"],
      });
      return entries.searchEntries.length > 0;
    };

    if (config.adminGroupDn && (await isMemberOf(config.adminGroupDn))) return "admin";
    if (config.viewerGroupDn && (await isMemberOf(config.viewerGroupDn))) return "viewer";
    return null;
  });
}

export interface AdAuthResult {
  ok: boolean;
  identity?: AdIdentity;
  error?: string;
}

/**
 * Authenticates against the domain: locate the user with the service account,
 * then bind as the user to check the password, then resolve the role from group
 * membership. Returns ok=false rather than throwing on bad credentials.
 */
export async function authenticateAgainstAd(
  login: string,
  password: string
): Promise<AdAuthResult> {
  const config = await getAdConfig();
  if (!config) return { ok: false, error: "Integracja z AD nie jest skonfigurowana" };

  // An empty password turns a simple bind into an anonymous bind, which
  // succeeds. Refuse before anything touches the domain controller.
  if (!password) return { ok: false, error: "Hasło jest wymagane" };

  const trimmed = login.trim();
  if (!trimmed) return { ok: false, error: "Nazwa użytkownika jest wymagana" };

  let entry;
  try {
    const entries = await withServiceBind(config, (client) =>
      searchPaged(client, config.baseDn, userFilter(trimmed), [
        "distinguishedName",
        "sAMAccountName",
        "displayName",
        "userAccountControl",
      ])
    );
    entry = entries[0];
  } catch (err) {
    if (err instanceof AdError) throw err;
    throw new AdError("Błąd wyszukiwania użytkownika w AD", err);
  }

  // Do not reveal whether the account exists.
  if (!entry) return { ok: false, error: "Nieprawidłowa nazwa użytkownika lub hasło" };

  const userDn = first(entry.distinguishedName) ?? entry.dn;
  const samAccountName = first(entry.sAMAccountName) ?? trimmed;

  const passwordOk = await verifyUserPassword(config, userDn, password);
  if (!passwordOk) return { ok: false, error: "Nieprawidłowa nazwa użytkownika lub hasło" };

  const role = await resolveRole(config, userDn);
  if (!role) {
    return {
      ok: false,
      error: "Twoje konto domenowe nie należy do grupy uprawnionej do korzystania z AR",
    };
  }

  return {
    ok: true,
    identity: { dn: userDn, samAccountName, displayName: first(entry.displayName), role },
  };
}
