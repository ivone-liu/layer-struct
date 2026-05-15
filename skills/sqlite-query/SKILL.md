---
name: sqlite-query
description: Structured and keyword lookup over local SQLite tables for documents, chunks, route logs, and conversation metadata. Use when the user asks for SQLite/database metadata, exact keyword/title/source lookup, recent documents, route logs, counts, or SQL-style inspection.
---

# SQLite Query

## Overview

Use this skill for local SQLite lookups that should not require embeddings: exact or keyword search, recent document lookup, title/source inspection, and metadata-oriented database questions.

## Workflow

1. Preserve exact keywords, titles, sources, or metadata terms from the user request.
2. Prefer safe parameterized reads over raw SQL generation.
3. Search `documents` joined to `chunks` by `projectId`, title, source, and chunk content.
4. For recency/listing requests, return recent chunk evidence ordered by document creation time.
5. Summarize matching rows with IDs and sources; do not invent rows when no match is found.

## Implementation Hook

The runnable application implements this skill in `DocumentService.searchSqlite`, backed by `SqliteStore.searchChunks` and `SqliteStore.listRecentChunkEvidence`.

## Manual Query Script

```bash
node skills/sqlite-query/scripts/query-sqlite.mjs "最近" default 6
```

The script posts to `POST /api/search`, so the local server must already be running.
