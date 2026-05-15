#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const source = process.argv[2];
const explicitName = process.argv[3];
if (!source) {
  console.error("Usage: node bin/install-skill.mjs <local-skill-dir|github-tree-url> [installed-name]");
  process.exit(1);
}

const root = process.cwd();
loadDotEnv(path.join(root, ".env"));
const skillsDir = path.join(root, "skills");
const registryPath = path.join(skillsDir, "registry.json");
mkdirSync(skillsDir, { recursive: true });

const tempDirs = [];
const sourceDir = resolveSourceDir(source, tempDirs);
const skillMd = path.join(sourceDir, "SKILL.md");
if (!existsSync(skillMd)) {
  cleanup(tempDirs);
  console.error(`SKILL.md not found in ${sourceDir}`);
  process.exit(1);
}

const skillMarkdown = readFileSync(skillMd, "utf8");
const manifest = parseFrontmatter(skillMarkdown);
const name = toKebabCase(explicitName ?? manifest.name ?? path.basename(sourceDir));
const validation = validateSkill({ sourceDir, installedName: name, manifest, skillMarkdown });
if (validation.errors.length > 0) {
  cleanup(tempDirs);
  console.error("Skill validation failed. Fix these issues before registering the skill:");
  for (const error of validation.errors) {
    console.error(`- ${error}`);
  }
  console.error("\nValidation follows Anthropic's Complete Guide to Building Skills: exact SKILL.md, kebab-case names, YAML frontmatter, concise trigger-aware descriptions, and progressive-disclosure folder layout.");
  process.exit(1);
}

for (const warning of validation.warnings) {
  console.warn(`Warning: ${warning}`);
}

let generated;
try {
  generated = await buildRegistryMetadata({ name, manifest, skillMarkdown });
} catch (error) {
  cleanup(tempDirs);
  console.error(`Skill metadata generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const destination = path.join(skillsDir, name);
const sourceIsDestination = pathsReferToSameEntry(sourceDir, destination);
if (!sourceIsDestination) {
  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
  cpSync(sourceDir, destination, { recursive: true });
}

const registry = readRegistry(registryPath);
registry.skills = (registry.skills ?? []).filter((entry) => entry.name !== name && entry.path !== name);
registry.skills.push({
  name,
  path: name,
  capabilityId: `skill.${name.replace(/-/g, "_")}`,
  examples: generated.examples,
  requiredParams: generated.requiredParams,
  optionalParams: generated.optionalParams,
  riskLevel: generated.riskLevel,
  costLevel: generated.costLevel,
  requiresConfirmation: generated.requiresConfirmation
});
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
cleanup(tempDirs);
console.log(`Installed skill ${name} into ${path.relative(root, destination)} and updated ${path.relative(root, registryPath)}.`);
console.log(`Generated registry examples: ${generated.examples.join(" | ")}`);

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const keyValue = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!keyValue) {
      continue;
    }

    const [, key, rawValue] = keyValue;
    process.env[key] ??= stripDotEnvValue(rawValue);
  }
}

function stripDotEnvValue(value) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/u, "");
}

function resolveSourceDir(value, tempDirs) {
  if (existsSync(value)) {
    return path.resolve(value);
  }

  const githubTree = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/u);
  if (githubTree) {
    const [, owner, repo, ref, subdir] = githubTree;
    const temp = mkdtempSync(path.join(tmpdir(), "skill-install-"));
    tempDirs.push(temp);
    execFileSync("git", ["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", ref, `https://github.com/${owner}/${repo}.git`, temp], { stdio: "inherit" });
    execFileSync("git", ["-C", temp, "sparse-checkout", "set", subdir], { stdio: "inherit" });
    return path.join(temp, subdir);
  }

  const gitRepo = value.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)(?:\.git)?$/u);
  if (gitRepo) {
    const temp = mkdtempSync(path.join(tmpdir(), "skill-install-"));
    tempDirs.push(temp);
    execFileSync("git", ["clone", "--depth", "1", `${gitRepo[1]}.git`, temp], { stdio: "inherit" });
    return temp;
  }

  console.error(`Unsupported source: ${value}`);
  process.exit(1);
}

function pathsReferToSameEntry(left, right) {
  if (!existsSync(left) || !existsSync(right)) {
    return false;
  }
  return normalizePath(realpathSync(left)) === normalizePath(realpathSync(right));
}

