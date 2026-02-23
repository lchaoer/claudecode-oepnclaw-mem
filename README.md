# claudecode-oepnclaw-mem

> 基于 SQLite + 关键词检索的 MCP 记忆服务（stdio）。

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

## 3. 数据库位置

默认 SQLite 文件：

```
./memory.sqlite
```

可用环境变量修改：

```
MCP_MEMORY_DB_PATH=D:/dev/cc/claudecode-oepnclaw-mem/memory.sqlite
```

## 3.1 Claude Code 会话历史（JSONL）

默认会话历史路径：

```
C:/Users/13357/.claude/history.jsonl
```

可用环境变量修改：

```
MCP_MEMORY_CLAUDE_HISTORY_PATH=C:/Users/13357/.claude/history.jsonl
```

## 4. 工具接口

- `memory_store(text, category?)`
- `memory_search(query, limit?)`
- `memory_forget(id)`

返回格式与设计文档一致（JSON）。

> 说明：本项目使用 MCP 官方 SDK 的 `McpServer`。如需改为自定义 JSON Schema，请同步修改 `src/server.ts`。

## 5. Claude Code 中使用

在 Claude Code 的 MCP 配置中新增一个 **stdio** 服务器。示例：

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
        "MCP_MEMORY_CLAUDE_HISTORY_PATH": "C:/Users/13357/.claude/history.jsonl"
      }
    }
  }
}
```

> 如果你用的是全局 Claude Code 配置，请把这段合并到你的 `mcpServers` 下。

## 6. 手动验证（可选）

如果你安装了 `mcporter`：

```bash
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-oepnclaw-mem run -s dev" memory_store text="用户偏好中文回复" category=preference
mcporter call --stdio "npm --prefix D:/dev/cc/claudecode-oepnclaw-mem run -s dev" memory_search query="中文回复" limit=5
```
