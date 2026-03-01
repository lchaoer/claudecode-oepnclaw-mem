# MCP 记忆服务架构文档

> `claudecode-oepnclaw-mem` — 为 Claude Code 提供跨会话长期记忆的 MCP Server。

## 1. 整体架构

```mermaid
graph TB
    subgraph "Claude Code (客户端)"
        U["用户输入"] --> LLM["Claude LLM"]
        LLM -->|MCP stdio| CLIENT["MCP Client"]
    end

    subgraph "MCP Server (claudecode-oepnclaw-mem)"
        CLIENT --> TOOLS["工具层<br/>memory_store / memory_search / memory_forget"]

        TOOLS --> DB["长期记忆<br/>SQLite memories + FTS5"]
        TOOLS --> HIST["会话历史<br/>history.jsonl"]
        TOOLS --> KNOW["知识索引<br/>knowledge_chunks + FTS5"]
    end

    subgraph "外部存储"
        DB --> SQLITE["memory.sqlite"]
        HIST --> JSONL["~/.claude/history.jsonl"]
        KNOW --> MDDIR["知识目录 (.md 文件)"]
    end

    subgraph "可选组件"
        WATCHER["fs.watch 文件监听"]
        META["knowledge_meta 配置检测"]
    end

    WATCHER -.->|dirty 标记| KNOW
    META -.->|配置变更触发全量重建| KNOW

    style LLM fill:#4a90d9,color:#fff
    style TOOLS fill:#7ed321,color:#fff
    style DB fill:#f5a623,color:#fff
    style HIST fill:#f5a623,color:#fff
    style KNOW fill:#f5a623,color:#fff
    style WATCHER fill:#e0e0e0,stroke:#999
    style META fill:#e0e0e0,stroke:#999
```

## 2. 源码结构

```
src/
├── server.ts       # MCP Server 入口，注册工具，启动 stdio 传输，watcher 初始化
├── tools.ts        # 三个工具的业务逻辑（store / search / forget）
├── db.ts           # SQLite 初始化，建表 + FTS5 + 触发器 + 迁移
├── knowledge.ts    # 知识索引：分块、增量同步、meta、watcher、FTS5 搜索
├── history.ts      # 读取 Claude Code history.jsonl
├── validators.ts   # Zod schema 校验
├── config.ts       # 环境变量配置
└── types.ts        # TypeScript 类型定义
```

### 2.1 模块依赖关系

```mermaid
graph LR
    SERVER["server.ts"] --> TOOLS["tools.ts"]
    SERVER --> CONFIG["config.ts"]
    SERVER --> DB["db.ts"]
    SERVER --> KNOWLEDGE["knowledge.ts"]

    TOOLS --> DB
    TOOLS --> HISTORY["history.ts"]
    TOOLS --> KNOWLEDGE
    TOOLS --> VALIDATORS["validators.ts"]
    TOOLS --> CONFIG
    TOOLS --> TYPES["types.ts"]

    DB --> CONFIG
    DB --> KNOWLEDGE
    HISTORY --> CONFIG
    KNOWLEDGE --> CONFIG
    VALIDATORS --> CONFIG
```

## 3. 数据模型

### 3.1 长期记忆（第 3 层）

```sql
-- 主表
CREATE TABLE memories (
  id         TEXT PRIMARY KEY,    -- UUID
  text       TEXT NOT NULL,       -- 记忆文本
  category   TEXT NOT NULL,       -- preference / fact / decision / entity / other
  created_at INTEGER NOT NULL,    -- 时间戳 (ms)
  hash       TEXT                -- sha256(text + category)
);

-- 去重约束
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);

-- FTS5 全文索引（通过触发器自动同步）
CREATE VIRTUAL TABLE memories_fts
USING fts5(id UNINDEXED, text, category UNINDEXED,
           content=memories, content_rowid=rowid, tokenize='unicode61');
```

### 3.2 知识索引（第 2 层）

