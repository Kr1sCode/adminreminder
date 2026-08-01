/**
 * Applies the ad_accounts table and users.auth_source column.
 *
 * The project's drizzle migration history drifted from the real database
 * (settings + services.last_notified_at were added by migrate-db.js, and there
 * is no __drizzle_migrations table), so `drizzle-kit migrate` would fail. This
 * script applies only what is missing, and is safe to run more than once.
 *
 *   node scripts/migrate-ad.js
 */
const { openDatabase } = require("../lib/db-encryption");

const db = openDatabase(process.env.DATABASE_URL || "./ar.db");

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

console.log("Applying AD schema changes...");

if (tableExists("ad_accounts")) {
  console.log("- ad_accounts already exists");
} else {
  db.exec(`
    CREATE TABLE ad_accounts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
    CREATE UNIQUE INDEX ad_accounts_object_guid_unique ON ad_accounts (object_guid);
    CREATE INDEX idx_ad_accounts_sam ON ad_accounts (sam_account_name);
    CREATE INDEX idx_ad_accounts_ou ON ad_accounts (ou_path);
    CREATE INDEX idx_ad_accounts_kind ON ad_accounts (kind);
  `);
  console.log("✓ Created table: ad_accounts");
}

if (columnExists("users", "auth_source")) {
  console.log("- users.auth_source already exists");
} else {
  db.exec("ALTER TABLE users ADD COLUMN auth_source text DEFAULT 'local' NOT NULL");
  console.log("✓ Added column: users.auth_source");
}

console.log("Done.");
db.close();
