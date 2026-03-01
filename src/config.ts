export const DB_PATH = process.env.MCP_MEMORY_DB_PATH ?? "./memory.sqlite";
export const DEFAULT_LIMIT = Number(process.env.MCP_MEMORY_DEFAULT_LIMIT ?? 5);
export const MAX_LIMIT = Number(process.env.MCP_MEMORY_MAX_LIMIT ?? 20);
export const CLAUDE_HISTORY_PATH =
  process.env.MCP_MEMORY_CLAUDE_HISTORY_PATH ?? "C:/Users/13357/.claude/history.jsonl";
export const KNOWLEDGE_PATH = process.env.MCP_MEMORY_KNOWLEDGE_PATH ?? "";

export const CHUNK_TOKENS = Number(process.env.MCP_MEMORY_CHUNK_TOKENS ?? 400);
export const CHUNK_OVERLAP_TOKENS = Number(process.env.MCP_MEMORY_CHUNK_OVERLAP_TOKENS ?? 80);
export const SYNC_COOLDOWN_MS = Number(process.env.MCP_MEMORY_SYNC_COOLDOWN_MS ?? 5000);
export const SYNC_ON_START = (process.env.MCP_MEMORY_SYNC_ON_START ?? "true") !== "false";
export const WATCH_ENABLED = (process.env.MCP_MEMORY_WATCH ?? "false") === "true";
export const WATCH_DEBOUNCE_MS = Number(process.env.MCP_MEMORY_WATCH_DEBOUNCE_MS ?? 1500);
