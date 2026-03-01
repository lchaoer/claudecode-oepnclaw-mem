import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CHUNK_OVERLAP_TOKENS,
  CHUNK_TOKENS,
  SESSIONS_PATH,
  SYNC_COOLDOWN_MS,
} from "./config.js";

// 同步冷却
let lastSessionSyncTime = 0;

// ============ 类型 ============

type SessionMessage = {
  type: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
};

type FileInfo = {
  relativePath: string;
  absolutePath: string;
  mtime: number;
  size: number;
};

type ChunkResult = {
  text: string;
  startIdx: number;
  endIdx: number;
  hash: string;
  startTime: number;
  endTime: number;
};

// ============ Schema ============

export function initSessionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_files (
      path     TEXT PRIMARY KEY,
      hash     TEXT NOT NULL,
      mtime    INTEGER NOT NULL,
      size     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_chunks (
      id         TEXT PRIMARY KEY,
      file_path  TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project    TEXT,
      text       TEXT NOT NULL,
      start_idx  INTEGER NOT NULL,
      end_idx    INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      start_time INTEGER NOT NULL DEFAULT 0,
      end_time   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sc_file_path ON session_chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_sc_session_id ON session_chunks(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_chunks_fts
    USING fts5(text, id UNINDEXED, file_path UNINDEXED, session_id UNINDEXED, tokenize='unicode61');
  `);

  // 迁移：补充 start_time / end_time 列（旧库兼容）
  const cols = db.prepare("PRAGMA table_info(session_chunks)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("start_time")) {
    db.exec("ALTER TABLE session_chunks ADD COLUMN start_time INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.has("end_time")) {
    db.exec("ALTER TABLE session_chunks ADD COLUMN end_time INTEGER NOT NULL DEFAULT 0");
  }
}

// ============ 工具函数 ============

function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function approxTokenCount(text: string): number {
  if (text.length === 0) return 0;
  const asciiCount = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAsciiCount = text.length - asciiCount;
  const asciiTokens = Math.ceil(asciiCount / 4);
  const nonAsciiTokens = nonAsciiCount;
  return Math.max(1, asciiTokens + nonAsciiTokens);
}

/** 扫描 SESSIONS_PATH 下所有子目录中的 .jsonl 文件 */
function listSessionFiles(dir: string): FileInfo[] {
  const results: FileInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 递归进子目录
      results.push(...listSessionFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const stat = fs.statSync(abs);
      results.push({
        relativePath: path.relative(dir, abs).replaceAll("\\", "/"),
        absolutePath: abs,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    }
  }
  return results;
}

type ExtractedMessage = {
  text: string;
  timestamp: number;
};

/** 从会话 JSONL 提取有效的 user/assistant 文本 */
function extractSessionText(filePath: string): {
  messages: ExtractedMessage[];
  sessionId: string;
  project: string;
} {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const messages: ExtractedMessage[] = [];
  let sessionId = "";
  let project = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SessionMessage;

      // 提取 sessionId 和 project
      if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId;
      if (parsed.cwd && !project) project = parsed.cwd;

      // 只处理 user 和 assistant 消息
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;

      const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;

      const contents = parsed.message?.content;
      if (!Array.isArray(contents)) continue;

      for (const block of contents) {
        if (block.type === "text" && block.text && block.text.trim().length > 0) {
          const role = parsed.message?.role === "assistant" ? "[A]" : "[U]";
          messages.push({ text: `${role} ${block.text.trim()}`, timestamp: ts });
        }
      }
    } catch {
      continue;
    }
  }

  return { messages, sessionId, project };
}

// ============ 分块 ============

function chunkMessages(messages: ExtractedMessage[]): ChunkResult[] {
  if (messages.length === 0) return [];

  const chunks: ChunkResult[] = [];
  let current: { msg: ExtractedMessage; idx: number }[] = [];
  let currentTokens = 0;

  function flush() {
    if (current.length === 0) return;
    const text = current.map((e) => e.msg.text).join("\n");
    const timestamps = current.map((e) => e.msg.timestamp).filter((t) => t > 0);
    chunks.push({
      text,
      startIdx: current[0].idx,
      endIdx: current[current.length - 1].idx,
      hash: hashContent(text),
      startTime: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      endTime: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    });
  }

  function carryOverlap() {
    if (CHUNK_OVERLAP_TOKENS <= 0 || current.length === 0) {
      current = [];
      currentTokens = 0;
      return;
    }
    let acc = 0;
    const kept: typeof current = [];
    for (let i = current.length - 1; i >= 0; i--) {
      acc += approxTokenCount(current[i].msg.text) + 1;
      kept.unshift(current[i]);
      if (acc >= CHUNK_OVERLAP_TOKENS) break;
    }
    current = kept;
    currentTokens = kept.reduce((s, e) => s + approxTokenCount(e.msg.text) + 1, 0);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] ?? { text: "", timestamp: 0 };
    const msgTokens = approxTokenCount(msg.text) + 1;
    if (currentTokens + msgTokens > CHUNK_TOKENS && current.length > 0) {
      flush();
      carryOverlap();
    }
    current.push({ msg, idx: i });
    currentTokens += msgTokens;
  }
  flush();
  return chunks;
}

// ============ 同步 ============

export function syncSessions(db: Database.Database): void {
  if (!SESSIONS_PATH) return;

  const files = listSessionFiles(SESSIONS_PATH);
  const diskPaths = new Set(files.map((f) => f.relativePath));

  const dbFiles = db
    .prepare("SELECT path, hash, mtime FROM session_files")
    .all() as Array<{ path: string; hash: string; mtime: number }>;
  const dbMap = new Map(dbFiles.map((f) => [f.path, f]));

  const insertFile = db.prepare(
    "INSERT OR REPLACE INTO session_files (path, hash, mtime, size) VALUES (?, ?, ?, ?)",
  );
  const deleteFileChunks = db.prepare("DELETE FROM session_chunks WHERE file_path = ?");
  const deleteFileFts = db.prepare("DELETE FROM session_chunks_fts WHERE file_path = ?");
  const deleteFile = db.prepare("DELETE FROM session_files WHERE path = ?");
  const insertChunk = db.prepare(
    "INSERT INTO session_chunks (id, file_path, session_id, project, text, start_idx, end_idx, hash, start_time, end_time, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertFts = db.prepare(
    "INSERT INTO session_chunks_fts (text, id, file_path, session_id) VALUES (?, ?, ?, ?)",
  );

  const syncAll = db.transaction(() => {
    for (const file of files) {
      const existing = dbMap.get(file.relativePath);

      // mtime 没变就跳过
      if (existing && existing.mtime === file.mtime) continue;

      // mtime 变了，计算 hash
      const raw = fs.readFileSync(file.absolutePath, "utf-8");
      const fileHash = hashContent(raw);
      if (existing && existing.hash === fileHash) {
        // 内容没变，只更新 mtime
        insertFile.run(file.relativePath, fileHash, file.mtime, file.size);
        continue;
      }

      // 内容变了，重建 chunks
      deleteFileChunks.run(file.relativePath);
      deleteFileFts.run(file.relativePath);

      const { messages, sessionId, project } = extractSessionText(file.absolutePath);
      const chunks = chunkMessages(messages);
      const now = Date.now();

      for (const chunk of chunks) {
        const id = randomUUID();
        insertChunk.run(
          id, file.relativePath, sessionId, project,
          chunk.text, chunk.startIdx, chunk.endIdx, chunk.hash,
          chunk.startTime, chunk.endTime, now,
        );
        insertFts.run(chunk.text, id, file.relativePath, sessionId);
      }

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
  lastSessionSyncTime = Date.now();
}

export function syncSessionsIfNeeded(db: Database.Database): void {
  if (!SESSIONS_PATH) return;
  const now = Date.now();
  if (now - lastSessionSyncTime < SYNC_COOLDOWN_MS) return;
  lastSessionSyncTime = now;

  // 轻量检测：比较文件数量
  const files = listSessionFiles(SESSIONS_PATH);
  const dbCount = db.prepare("SELECT count(*) as c FROM session_files").get() as { c: number };
  if (files.length !== dbCount.c) {
    syncSessions(db);
    return;
  }

  // 抽样检测 mtime
  for (const file of files.slice(0, 20)) {
    const dbFile = db.prepare("SELECT mtime FROM session_files WHERE path = ?").get(file.relativePath) as { mtime: number } | undefined;
    if (!dbFile || dbFile.mtime !== file.mtime) {
      syncSessions(db);
      return;
    }
  }
}

// ============ 搜索 ============

export type SessionSearchResult = {
  id: string;
  sessionId: string;
  project: string;
  snippet: string;
  score: number;
  startTime: number;
  endTime: number;
  updatedAt: number;
};

export function searchSessions(
  db: Database.Database,
  query: string,
  limit: number,
): SessionSearchResult[] {
  const tokens = query
    .replace(/["""''(){}[\]<>!@#$%^&*+=|\\/:;,~`]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return [];

  const ftsQuery = tokens.map((t) => `"${t}"*`).join(" OR ");

  const rows = db
    .prepare(
      `SELECT c.id, c.session_id, c.project, c.text, c.start_time, c.end_time, c.updated_at,
              bm25(session_chunks_fts) AS rank
       FROM session_chunks_fts fts
       JOIN session_chunks c ON fts.id = c.id
       WHERE session_chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, limit * 3) as Array<{
    id: string;
    session_id: string;
    project: string;
    text: string;
    start_time: number;
    end_time: number;
    updated_at: number;
    rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    project: row.project ?? "",
    snippet: row.text,
    score: -row.rank,
    startTime: row.start_time,
    endTime: row.end_time,
    updatedAt: row.end_time || row.updated_at,
  }));
}
