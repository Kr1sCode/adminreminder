/**
 * Idempotent schema bootstrap. Creates every table/column/index the app needs,
 * using IF NOT EXISTS throughout, then applies the later additive migrations.
 *
 * Runs on every container start (see Dockerfile entrypoint), so a fresh volume
 * gets a working schema and an existing database is left untouched. This exists
 * because the drizzle migration history drifted from the real database and
 * `drizzle-kit migrate` cannot be used (see docs / migrate-*.js).
 */
const { openDatabase } = require("../lib/db-encryption");

const dbPath = process.env.DATABASE_URL || "./ar.db";
// Transparently encrypted with SQLCipher when DB_ENCRYPTION_KEY is set,
// including converting a pre-existing plaintext database on the very run
// where the key is first configured — see lib/db-encryption.js.
const db = openDatabase(dbPath);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function addColumn(table, ddl, name) {
  if (!columnExists(table, name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`  + ${table}.${name}`);
  }
}

console.log(`[init-db] ${dbPath}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    auth_source text DEFAULT 'local' NOT NULL,
    role text DEFAULT 'viewer' NOT NULL,
    created_at integer NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);

  CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY NOT NULL,
    value text,
    updated_at integer NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    type text DEFAULT 'https_cert' NOT NULL,
    name text NOT NULL,
    identifier text NOT NULL,
    port integer DEFAULT 443 NOT NULL,
    owner text,
    notes text,
    custom_data text DEFAULT '{}',
    renewal_url text,
    expiry_date integer,
    last_checked_at integer,
    last_check_status text,
    last_check_error text,
    last_notified_at integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_services_identifier ON services (identifier);

  CREATE TABLE IF NOT EXISTS check_history (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    service_id integer NOT NULL,
    checked_at integer NOT NULL,
    expiry_date integer,
    success integer NOT NULL,
    error_message text,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE cascade
  );

  CREATE TABLE IF NOT EXISTS ad_accounts (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    source text DEFAULT 'ad' NOT NULL,
    object_guid text NOT NULL,
    sam_account_name text NOT NULL,
    distinguished_name text NOT NULL,
    ou_path text NOT NULL,
    display_name text,
    user_principal_name text,
    kind text DEFAULT 'user' NOT NULL,
    kind_reason text,
    enabled integer DEFAULT true NOT NULL,
    user_account_control integer DEFAULT 0 NOT NULL,
    password_never_expires integer DEFAULT false NOT NULL,
    password_expires_at integer,
    account_expires_at integer,
    last_logon_at integer,
    spn_count integer DEFAULT 0 NOT NULL,
    last_synced_at integer NOT NULL,
    created_at integer NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_accounts_source_guid ON ad_accounts (source, object_guid);
  CREATE INDEX IF NOT EXISTS idx_ad_accounts_sam ON ad_accounts (sam_account_name);
  CREATE INDEX IF NOT EXISTS idx_ad_accounts_ou ON ad_accounts (ou_path);
  CREATE INDEX IF NOT EXISTS idx_ad_accounts_kind ON ad_accounts (kind);

  CREATE TABLE IF NOT EXISTS ad_notify_policies (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    scope text NOT NULL,
    target text NOT NULL,
    enabled integer DEFAULT true NOT NULL,
    notify_password integer DEFAULT true NOT NULL,
    password_days text,
    notify_account integer DEFAULT true NOT NULL,
    account_days text,
    muted_until integer,
    notify_recipients text,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_notify_scope_target ON ad_notify_policies (scope, target);

  CREATE TABLE IF NOT EXISTS api_keys (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    prefix text NOT NULL,
    scopes text DEFAULT '["read"]' NOT NULL,
    created_by text,
    last_used_at integer,
    revoked integer DEFAULT false NOT NULL,
    created_at integer NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_unique ON api_keys (key_hash);

  CREATE TABLE IF NOT EXISTS audit_log (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    at integer NOT NULL,
    actor_id integer,
    actor_name text NOT NULL,
    actor_role text,
    action text NOT NULL,
    entity_type text,
    entity_id integer,
    entity_name text,
    details text
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_name);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
`);

// Columns added to pre-existing tables on older databases.
addColumn("users", "auth_source text DEFAULT 'local' NOT NULL", "auth_source");
addColumn("services", "last_notified_at integer", "last_notified_at");
addColumn("ad_accounts", "source text DEFAULT 'ad' NOT NULL", "source");

