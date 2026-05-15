#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const manifest = parseFrontmatter(readFileSync(skillMd, "utf8"));
const name = toKebabCase(explicitName ?? manifest.name ?? path.basename(sourceDir));
const destination = path.join(skillsDir, name);
if (existsSync(destination)) {
  rmSync(destination, { recursive: true, force: true });
}
cpSync(sourceDir, destination, { recursive: true });

const registry = readRegistry(registryPath);
registry.skills = (registry.skills ?? []).filter((entry) => entry.name !== name && entry.path !== name);
registry.skills.push({
  name,
  path: name,
  capabilityId: `skill.${name.replace(/-/g, "_")}`,
  requiredParams: ["query"],
  optionalParams: ["projectId", "limit"]
});
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
cleanup(tempDirs);
console.log(`Installed skill ${name} into ${path.relative(root, destination)} and updated ${path.relative(root, registryPath)}.`);

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
  const result = {};
  for (const line of block.split(/\r?\n/u)) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    result[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^[ '"]|[ '"]$/gu, "");
  }
  const parsedName = block.match(/(?:^|\s)name:\s*([^\s]+)/u)?.[1];
  if (!result.name || result.name.includes(":")) {
    result.name = parsedName;
  }
  result.description ??= block.match(/(?:^|\s)description:\s*([\s\S]*?)(?:\s+(?:license|allowed-tools|metadata):|$)/u)?.[1]?.trim();
  return result;
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