```sql
-- 文件元数据（增量检测）
CREATE TABLE knowledge_files (
  path  TEXT PRIMARY KEY,    -- 相对于知识目录
  hash  TEXT NOT NULL,       -- SHA-256
  mtime INTEGER NOT NULL,
  size  INTEGER NOT NULL
);

-- 分块内容
CREATE TABLE knowledge_chunks (
  id         TEXT PRIMARY KEY,   -- UUID
  file_path  TEXT NOT NULL,
  text       TEXT NOT NULL,      -- 块内容
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  hash       TEXT NOT NULL,      -- SHA-256
  updated_at INTEGER NOT NULL
);

-- FTS5 全文索引
CREATE VIRTUAL TABLE knowledge_chunks_fts
USING fts5(text, id UNINDEXED, file_path UNINDEXED, tokenize='unicode61');

-- 索引元数据（配置变更检测）
CREATE TABLE knowledge_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**knowledge_meta 存储项**：

| key | 说明 |
|-----|------|
| `chunk_config` | 分块参数签名（tokens/overlap/version），变更时触发全量重建 |
| `last_sync` | 上次同步时间戳 |

### 3.3 会话历史（第 1 层）

不自建存储，直接读取 Claude Code 的 `~/.claude/history.jsonl`。每行一个 JSON 对象：

```json
{ "display": "用户的 prompt", "timestamp": 1708000000000, "project": "/path", "sessionId": "..." }
```

## 4. 工作流程

### 4.1 memory_store — 写入记忆

```mermaid
flowchart LR
    A["memory_store(text, category)"] --> B["Zod 校验"]
    B --> C["生成 UUID + hash"]
    C --> D["INSERT OR IGNORE INTO memories"]
    D --> E{是否重复?}
    E -->|是| F["返回 action=duplicate"]
    E -->|否| G["触发器同步到 FTS5"]
    G --> H["返回 action=stored"]
```

### 4.2 memory_search — 搜索记忆

```mermaid
flowchart TD
    A["memory_search(query, limit)"] --> B["Zod 校验"]

    B --> C1["① 长期记忆检索"]
    C1 --> C1a["FTS5 MATCH + bm25 → TopK"]
    C1a --> C1b{有结果?}
    C1b -->|否| C1c["LIKE 兜底 + 手动评分 → TopK"]
    C1b -->|是| MERGE
    C1c --> MERGE

    B --> C2["② 会话历史检索"]
    C2 --> C2a["读取 history.jsonl"]
    C2a --> C2b["关键词评分 → TopK"]
    C2b --> MERGE

    B --> C3["③ 知识库检索"]
    C3 --> C3a["syncKnowledgeIfNeeded()"]
    C3a --> C3b["FTS5 MATCH + bm25 → TopK"]
    C3b --> MERGE

    MERGE["合并候选"] --> RERANK["重要度加权重排"]
    RERANK --> SORT["按 finalScore 降序 + 时间降序"]
    SORT --> TOP["取 Top N"]
    TOP --> OUT["返回 {results}"]
```

### 4.3 memory_forget — 删除记忆

```mermaid
flowchart LR
    A["memory_forget(id)"] --> B["Zod 校验"]
    B --> C["DELETE FROM memories"]
    C --> D["触发器同步删除 FTS5"]
    D --> E["返回 {deleted: true/false}"]
```

### 4.4 知识索引同步流程

```mermaid
flowchart TD
    START["启动 / 搜索前触发"] --> META{chunk 配置变更?}
    META -->|是| FULL["全量重建（清库 + 重新分块 + 索引）"]
    META -->|否| CHECK{KNOWLEDGE_PATH 非空?}

    CHECK -->|否| SKIP["跳过"]
    CHECK -->|是| DIRTY{watcher dirty<br/>或 文件变更?}

    DIRTY -->|否| SKIP2["跳过（冷却期内）"]
    DIRTY -->|是| SCAN["递归扫描 .md 文件"]

    SCAN --> COMPARE["mtime 变化 → 计算 hash 对比"]
    COMPARE --> CHANGED{hash 变化?}
    CHANGED -->|否| NEXT["跳过该文件"]
    CHANGED -->|是| DELETE["删除旧 chunks + FTS"]
    DELETE --> CHUNK["重新分块（近似 token：400/80）"]
    CHUNK --> INSERT["插入新 chunks + FTS"]
    INSERT --> NEXT
    NEXT --> CLEAN["清理磁盘已删除的文件记录"]
    CLEAN --> SAVEMETA["更新 knowledge_meta"]

    FULL --> SCAN
