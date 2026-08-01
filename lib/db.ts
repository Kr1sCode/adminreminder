import { drizzle } from "drizzle-orm/better-sqlite3";
import { openDatabase } from "./db-encryption";
import * as schema from "@/db/schema";

const dbPath = process.env.DATABASE_URL || "./ar.db";

// Create the SQLite connection (singleton pattern). Transparently encrypted
// with SQLCipher when DB_ENCRYPTION_KEY is set — see lib/db-encryption.js.
const sqlite = openDatabase(dbPath);

export const db = drizzle(sqlite, { schema });

export { sqlite };
