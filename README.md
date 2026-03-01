# claudecode-infinite-memory

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
| `MCP_MEMORY_CHUNK_TOKENS` | `400` | 知识索引分块大小（近似 token） |
| `MCP_MEMORY_CHUNK_OVERLAP_TOKENS` | `80` | 分块重叠大小（近似 token） |
| `MCP_MEMORY_SYNC_COOLDOWN_MS` | `5000` | 搜索前增量同步冷却时间（ms） |
| `MCP_MEMORY_SYNC_ON_START` | `true` | 启动时是否全量同步知识索引 |
| `MCP_MEMORY_WATCH` | `false` | 是否启用知识目录文件监听 |
| `MCP_MEMORY_WATCH_DEBOUNCE_MS` | `1500` | 文件监听防抖时间（ms） |

## 4. 工具接口

- `memory_store(text, category?)` — 写入一条长期记忆（带去重）
- `memory_search(query, limit?)` — 搜索记忆（合并三个数据源）
- `memory_forget(id)` — 删除一条记忆

### 4.0 memory_store 去重说明

- 使用 `sha256(text + category)` 作为唯一 hash
- SQLite `UNIQUE(hash)` 强制去重
- 重复写入返回 `action: "duplicate"`（成功则 `action: "stored"`）

### 4.1 memory_search 数据源

`memory_search` 会从三个来源检索并合并排序：

1. **长期记忆（memories）**：FTS5 全文检索 + bm25 排名，LIKE 兜底
2. **会话历史（history.jsonl）**：关键词评分匹配用户历史 prompt
3. **知识索引（knowledge_chunks）**：对知识目录 `.md` 文件分块后的 FTS5 检索

**排序策略**：
- 先对每个来源取 **TopK** 候选（`limit * 5`，上限 50）
- 再统一重排：`score + 重要度加权`（来源权重 + 结构权重 + 类别权重）
- 按 `finalScore` 降序 + 时间降序取 Top N

## 5. 知识索引功能（第二层记忆）

设置 `MCP_MEMORY_KNOWLEDGE_PATH` 指向一个目录，往里面放 `.md` 文件即可。

**工作原理**：
- **启动时**：全量扫描目录 → 近似 token 分块（默认 400 token/块，80 token 重叠）→ 建 FTS5 索引
- **搜索时**：冷却期 + 变更检测 → 有变化时增量重建
- **增量同步**：mtime 变更触发 hash 校验，只重建变化文件的 chunks
- **删除同步**：磁盘上不存在的文件自动清理对应 chunks
- **配置变更重建**：修改 chunk 参数后自动触发全量重建（通过 `knowledge_meta` 检测）
- **文件监听（可选）**：设置 `MCP_MEMORY_WATCH=true` 启用 fs.watch，1.5s 防抖后标记 dirty

**不设置 `MCP_MEMORY_KNOWLEDGE_PATH` 时**，该功能完全静默跳过，不影响现有功能。

### 5.1 与 OpenClaw 第二层的差异

| 能力 | 本项目 | OpenClaw |
|------|--------|----------|
| 分块策略 | 近似 token（400/80） | 精确 token（400/80） |
| 索引方式 | FTS5 BM25 | FTS5 + 向量混合 |
| 语义召回 | 无（仅关键词） | 有（向量嵌入） |
| 会话数据源 | history.jsonl | sessions JSONL 分块索引 |
| 增量同步 | hash/mtime | hash/mtime |
| 文件监听 | fs.watch（可选） | chokidar + 防抖 |
| 安全重建 | 事务内全量清除+重建 | 临时库 → 原子交换 |

**差异原因**：本项目定位为轻量 MCP 实现，暂不引入向量嵌入与外部模型依赖。

## 6. Claude Code 中使用

在 Claude Code 的 MCP 配置（`~/.claude.json`）中新增一个 **stdio** 服务器：

```json
{
  "mcpServers": {
    "claudecode-infinite-memory": {
      "command": "npm",
      "args": ["--prefix", "D:/dev/cc/claudecode-infinite-memory", "run", "-s", "dev"],
      "env": {
        "MCP_MEMORY_DB_PATH": "D:/dev/cc/claudecode-infinite-memory/memory.sqlite",
        "MCP_MEMORY_DEFAULT_LIMIT": "5",
        "MCP_MEMORY_MAX_LIMIT": "20",
        "MCP_MEMORY_CLAUDE_HISTORY_PATH": "C:/Users/13357/.claude/history.jsonl",
        "MCP_MEMORY_KNOWLEDGE_PATH": "D:/dev/cc/knowledge-base",
        "MCP_MEMORY_WATCH": "false"
      }
    }
  }
}
```

> 如果你用的是全局 Claude Code 配置，请把这段合并到你的 `mcpServers` 下。

## 7. 手动验证（可选）

如果你安装了 `mcporter`：

```bash
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-infinite-memory run -s dev" memory_store text="用户偏好中文回复" category=preference
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-infinite-memory run -s dev" memory_search query="中文回复" limit=5
```
