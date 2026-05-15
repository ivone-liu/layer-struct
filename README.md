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
npm run skills:install -- https://github.com/anthropics/skills/tree/main/skills/pdf
```

安装脚本会复制包含 `SKILL.md` 的目录到 `skills/<skill-name>`，并更新 `skills/registry.json`。应用启动时读取该注册表，把已安装 Skill 暴露给 Router 的能力列表。
