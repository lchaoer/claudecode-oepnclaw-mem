import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./config.js";

export const memoryStoreSchema = z.object({
  text: z.string().trim().min(1, "text 不能为空"),
  category: z
    .enum(["preference", "fact", "decision", "entity", "other"])
    .optional()
    .default("other"),
});

export const memorySearchSchema = z.object({
  query: z.string().trim().min(1, "query 不能为空"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .default(DEFAULT_LIMIT),
});

export const memoryForgetSchema = z.object({
  id: z.string().trim().min(1, "id 不能为空"),
});

