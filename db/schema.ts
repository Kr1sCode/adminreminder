import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  // For authSource="ad" this holds an unusable placeholder: the password never
  // leaves the domain controller, and local login is refused for such rows.
  passwordHash: text("password_hash").notNull(),
  authSource: text("auth_source", { enum: ["local", "ad"] }).notNull().default("local"),
  role: text("role", { enum: ["admin", "viewer"] }).notNull().default("viewer"),
  // TOTP two-factor. The secret is stored encrypted (lib/crypto). `mfaEnabled`
  // means an operator has finished enrolment and confirmed a code; `mfaRequired`
  // means an admin demands it, forcing enrolment at the next login if not done.
  mfaSecret: text("mfa_secret"),
  mfaEnabled: integer("mfa_enabled", { mode: "boolean" }).notNull().default(false),
  mfaRequired: integer("mfa_required", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

// Simple key-value settings for admin configuration
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const ITEM_TYPES = [
  'https_cert',
  'tls_endpoint',
  'warranty',
  'azure_secret',
  'azure_cert',
  'api_token',
  'license',
  'domain',
  'other',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export const services = sqliteTable("services", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Generalization: not only certificates anymore
  type: text("type", { enum: ITEM_TYPES }).notNull().default('https_cert'),
  name: text("name").notNull(),
  // For https_cert: hostname
  // For warranty: serial number / asset tag
  // For azure_secret: Application (client) ID
  // For others: any useful identifier
  identifier: text("identifier").notNull(),
  port: integer("port").notNull().default(443), // only used by https_cert
  owner: text("owner"),
  notes: text("notes"),
  // Flexible custom variables / additional data.
  // For tls_endpoint this carries the probe's configuration:
  //   role — free-text label of what the endpoint is (LDAPS / ADFS / VPN / Exchange…)
  //   sni  — TLS server name to request; empty means "use the identifier"
  //   pin  — expected SHA-256 fingerprint; a mismatch means the cert was swapped
  customData: text("custom_data", { mode: "json" }).$type<Record<string, string>>().default({}),
  // Renewal
  renewalUrl: text("renewal_url"),
  // Expiry
  expiryDate: integer("expiry_date", { mode: "timestamp" }),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
  lastCheckStatus: text("last_check_status", { enum: ["ok", "expiring", "expired", "error"] }),
  lastCheckError: text("last_check_error"),

  // The domain registration behind an https_cert row. A website is one item with
  // two independent expiries: the certificate above, the registration here.
  // Null domainName means the registration is simply not tracked for this item.
  domainName: text("domain_name"),
  domainExpiryDate: integer("domain_expiry_date", { mode: "timestamp" }),
  domainLastCheckedAt: integer("domain_last_checked_at", { mode: "timestamp" }),
  domainLastCheckStatus: text("domain_last_check_status", { enum: ["ok", "expiring", "expired", "error"] }),
  domainLastCheckError: text("domain_last_check_error"),

  // Notification policy. Per item when set, otherwise the global default.
  /** Comma-separated days before expiry, e.g. "3,7,21". Null inherits the global setting. */
  notificationDays: text("notification_days"),
  /** Thresholds already fired, as ["cert:7","domain:21"]; reset when a date moves out. */
  notifiedThresholds: text("notified_thresholds", { mode: "json" }).$type<string[]>().notNull().default([]),
  /** Suppresses all alerts for this item until the given moment. */
  mutedUntil: integer("muted_until", { mode: "timestamp" }),
  /** Extra recipients beyond the global list, comma-separated. */
  notifyRecipients: text("notify_recipients"),

  lastNotifiedAt: integer("last_notified_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  identifierIdx: index("idx_services_identifier").on(table.identifier),
  // A second row with the same type, identifier and port is always an accidental
  // double submit; the database rejects it rather than trusting the client.
  typeIdentifierPortIdx: uniqueIndex("idx_services_type_identifier_port").on(
    table.type,
    table.identifier,
    table.port
  ),
}));

/** How an account was classified by lib/ad/classify.ts. */
export const AD_ACCOUNT_KINDS = ['user', 'technical', 'functional'] as const;
export type AdAccountKind = (typeof AD_ACCOUNT_KINDS)[number];

export const AD_ACCOUNT_KIND_LABELS: Record<AdAccountKind, string> = {
  user: 'Konto użytkownika',
  technical: 'Konto techniczne',
  functional: 'Konto funkcyjne',
};

/** On-prem Active Directory (LDAP) or cloud Microsoft Entra ID (Graph). */
export const DIRECTORY_SOURCES = ['ad', 'entra'] as const;
export type DirectorySource = (typeof DIRECTORY_SOURCES)[number];

/**
 * Holds accounts from both directories. AD rows carry a real distinguishedName
 * and OU tree; Entra rows carry a synthetic ouPath built from the department so
 * the same tree/table UI renders both. objectGuid is scoped by source because
 * the two directories mint GUIDs independently.
 */
export const adAccounts = sqliteTable("ad_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: DIRECTORY_SOURCES }).notNull().default('ad'),
  // AD: objectGUID; Entra: the object id. Only stable identifier across renames.
  objectGuid: text("object_guid").notNull(),
  samAccountName: text("sam_account_name").notNull(),
  distinguishedName: text("distinguished_name").notNull(),
  // Parent container DN, e.g. "OU=Service Accounts,DC=corp,DC=local"
  ouPath: text("ou_path").notNull(),
  displayName: text("display_name"),
  userPrincipalName: text("user_principal_name"),

  kind: text("kind", { enum: AD_ACCOUNT_KINDS }).notNull().default('user'),
  kindReason: text("kind_reason"),

  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  userAccountControl: integer("user_account_control").notNull().default(0),
  passwordNeverExpires: integer("password_never_expires", { mode: "boolean" }).notNull().default(false),

  // Both are null when the directory says "never expires".
  passwordExpiresAt: integer("password_expires_at", { mode: "timestamp" }),
  accountExpiresAt: integer("account_expires_at", { mode: "timestamp" }),

  lastLogonAt: integer("last_logon_at", { mode: "timestamp" }),
  spnCount: integer("spn_count").notNull().default(0),

  // Notification state. The policy itself lives in ad_notify_policies (it may be
  // set on an OU and cover thousands of accounts); what already fired is a fact
  // about this one account, so it belongs here. Sync must never overwrite these.
  /** Thresholds already fired, as ["password:7","account:21"]; reset when a date moves out. */
  notifiedThresholds: text("notified_thresholds", { mode: "json" }).$type<string[]>().notNull().default([]),
  lastNotifiedAt: integer("last_notified_at", { mode: "timestamp" }),

  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  sourceGuidIdx: uniqueIndex("idx_ad_accounts_source_guid").on(table.source, table.objectGuid),
  samIdx: index("idx_ad_accounts_sam").on(table.samAccountName),
  ouIdx: index("idx_ad_accounts_ou").on(table.ouPath),
  kindIdx: index("idx_ad_accounts_kind").on(table.kind),
}));

