import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { KNOWLEDGE_PATH } from "./config.js";

// 分块参数
const MAX_CHARS = 800;
const OVERLAP_CHARS = 160;

// 搜索前同步冷却
const SYNC_COOLDOWN_MS = 5000;
let lastSyncTime = 0;

type ChunkResult = {
  text: string;
  startLine: number;
  endLine: number;
  hash: string;
};

type FileInfo = {
  relativePath: string;
  absolutePath: string;
  mtime: number;
  size: number;
};

// ============ Schema ============

export function initKnowledgeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_files (
      path     TEXT PRIMARY KEY,
      hash     TEXT NOT NULL,
      mtime    INTEGER NOT NULL,
      size     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_chunks (
      id         TEXT PRIMARY KEY,
      file_path  TEXT NOT NULL,
      text       TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line   INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kc_file_path ON knowledge_chunks(file_path);

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
    USING fts5(text, id UNINDEXED, file_path UNINDEXED, tokenize='unicode61');
  `);
}

// ============ 工具函数 ============

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function listMdFiles(dir: string, base?: string): FileInfo[] {
  const results: FileInfo[] = [];
  const baseDir = base ?? dir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listMdFiles(abs, baseDir));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const stat = fs.statSync(abs);
      results.push({
        relativePath: path.relative(baseDir, abs).replaceAll("\\", "/"),
        absolutePath: abs,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    }
  }
  return results;
}

// ============ 分块 ============

export function chunkMarkdown(content: string): ChunkResult[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const chunks: ChunkResult[] = [];
  let current: { line: string; lineNo: number }[] = [];
  let currentChars = 0;

  function flush() {
    if (current.length === 0) return;
    const text = current.map((e) => e.line).join("\n");
    chunks.push({
      text,
      startLine: current[0].lineNo,
      endLine: current[current.length - 1].lineNo,
      hash: hashContent(text),
    });
  }

  function carryOverlap() {
    if (OVERLAP_CHARS <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: typeof current = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += current[i].line.length + 1;
      kept.unshift(current[i]);
      if (acc >= OVERLAP_CHARS) break;
    }
    current = kept;
    currentChars = kept.reduce((s, e) => s + e.line.length + 1, 0);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineSize = line.length + 1;
    if (currentChars + lineSize > MAX_CHARS && current.length > 0) {
      flush();
      carryOverlap();
    }
    current.push({ line, lineNo: i + 1 });
    currentChars += lineSize;
  }
  flush();
  return chunks;
}

// ============ 增量同步 ============

export function syncKnowledge(db: Database.Database): void {
  if (!KNOWLEDGE_PATH) return;

  const files = listMdFiles(KNOWLEDGE_PATH);
  const diskPaths = new Set(files.map((f) => f.relativePath));

  // 获取 DB 中的文件记录
  const dbFiles = db
    .prepare("SELECT path, hash, mtime FROM knowledge_files")
    .all() as Array<{ path: string; hash: string; mtime: number }>;
  const dbMap = new Map(dbFiles.map((f) => [f.path, f]));

  const insertFile = db.prepare(
    "INSERT OR REPLACE INTO knowledge_files (path, hash, mtime, size) VALUES (?, ?, ?, ?)",
  );
  const deleteFileChunks = db.prepare("DELETE FROM knowledge_chunks WHERE file_path = ?");
  const deleteFileFts = db.prepare("DELETE FROM knowledge_chunks_fts WHERE file_path = ?");
  const deleteFile = db.prepare("DELETE FROM knowledge_files WHERE path = ?");
  const insertChunk = db.prepare(
    "INSERT INTO knowledge_chunks (id, file_path, text, start_line, end_line, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO knowledge_chunks_fts (text, id, file_path) VALUES (?, ?, ?)",
  );

  const syncAll = db.transaction(() => {
    for (const file of files) {
      const content = fs.readFileSync(file.absolutePath, "utf-8");
      const fileHash = hashContent(content);
      const existing = dbMap.get(file.relativePath);

      // hash 相同，跳过
      if (existing && existing.hash === fileHash) continue;

      // 删除旧 chunks + FTS
      deleteFileChunks.run(file.relativePath);
      deleteFileFts.run(file.relativePath);

      // 分块并插入
      const chunks = chunkMarkdown(content);
      const now = Date.now();
      for (const chunk of chunks) {
        const id = randomUUID();
        insertChunk.run(id, file.relativePath, chunk.text, chunk.startLine, chunk.endLine, chunk.hash, now);
        insertFts.run(chunk.text, id, file.relativePath);
      }

      // 更新文件记录
      insertFile.run(file.relativePath, fileHash, file.mtime, file.size);
    }

    // 清理已删除的文件
    for (const dbFile of dbFiles) {
      if (!diskPaths.has(dbFile.path)) {
        deleteFileChunks.run(dbFile.path);
        deleteFileFts.run(dbFile.path);
        deleteFile.run(dbFile.path);
      }
    }
  });

  syncAll();
  lastSyncTime = Date.now();
}

// ============ 轻量变更检测 ============

function hasKnowledgeChanges(db: Database.Database): boolean {
  if (!KNOWLEDGE_PATH) return false;

  const files = listMdFiles(KNOWLEDGE_PATH);
  const dbFiles = db
    .prepare("SELECT path, mtime FROM knowledge_files")
    .all() as Array<{ path: string; mtime: number }>;
  const dbMap = new Map(dbFiles.map((f) => [f.path, f.mtime]));

  // 文件数量不同
  if (files.length !== dbMap.size) return true;

  // 逐个比较 mtime
  for (const file of files) {
    const dbMtime = dbMap.get(file.relativePath);
    if (dbMtime === undefined || dbMtime !== file.mtime) return true;
  }
  return false;
}

export function syncKnowledgeIfNeeded(db: Database.Database): void {
  if (!KNOWLEDGE_PATH) return;
  const now = Date.now();
  if (now - lastSyncTime < SYNC_COOLDOWN_MS) return;
  lastSyncTime = now;
  if (hasKnowledgeChanges(db)) {
    syncKnowledge(db);
  }
}

// ============ 搜索 ============

export type KnowledgeSearchResult = {
  id: string;
  path: string;
  snippet: string;
  startLine: number;
  endLine: number;
  score: number;
  updatedAt: number;
};

export function searchKnowledge(
  db: Database.Database,
  query: string,
  limit: number,
): KnowledgeSearchResult[] {
  const tokens = query
    .replace(/["""''(){}[\]<>!@#$%^&*+=|\\/:;,~`]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return [];

  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" OR ");

  const rows = db
    .prepare(
      `SELECT c.id, c.file_path, c.text, c.start_line, c.end_line, c.updated_at,
              bm25(knowledge_chunks_fts) AS rank
       FROM knowledge_chunks_fts fts
       JOIN knowledge_chunks c ON fts.id = c.id
       WHERE knowledge_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, limit * 3) as Array<{
    id: string;
    file_path: string;
    text: string;
    start_line: number;
    end_line: number;
    updated_at: number;
    rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.file_path,
    snippet: row.text,
    startLine: row.start_line,
    endLine: row.end_line,
    score: -row.rank,
    updatedAt: row.updated_at,
  }));
}
