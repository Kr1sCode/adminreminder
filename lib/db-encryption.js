// Shared by lib/db.ts (the app's runtime connection) and scripts/init-db.js
// (the standalone schema bootstrap that runs before the server starts) — both
// need the exact same encryption-detection logic, and it must not drift
// between two copies. Plain CommonJS, no path aliases: init-db.js runs via
// `node scripts/init-db.js` outside Next's module system entirely.
"use strict";

const Database = require("better-sqlite3-multiple-ciphers");

/** Fails if the connection cannot actually read the schema, however it opened. */
function verifyReadable(db) {
  db.prepare("SELECT count(*) FROM sqlite_master").get();
}

function applyCipherPragmas(db) {
  // "legacy=4" pins the SQLCipher-compatible KDF/page format so a key
  // generated today keeps opening the same way after a future upgrade of
  // this dependency, rather than silently following whatever the library's
  // current default cipher profile happens to be.
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
}

/**
 * Opens the SQLite database, transparently encrypting it with SQLCipher when
 * DB_ENCRYPTION_KEY is set. Three cases, in order:
 *
 *  1. No key configured: open exactly as plain better-sqlite3 always did. If
 *     the file turns out to be encrypted anyway (the key was removed from
 *     .env by mistake), fail loudly here rather than on some unrelated query
 *     deep in the app later.
 *  2. Key configured, file already encrypted with it (including a brand new
 *     empty file — PRAGMA key on an empty file establishes its encryption
 *     from that point on, no rekey needed): opens normally.
 *  3. Key configured, file is still plaintext with existing data (the common
 *     case: encryption turned on for an install that predates it): rekey it
 *     in place. better-sqlite3-multiple-ciphers writes the encrypted file
 *     directly; there is no separate export/import step.
 *
 * A wrong key and file corruption both surface as the same SQLCipher error
 * ("file is not a database") and are reported the same way — there is no
 * reliable way to tell them apart from outside the library.
 */
function openDatabase(dbPath) {
  const key = process.env.DB_ENCRYPTION_KEY;

  if (!key) {
    const db = new Database(dbPath);
    try {
      verifyReadable(db);
    } catch {
      db.close();
      throw new Error(
        `Baza ${dbPath} jest zaszyfrowana, ale DB_ENCRYPTION_KEY nie jest ustawiony. ` +
          "Ustaw DB_ENCRYPTION_KEY na klucz użyty do zaszyfrowania tej bazy."
      );
    }
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  }

  let db = new Database(dbPath);
  applyCipherPragmas(db);
  db.pragma(`key='${key}'`);
  try {
    verifyReadable(db);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch {
    db.close();
  }

  // Not readable as an already-encrypted file under this key. The only other
  // legitimate possibility is a pre-existing plaintext database; anything
  // else (wrong key, corruption) fails the same plaintext check too.
  db = new Database(dbPath);
  try {
    verifyReadable(db);
  } catch {
    db.close();
    throw new Error(
      `Nie można otworzyć bazy ${dbPath}: zły DB_ENCRYPTION_KEY albo uszkodzony plik.`
    );
  }

  applyCipherPragmas(db);
  // SQLCipher refuses to rekey a database that is in WAL mode (a real case
  // here: every prior plain run of this app already switched it to WAL for
  // concurrency). Drop to the rollback journal for the rewrite, then switch
  // back once the file is actually encrypted.
  db.pragma("journal_mode = DELETE");
  db.pragma(`rekey='${key}'`);
  console.log(`[db-encryption] baza zaszyfrowana po raz pierwszy: ${dbPath}`);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

module.exports = { openDatabase };