export type AdAccount = typeof adAccounts.$inferSelect;
export type NewAdAccount = typeof adAccounts.$inferInsert;

/** A policy is attached either to an organisational unit or to a single account. */
export const AD_NOTIFY_SCOPES = ['ou', 'account'] as const;
export type AdNotifyScope = (typeof AD_NOTIFY_SCOPES)[number];

/** The two clocks an account runs on, alerted apart because they mean different things. */
export const AD_NOTIFY_SIDES = ['password', 'account'] as const;
export type AdNotifySide = (typeof AD_NOTIFY_SIDES)[number];

/**
 * Who gets alerted about an expiring account, and when.
 *
 * Unlike the inventory, the directory is opt-in: a domain holds hundreds of
 * accounts nobody wants mail about, so an account with no policy above it stays
 * silent. An OU policy covers its whole subtree; an account policy overrides
 * whatever the OUs say — including a deliberate `enabled = false`, which is how
 * one noisy account is excluded from an otherwise watched OU.
 *
 * The two expiries are governed separately. A password runs out every 30-90 days
 * and the user fixes it themselves in a minute; an account runs out once, on the
 * day a contract ends, and someone has to act before it does. They deserve
 * different lead times and, often, different audiences — so each side carries its
 * own switch and its own thresholds, and `enabled` gates both.
 *
 * `target` is the OU's distinguishedName, or `${source}:${objectGuid}` for an
 * account — the GUID, not the row id, so the policy survives a resync that
 * deletes and recreates the row.
 */
