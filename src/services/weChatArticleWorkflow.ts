import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config/env.js";

const execFileAsync = promisify(execFile);

export interface WeChatArticleFetchResult {
  url: string;
  title: string;
  author?: string;
  publishTime?: string;
  content: string;
  markdownFile?: string;
  infoFile?: string;
  rawInfo: Record<string, unknown>;
}

export class WeChatArticleWorkflow {
  constructor(private readonly config: AppConfig["wespy"]) {}

  async fetchArticle(url: string): Promise<WeChatArticleFetchResult> {
    const outputDir = path.resolve(this.config.outputDir, safeRunDirectoryName());
    await mkdir(outputDir, { recursive: true });

    try {
      await execFileAsync(this.config.command, [...this.config.commandArgs, url, "--json", "-o", outputDir], {
        timeout: this.config.timeoutMs,
        maxBuffer: 1024 * 1024 * 20
      });
    } catch (error) {
      throw new Error(`WeSpy 获取公众号文章失败：${formatExecError(error)}`);
    }

    const files = await listFiles(outputDir);
    const infoFile = await newestFile(files.filter((file) => file.endsWith("_info.json") || file.endsWith(".json")));
    const markdownFile = await newestFile(files.filter((file) => file.endsWith(".md")));
    const rawInfo = infoFile ? await readJsonRecord(infoFile) : {};
    const content = markdownFile ? (await readFile(markdownFile, "utf8")).trim() : stringValue(rawInfo.markdown) ?? "";
    if (!content) {
      throw new Error("WeSpy 已执行，但没有生成可写入数据库的 Markdown 内容。");
    }

    return {
      url,
      title: stringValue(rawInfo.title) ?? titleFromMarkdown(content) ?? "微信公众号文章",
      author: stringValue(rawInfo.author),
      publishTime: stringValue(rawInfo.publish_time) ?? stringValue(rawInfo.publishTime),
      content,
      markdownFile,
      infoFile,
      rawInfo
    };
  }
}

export function extractWeChatArticleUrl(message: string): string | undefined {
  const match = message.match(/https:\/\/mp\.weixin\.qq\.com\/[^\s，。；、)）]+/u);
  return match?.[0]?.trim();
}

function safeRunDirectoryName(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(filePath)));
    } else if (entry.isFile()) {
      files.push(filePath);
    }
  }
  return files;
}

async function newestFile(files: string[]): Promise<string | undefined> {
  let newest: { file: string; mtimeMs: number } | undefined;
  for (const file of files) {
    const fileStat = await stat(file);
    if (!newest || fileStat.mtimeMs > newest.mtimeMs) {
      newest = { file, mtimeMs: fileStat.mtimeMs };
    }
  }
  return newest?.file;
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function titleFromMarkdown(content: string): string | undefined {
  const firstHeading = content.match(/^#\s+(.+)$/m);
  return firstHeading?.[1]?.trim();
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { message?: string; stderr?: string; stdout?: string; code?: unknown };
    const detail = maybe.stderr?.trim() || maybe.stdout?.trim() || maybe.message;
    return detail ? `${detail}${maybe.code ? ` (code: ${String(maybe.code)})` : ""}` : "未知错误";
  }
  return String(error);
}
