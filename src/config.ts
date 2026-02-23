export const DB_PATH = process.env.MCP_MEMORY_DB_PATH ?? "./memory.sqlite";
export const DEFAULT_LIMIT = Number(process.env.MCP_MEMORY_DEFAULT_LIMIT ?? 5);
export const MAX_LIMIT = Number(process.env.MCP_MEMORY_MAX_LIMIT ?? 20);
export const CLAUDE_HISTORY_PATH =
  process.env.MCP_MEMORY_CLAUDE_HISTORY_PATH ?? "C:/Users/13357/.claude/history.jsonl";
