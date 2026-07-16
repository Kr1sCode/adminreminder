import { getSetting, getSecret } from "@/lib/settings";

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "GraphError";
  }
}

export interface AzureConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Environment variables win over the settings table, so a container can pin its
 * credentials without anyone being able to change them from the web UI.
 */
export async function getAzureConfig(): Promise<AzureConfig | null> {
  const tenantId = process.env.AZURE_TENANT_ID || (await getSetting("azure_tenant_id"));
  const clientId = process.env.AZURE_CLIENT_ID || (await getSetting("azure_client_id"));
  const clientSecret = process.env.AZURE_CLIENT_SECRET || (await getSecret("azure_client_secret"));

  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

export async function isAzureConfigured(): Promise<boolean> {
  return (await getAzureConfig()) !== null;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(config: AzureConfig): Promise<string> {
  // Re-use the token until a minute before it expires.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const res = await fetch(`${LOGIN_HOST}/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new GraphError(
      `Nie udało się uzyskać tokenu Entra ID: ${data.error_description || data.error || res.statusText}`,
      res.status
    );
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/** Drops the cached token. Used when Graph rejects it mid-run. */
export function invalidateTokenCache() {
  cachedToken = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graphFetch(url: string, config: AzureConfig, attempt = 0): Promise<any> {
  const token = await getAccessToken(config);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  // Graph throttles aggressively on large tenants; honour Retry-After.
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) {
      throw new GraphError(`Graph API zwróciło ${res.status} po kilku próbach`, res.status);
    }
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await sleep(retryAfter * 1000);
    return graphFetch(url, config, attempt + 1);
  }

  if (res.status === 401 && attempt === 0) {
    invalidateTokenCache();
    return graphFetch(url, config, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = body?.error?.message || res.statusText;
    if (res.status === 403) {
      throw new GraphError(
        `Brak uprawnień do Graph API (${detail}). Sprawdź, czy aplikacja ma nadane uprawnienie aplikacyjne Application.Read.All wraz ze zgodą administratora.`,
        403
      );
    }
    throw new GraphError(`Graph API: ${detail}`, res.status);
  }

  return res.json();
}

/** Follows @odata.nextLink and yields every page's `value` entries. */
async function* graphPaged<T>(path: string, config: AzureConfig): AsyncGenerator<T> {
  let url: string | undefined = `${GRAPH_BASE}${path}`;

  while (url) {
    const page: { value?: T[]; "@odata.nextLink"?: string } = await graphFetch(url, config);
    for (const entry of page.value ?? []) yield entry;
    url = page["@odata.nextLink"];
  }
}

export interface GraphCredential {
  keyId: string;
  displayName: string | null;
  endDateTime: string;
}

export interface GraphDirectoryObject {
  id: string;
  appId: string;
  displayName: string | null;
  passwordCredentials?: GraphCredential[];
  keyCredentials?: GraphCredential[];
}

const SELECT = "$select=id,appId,displayName,passwordCredentials,keyCredentials";

export function listApplications(config: AzureConfig) {
  return graphPaged<GraphDirectoryObject>(`/applications?${SELECT}&$top=999`, config);
}

export function listServicePrincipals(config: AzureConfig) {
  return graphPaged<GraphDirectoryObject>(`/servicePrincipals?${SELECT}&$top=999`, config);
}

export interface GraphUser {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
  accountEnabled: boolean | null;
  department: string | null;
  // Space- or comma-separated flags; "DisablePasswordExpiration" means never.
  passwordPolicies: string | null;
  // ISO 8601; combined with the domain's validity period to derive expiry.
  lastPasswordChangeDateTime: string | null;
}

const USER_SELECT =
  "$select=id,displayName,userPrincipalName,accountEnabled,department,passwordPolicies,lastPasswordChangeDateTime";

export function listUsers(config: AzureConfig) {
  return graphPaged<GraphUser>(`/users?${USER_SELECT}&$top=999`, config);
}

export interface GraphDomain {
  id: string;
  passwordValidityPeriodInDays: number | null;
  isDefault: boolean;
}

/** Per-domain password validity, used to compute Entra password expiry. */
export async function listDomains(config: AzureConfig): Promise<GraphDomain[]> {
  const domains: GraphDomain[] = [];
  for await (const d of graphPaged<GraphDomain>(
    "/domains?$select=id,passwordValidityPeriodInDays,isDefault",
    config
  )) {
    domains.push(d);
  }
  return domains;
}
