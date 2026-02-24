# claudecode-oepnclaw-mem

> 基于 SQLite + FTS5 全文检索的 MCP 记忆服务（stdio），支持长期记忆、会话历史、知识索引三源合并检索。

## 1. 运行环境

- Node.js 18+（建议 20+）
- 已在本项目执行过 `npm install`

## 2. 本地运行（stdio）

```bash
npm run dev
```

这会启动 MCP server（stdio 模式），用于 Claude Code 连接。

如需生成产物：

```bash
npm run build
npm start
```

## 3. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_MEMORY_DB_PATH` | `./memory.sqlite` | SQLite 数据库路径 |
| `MCP_MEMORY_CLAUDE_HISTORY_PATH` | `C:/Users/13357/.claude/history.jsonl` | Claude Code 会话历史文件路径 |
| `MCP_MEMORY_KNOWLEDGE_PATH` | （空，不启用） | 知识目录路径，放入 `.md` 文件自动索引 |
| `MCP_MEMORY_DEFAULT_LIMIT` | `5` | 默认搜索结果数 |
| `MCP_MEMORY_MAX_LIMIT` | `20` | 最大搜索结果数 |

## 4. 工具接口

- `memory_store(text, category?)` — 写入一条长期记忆
- `memory_search(query, limit?)` — 搜索记忆（合并三个数据源）
- `memory_forget(id)` — 删除一条记忆

### 4.1 memory_search 数据源

`memory_search` 会从三个来源检索并合并排序：

1. **长期记忆（memories）**：FTS5 全文检索 + bm25 排名，LIKE 兜底
2. **会话历史（history.jsonl）**：关键词评分匹配用户历史 prompt
3. **知识索引（knowledge_chunks）**：对知识目录 `.md` 文件分块后的 FTS5 检索

三个来源按 score 降序 + 时间降序合并，返回 Top N。

## 5. 知识索引功能

设置 `MCP_MEMORY_KNOWLEDGE_PATH` 指向一个目录，往里面放 `.md` 文件即可。

**工作原理**：
- **启动时**：全量扫描目录 → 分块（800 字符/块，160 字符重叠）→ 建 FTS5 索引
- **搜索时**：5 秒冷却 + mtime 变更检测 → 有变化时增量重建
- **增量同步**：通过 SHA-256 hash 检测文件变化，只重建变化文件的 chunks

**不设置 `MCP_MEMORY_KNOWLEDGE_PATH` 时**，该功能完全静默跳过，不影响现有功能。

## 6. Claude Code 中使用

在 Claude Code 的 MCP 配置（`~/.claude.json`）中新增一个 **stdio** 服务器：

```json
{
  "mcpServers": {
    "claudecode-oepnclaw-mem": {
      "command": "npm",
      "args": ["--prefix", "D:/dev/cc/claudecode-oepnclaw-mem", "run", "-s", "dev"],
      "env": {
        "MCP_MEMORY_DB_PATH": "D:/dev/cc/claudecode-oepnclaw-mem/memory.sqlite",
        "MCP_MEMORY_DEFAULT_LIMIT": "5",
        "MCP_MEMORY_MAX_LIMIT": "20",
        "MCP_MEMORY_CLAUDE_HISTORY_PATH": "C:/Users/13357/.claude/history.jsonl",
        "MCP_MEMORY_KNOWLEDGE_PATH": "D:/dev/cc/knowledge-base"
      }
    }
  }
}
```

> 如果你用的是全局 Claude Code 配置，请把这段合并到你的 `mcpServers` 下。

## 7. 手动验证（可选）

如果你安装了 `mcporter`：

```bash
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-oepnclaw-mem run -s dev" memory_store text="用户偏好中文回复" category=preference
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-oepnclaw-mem run -s dev" memory_search query="中文回复" limit=5
```