function normalizePath(value) {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readRegistry(filePath) {
  if (!existsSync(filePath)) {
    return { skills: [] };
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseFrontmatter(markdown) {
  const block = markdown.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? markdown.match(/^---\s+([\s\S]*?)\s+---/u)?.[1];
  if (!block) {
    return {};
  }

  const result = { __raw: block };
  const lines = block.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!keyValue) {
      continue;
    }

    const [, key, rawValue] = keyValue;
    if (rawValue.trim() === "") {
      const items = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const item = lines[cursor].match(/^\s*-\s+(.+)$/u);
        if (!item) {
          break;
        }
        items.push(stripQuotes(item[1].trim()));
        cursor += 1;
      }
      result[key] = items.length > 0 ? items : "";
      index = Math.max(index, cursor - 1);
      continue;
    }

    const inlineArray = rawValue.trim().match(/^\[(.*)\]$/u);
    result[key] = inlineArray
      ? inlineArray[1].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean)
      : stripQuotes(rawValue.trim());
  }

  const parsedName = block.match(/(?:^|\s)name:\s*([^\s]+)/u)?.[1];
  if (!result.name || String(result.name).includes(":")) {
    result.name = parsedName;
  }
  result.description ??= block.match(/(?:^|\s)description:\s*([\s\S]*?)(?:\s+(?:license|allowed-tools|compatibility|metadata):|$)/u)?.[1]?.trim();
  return result;
}

function validateSkill({ sourceDir, installedName, manifest, skillMarkdown }) {
  const errors = [];
  const warnings = [];
  const folderName = path.basename(sourceDir);
  const frontmatter = manifest.__raw;

  if (!frontmatter) {
    errors.push("SKILL.md must start with YAML frontmatter delimited by ---.");
  }

  if (folderName !== installedName && !isTempInstallPath(sourceDir)) {
    warnings.push(`Source folder '${folderName}' will be registered as '${installedName}'. The installed folder will match the frontmatter name.`);
  }

  if (!isKebabCase(installedName)) {
    errors.push(`Skill folder/name '${installedName}' must be kebab-case with lowercase letters, numbers, and hyphens only.`);
  }

  const manifestName = stringValue(manifest.name);
  if (!manifestName) {
    errors.push("Frontmatter field 'name' is required.");
  } else {
    if (!isKebabCase(manifestName)) {
      errors.push(`Frontmatter name '${manifestName}' must be kebab-case.`);
    }
    if (manifestName !== installedName) {
      errors.push(`Frontmatter name '${manifestName}' must match the registered folder name '${installedName}'.`);
    }
    if (/(?:^|-)(?:claude|anthropic)(?:-|$)/iu.test(manifestName)) {
      errors.push("Frontmatter name must not contain reserved words 'claude' or 'anthropic'.");
    }
  }

  const description = stringValue(manifest.description);
  if (!description) {
    errors.push("Frontmatter field 'description' is required.");
  } else {
    if (description.length > 1024) {
      errors.push(`Description must be under 1024 characters; found ${description.length}.`);
    }
    if (!hasUsageTrigger(description)) {
      errors.push("Description must explain when to use the skill with concrete trigger conditions, such as 'Use when user asks...' or equivalent Chinese wording.");
    }
    if (description.replace(/Use when|When to use|用于|适用于|当用户|如果/giu, "").trim().length < 24) {
      errors.push("Description must explain what the skill does, not only when it triggers.");
    }
  }

  if (frontmatter && /[<>]/u.test(frontmatter)) {
    errors.push("Frontmatter must not contain XML angle brackets '<' or '>'.");
  }

  const readmePath = path.join(sourceDir, "README.md");
  if (existsSync(readmePath)) {
    errors.push("Skill folders must not contain README.md; put human docs in SKILL.md or references/.");
  }

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  const skillMdEntries = entries.filter((entry) => entry.name.toLowerCase() === "skill.md");
  if (skillMdEntries.some((entry) => entry.name !== "SKILL.md")) {
    errors.push("Skill entrypoint must be named exactly SKILL.md with this capitalization.");
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!["scripts", "references", "assets", "agents"].includes(entry.name)) {
      warnings.push(`Directory '${entry.name}/' is not part of the standard progressive-disclosure layout (scripts/, references/, assets/); make sure it is intentional.`);
    }
  }

  const body = skillMarkdown.replace(/^---\n[\s\S]*?\n---/u, "").trim();
  if (body.length < 80) {
    warnings.push("SKILL.md body is very short; effective skills usually include specific workflow steps, examples, and troubleshooting guidance.");
  }
  if (!/^#/mu.test(body)) {
    warnings.push("SKILL.md body has no Markdown headings; headings improve scanability for progressive disclosure.");
  }

  return { errors, warnings };
}

