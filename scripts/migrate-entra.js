/**
 * Adds the `source` column to ad_accounts and scopes the objectGUID uniqueness
 * per source, so on-prem AD and cloud Entra ID accounts can share the table.
 * Idempotent; safe to re-run.
 *
 *   node scripts/migrate-entra.js
 */
const Database = require("better-sqlite3");

const db = new Database(process.env.DATABASE_URL || "./ar.db");

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}
function indexExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
}

console.log("Applying Entra ID schema changes...");

if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ad_accounts'").get()) {
  console.error("✗ Table ad_accounts is missing. Run scripts/migrate-ad.js first.");
  process.exit(1);
}

if (columnExists("ad_accounts", "source")) {
  console.log("- ad_accounts.source already exists");
} else {
  db.exec("ALTER TABLE ad_accounts ADD COLUMN source text DEFAULT 'ad' NOT NULL");
  console.log("✓ Added column: ad_accounts.source");
}

// Replace the single-column unique index with a (source, object_guid) one.
db.transaction(() => {
  if (indexExists("ad_accounts_object_guid_unique")) {
    db.exec("DROP INDEX ad_accounts_object_guid_unique");
    console.log("✓ Dropped old unique index on object_guid");
  }
  if (!indexExists("idx_ad_accounts_source_guid")) {
    db.exec("CREATE UNIQUE INDEX idx_ad_accounts_source_guid ON ad_accounts (source, object_guid)");
    console.log("✓ Created unique index on (source, object_guid)");
  } else {
    console.log("- unique index (source, object_guid) already exists");
  }
})();

console.log("Done.");
db.close();
