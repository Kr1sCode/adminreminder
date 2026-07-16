import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "@/db/schema";

const dbPath = process.env.DATABASE_URL || "./ar.db";

// Create the SQLite connection (singleton pattern)
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL"); // better performance & concurrency
sqlite.pragma("foreign_keys = ON");  // ensure cascades and constraints work

export const db = drizzle(sqlite, { schema });

export { sqlite };
