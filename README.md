# Layer Struct AI Orchestrator

本项目是一个本地运行的个人知识与对话 Orchestrator。它支持保存资料、继续历史对话、查询本地知识库，并在回答中回到已保存的原文片段。

## 功能

- 本地 Web 聊天界面。
- SQLite 保存会话、消息、采集资料、文档和切片。
- LanceDB 提供向量检索。
- 支持保存普通文本资料。
- 支持保存微信公众号文章。
- 支持基于本地资料的检索、总结和引用。
- 支持安装自定义 Skill。
- 支持按需添加、启用、停用和移除 MCP 服务。

## 快速开始

安装依赖：

```bash
npm install
```

配置 `.env`：

```env
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=...
AI_ROUTER_MODEL=...
AI_CHAT_MODEL=...
AI_COMPRESSOR_MODEL=...
AI_EMBEDDING_MODEL=...
AI_EMBEDDING_DIM=1536

PORT=3000
DATA_DIR=./data
SQLITE_PATH=./data/orchestrator.sqlite
LANCEDB_URI=./data/lancedb
LANCEDB_DOCUMENT_TABLE=document_chunks
LANCEDB_MEMORY_TABLE=memory_items
LANCEDB_SESSION_TABLE=session_summaries
LANCEDB_CAPABILITY_TABLE=capability_index

AI_REQUEST_TIMEOUT_MS=60000
AI_STREAM_CONNECT_TIMEOUT_MS=30000
AI_STREAM_FIRST_TOKEN_TIMEOUT_MS=60000
AI_STREAM_IDLE_TIMEOUT_MS=60000
AI_STREAM_TOTAL_TIMEOUT_MS=180000

CONTEXT_RAW_RECENT_TURNS=2
CONTEXT_COMPRESS_MIN_MESSAGES=6
CONTEXT_COMPRESS_MAX_MESSAGES=30
EVIDENCE_CONTEXT_WINDOW=1

WESPY_COMMAND=python3
WESPY_COMMAND_ARGS=-m wespy
WESPY_OUTPUT_DIR=./data/wespy
WESPY_TIMEOUT_MS=120000
```

启动开发服务：

```bash
npm run dev
```

打开：

```text
http://localhost:3000
```

## 使用示例

保存文本资料：

```text
保存这段：标题：项目架构原则
Orchestrator 是代码主导、模型辅助的请求调度系统。
```

保存微信公众号文章：

```text
保存公众号文章：https://mp.weixin.qq.com/s/xxxxx
```

查询资料：

```text
查询数据库：Orchestrator 的职责是什么？
```

要求引用原文：

```text
原文里哪一段提到了 Router 的职责？
```

继续历史会话：

```text
在左侧选择历史会话后直接发送下一条消息。
```

## Skill

项目内置两个查询 Skill：

- `skill.lancedb_query`：语义检索本地文档切片。
- `skill.sqlite_query`：精确查询本地 SQLite 文档、切片和元数据。

安装自定义 Skill：

```bash
npm run skills:install -- /path/to/my-skill
npm run skills:install -- ./skills/pdf
npm run skills:install -- https://github.com/anthropics/skills/tree/main/skills/pdf
```

手动查询：

```bash
curl -X POST http://localhost:3000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"Router 的职责是什么？","projectId":"default","skillId":"skill.lancedb_query"}'
```

## MCP

MCP 服务不写入 `.env`。`.env` 只保存项目运行环境变量；MCP 服务保存在：

```text
mcp/registry.json
```

通过 URL 注册 MCP 服务，token 可以省略：

```bash
npm run mcp:add-url -- https://example.com/mcp
npm run mcp:add-url -- https://example.com/mcp your-token
```

也可以通过 API 注册：

```bash
curl -X POST http://localhost:3000/api/mcp/servers/from-url \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/mcp","token":""}'
```

传入 token 时会自动生成 `Authorization: Bearer <token>` header。未传 token 或 token 为空时不会写入认证 header。

需要完整控制时，也可以注册一个 MCP server JSON：

```json
{
  "id": "example",
  "name": "Example MCP",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["./path/to/server.js"],
  "allowedTools": ["search"],
  "tools": [
    {
      "name": "search",
      "description": "Search external content through Example MCP.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" }
        },
        "required": ["query"]
      }
    }
  ]
}
```

管理 MCP 服务：

```bash
npm run mcp:add -- ./example-mcp.json
npm run mcp:add-url -- https://example.com/mcp optional-token
npm run mcp:list
npm run mcp:disable -- example
npm run mcp:enable -- example
npm run mcp:remove -- example
```

Secret 可以放在 `data/secrets/<name>` 或 `data/secrets.json`，并在 MCP registry 中引用：

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "$secret.github_token"
  }
}
```

MCP tool 会映射为：

```text
mcp.<serverId>.<toolName>
```

例如：

```text
mcp.example.search
```

刷新 MCP tools：

```bash
curl "http://localhost:3000/api/mcp/servers/example/tools?refresh=true"
```

## WeSpy

保存微信公众号文章前需要安装 WeSpy：

```bash
python3 -m pip install wespy
```

如果 Node 服务进程找不到 `wespy` 可执行文件，推荐在 `.env` 中使用 Python 模块方式启动：

```env
WESPY_COMMAND=python3
WESPY_COMMAND_ARGS=-m wespy
```

## API

会话：

- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:sessionId`
- `GET /api/conversations/:sessionId/messages`
- `POST /api/conversations/:sessionId/archive`

聊天：

- `POST /api/chat`
- `POST /api/chat/stream`

资料：

- `POST /api/collected`
- `GET /api/collected`
- `GET /api/collected/:id`
- `POST /api/documents`
- `GET /api/documents/:id`
- `PATCH /api/documents/:id`
- `GET /api/documents/:id/tags`
- `PUT /api/documents/:id/tags`
- `GET /api/tags`
- `POST /api/tags`
- `PATCH /api/tags/:id`
- `DELETE /api/tags/:id`
- `POST /api/search`

MCP：

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `POST /api/mcp/servers/from-url`
- `POST /api/mcp/servers/:id/enable`
- `POST /api/mcp/servers/:id/disable`
- `POST /api/mcp/servers/:id/remove`
- `DELETE /api/mcp/servers/:id`
- `GET /api/mcp/servers/:id/tools`
- `GET /api/mcp/servers/:id/tools?refresh=true`
