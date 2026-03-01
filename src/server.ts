import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { memoryForget, memorySearch, memoryStore } from "./tools.js";
import { KNOWLEDGE_PATH, SYNC_ON_START } from "./config.js";
import { getDb } from "./db.js";
import { initKnowledgeWatcher, syncKnowledge } from "./knowledge.js";

const server = new McpServer({
  name: "claudecode-oepnclaw-mem",
  version: "0.1.0",
});

server.registerTool(
  "memory_store",
  {
    title: "Memory Store",
    description: "写入一条长期记忆",
    inputSchema: {
      text: z.string(),
      category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional(),
    },
  },
  async (input) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(memoryStore(input)),
      },
    ],
  }),
);

server.registerTool(
  "memory_search",
  {
    title: "Memory Search",
    description: "根据查询返回相关记忆（关键词检索）",
    inputSchema: {
      query: z.string(),
      limit: z.number().optional(),
    },
  },
  async (input) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(memorySearch(input)),
      },
    ],
  }),
);

server.registerTool(
  "memory_forget",
  {
    title: "Memory Forget",
    description: "删除一条记忆",
    inputSchema: {
      id: z.string(),
    },
  },
  async (input) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(memoryForget(input)),
      },
    ],
  }),
);

async function main() {
  // 启动时首次同步知识索引
  if (KNOWLEDGE_PATH && SYNC_ON_START) {
    syncKnowledge(getDb());
  }

  // 可选 watcher
  let stopWatcher: (() => void) | null = null;
  if (KNOWLEDGE_PATH) {
    stopWatcher = initKnowledgeWatcher();
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (stopWatcher) {
    process.on("exit", () => stopWatcher?.());
  }
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
