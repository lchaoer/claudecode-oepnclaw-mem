import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
`);

export function getDb() {
  return db;
}
