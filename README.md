# Layer Struct AI Orchestrator

一个减法版 AI Orchestrator MVP：小模型 Router、SQLite 元数据、LanceDB 向量库、云端 Embedding/LLM，以及一个极简对话页面。

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 配置 `.env` 中的云端模型服务：

```bash
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=...
AI_ROUTER_MODEL=...
AI_CHAT_MODEL=...
AI_EMBEDDING_MODEL=...
```

3. 启动开发服务：

```bash
npm run dev
```

访问 `http://localhost:3000`。

## 对话示例

写入数据库：

```text
写入数据库：标题：项目架构原则
Orchestrator 不是一个模型，而是一套由代码主导的 AI 调度系统。
```

查询数据库：

```text
查询数据库：Orchestrator 的职责是什么？
```
