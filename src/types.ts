export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "knowledge";

export type MemoryEntry = {
  id: string;
  text: string;
  category: MemoryCategory;
  createdAt: number;
};

export type MemorySearchResult = {
  id: string;
  text: string;
  category: MemoryCategory;
  score: number;
};

export type MessageRole = "user" | "assistant";
