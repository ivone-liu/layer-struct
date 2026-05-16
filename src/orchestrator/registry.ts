import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CapabilityDefinition } from "../types.js";
import { loadMcpCapabilities } from "../mcp/registry.js";

interface SkillRegistryEntry {
  name: string;
  path: string;
  capabilityId?: string;
  kind?: "skill" | "workflow";
  examples?: string[];
  requiredParams?: string[];
  optionalParams?: string[];
  riskLevel?: "low" | "medium" | "high";
  costLevel?: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
}

interface SkillRegistryFile {
  skills?: SkillRegistryEntry[];
}

export const builtInCapabilities: CapabilityDefinition[] = [
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
    id: "workflow.ingest_collected_content",
    kind: "workflow",
    name: "采集信息入库",
    description: "接收用户提供的内容，创建 collected_item，写入 documents/chunks，生成 embedding，写入 LanceDB，创建 memory anchor，并完成内容注册。",
    examples: ["保存这段：标题：AI范式变化 ...", "采集这段内容", "保存到知识库"],
    requiredParams: ["content"],
    optionalParams: ["title", "source", "kind", "metadata", "projectId"],
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
  }
];

export function loadCapabilities(rootDir = process.cwd()): CapabilityDefinition[] {
  const skillCapabilities = loadSkillCapabilities(path.resolve(rootDir, "skills", "registry.json"));
  const mcpCapabilities = loadMcpCapabilities(rootDir);
  const capabilitiesById = new Map<string, CapabilityDefinition>();
  for (const capability of [...builtInCapabilities, ...skillCapabilities, ...mcpCapabilities]) {
    capabilitiesById.set(capability.id, capability);
  }
  return Array.from(capabilitiesById.values());
}

export const capabilities: CapabilityDefinition[] = loadCapabilities();

function loadSkillCapabilities(registryPath: string): CapabilityDefinition[] {
  if (!existsSync(registryPath)) {
    return defaultQuerySkillCapabilities();
  }

  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as SkillRegistryFile;
    const baseDir = path.dirname(registryPath);
    const capabilities = (registry.skills ?? [])
      .map((entry) => toCapability(entry, baseDir))
      .filter((capability): capability is CapabilityDefinition => Boolean(capability));
    return capabilities.length > 0 ? capabilities : defaultQuerySkillCapabilities();
  } catch {
    return defaultQuerySkillCapabilities();
  }
}

function toCapability(entry: SkillRegistryEntry, baseDir: string): CapabilityDefinition | undefined {
  const skillPath = path.resolve(baseDir, entry.path);
  const skillMd = path.join(skillPath, "SKILL.md");
  if (!existsSync(skillMd)) {
    return undefined;
  }

  const frontmatter = parseSkillFrontmatter(readFileSync(skillMd, "utf8"));
  if (!frontmatter.name || !frontmatter.description) {
    return undefined;
  }

  const capabilityId = entry.capabilityId ?? `skill.${frontmatter.name.replace(/-/g, "_")}`;
  return {
    id: capabilityId,
    kind: entry.kind ?? "skill",
    name: frontmatter.name,
    description: frontmatter.description,
    examples: entry.examples ?? [],
    requiredParams: entry.requiredParams ?? ["query"],
    optionalParams: entry.optionalParams ?? ["projectId", "limit"],
    riskLevel: entry.riskLevel ?? "low",
    costLevel: entry.costLevel ?? "low",
    requiresConfirmation: entry.requiresConfirmation ?? false
  };
}

function parseSkillFrontmatter(markdown: string): { name?: string; description?: string } {
  const block = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? markdown.match(/^---\s+([\s\S]*?)\s+---/)?.[1];
  if (!block) {
    return {};
  }

  const result: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^[ '"]|[ '"]$/g, "");
    if (key === "name" || key === "description") {
      result[key] = value;
    }
  }

  const parsedName = block.match(/(?:^|\s)name:\s*([^\s]+)/)?.[1];
  if (!result.name || result.name.includes(":")) {
    result.name = parsedName;
  }
  result.description ??= block
    .match(/(?:^|\s)description:\s*([\s\S]*?)(?:\s+(?:license|allowed-tools|metadata):|$)/)?.[1]
    ?.trim();
  return result;
}


function defaultQuerySkillCapabilities(): CapabilityDefinition[] {
  return [
    {
      id: "skill.lancedb_query",
      kind: "skill",
      name: "lancedb-query",
      description:
        "Semantic vector retrieval over LanceDB document chunks. Use when the user asks to query/search the knowledge base by meaning, find similar passages, perform RAG retrieval, or asks for LanceDB/vector/embedding search.",
      examples: ["查询知识库：Router 的职责是什么？", "用 LanceDB 语义检索 orchestrator", "从资料中找相似片段"],
      requiredParams: ["query"],
      optionalParams: ["projectId", "limit"],
      riskLevel: "low",
      costLevel: "low",
      requiresConfirmation: false
    },
    {
      id: "skill.sqlite_query",
      kind: "skill",
      name: "sqlite-query",
      description:
        "Structured and keyword lookup over local SQLite tables for documents, chunks, route logs, and conversation metadata. Use when the user asks for SQLite/database metadata, exact keyword/title/source lookup, recent documents, route logs, counts, or SQL-style inspection.",
      examples: ["查 SQLite 最近写入的文档", "按标题在数据库里找架构原则", "列出 route_logs 最近记录"],
      requiredParams: ["query"],
      optionalParams: ["projectId", "limit"],
      riskLevel: "low",
      costLevel: "low",
      requiresConfirmation: false
    }
  ];
}
