/**
 * Notification policies for the directory: the ad_notify_policies table (per OU
 * or per account) and the per-account record of which thresholds already fired.
 *
 * The password and the account expire on unrelated clocks, so each side carries
 * its own switch and its own thresholds. An older build had a single
 * `notification_days` column; its value becomes the password thresholds, which is
 * what it actually governed, and the column goes.
 *
 * Idempotent; safe to re-run.
 *
 *   node scripts/migrate-ad-notify.js
 */
const { openDatabase } = require("../lib/db-encryption");

const db = openDatabase(process.env.DATABASE_URL || "./ar.db");

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function addColumn(table, ddl, name) {
  if (columnExists(table, name)) {
    console.log(`- ${table}.${name} already exists`);
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  console.log(`✓ Added column: ${table}.${name}`);
}

console.log("Applying AD notification schema changes...");

if (!tableExists("ad_accounts")) {
  console.error("✗ Table ad_accounts is missing. Run scripts/migrate-ad.js first.");
  process.exit(1);
}

if (tableExists("ad_notify_policies")) {
  console.log("- table ad_notify_policies already exists");
} else {
  db.exec(`
    CREATE TABLE ad_notify_policies (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      scope text NOT NULL,
      target text NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      notify_password integer DEFAULT 1 NOT NULL,
      password_days text,
      notify_account integer DEFAULT 1 NOT NULL,
      account_days text,
      muted_until integer,
      notify_recipients text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX idx_ad_notify_scope_target ON ad_notify_policies (scope, target);
  `);
  console.log("✓ Created table: ad_notify_policies");
}

addColumn("ad_notify_policies", "notify_password integer DEFAULT 1 NOT NULL", "notify_password");
addColumn("ad_notify_policies", "password_days text", "password_days");
addColumn("ad_notify_policies", "notify_account integer DEFAULT 1 NOT NULL", "notify_account");
addColumn("ad_notify_policies", "account_days text", "account_days");

// The single-threshold build governed the password expiry, whatever the column
// was called. Carry the value across, then drop the column so nothing reads it.
if (columnExists("ad_notify_policies", "notification_days")) {
  db.transaction(() => {
    const moved = db
      .prepare("UPDATE ad_notify_policies SET password_days = notification_days WHERE password_days IS NULL AND notification_days IS NOT NULL")
      .run().changes;
    db.exec("ALTER TABLE ad_notify_policies DROP COLUMN notification_days");
    console.log(`✓ Moved notification_days -> password_days (${moved} rows) and dropped the column`);
  })();
}

// Kept on the account, not on the policy: one OU policy covers many accounts,
// and "which threshold already fired" is a fact about each of them separately.
addColumn("ad_accounts", "notified_thresholds text DEFAULT '[]' NOT NULL", "notified_thresholds");
addColumn("ad_accounts", "last_notified_at integer", "last_notified_at");

console.log("Done.");
db.close();
