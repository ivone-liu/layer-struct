import type { CapabilityDefinition } from "../types.js";

export const capabilities: CapabilityDefinition[] = [
  {
    id: "workflow.ingest_wechat_article",
    kind: "workflow",
    name: "保存公众号文章",
    description: "通过 WeSpy 获取 mp.weixin.qq.com 公众号文章，提取 Markdown 内容后写入本地 SQLite 与 LanceDB。",
    examples: ["保存公众号文章：https://mp.weixin.qq.com/s/xxxxx", "把这篇公众号文章入库 https://mp.weixin.qq.com/..."],
    requiredParams: ["url"],
    optionalParams: ["projectId"],
    riskLevel: "low",
    costLevel: "low",
    requiresConfirmation: false
  },
  {
    id: "workflow.ingest_text_database",
    kind: "workflow",
    name: "写入数据库",
    description: "将用户提供的文本资料切片、生成云端 embedding，并写入本地 SQLite 与 LanceDB。",
    examples: ["写入数据库：标题：架构原则 ...", "保存这段资料到知识库", "把下面内容入库"],
    requiredParams: ["content"],
    optionalParams: ["title", "source", "projectId"],
    riskLevel: "low",
    costLevel: "low",
    requiresConfirmation: false
  },
  {
    id: "skill.query_database",
    kind: "skill",
    name: "查询数据库",
    description: "对用户问题生成云端 embedding，在本地 LanceDB 召回资料片段，并结合 SQLite 元数据返回证据。",
    examples: ["查询数据库：Orchestrator 的边界是什么？", "从知识库里找 Router 的职责", "根据资料回答这个问题"],
    requiredParams: ["query"],
    optionalParams: ["projectId", "limit"],
    riskLevel: "low",
    costLevel: "low",
    requiresConfirmation: false
  }
];
