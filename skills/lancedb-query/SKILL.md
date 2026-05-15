---
name: lancedb-query
description: Semantic vector retrieval over LanceDB document chunks. Use when the user asks to query/search the knowledge base by meaning, find similar passages, perform RAG retrieval, or asks for LanceDB/vector/embedding search.
---

# LanceDB Query

## Overview

Use this skill for semantic retrieval from the local LanceDB vector index. It loads automatically through the orchestrator registry as `skill.lancedb_query` when a request needs RAG, similarity search, vector search, or meaning-based knowledge-base lookup.

## Workflow

1. Extract the user's natural-language query without command prefixes such as `查询数据库：`.
2. Generate an embedding with the configured OpenAI-compatible embedding client.
3. Search the configured LanceDB table for candidate chunks.
4. Filter results by `projectId` and return evidence items with `chunkId`, `documentId`, `title`, `source`, `content`, `score`, and `projectId`.
5. Answer only from returned evidence; state when the vector index has no supporting chunks.

## Implementation Hook

The runnable application implements this skill in `DocumentService.searchLanceDb`, which calls `LanceVectorStore.search`. Use `scripts/query-lancedb.mjs` only for manual inspection or smoke checks against a running service.

## Manual Query Script

```bash
node skills/lancedb-query/scripts/query-lancedb.mjs "Router 的职责是什么？" default 6
```

The script posts to `POST /api/search`, so the local server must already be running and embedding must be configured.