async function buildRegistryMetadata({ name, manifest, skillMarkdown }) {
  const modelMetadata = await generateRegistryMetadata({ name, manifest, skillMarkdown });
  return normalizeRegistryMetadata(modelMetadata);
}

async function generateRegistryMetadata({ name, manifest, skillMarkdown }) {
  const config = readAiConfig();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutMs),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      top_p: 1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You generate deterministic skill registry metadata from SKILL.md files. Return only valid JSON. Use the source text only; do not invent external capabilities. Prefer stable, concise, user-facing examples."
        },
        {
          role: "user",
          content: JSON.stringify({
            task:
              "Generate registry metadata for this skill. Output exactly these keys: examples, requiredParams, optionalParams, riskLevel, costLevel, requiresConfirmation. examples must be 3-5 realistic user utterances that should trigger the skill. requiredParams and optionalParams must be arrays of camelCase identifiers. riskLevel and costLevel must each be one of low, medium, high. requiresConfirmation must be boolean. Make the output deterministic for identical input.",
            skillName: name,
            frontmatter: manifest,
            skillMarkdown
          })
        }
      ]
    })
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Skill metadata model request failed with HTTP ${response.status}: ${responseBody}`);
  }

  const payload = JSON.parse(responseBody);
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Skill metadata model response did not include message content.");
  }

  return JSON.parse(extractJsonObject(content));
}

function readAiConfig() {
  const apiKey = process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY;
  const model = process.env.AI_SKILL_REGISTRY_MODEL ?? process.env.AI_ROUTER_MODEL ?? process.env.AI_CHAT_MODEL ?? process.env.OPENAI_MODEL;
  const rawBaseUrl = process.env.AI_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const timeoutMs = numberFromEnv(process.env.AI_SKILL_REGISTRY_TIMEOUT_MS) ?? numberFromEnv(process.env.AI_REQUEST_TIMEOUT_MS) ?? 60000;
  if (!apiKey) {
    throw new Error("AI_API_KEY or OPENAI_API_KEY is required to generate skill registry metadata with the model.");
  }
  if (!model) {
    throw new Error("AI_SKILL_REGISTRY_MODEL, AI_ROUTER_MODEL, AI_CHAT_MODEL, or OPENAI_MODEL is required to generate skill registry metadata with the model.");
  }

  return {
    apiKey,
    model,
    baseUrl: rawBaseUrl.replace(/\/+$/u, ""),
    timeoutMs
  };
}

function numberFromEnv(value) {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeRegistryMetadata(metadata) {
  const examples = uniqueStrings(arrayValue(metadata.examples)).slice(0, 5);
  if (examples.length === 0) {
    throw new Error("Skill metadata model output must include at least one example.");
  }

  const requiredParams = normalizeParamList(arrayValue(metadata.requiredParams));
  if (requiredParams.length === 0) {
    throw new Error("Skill metadata model output must include at least one required parameter.");
  }

  return {
    examples,
    requiredParams,
    optionalParams: normalizeParamList(arrayValue(metadata.optionalParams)),
    riskLevel: normalizeLevel(metadata.riskLevel, ["low", "medium", "high"], "low"),
    costLevel: normalizeLevel(metadata.costLevel, ["low", "medium", "high"], "low"),
    requiresConfirmation: booleanValue(metadata.requiresConfirmation) ?? false
  };
}

function extractJsonObject(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) {
    return fenced;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error("Skill metadata model response was not a JSON object.");
}

function isTempInstallPath(sourceDir) {
  return normalizePath(sourceDir).startsWith(normalizePath(tmpdir()));
}

function hasUsageTrigger(description) {
  return /\b(?:use when|when user|when the user|asks? for|mentions|says|trigger)\b|用于|适用于|当用户|用户.*(?:询问|要求|需要|想要|输入|说)|如果.*用户/iu.test(description);
}

function normalizeParamList(values) {
  return uniqueStrings(values.map((value) => String(value).trim()).filter((value) => /^[A-Za-z][A-Za-z0-9_]*$/u.test(value)));
}

function normalizeLevel(value, allowed, fallback) {
  const normalized = stringValue(value)?.toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function booleanValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = stringValue(value)?.toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function arrayValue(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return [];
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanExample(String(value));
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function cleanExample(value) {
  return String(value)
    .replace(/[`*_#]/gu, "")
    .replace(/^[:：\-\s“”"]+|[.。;；,，\s“”"]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripQuotes(value) {
  return String(value).replace(/^[ '"]|[ '"]$/gu, "");
}

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(value));
}

function toKebabCase(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "installed-skill";
}

function cleanup(paths) {
  for (const item of paths) {
    rmSync(item, { recursive: true, force: true });
  }
}