// A website is one item with two expiries: the certificate and the registration
// of the domain behind it.
addColumn("services", "domain_name text", "domain_name");
addColumn("services", "domain_expiry_date integer", "domain_expiry_date");
addColumn("services", "domain_last_checked_at integer", "domain_last_checked_at");
addColumn("services", "domain_last_check_status text", "domain_last_check_status");
addColumn("services", "domain_last_check_error text", "domain_last_check_error");

// Per-item notification policy. NULL notification_days inherits the global one.
addColumn("services", "notification_days text", "notification_days");
addColumn("services", "notified_thresholds text DEFAULT '[]' NOT NULL", "notified_thresholds");
addColumn("services", "muted_until integer", "muted_until");
addColumn("services", "notify_recipients text", "notify_recipients");

// Which thresholds already fired for an account. The policy itself hangs on an
// OU or an account (ad_notify_policies); this is state, and it belongs per row.
addColumn("ad_accounts", "notified_thresholds text DEFAULT '[]' NOT NULL", "notified_thresholds");
addColumn("ad_accounts", "last_notified_at integer", "last_notified_at");

// The password and the account expire on unrelated clocks, so each side of a
// policy carries its own switch and thresholds. A build in between had a single
// `notification_days`: it governed the password, so its value moves there.
addColumn("ad_notify_policies", "notify_password integer DEFAULT 1 NOT NULL", "notify_password");
addColumn("ad_notify_policies", "password_days text", "password_days");
addColumn("ad_notify_policies", "notify_account integer DEFAULT 1 NOT NULL", "notify_account");
addColumn("ad_notify_policies", "account_days text", "account_days");

if (columnExists("ad_notify_policies", "notification_days")) {
  db.exec(`
    UPDATE ad_notify_policies SET password_days = notification_days
      WHERE password_days IS NULL AND notification_days IS NOT NULL;
    ALTER TABLE ad_notify_policies DROP COLUMN notification_days;
  `);
  console.log("  ~ ad_notify_policies.notification_days -> password_days");
}

// TOTP two-factor. Secret stored encrypted; enabled after a confirmed code;
// required is an admin's demand that forces enrolment at the next login.
addColumn("users", "mfa_secret text", "mfa_secret");
addColumn("users", "mfa_enabled integer DEFAULT 0 NOT NULL", "mfa_enabled");
addColumn("users", "mfa_required integer DEFAULT 0 NOT NULL", "mfa_required");

// Guards against a double-submitted "add item" form. A database that already
// contains duplicates cannot take the index; refuse loudly rather than crash on
// every start, and leave the rows for a human to merge.
const duplicates = db
  .prepare(
    `SELECT type, identifier, port, COUNT(*) c FROM services
     GROUP BY type, identifier, port HAVING c > 1`
  )
  .all();

if (duplicates.length > 0) {
  console.warn(
    `[init-db] UWAGA: pomijam unikalny indeks services — ${duplicates.length} zduplikowanych pozycji:`
  );
  for (const d of duplicates) console.warn(`  ${d.type} ${d.identifier}:${d.port} (${d.c}x)`);
  console.warn("[init-db] usuń nadmiarowe wiersze, aby włączyć ochronę przed duplikatami.");
} else {
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_services_type_identifier_port
       ON services (type, identifier, port)`
  );
}

// The audit log used to store the client IP. It is no longer collected, and the
// column goes with the rows it holds: keeping personal data nobody reads is the
// worst of both worlds.
if (columnExists("audit_log", "ip")) {
  db.exec("ALTER TABLE audit_log DROP COLUMN ip");
  console.log("  - audit_log.ip (usunieto kolumne wraz z zapisanymi adresami)");
}

// The Gmail OAuth provider was removed: SMTP covers the same case without a
// Google Cloud project, a verified consent screen and a stored refresh token.
// Drop the leftovers rather than leave an encrypted credential nobody reads.
const googleKeys = db
  .prepare("SELECT key FROM settings WHERE key LIKE 'google_oauth_%'")
  .all()
  .map((r) => r.key);

if (googleKeys.length > 0) {
  db.prepare("DELETE FROM settings WHERE key LIKE 'google_oauth_%'").run();
  console.log(`  - usunieto ${googleKeys.length} kluczy google_oauth_* z ustawien`);
}

const provider = db.prepare("SELECT value FROM settings WHERE key = 'email_provider'").get();
if (provider && provider.value === "gmail_oauth") {
  db.prepare("UPDATE settings SET value = 'smtp' WHERE key = 'email_provider'").run();
  console.warn("[init-db] UWAGA: dostawca poczty gmail_oauth zostal usuniety — przelaczono na smtp, uzupelnij ustawienia SMTP.");
}

console.log("[init-db] schema ready");
db.close();
