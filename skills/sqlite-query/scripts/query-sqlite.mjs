#!/usr/bin/env node
const [query, projectId = "default", limit = "6"] = process.argv.slice(2);
if (!query) {
  console.error('Usage: node skills/sqlite-query/scripts/query-sqlite.mjs "query" [projectId] [limit]');
  process.exit(1);
}
const baseUrl = process.env.ORCHESTRATOR_URL ?? "http://localhost:3000";
const response = await fetch(`${baseUrl}/api/search`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query, projectId, limit: Number(limit), skillId: "skill.sqlite_query" })
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}
console.log(JSON.stringify(await response.json(), null, 2));