```

### 4.5 分块策略

```mermaid
flowchart LR
    A[".md 文件内容"] --> B["按行遍历"]
    B --> C["approxTokenCount 估算 token"]
    C --> D{累计 > CHUNK_TOKENS?}
    D -->|否| E["继续累加"]
    D -->|是| F["flush 当前块"]
    F --> G["保留尾部 overlap"]
    G --> B
```

**近似 token 估算**：
- ASCII 字符：每 4 字符 ≈ 1 token
- 非 ASCII 字符（中文等）：每字符 ≈ 1 token

### 4.6 文件监听（可选）

```mermaid
flowchart LR
    A["fs.watch(KNOWLEDGE_PATH)"] --> B["文件变更事件"]
    B --> C["防抖 1.5s"]
    C --> D["标记 knowledgeDirty = true"]
    D --> E["下次 syncKnowledgeIfNeeded 时触发同步"]
```

- 通过 `MCP_MEMORY_WATCH=true` 启用
- 使用 Node.js 原生 `fs.watch`（recursive 模式）
- 防抖避免频繁触发

## 5. 检索策略

### 5.1 评分与排序

| 数据源 | 检索方式 | 基础评分 |
|--------|----------|----------|
| 长期记忆 | FTS5 MATCH (LIKE 兜底) | `bm25()` 取反 / 手动评分 |
| 会话历史 | 全量扫描 | `scoreText()` 关键词评分 |
| 知识索引 | FTS5 MATCH | `bm25()` 取反 |

**重排策略**：
- 每个来源先取 TopK 候选
- `finalScore = baseScore + importanceBoost`
- `importanceBoost` 由**来源权重 + 结构权重 + 类别权重**组成
- 按 `finalScore` 降序 → `createdAt` 降序取 Top N

### 5.2 重要度加权

- **来源权重**：memory > knowledge > history
- **结构权重**：标题行（`^#`）、列表项（`^-`/`*`/`\d+\.`）、代码块（` ``` `）
- **类别权重**：`decision`、`preference` 适度加权

### 5.3 FTS5 查询构造

```
原始 query: "API 配置方法"
  → 分词: ["API", "配置方法"]
  → FTS5 query: "API"* OR "配置方法"*
```

- 标点符号替换为空格
- 每个 token 加 `"..."*` 支持前缀匹配
- 多个 token 用 `OR` 连接
- unicode61 tokenizer 支持中英文

## 6. 启动流程

```mermaid
sequenceDiagram
    participant Main as server.ts main()
    participant DB as db.ts
    participant Knowledge as knowledge.ts
    participant MCP as McpServer

    Main->>DB: import getDb() (触发模块初始化)
    DB->>DB: 建 memories 表 + FTS5 + 触发器
    DB->>DB: FTS 迁移（灌入已有数据）
    DB->>DB: hash 列迁移（旧库兼容）
    DB->>Knowledge: initKnowledgeSchema() (如 KNOWLEDGE_PATH 非空)
    Knowledge->>DB: 建 knowledge_files / knowledge_chunks / FTS5 / meta 表

    alt SYNC_ON_START = true
        Main->>Knowledge: syncKnowledge() (全量同步)
        Knowledge->>Knowledge: 扫描 .md → 近似 token 分块 → 入库
    end

    alt WATCH_ENABLED = true
        Main->>Knowledge: initKnowledgeWatcher()
        Knowledge->>Knowledge: fs.watch + 防抖 → dirty 标记
    end

    Main->>MCP: server.connect(StdioServerTransport)
    MCP-->>Main: 等待 Claude Code 连接
```

