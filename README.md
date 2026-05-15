# Layer Struct AI Orchestrator

本项目实现一个本地运行的 AI Orchestrator 基础结构，用于支持对话、资料写入、向量检索和基于资料的回答。

## 当前能力

- 基于 TypeScript 和 Node.js 提供 HTTP 服务
- 使用 Router 生成结构化 `RoutePlan`
- 使用 SQLite 保存文档、切片、会话和路由日志
- 使用 LanceDB 保存文本切片向量
- 使用云端 Embedding 服务完成写入和查询所需向量化
- 使用云端 Chat 服务生成最终回答
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