export const adNotifyPolicies = sqliteTable("ad_notify_policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope", { enum: AD_NOTIFY_SCOPES }).notNull(),
  target: text("target").notNull(),
  /** False means "explicitly silent", which is not the same as having no policy. */
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  /** Alert on the password expiry (msDS-UserPasswordExpiryTimeComputed). */
  notifyPassword: integer("notify_password", { mode: "boolean" }).notNull().default(true),
  /** Comma-separated days before the password expires. Null inherits ad_password_days. */
  passwordDays: text("password_days"),

  /** Alert on the account expiry (accountExpires) — the contract end, not the password. */
  notifyAccount: integer("notify_account", { mode: "boolean" }).notNull().default(true),
  /** Comma-separated days before the account expires. Null inherits ad_account_days. */
  accountDays: text("account_days"),

  /** Suppresses alerts for everything this policy covers, until the given moment. */
  mutedUntil: integer("muted_until", { mode: "timestamp" }),
  /** Extra recipients beyond the global list, comma-separated. */
  notifyRecipients: text("notify_recipients"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  scopeTargetIdx: uniqueIndex("idx_ad_notify_scope_target").on(table.scope, table.target),
}));

export type AdNotifyPolicy = typeof adNotifyPolicies.$inferSelect;

/** Scopes an API key may hold. Read-only for now; keep additive. */
export const API_SCOPES = ['read'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const apiKeys = sqliteTable("api_keys", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  // SHA-256 of the token; the plaintext is shown once at creation and never stored.
  keyHash: text("key_hash").notNull().unique(),
  // First few chars of the token, for humans to recognise a key in the list.
  prefix: text("prefix").notNull(),
  scopes: text("scopes", { mode: "json" }).$type<ApiScope[]>().notNull().default(['read']),
  createdBy: text("created_by"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type ApiKey = typeof apiKeys.$inferSelect;

export const checkHistory = sqliteTable("check_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serviceId: integer("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  checkedAt: integer("checked_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  expiryDate: integer("expiry_date", { mode: "timestamp" }),
  success: integer("success", { mode: "boolean" }).notNull(),
  errorMessage: text("error_message"),
});

/** What a human did. Automatic checks are not recorded: the cron touches every
 *  row several times a day and would bury the one entry that matters. */
export const AUDIT_ACTIONS = [
  'item.create', 'item.update', 'item.renew', 'item.delete',
  'item.check', 'item.check_all', 'item.track_domain', 'item.notifications',
  'user.create', 'user.delete',
  'user.mfa_required', 'user.mfa_unrequired', 'user.mfa_reset',
  'settings.update', 'apikey.create', 'apikey.revoke',
  'auth.login', 'auth.login_failed', 'auth.logout', 'auth.setup',
  'mfa.enrolled', 'auth.mfa_failed',
  'sync.ad', 'sync.entra', 'sync.azure', 'notifications.send',
  'ad.notifications',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),

  // Denormalised on purpose: an entry must stay readable after the user or the
  // item it refers to has been deleted, which is exactly when it matters most.
  actorId: integer("actor_id"),
  actorName: text("actor_name").notNull(),
  actorRole: text("actor_role"),

  action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  entityName: text("entity_name"),

  /** Field-level before/after, or a short summary. Never holds secret values. */
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
}, (table) => ({
  atIdx: index("idx_audit_at").on(table.at),
  actorIdx: index("idx_audit_actor").on(table.actorName),
  actionIdx: index("idx_audit_action").on(table.action),
}));

export type AuditEntry = typeof auditLog.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type CheckHistory = typeof checkHistory.$inferSelect;

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  https_cert: 'Certyfikat HTTPS',
  tls_endpoint: 'Punkt TLS (LDAPS / usługa)',
  warranty: 'Gwarancja sprzętu',
  azure_secret: 'Sekret Azure (Graph API)',
  azure_cert: 'Certyfikat Azure',
  api_token: 'Token / Klucz API',
  license: 'Licencja',
  domain: 'Domena',
  other: 'Inne',
};
