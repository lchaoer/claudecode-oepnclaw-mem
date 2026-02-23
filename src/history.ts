import fs from "node:fs";
import { CLAUDE_HISTORY_PATH } from "./config.js";

export type HistoryEntry = {
  display?: string;
  pastedContents?: Record<string, unknown>;
  timestamp?: number;
  project?: string;
  sessionId?: string;
};

export function readHistoryEntries(): HistoryEntry[] {
  if (!fs.existsSync(CLAUDE_HISTORY_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(CLAUDE_HISTORY_PATH, "utf-8");
  if (!raw.trim()) {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as HistoryEntry;
      entries.push(parsed);
    } catch {
      continue;
    }
  }
  return entries;
}
