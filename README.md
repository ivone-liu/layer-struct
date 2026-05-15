# Layer Struct AI Orchestrator

本项目实现一个本地运行的 AI Orchestrator 基础结构，用于支持对话、资料写入、向量检索和基于资料的回答。

## 当前能力

- 基于 TypeScript 和 Node.js 提供 HTTP 服务
- 使用 Router 生成结构化 `RoutePlan`
- 使用 SQLite 保存文档、切片、会话和路由日志
- 使用 LanceDB 保存文本切片向量
- 使用云端 Embedding 服务完成写入和查询所需向量化
- 使用云端 Chat 服务生成最终回答
- 支持 Orchestrator 进入后先即时响应“执行中...”，再通过流式响应输出最终答案
- 通过 WeSpy 获取微信公众号文章并写入 SQLite 与 LanceDB
- 提供一个简单对话页面

## 快速开始

安装依赖：

```bash
npm install
```

配置 `.env`：

```bash
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=...
AI_ROUTER_MODEL=...
AI_CHAT_MODEL=...
AI_EMBEDDING_MODEL=...
AI_EMBEDDING_DIM=1536
AI_REQUEST_TIMEOUT_MS=60000
AI_STREAM_CONNECT_TIMEOUT_MS=30000
AI_STREAM_FIRST_TOKEN_TIMEOUT_MS=60000
AI_STREAM_IDLE_TIMEOUT_MS=60000
AI_STREAM_TOTAL_TIMEOUT_MS=180000
# 可选：WeSpy 公众号文章抓取配置
WESPY_COMMAND=wespy
WESPY_OUTPUT_DIR=./data/wespy
WESPY_TIMEOUT_MS=120000
```

启动开发服务：

```bash
npm run dev
```

访问：

```text
http://localhost:3000
```


### AI 请求超时配置

- `AI_REQUEST_TIMEOUT_MS=60000`：用于普通非流式 AI 请求，例如路由、Embedding 或一次性 Chat 请求。
- `AI_STREAM_CONNECT_TIMEOUT_MS=30000`：用于流式最终生成的连接建立阶段。
- `AI_STREAM_FIRST_TOKEN_TIMEOUT_MS=60000`：用于流式响应 body 开始读取后，到第一个有效 token 之间的等待时间。
- `AI_STREAM_IDLE_TIMEOUT_MS=60000`：用于流式生成过程中相邻 chunk/token 之间的空闲等待时间。
- `AI_STREAM_TOTAL_TIMEOUT_MS=180000`：用于流式最终生成的总时长上限。长回答或大证据包场景建议适当提高该值。

流式最终生成使用 `AI_STREAM_*` 分阶段超时，不再由单一 30 秒总超时控制；普通请求仍使用 `AI_REQUEST_TIMEOUT_MS`。

## 使用示例

写入数据库：

```text
写入数据库：标题：项目架构原则
Orchestrator 是代码主导、模型辅助的请求调度系统。
```

保存公众号文章：

```text
保存公众号文章：https://mp.weixin.qq.com/s/xxxxx
```

查询数据库：

```text
查询数据库：Orchestrator 的职责是什么？
```

## 流式对话接口

页面默认调用 `POST /api/chat/stream`，服务端通过 SSE 返回事件：

- `assistant_delta`：可直接追加到当前助手消息气泡的文本增量。
- `status`：当前执行状态，例如 `执行中...`。
- `metadata`：路由、执行结果和证据包，便于页面实时刷新详情面板。
- `done`：完整回答和最终元数据。

保留 `POST /api/chat` 用于一次性 JSON 响应。

## WeSpy 公众号文章工作流

当用户消息中包含 `https://mp.weixin.qq.com/` 开头的链接，并表达保存、入库或记录公众号文章内容的意图时，Router 会调用 `workflow.ingest_wechat_article`。该工作流使用本机 `wespy` 命令获取文章 Markdown 与元数据，然后沿用文档写入链路切片、生成 embedding，并写入 SQLite 与 LanceDB。

使用前请安装 WeSpy：

```bash
pip install wespy
```

## 文档

- 环境与启动：[doc/environment.md](doc/environment.md)
- 技术实现方案：[doc/TECHNICAL_IMPLEMENTATION_PLAN.md](doc/TECHNICAL_IMPLEMENTATION_PLAN.md)
- 架构对齐 Review：[doc/ARCHITECTURE_ALIGNMENT_REVIEW.md](doc/ARCHITECTURE_ALIGNMENT_REVIEW.md)

## Skill 查询能力

项目内置了两个按标准 Skill 目录组织的查询能力，并通过 `skills/registry.json` 注册。Router 在需要查询时会根据意图自动选择并加载对应 capability：

- `skill.lancedb_query`：位于 `skills/lancedb-query`，用于 LanceDB 向量/语义检索、RAG 召回和相似片段查询。
- `skill.sqlite_query`：位于 `skills/sqlite-query`，用于 SQLite 精确关键词、标题/来源、最近文档和元数据类查询。

手动查询示例：

```bash
# 语义检索，默认走 LanceDB skill
curl -X POST http://localhost:3000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"Router 的职责是什么？","projectId":"default","skillId":"skill.lancedb_query"}'

# 精确/元数据查询，走 SQLite skill
curl -X POST http://localhost:3000/api/search \
  -H 'content-type: application/json' \
  -d '{"query":"最近","projectId":"default","skillId":"skill.sqlite_query"}'
```

