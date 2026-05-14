# 环境依赖与启动说明

## 1. 基础环境

本项目是 TypeScript + Node.js 的本地 AI Orchestrator MVP，需要以下环境：

- Node.js：`>= 24.0.0`
- npm：建议使用 Node.js 自带 npm
- TypeScript：通过项目 `devDependencies` 安装
- SQLite：使用 Node.js 24 内置 `node:sqlite`，不需要额外安装 SQLite npm 包
- LanceDB：使用 npm 包 `@lancedb/lancedb`
- 云端模型服务：需要兼容 OpenAI API 的服务

> 当前项目暂不考虑本地模型服务，Embedding、Router、最终生成都通过云端服务调用。

## 2. 安装依赖

在项目根目录执行：

```bash
npm install
```

项目核心依赖：

- `@lancedb/lancedb`：本地向量数据库
- `typescript`：TypeScript 编译
- `tsx`：开发环境直接运行 TypeScript
- `@types/node`：Node.js 类型定义

## 3. 环境变量配置

项目根目录已提供：

- `.env`：本地实际配置
- `.env.example`：配置示例

至少需要配置以下字段：

```bash
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-your-key
AI_ROUTER_MODEL=gpt-4.1-mini
AI_CHAT_MODEL=gpt-4.1
AI_EMBEDDING_MODEL=text-embedding-3-small
AI_EMBEDDING_DIM=1536
```

本地存储配置：

```bash
PORT=3000
DATA_DIR=./data
SQLITE_PATH=./data/orchestrator.sqlite
LANCEDB_URI=./data/lancedb
LANCEDB_TABLE=document_chunks
DEFAULT_PROJECT_ID=default
```

说明：

- `SQLITE_PATH` 用于保存文档、切片、会话、RoutePlan 日志。
- `LANCEDB_URI` 用于保存本地向量库文件。
- `AI_EMBEDDING_DIM` 必须与云端 Embedding 模型实际输出维度一致。

## 4. 启动项目

开发模式：

```bash
npm run dev
```

启动后访问：

```text
http://localhost:3000
```

生产构建：

```bash
npm run build
npm run start
```

## 5. 页面使用方式

打开 `http://localhost:3000` 后，可以直接在页面输入对话。

普通对话示例：

```text
请解释 AI Orchestrator 的职责
```

写入数据库示例：

```text
写入数据库：标题：架构原则
Orchestrator 不是一个模型，而是一套由代码主导的 AI 调度系统。
小模型负责判断和抽取，Embedding 负责匹配和召回，代码负责决策和执行，大模型负责最终综合与表达。
```

查询数据库示例：

```text
查询数据库：Orchestrator 的职责是什么？
```

页面右侧会展示本次请求的调试详情，包括：

- `routePlan`
- `executionResult`
- `evidencePack`

## 6. API 使用方式

### 健康检查

```bash
curl http://localhost:3000/api/health
```

返回内容会显示：

- Chat 模型是否配置
- Router 模型是否配置
- Embedding 模型是否配置
- SQLite 路径
- LanceDB 路径

### 对话接口

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "content-type: application/json" \
  -d '{
    "message": "查询数据库：Orchestrator 的职责是什么？",
    "sessionId": "demo-session",
    "projectId": "default"
  }'
```

### 直接写入文档

```bash
curl -X POST http://localhost:3000/api/documents \
  -H "content-type: application/json" \
  -d '{
    "title": "架构原则",
    "content": "Orchestrator 是代码主导、模型辅助的请求调度系统。",
    "source": "manual",
    "projectId": "default"
  }'
```

### 直接查询数据库

```bash
curl -X POST http://localhost:3000/api/search \
  -H "content-type: application/json" \
  -d '{
    "query": "代码主导是什么意思？",
    "projectId": "default",
    "limit": 6
  }'
```

## 7. 测试方式

### 1. 配置检查

启动服务后执行：

```bash
curl http://localhost:3000/api/health
```

确认返回中：

```json
{
  "ok": true
}
```

并确认：

- `embeddingConfigured` 为 `true`
- `chatConfigured` 为 `true`
- `routerConfigured` 为 `true`

如果 `routerConfigured` 为 `false`，系统仍会使用规则兜底处理基础写库和查库指令。

### 2. 构建检查

```bash
npm run build
```

该命令会运行 TypeScript 编译，检查类型与导入路径。

### 3. 写入数据库测试

```bash
curl -X POST http://localhost:3000/api/documents \
  -H "content-type: application/json" \
  -d '{
    "title": "测试资料",
    "content": "Router 输出 RoutePlan，Embedding 用于召回，SQLite 记录结构化日志，LanceDB 保存向量。",
    "projectId": "default"
  }'
```

预期结果：

- 返回 `status: "success"`
- 返回 `documentId`
- 返回 `chunkCount`
- 本地生成 `data/orchestrator.sqlite`
- 本地生成 `data/lancedb`

### 4. 查询数据库测试

写入成功后执行：

```bash
curl -X POST http://localhost:3000/api/search \
  -H "content-type: application/json" \
  -d '{
    "query": "RoutePlan 是什么？",
    "projectId": "default",
    "limit": 3
  }'
```

预期结果：

- 返回 `items`
- 每个 item 包含 `title`、`content`、`documentId`、`chunkId`

### 5. 对话链路测试

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "content-type: application/json" \
  -d '{
    "message": "查询数据库：RoutePlan 是什么？",
    "sessionId": "test-session",
    "projectId": "default"
  }'
```

预期结果：

- 返回 `answer`
- 返回 `routePlan`
- 查询类请求返回 `evidencePack`
- 写入类请求返回 `executionResult`

## 8. 常见问题

### npm 不存在

如果执行 `npm install` 时提示 `npm: command not found`，请重新安装 Node.js 官方发行版，或使用带 npm 的 Node 版本管理工具。

### Embedding 维度不匹配

如果出现类似：

```text
Embedding dimension mismatch
```

请检查 `.env` 中的 `AI_EMBEDDING_DIM` 是否与 `AI_EMBEDDING_MODEL` 实际输出维度一致。

### 查询没有结果

请确认：

- 已经先写入数据库
- 查询和写入使用相同的 `projectId`
- `.env` 中的 Embedding 配置可用
- `data/lancedb` 已生成

### Router 模型未配置

如果没有配置 `AI_ROUTER_MODEL`，系统仍可用规则识别基础指令：

- `写入数据库：...`
- `查询数据库：...`

复杂请求建议配置 Router 模型。
