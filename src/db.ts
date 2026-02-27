import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { DB_PATH, KNOWLEDGE_PATH } from "./config.js";
import { initKnowledgeSchema } from "./knowledge.js";

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

// 主表
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// 旧库兼容：补充 hash 列
const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
const hasHashColumn = memoryColumns.some((col) => col.name === "hash");
if (!hasHashColumn) {
  db.exec("ALTER TABLE memories ADD COLUMN hash TEXT");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash);
`);

// FTS5 全文索引（tokenize=unicode61 对中英文都友好）
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(id UNINDEXED, text, category UNINDEXED, content=memories, content_rowid=rowid, tokenize='unicode61');
`);

// 触发器：保持 FTS 与主表同步
db.exec(`
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, id, text, category)
    VALUES (new.rowid, new.id, new.text, new.category);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, id, text, category)
    VALUES ('delete', old.rowid, old.id, old.text, old.category);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, id, text, category)
    VALUES ('delete', old.rowid, old.id, old.text, old.category);
    INSERT INTO memories_fts(rowid, id, text, category)
    VALUES (new.rowid, new.id, new.text, new.category);
  END;
`);

// 迁移：把已有的 memories 数据灌入 FTS（如果 FTS 为空的话）
const ftsCount = db.prepare("SELECT count(*) as c FROM memories_fts").get() as { c: number };
const memCount = db.prepare("SELECT count(*) as c FROM memories").get() as { c: number };
if (ftsCount.c === 0 && memCount.c > 0) {
  db.exec("INSERT INTO memories_fts(rowid, id, text, category) SELECT rowid, id, text, category FROM memories;");
}

// 迁移：为已有数据补 hash（若缺失）
const missingHash = db.prepare("SELECT count(*) as c FROM memories WHERE hash IS NULL OR hash = ''").get() as { c: number };
if (missingHash.c > 0) {
  const updateHash = db.prepare("UPDATE memories SET hash = ? WHERE id = ?");
  const rows = db.prepare("SELECT id, text, category FROM memories WHERE hash IS NULL OR hash = ''").all() as Array<{ id: string; text: string; category: string }>;
  const fill = db.transaction(() => {
    for (const row of rows) {
      const hash = createHash("sha256").update(`${row.text}\n${row.category}`, "utf-8").digest("hex");
      updateHash.run(hash, row.id);
    }
  });
  fill();
}

// 知识索引建表（KNOWLEDGE_PATH 非空时）
if (KNOWLEDGE_PATH) {
  initKnowledgeSchema(db);
}

export function getDb() {
  return db;
}
