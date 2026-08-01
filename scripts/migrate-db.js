const { openDatabase } = require("../lib/db-encryption");
const db = openDatabase(process.env.DATABASE_URL || "./ar.db");

console.log("Starting schema migration for generalized expiry tracker...");

// Helper to add column safely
function addColumn(name, type, defaultClause = "") {
  try {
    const sql = `ALTER TABLE services ADD COLUMN ${name} ${type} ${defaultClause}`.trim();
    db.exec(sql);
    console.log("✓ Added column:", name);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("duplicate column name")) {
      console.log("- Column already exists:", name);
    } else {
      console.error("✗ Error adding column", name, ":", msg);
    }
  }
}

// Add new columns
addColumn("type", "TEXT", "DEFAULT 'https_cert' NOT NULL");
addColumn("identifier", "TEXT");
addColumn("renewal_url", "TEXT");

// Backfill data from old 'domain' column
try {
  const stmt = db.prepare(`
    UPDATE services 
    SET identifier = COALESCE(identifier, domain),
        type = COALESCE(NULLIF(type, ''), 'https_cert')
    WHERE (identifier IS NULL OR identifier = '') AND domain IS NOT NULL
  `);
  const info = stmt.run();
  console.log(`✓ Backfilled ${info.changes} rows (domain → identifier)`);
} catch (e) {
  console.error("Data backfill error:", e.message);
}

// Optional: we can leave the old 'domain' column for backward compat during transition

console.log("\nMigration finished successfully.");
console.log("You can now use the generalized 'items' model (certificates + warranties + Azure secrets etc).");