安装自定义 Skill 并更新注册表：

```bash
npm run skills:install -- /path/to/my-skill
npm run skills:install -- ./skills/pdf
npm run skills:install -- https://github.com/anthropics/skills/tree/main/skills/pdf
```

安装脚本会复制包含 `SKILL.md` 的目录到 `skills/<skill-name>`，并更新 `skills/registry.json`。如果自定义 Skill 已经位于目标目录（例如 `./skills/pdf` 且 Skill 名称为 `pdf`），脚本会保留该目录并只刷新注册表，避免先删除源目录再复制导致 `ENOENT`。应用启动时读取该注册表，把已安装 Skill 暴露给 Router 的能力列表。

注册新 Skill 时，安装脚本会按 Anthropic《The Complete Guide to Building Skills for Claude》的核心格式要求做本地校验：`SKILL.md` 必须大小写完全匹配、包含 YAML frontmatter，`name` 必须是 kebab-case 且与注册目录一致，`description` 必须说明“做什么”和“何时使用”、长度小于 1024 字符且 frontmatter 不包含 XML 尖括号；Skill 目录内不能放 `README.md`，额外资料应放在 `SKILL.md` 或 `references/`。校验通过后，脚本会调用 OpenAI-compatible 大模型为该 Skill 生成确定结构的注册表基础信息，包括 `examples`、`requiredParams`、`optionalParams`、风险/成本等级和是否需要确认。模型调用使用 `temperature: 0`、`response_format: {"type":"json_object"}`，并在写入注册表前对 JSON 字段做归一化校验，方便 Router 后续稳定选择和调用。

Skill 注册元数据生成依赖以下环境变量：`AI_API_KEY`（或 `OPENAI_API_KEY`）、`AI_SKILL_REGISTRY_MODEL`（优先；也可回退到 `AI_ROUTER_MODEL`、`AI_CHAT_MODEL` 或 `OPENAI_MODEL`），以及可选的 `AI_BASE_URL`（或 `OPENAI_BASE_URL`，默认 `https://api.openai.com/v1`）和 `AI_SKILL_REGISTRY_TIMEOUT_MS`（默认回退到 `AI_REQUEST_TIMEOUT_MS` 或 60000）。安装脚本会自动读取项目当前工作目录下的 `.env` 并补齐缺失的进程环境变量；shell 中已存在的环境变量优先级更高。如果未配置 API key 或模型，安装脚本会拒绝注册并提示缺失配置。

## Memory RAG、多索引检索与 Chunk Expansion

本项目现在将搜索链路升级为“三段式”：

1. **Memory RAG 找导航锚点**：写入文档后会创建 `document_anchor` 记忆，用于跨 session 找回历史文档、会话摘要、偏好和修正等导航线索。
2. **Document RAG 找原文证据**：当用户要求“原文引用/出处/文中怎么说”时，Memory 只能帮助定位 `documentId`，最终证据必须回到 SQLite `chunks` 或 LanceDB `document_chunks` 对应的原文 chunk。
3. **Chunk Expansion 补上下文**：命中一个 chunk 后，最终 prompt 会自动带上前后相邻 chunk（默认前后各 1 个），提高引用上下文完整度。

### LanceDB 多索引表

LanceDB 现在按用途拆分为多张表：

- `document_chunks`：文档切片向量，作为原文 RAG 的主要向量索引。
- `memory_items`：跨 session memory 向量，保存 document anchor、session summary、用户偏好、纠错和工作流轨迹等导航线索。
- `session_summaries`：预留给会话摘要索引。
- `capability_index`：预留给能力/Skill 检索索引。

环境变量：

```env
LANCEDB_TABLE=document_chunks
LANCEDB_DOCUMENT_TABLE=document_chunks
LANCEDB_MEMORY_TABLE=memory_items
LANCEDB_SESSION_TABLE=session_summaries
LANCEDB_CAPABILITY_TABLE=capability_index
```

`LANCEDB_TABLE` 仍保留兼容旧逻辑；新代码优先使用 `LANCEDB_DOCUMENT_TABLE`。

### Memory 不是原文证据

Memory 的职责是“导航”，例如根据“罗福莉”找回之前保存过的文章 `documentId`。它不能被当作原文引用来源；如果用户要求引用、摘录、出处或“文中怎么说”，系统必须查询 `document_chunks` / SQLite `chunks`，没有原文 evidence 时会拒绝编造引用。

### 记忆命中增强与衰减

Memory 命中后会提升 `hit_count` 与 `score`；服务启动后会在本地进程内定时衰减长期未命中的非 pinned memory，并在分数过低且长期不用时软删除。

```env
MEMORY_DECAY_INTERVAL_HOURS=24
MEMORY_DECAY_AMOUNT=1
MEMORY_DELETE_SCORE_THRESHOLD=-5
MEMORY_DELETE_AFTER_DAYS=30
MEMORY_HIT_BOOST=1
MEMORY_DEFAULT_SCORE=5
```

### Chunk Expansion

`EVIDENCE_CONTEXT_WINDOW` 控制每个命中 chunk 前后扩展多少个相邻 chunk。默认 `1` 表示命中 `chunkIndex=12` 时，最终 prompt 会优先使用包含 11、12、13 的 expanded evidence。

```env
EVIDENCE_CONTEXT_WINDOW=1
```
