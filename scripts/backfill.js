const { openDatabase } = require("../lib/db-encryption");
const db = openDatabase(process.env.DATABASE_URL || "./ar.db");

console.log("Backfilling identifier and type from legacy data...");

// Make sure identifier gets the value from domain if empty
const update = db.prepare(`
  UPDATE services 
  SET identifier = CASE 
      WHEN identifier IS NULL OR identifier = '' THEN domain 
      ELSE identifier 
    END,
    type = CASE 
      WHEN type IS NULL OR type = '' THEN 'https_cert' 
      ELSE type 
    END
`);
const result = update.run();

console.log("Rows updated:", result.changes);

// Show current state
const rows = db.prepare("SELECT id, type, name, identifier, port, owner FROM services").all();
console.table(rows);

console.log("\nDone.");
