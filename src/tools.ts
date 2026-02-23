import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { readHistoryEntries } from "./history.js";
import { memoryForgetSchema, memorySearchSchema, memoryStoreSchema } from "./validators.js";
import type { MemorySearchResult } from "./types.js";

const SCORE_MATCH = 10;
const SCORE_OCCURRENCE = 2;
const SCORE_EARLY = 5;
const SCORE_LENGTH_PENALTY = 0.02;

function scoreText(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  if (!haystack.includes(needle)) {
    return 0;
  }
  const firstIndex = haystack.indexOf(needle);
  let count = 0;
  let pos = 0;
  while (true) {
    const next = haystack.indexOf(needle, pos);
    if (next === -1) {
      break;
    }
    count += 1;
    pos = next + needle.length;
  }
  const earlyBonus = firstIndex === 0 ? SCORE_EARLY : Math.max(0, SCORE_EARLY - firstIndex / 10);
  const lengthPenalty = text.length * SCORE_LENGTH_PENALTY;
  return SCORE_MATCH + count * SCORE_OCCURRENCE + earlyBonus - lengthPenalty;
}

export function memoryStore(input: unknown) {
  const parsed = memoryStoreSchema.parse(input);
  const id = randomUUID();
  const createdAt = Date.now();
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO memories (id, text, category, created_at) VALUES (?, ?, ?, ?)",
  );
  stmt.run(id, parsed.text, parsed.category, createdAt);
  return { id, createdAt };
}

export function memorySearch(input: unknown) {
  const parsed = memorySearchSchema.parse(input);
  const db = getDb();
  const pattern = `%${parsed.query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = db
    .prepare(
      "SELECT id, text, category, created_at FROM memories WHERE text LIKE ? ESCAPE '\\'",
    )
    .all(pattern) as Array<{ id: string; text: string; category: string; created_at: number }>;

  const dbScored: Array<MemorySearchResult & { createdAt: number }> = rows
    .map((row) => ({
      id: row.id,
      text: row.text,
      category: row.category as MemorySearchResult["category"],
      score: scoreText(row.text, parsed.query),
      createdAt: row.created_at,
    }))
    .filter((row) => row.score > 0);

  const historyScored: Array<MemorySearchResult & { createdAt: number }> = readHistoryEntries()
    .map((entry) => {
      const text = entry.display ?? "";
      return {
        id: entry.sessionId ?? `history:${entry.timestamp ?? "unknown"}`,
        text,
        category: "other",
        score: scoreText(text, parsed.query),
        createdAt: entry.timestamp ?? 0,
      };
    })
    .filter((row) => row.text.length > 0 && row.score > 0);

  const scored = [...dbScored, ...historyScored]
    .sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt))
    .slice(0, parsed.limit)
    .map(({ createdAt, ...rest }) => rest);

  return { results: scored };
}

export function memoryForget(input: unknown) {
  const parsed = memoryForgetSchema.parse(input);
  const db = getDb();
  const stmt = db.prepare("DELETE FROM memories WHERE id = ?");
  const result = stmt.run(parsed.id);
  return { deleted: result.changes > 0 };
}