## 7. 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `MCP_MEMORY_DB_PATH` | `./memory.sqlite` | SQLite 数据库路径 |
| `MCP_MEMORY_CLAUDE_HISTORY_PATH` | `~/.claude/history.jsonl` | 会话历史文件 |
| `MCP_MEMORY_KNOWLEDGE_PATH` | （空） | 知识目录，为空则不启用知识索引 |
| `MCP_MEMORY_DEFAULT_LIMIT` | `5` | 默认搜索结果数 |
| `MCP_MEMORY_MAX_LIMIT` | `20` | 最大搜索结果数 |
| `MCP_MEMORY_CHUNK_TOKENS` | `400` | 知识索引分块大小（近似 token） |
| `MCP_MEMORY_CHUNK_OVERLAP_TOKENS` | `80` | 分块重叠大小（近似 token） |
| `MCP_MEMORY_SYNC_COOLDOWN_MS` | `5000` | 搜索前增量同步冷却时间（ms） |
| `MCP_MEMORY_SYNC_ON_START` | `true` | 启动时是否全量同步知识索引 |
| `MCP_MEMORY_WATCH` | `false` | 是否启用知识目录文件监听 |
| `MCP_MEMORY_WATCH_DEBOUNCE_MS` | `1500` | 文件监听防抖时间（ms） |

## 8. 三层记忆体系

```mermaid
graph TD
    subgraph "第 1 层：会话转录"
        L1["history.jsonl"]
        L1D["Claude Code 自动写入<br/>memory_search 时全量扫描"]
    end

    subgraph "第 2 层：知识索引"
        L2["知识目录 .md 文件"]
        L2D["近似 token 分块 + FTS5 索引<br/>增量同步 (hash/mtime) + watcher"]
    end

    subgraph "第 3 层：长期记忆"
        L3["memories 表"]
        L3D["memory_store 写入<br/>FTS5 + 触发器同步"]
    end

    L1 --> SEARCH["memory_search<br/>三源合并 + 重要度重排"]
    L2 --> SEARCH
    L3 --> SEARCH

    style L1 fill:#e8f4fd,stroke:#4a90d9
    style L2 fill:#fef3e0,stroke:#f5a623
    style L3 fill:#e8f5e9,stroke:#7ed321
    style SEARCH fill:#f3e5f5,stroke:#9c27b0
```

| 层级 | 数据来源 | 写入方式 | 索引方式 | 特点 |
|------|----------|----------|----------|------|
| 第 1 层 | `history.jsonl` | Claude Code 自动 | 全量扫描 + 关键词评分 | 零配置，低精度 |
| 第 2 层 | 知识目录 `.md` | 用户手动放文件 | FTS5 分块索引（近似 token） | 高精度，需维护文件 |
| 第 3 层 | `memory_store` | Claude Code 调用 / 用户触发 | FTS5 + 触发器 | 精准，CLAUDE.md 驱动 |

## 9. 与 OpenClaw 第二层的差异

| 能力 | 本项目 | OpenClaw | 差异原因 |
|------|--------|----------|----------|
| 分块策略 | 近似 token（400/80） | 精确 token（400/80） | 轻量实现，免外部依赖 |
| 索引方式 | FTS5 BM25 | FTS5 + 向量混合 | 不引入嵌入模型 |
| 语义召回 | 无（仅关键词） | 有（向量嵌入） | 不引入嵌入模型 |
| 会话数据源 | history.jsonl | sessions JSONL 分块索引 | 复用 Claude Code 原生 |
| 增量同步 | hash/mtime + meta | hash/mtime | 基本对齐 |
| 配置变更重建 | knowledge_meta 检测 | meta 表检测 | 基本对齐 |
| 文件监听 | fs.watch（可选） | chokidar + 防抖 | 免外部依赖 |
| 安全重建 | 事务内全量清除+重建 | 临时库 → 原子交换 | 知识索引与主库共用同一 SQLite |
| 嵌入缓存 | 无 | embedding_cache | 无向量则无需缓存 |
