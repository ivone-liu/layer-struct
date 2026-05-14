# AI Orchestrator TypeScript 技术实现方案

## 目标

本项目先实现架构文档中的 MVP 骨架：用户请求进入 Orchestrator 后，由 Router 生成 `RoutePlan`，再根据路径执行普通对话、数据库写入或数据库查询。数据库写入会同时落 SQLite 与 LanceDB；查询会通过云端 Embedding 生成向量，在本地 LanceDB 检索证据，再由大模型基于 `FinalContext` 生成回答。

## 技术栈

- 运行时：Node.js 24+
- 语言：TypeScript
- HTTP 服务：Node 内置 `http`
- 结构化数据库：Node 内置 `node:sqlite`
- 向量数据库：`@lancedb/lancedb`
- 模型服务：OpenAI-compatible 云端接口
- 前端：静态 HTML/CSS/JS 极简对话页

## 环境变量

项目根目录提供 `.env` 与 `.env.example`。

核心配置：

- `AI_BASE_URL`：云端模型服务地址，例如 `https://api.openai.com/v1`
- `AI_API_KEY`：云端服务 API Key
- `AI_ROUTER_MODEL`：小模型 Router
- `AI_CHAT_MODEL`：最终生成模型
- `AI_EMBEDDING_MODEL`：Embedding 模型
- `AI_EMBEDDING_DIM`：Embedding 维度
- `SQLITE_PATH`：SQLite 文件路径
- `LANCEDB_URI`：LanceDB 本地目录
- `LANCEDB_TABLE`：向量表名

当前只接入云端模型服务，不考虑本地模型服务。

## 模块划分

### 1. Config

文件：`src/config/env.ts`

职责：

- 读取 `.env`
- 汇总服务端口、数据库路径、模型配置
- 为其他模块提供稳定的 `AppConfig`

### 2. AI Client

文件：`src/ai/openAiCompatibleClient.ts`

职责：

- 调用 `/embeddings` 生成向量
- 调用 `/chat/completions` 完成 Router JSON 输出与最终回答
- 校验 embedding 维度
- 统一超时与错误处理

### 3. Router

文件：`src/orchestrator/router.ts`

职责：

- 使用 `AI_ROUTER_MODEL` 输出结构化 `RoutePlan`
- 在模型不可用时使用规则兜底识别：
  - `写入数据库` / `保存到知识库` -> `workflow.ingest_text_database`
  - `查询数据库` / `查询知识库` / `根据资料` -> `rag_chat`
  - 其他 -> `chat`
- 抽取基础参数：`title`、`content`、`query`、`source`

边界：

- Router 不直接回答用户
- Router 不直接执行工具
- Router 输出只作为后续链路的计划输入

### 4. Storage

文件：

- `src/storage/sqliteStore.ts`
- `src/storage/lanceVectorStore.ts`

SQLite 职责：

- 保存文档元数据与全文
- 保存切片文本
- 保存会话消息
- 保存 RoutePlan 日志，便于后续回放和评估

LanceDB 职责：

- 保存切片向量
- 根据查询向量召回相关片段
- 使用 `projectId` 做基础隔离

### 5. Document Service

文件：`src/services/documentService.ts`

职责：

- 文本切片
- 对每个切片调用云端 Embedding
- 写入 SQLite 文档和切片
- 写入 LanceDB 向量记录
- 查询时生成 query embedding 并召回证据包

写入结果：

- `documents` 表：文档级信息
- `chunks` 表：切片级文本
- LanceDB `document_chunks` 表：切片向量与检索字段

### 6. Context Builder

文件：`src/orchestrator/contextBuilder.ts`

职责：

- 将 `RequestContext`、`RoutePlan`、`EvidencePack`、`ExecutionResult` 组装成 `FinalContext`
- 给最终大模型明确证据、执行结果和输出约束

### 7. Orchestrator

文件：`src/orchestrator/orchestrator.ts`

职责：

1. 创建 `RequestContext`
2. 调用 Router 生成 `RoutePlan`
3. 按路径执行：
   - `workflow.ingest_text_database`：写入 SQLite + LanceDB
   - `rag_chat` / `skill.query_database`：查询 LanceDB 并构建证据包
   - `chat`：直接进入最终生成
4. 构建 `FinalContext`
5. 调用大模型生成最终回答
6. 记录会话与路由日志

## API

### `GET /api/health`

返回模型配置与本地存储状态。

### `POST /api/chat`

请求：

```json
{
  "message": "查询数据库：Orchestrator 的职责是什么？",
  "sessionId": "optional-session-id",
  "projectId": "default"
}
```

返回：

```json
{
  "answer": "...",
  "routePlan": {},
  "evidencePack": {},
  "executionResult": {}
}
```

### `POST /api/documents`

直接写入数据库。

```json
{
  "title": "架构原则",
  "content": "Orchestrator 是代码主导、模型辅助的调度系统。",
  "source": "manual",
  "projectId": "default"
}
```

### `POST /api/search`

直接查询数据库。

```json
{
  "query": "Router 的职责是什么？",
  "projectId": "default",
  "limit": 6
}
```

## MVP 验收

- 能启动一个本地 HTTP 服务
- 页面可以发送普通对话
- 用户可通过对话触发写入数据库
- 用户可通过对话触发查询数据库
- 写入时 SQLite 保存元数据和切片，LanceDB 保存向量
- 查询时使用云端 Embedding 检索 LanceDB
- 每次请求保留 `RoutePlan`，便于调试和回放

## 后续扩展

- 增加能力注册表 embedding 缓存，避免每次重新计算能力向量
- 增加 Reranker 与证据压缩
- 增加 Workflow 步骤状态表
- 增加高风险能力人工确认机制
- 增加项目级 Memory 与历史摘要
- 增加小样本路由评估集，统计 Router 准确率
