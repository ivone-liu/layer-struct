# Layer Struct AI Orchestrator 完整架构文档

> 本文档是对当前代码实现的自包含架构说明，不依赖外部架构图、PDF 或其他说明文件。阅读本文即可理解系统目标、模块边界、核心数据结构、请求链路、存储模型、扩展点与运行约束。

## 1. 系统定位

Layer Struct AI Orchestrator 是一个本地运行的个人知识与对话编排系统。它将用户请求抽象为“意图判断 → 能力规划 → 可选工作流/检索/记忆召回 → 上下文构建 → 最终生成 → 过程持久化”的统一链路，并以本地 SQLite 与 LanceDB 作为长期状态和向量检索基础。

系统的核心设计目标包括：

1. **代码主导、模型辅助**：模型用于分类、压缩、生成与标签建议；真正的流程控制、状态迁移、工具执行和数据写入由 TypeScript 代码显式完成。
2. **本地优先的知识库**：文档全文、切片、会话、运行轨迹、采集记录、标签和记忆保存在本地 SQLite；语义检索向量保存在本地 LanceDB。
3. **可回放的请求编排**：每次请求都会生成 RoutePlan，并可在流式路径中记录 runs、run_steps、run_events，便于调试、观测和后续评估。
4. **证据约束的回答**：当用户需要基于资料、原文、引用或出处回答时，系统必须先获得 evidencePack，再由最终生成模型基于证据回答；证据不足时会拒绝编造。
5. **会话连续性**：系统同时维护当前会话的原始消息、压缩上下文、session 用户需求 memory 和跨会话 memory，用于延续用户目标并定位历史文档。
6. **能力可扩展**：内置 workflow、Skill 和 MCP capability 都被统一抽象为 capability，Router 与 SkillPlanner 可以在同一能力注册视图下选择后续动作。

## 2. 运行时与技术栈

| 层次 | 技术/实现 | 说明 |
|---|---|---|
| Runtime | Node.js 24+ | 使用原生 ESM、fetch、http、node:sqlite 等能力。 |
| 语言 | TypeScript | 源码位于 `src/`，构建输出由 `tsc` 生成。 |
| HTTP 服务 | Node 内置 `http` | 未引入 Express/Koa，路由逻辑集中在 `src/server.ts`。 |
| 结构化存储 | SQLite (`node:sqlite`) | 保存文档、切片、会话、记忆、采集记录、运行轨迹等。 |
| 向量存储 | LanceDB (`@lancedb/lancedb`) | 保存文档切片、记忆、会话摘要、能力索引向量。 |
| AI 接口 | OpenAI-compatible API | 统一调用 `/chat/completions`、`/embeddings`，支持同步与流式生成。 |
| 前端 | 静态 HTML/CSS/JS | `public/` 下提供本地聊天与管理页面。 |
| 外部采集 | WeSpy 命令行 | 用于抓取微信公众号文章后进入采集入库链路。 |
| MCP | 自定义 registry + client manager | MCP server 配置保存在 `mcp/registry.json`，按需发现工具。 |

## 3. 顶层目录与职责

```text
.
├── src/
│   ├── server.ts                         # HTTP 入口、依赖装配、API 路由、静态资源服务
│   ├── types.ts                          # 系统核心类型：RoutePlan、SkillPlan、EvidencePack、Memory 等
│   ├── ai/                               # OpenAI-compatible 客户端与 JSON 解析
│   ├── config/                           # 环境变量读取与 AppConfig 生成
│   ├── orchestrator/                     # 请求编排核心：Router、Planner、Executor、ContextBuilder、RunTracker
│   ├── services/                         # 领域服务：文档、记忆、会话、压缩、采集、公众号工作流
│   ├── storage/                          # SQLite 与 LanceDB 访问层
│   └── mcp/                              # MCP registry、类型和 client manager
├── public/                               # 本地 Web UI
├── skills/                               # 内置和可安装 Skill
├── mcp/                                  # MCP server registry
├── bin/                                  # Skill 安装与 MCP 管理 CLI
├── doc/                                  # 文档目录
├── package.json                          # npm scripts 与依赖声明
└── tsconfig.json                         # TypeScript 编译配置
```

系统入口 `src/server.ts` 在启动时完成依赖装配：加载配置、创建数据目录、初始化 SQLite、AI Client、LanceVectorStore、DocumentService、MemoryService、ConversationService、CollectedContentWorkflow、Orchestrator 与 McpClientManager。HTTP 请求进入后，除静态资源和少数 CRUD API 外，核心聊天请求都会委托给 Orchestrator。

## 4. 逻辑分层总览

系统可抽象为六层：

```text
┌──────────────────────────────────────────────────────────────┐
│                         Client/UI                             │
│  Web Chat / curl / MCP 管理 / Skill 安装命令                    │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP / CLI
┌──────────────────────────────▼───────────────────────────────┐
│                     API & Composition Layer                    │
│  server.ts：路由、输入校验、依赖注入、SSE、静态资源              │
└──────────────────────────────┬───────────────────────────────┘
                               │ Chat / Document / Search / MCP
┌──────────────────────────────▼───────────────────────────────┐
│                     Orchestration Layer                        │
│  Router → ParallelRetriever → DocumentResolver → SkillPlanner  │
│  → Workflow/Skill Execution → ContextBuilder → Generation       │
└──────────────┬───────────────────────────────┬───────────────┘
               │                               │
┌──────────────▼───────────────┐   ┌───────────▼────────────────┐
│        Domain Services        │   │        Capability Layer      │
│ Document / Memory / Session   │   │ Skill / Workflow / MCP       │
│ ContextCompression / Collect  │   │ registry + executors         │
└──────────────┬───────────────┘   └───────────┬────────────────┘
               │                               │
┌──────────────▼───────────────────────────────▼───────────────┐
│                         Storage Layer                         │
│ SQLite：事实状态、全文、日志、会话、记忆                         │
│ LanceDB：document_chunks、memory_items、session_summaries、capability_index │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                      External Model/Tool Layer                 │
│ OpenAI-compatible chat/embedding API / WeSpy / MCP servers     │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 API & Composition Layer

`server.ts` 的主要职责是：

- 读取请求并校验必要字段。
- 将请求路由到 Orchestrator、DocumentService、ConversationService、CollectedContentWorkflow 或 MCP registry。
- 对 `/api/chat/stream` 输出 Server-Sent Events。
- 对静态前端资源执行安全路径解析。
- 在进程启动后安排 memory decay 定时任务。
- 在 SIGINT 时关闭 SQLite 和 HTTP server。

该层不承担复杂业务决策；复杂请求一律进入 Orchestrator 或领域服务。

### 4.2 Orchestration Layer

Orchestrator 是系统最重要的编排对象。它不直接实现所有业务细节，而是把一次请求拆成多个可观测阶段：

1. 创建 RequestContext。
2. 确保或创建 ConversationSession。
3. 写入用户消息。
4. 更新 session 用户需求 memory。
5. 调用 Router 得到 RoutePlan。
6. 并行召回 memory hints 与 document candidates。
7. 根据 session state、memory 和文档候选进行 DocumentResolution。
8. 根据 RoutePlan、能力注册表和解析结果生成 SkillPlan。
9. 如需要，执行 workflow。
10. 如需要，执行 Skill 检索并合并 evidencePack。
11. 扩展证据上下文窗口。
12. 对证据不足的强约束请求进行 guard。
13. 构建 FinalContext 并调用最终生成模型，或返回静态 workflow/fallback 答案。
14. 写入助手消息。
15. 回写 session 用户需求 memory 和会话标题。
16. 返回 ChatResponse；流式路径还会持续写入 run 状态和 SSE 事件。

### 4.3 Domain Services Layer

领域服务把可复用业务逻辑从 Orchestrator 中拆出：

- **DocumentService**：文档写入、更新、切片、标签生成、embedding、向量写入、语义/SQLite 检索、证据扩展。
- **MemoryService**：跨会话 memory 的创建、向量化、搜索、命中计数与衰减。
- **ConversationService**：会话创建、消息追加、消息更新、标题与归档管理。
- **ContextCompressor**：把较长历史消息压缩为 ConversationCompressedContext，同时保留最近若干轮原文。
- **CollectedContentWorkflow**：把采集条目作为统一入口，先创建 collected_item，再写入文档和 memory anchor。
- **WeChatArticleWorkflow**：通过 WeSpy 拉取公众号文章并转交采集入库流程。
- **SessionRequirementMemoryService**：维护当前 session 的“用户真实需求”摘要，避免长对话中目标漂移。

### 4.4 Capability Layer

系统把可被 Router/Planner 选择的能力统一抽象为 CapabilityDefinition。能力来源包括：

1. **内置 workflow**：例如采集内容入库、文本入库、微信公众号文章入库。
2. **Skill registry**：`skills/registry.json` 中安装的 Skill，根据 SKILL.md frontmatter 与 registry 元数据转为 capability。
3. **MCP registry**：`mcp/registry.json` 中启用的 MCP server/tool 被映射为 `mcp.<serverId>.<toolName>`。

当前核心 SkillExecutor 直接支持：

- `skill.lancedb_query`：语义检索文档切片。
- `skill.sqlite_query`：结构化/关键词检索 SQLite 文档与切片。

MCP capability 已纳入注册与发现视图，但工具调用本身需要由后续 executor 扩展进一步接入主链路。

### 4.5 Storage Layer

SQLite 是事实源，LanceDB 是向量检索索引。文档写入时先持久化 SQLite 文档和切片，再调用 embedding 写入 LanceDB。查询时语义向量先召回 LanceDB 结果，再可回到 SQLite 拿相邻切片以扩展上下文。

## 5. 核心类型模型

### 5.1 RequestContext

RequestContext 是一次用户请求的不可变事实包，包含：

- `requestId`：本次请求 ID。
- `sessionId`：会话 ID；如果未传入则新建。
- `userId`：可选用户 ID。
- `projectId`：项目/知识库隔离 ID，默认 `default`。
- `message`：用户原始输入。
- `createdAt`：请求创建时间。

### 5.2 RoutePlan

RoutePlan 是 Router 的结构化输出，也是后续链路的主控制面。关键字段：

- `taskType`：`chat`、`rag_chat`、`skill_call`、`workflow`。
- `needsRag`、`needsMemory`、`needsSkill`、`needsWorkflow`：布尔需求标记。
- `candidateCapabilities`：候选能力 ID，例如 `workflow.ingest_collected_content`、`skill.lancedb_query`。
- `extractedParams`：Router 从用户输入中抽取的参数。
- `searchQueries` / `resolvedQuery`：检索查询。
- `answerStrategy`：`direct`、`rag`、`citation`、`workflow`、`multi_step`。
- `requiresEvidence`：是否必须有 evidence 才能回答。
- `documentResolution`：文档定位结果，由 DocumentResolver 后置写入。
- `skillPlan`：能力规划结果，由 SkillPlanner 后置写入。

RoutePlan 的设计要点是“只计划，不执行”。Router 不回答用户，也不直接调用工具。

### 5.3 SkillPlan 与 SkillExecutionResult

SkillPlan 是对 RoutePlan 的进一步执行计划：

- `answerStrategy`：最终回答策略。
- `calls`：需要执行的 SkillCall 数组。
- `requiresEvidence`：SkillPlan 层面的证据要求。
- `canAnswerWithoutSkill`：是否允许没有 Skill 结果也回答。
- `rationale`：规划理由。

SkillExecutionResult 保存每个 SkillCall 的执行结果：成功、失败、空结果或跳过，并可携带 evidencePack、结构化输出和错误信息。

### 5.4 EvidencePack

EvidencePack 是证据回答的唯一正文来源之一。它包括：

- `query`：检索查询。
- `skillId`：证据来自哪个 Skill。
- `items`：中心证据切片。
- `expandedItems`：基于相邻 chunk 扩展后的证据。
- `memoryHits`：相关 memory，仅作导航线索，不作为原文证据。
- `retrievalSources`：检索来源说明。

最终 prompt 明确要求：需要原文引用时必须引用 document_chunks/chunks 的正文，不能把 MemoryHits 当作原文证据。

### 5.5 Memory 模型

系统存在两类 memory：

1. **跨会话 MemoryItem**：保存在 `memory_items`，可向量检索，类型包括 document_anchor、session_summary、user_preference、correction、workflow_trace。它用于定位文档、延续偏好、保留摘要或工作流痕迹。
2. **SessionRequirementMemory**：每个 session 唯一，保存在 `session_requirement_memory`，只描述当前会话的用户真实需求、理解、细节和待确认问题。它优先级高，但不是外部资料证据。

### 5.6 FinalContext

FinalContext 是最终生成模型看到的任务包，包含 request、routePlan、evidencePack、executionResult、skillPlan、skillResults、observation、constraints、memoryHits、conversationContext 和 sessionRequirementMemory。最终模型不重新决策系统路径，只基于这个任务包回答。

## 6. 请求链路详解

### 6.1 普通非流式聊天 `/api/chat`

```text
POST /api/chat
  ↓
createRequestContext
  ↓
ConversationService.ensureConversationSession
  ↓
append user message
  ↓
SessionRequirementMemoryService.refineBeforeAnswer
  ↓
Router.route → RoutePlan
  ↓
insert route_logs
  ↓
ParallelRetriever.searchHints
  ├─ MemoryService.search
  └─ DocumentService.searchDocuments
  ↓
DocumentResolver.resolve
  ├─ ambiguous → 返回候选文档列表，停止生成
  └─ resolved/not_found → 继续
  ↓
SkillPlanner.plan
  ↓
executeIfNeeded(workflow)
  ↓
executeSkillsIfNeeded(skill calls)
  ↓
DocumentService.expandEvidencePack
  ↓
guardedNoEvidenceAnswer
  ├─ 证据不足且必须证据 → 返回拒答/说明
  └─ 证据足够或非强证据 → prepareGenerationInput
         ↓
     ContextCompressor.buildContextPack
         ↓
     ContextBuilder.buildFinalPrompt
         ↓
     OpenAiCompatibleClient.chat
  ↓
append assistant message
  ↓
SessionRequirementMemoryService.refineAfterAnswer
  ↓
可选生成会话标题
  ↓
ChatResponse
```

### 6.2 流式聊天 `/api/chat/stream`

流式链路与非流式链路的业务阶段基本一致，但多了运行观测与 SSE 输出：

- 创建 `runs` 记录。
- 用 RunTracker 维护 `run_steps`：intake、router、execution、retrieval、context、generation。
- 向前端发送事件：conversation_created、memory_started/completed、document_resolved/ambiguous、skill_started/completed、answer_delta、error 等。
- 助手消息先以 streaming 状态创建，再随着 token delta 持续更新。
- 如果最终生成模型发生连接、首 token、空闲或总时长超时，系统会基于已检索证据生成降级摘要，并标记 completed_with_fallback。

### 6.3 文档写入链路

文档写入可以来自三种入口：

1. `/api/documents` 直接写入。
2. 聊天中识别到保存/采集/入库意图，进入 `workflow.ingest_collected_content`。
3. 聊天中识别到微信公众号文章 URL，进入 `workflow.ingest_wechat_article` 后再进入采集链路。

通用写入链路如下：

```text
输入 title/content/source/projectId/tags/metadata
  ↓
DocumentService.writeDocument
  ↓
chunkText(content)
  ↓
generateDocumentTags
  ├─ 模型可用：使用模型返回标签建议
  └─ 模型不可用或失败：使用启发式标签
  ↓
SQLite insert documents
  ↓
SQLite replace document_tags / document_tag_links
  ↓
SQLite insert chunks
  ↓
对每个 chunk 调用 OpenAiCompatibleClient.embed
  ↓
LanceVectorStore.addChunks(document_chunks)
  ↓
创建 document_anchor memory
  ↓
更新 session_state.currentDocumentId（聊天工作流场景）
```

### 6.4 资料查询链路

当 Router 判断请求依赖已保存资料时，SkillPlanner 会生成 SkillCall：

- 语义/RAG/相似检索优先 `skill.lancedb_query`。
- SQLite/SQL/元数据/标题/来源/最近/精确关键词查询优先 `skill.sqlite_query`。
- 如果 DocumentResolver 已定位到具体文档，SkillCall 会带上 `documentId`，优先在该文档内检索。

执行路径：

```text
SkillExecutor.execute(call)
  ├─ skill.lancedb_query
  │    └─ DocumentService.search(query, projectId, limit, skillId)
  └─ skill.sqlite_query
       └─ DocumentService.search(... skillId=skill.sqlite_query)
  ↓
observeSkillResults
  ↓
mergeEvidencePacks 去重合并
  ↓
expandEvidencePack 根据 EVIDENCE_CONTEXT_WINDOW 补前后文
  ↓
ContextBuilder.renderEvidence
```

### 6.5 文档定位链路

DocumentResolver 解决“这篇文章”“刚才那篇”“上面那篇”等隐式引用问题。优先级：

1. RoutePlan 明确指定 `targetDocumentId`。
2. 用户提到当前文档，并且 session_state 有 currentDocumentId。
3. MemoryService 召回的 document_anchor。
4. DocumentService.searchDocuments 的标题/来源/内容候选。
5. 若没有候选但用户明显提到当前文档，则回退到最近文档。

如果多个候选分数接近，则返回 `ambiguous`，系统会要求用户指定文档，避免误读。

## 7. Router 设计

Router 优先使用配置的 `AI_ROUTER_MODEL` 输出 JSON；如果模型不可用或输出解析失败，则退回规则路由。规则覆盖：

- 微信公众号 URL + 保存意图 → `workflow.ingest_wechat_article`。
- 保存/采集/写入/入库文本 → `workflow.ingest_collected_content`。
- 显式 MCP capability → `skill_call`。
- 查询数据库/知识库/根据资料 → `rag_chat`。
- 原文、引用、出处、文中怎么说、哪一段、刚才那篇、这篇文章、最近保存等隐式证据意图 → `rag_chat` 且 `requiresEvidence=true`。
- 其他 → `chat`。

Router 输出会经过 normalize：

- 校正非法 taskType。
- 归一化 capability ID，例如旧的 `skill.query_database` 映射为具体查询 Skill。
- 对 workflow/RAG 自动补 candidateCapabilities。
- 对 citation 请求强制 requiresEvidence。
- 对 evidence intent 防止误归类为普通 chat。

这种设计把模型的不确定性限制在“提议”，而不是让模型直接控制系统行为。

## 8. SkillPlanner、SkillExecutor 与 Observation

### 8.1 SkillPlanner

SkillPlanner 将 RoutePlan 转为可执行 SkillPlan。它综合：

- Router 的 candidateCapabilities。
- 当前 session_state。
- DocumentResolution 结果。
- MemoryHits。
- 已注册能力列表。
- 用户是否要求引用、总结、根据资料回答。

如果请求需要 evidence，SkillPlanner 会生成至少一个查询 SkillCall，并把 query、projectId、limit、documentId 等参数写入 call.params。

### 8.2 SkillExecutor

SkillExecutor 当前是显式分发器：

- 对 `skill.lancedb_query` 调用文档语义检索。
- 对 `skill.sqlite_query` 调用文档结构化/关键词检索。
- 对指定 documentId 的请求，优先使用文档内检索；没有命中则列出该文档切片作为兜底。
- 对不支持的 skill 返回 skipped。
- 对异常返回 failed，不让异常直接破坏外层流程。

### 8.3 SkillObserver

SkillObserver 汇总 SkillExecutionResult，判断证据是否足够：

- 如果 SkillPlan 不需要证据，则通常可继续回答。
- 如果 requiresEvidence 但所有结果为空、失败或跳过，则 observation.enoughToAnswer=false。
- Orchestrator 会根据 observation 执行 guard，避免 citation/rag 场景下无证据编造。

## 9. ContextBuilder 与最终生成约束

ContextBuilder 把 FinalContext 渲染为最终 prompt。prompt 结构包含：

1. 用户请求。
2. Session 用户需求 Memory。
3. 对话压缩上下文。
4. RoutePlan compact。
5. AnswerStrategy。
6. MemoryHits compact。
7. SkillPlan compact。
8. SkillResults summary。
9. Observation compact。
10. EvidencePack 正文。
11. ExecutionResult compact。
12. 输出约束。

默认约束按 AnswerStrategy 分层：

- `direct`：可正常回答用户问题。
- `workflow`：简洁说明执行结果、数量和可追踪 ID。
- `rag` / `multi_step`：必须优先基于 SkillResults/EvidencePack，证据不足要说明。
- `citation`：只能引用 evidencePack 中 document_chunks/chunks 的原文，每个观点绑定证据 item，输出必须包含“结论、原文引用与解读、未确认部分”。

最终生成模型的 system message 明确说明：它是最终生成模型，不重新决定系统路径，只基于给定任务包回答。

## 10. 存储架构

### 10.1 SQLite 表

| 表 | 职责 |
|---|---|
| `documents` | 文档元数据、全文、source、project_id、metadata、创建/更新时间。 |
| `chunks` | 文档切片正文、chunk_index、token_estimate。 |
| `document_tags` | 项目内标签字典，按 normalized_name 唯一。 |
| `document_tag_links` | 文档与标签的多对多关系，包含 confidence 和 reason。 |
| `conversation_sessions` | 会话标题、状态、消息数、最近消息预览和时间。 |
| `conversation_messages` | 用户/助手/system 消息，支持 run_id、content_type、metadata、token_estimate。 |
| `conversation_summaries` | 历史会话压缩摘要，供 ContextCompressor 使用。 |
| `session_requirement_memory` | 每个 session 唯一的用户需求 memory。 |
| `collected_items` | 采集内容的状态机记录，关联最终 documentId。 |
| `session_state` | 当前会话正在讨论/最近写入的文档指针。 |
| `memory_items` | 跨会话 memory，支持 score、hit_count、decay、pin/delete。 |
| `route_logs` | 每次请求的 RoutePlan JSON，用于回放和评估。 |
| `runs` | 流式请求的运行总记录。 |
| `run_steps` | 流式请求阶段状态。 |
| `run_events` | 流式请求事件和调试 payload。 |

### 10.2 LanceDB 表

| 表 | 默认名称 | 职责 |
|---|---|---|
| 文档切片表 | `document_chunks` | 保存 chunk 向量、chunkId、documentId、projectId、title、source、text、chunkIndex。 |
| 记忆表 | `memory_items` | 保存 memory 向量，支持跨会话语义召回。 |
| 会话摘要表 | `session_summaries` | 预留/支持会话摘要向量索引。 |
| 能力索引表 | `capability_index` | 预留/支持 capability 语义匹配。 |

LanceVectorStore 对搜索结果先拉取 `limit * 4` 条，再在应用层按 projectId、userId 和 filter 做过滤，最后截断到 limit。这样可以弥补底层向量库过滤能力差异，但也意味着 filter 是近似后过滤，不是严格预过滤。

### 10.3 事实源与索引一致性

- SQLite 是事实源，保存全文和元数据。
- LanceDB 是派生索引，保存向量与检索必要字段。
- 文档更新时，如果 title/source/content/projectId 变化，会删除旧 document chunks 向量并重新 embedding 写入。
- 如果 embedding 阶段失败，DocumentService 会抛出 DocumentWriteFailure；SQLite 中可能已经有文档和切片，因此调用方应在产品层提示“写入索引失败”并允许重试更新。

## 11. Memory 架构

### 11.1 document_anchor memory

当文档写入成功后，系统会创建 document_anchor memory，内容通常是文档标题、来源和内容样本。这类 memory 的作用不是作为证据回答，而是帮助后续“刚才那篇”“上次保存的文章”等请求定位文档。

### 11.2 memory search

ParallelRetriever 在 Router 后并行执行 memory search 和 document search。memory search 使用当前 query 生成 embedding，在 LanceDB memory table 中召回，再回到 SQLite memory_items 读取事实字段并更新 hit 相关统计。

### 11.3 decay

server 启动 60 秒后安排 memory decay 周期任务。MemoryService 根据配置对非 pinned memory 降分，并可按阈值或时间标记删除。这样 memory 不会无限积累低价值内容。

## 12. 会话与上下文压缩

系统通过三层上下文保持连续性：

1. **原始消息**：conversation_messages 保存完整对话。
2. **压缩摘要**：ContextCompressor 在消息数量达到阈值后，将较早消息压缩为结构化 ConversationCompressedContext，并写入 conversation_summaries。
3. **最近原文**：即使存在压缩摘要，系统仍保留最近若干轮原文，避免压缩损失造成短期上下文错误。

压缩摘要包括用户目标、事实、决策、开放问题、引用文档、偏好、纠正、工作流结果和重要消息。它用于延续对话，不可被当作资料库原文证据。

## 13. 采集内容工作流

CollectedContentWorkflow 把“用户提供的一段内容”“URL 内容”“笔记”“转录稿”“微信公众号文章”等统一成 CollectedItem：

```text
pending/processing collected_item
  ↓
DocumentService.writeDocument
  ↓
completed collected_item + documentId
  ↓
MemoryService.createDocumentAnchorMemory
```

这样 API 直接写入、聊天工作流写入和 WeChat 文章写入都可以共享文档入库、标签、切片、向量化和 memory anchor 逻辑。

## 14. MCP 架构

MCP 配置不写入 `.env`，而是保存到 `mcp/registry.json`。一个 MCP server 可以是：

- `stdio`：通过 command/args/cwd/env 启动本地进程。
- `http`/URL 类：通过 url 和 headers 连接远端服务。

MCP registry 层支持：

- 新增、启用、停用、删除 server。
- 从 URL 快速创建 server；可把 token 写成 Authorization header。
- 刷新 server tools 并保存工具 schema。
- 将工具映射为 capability：`mcp.<serverId>.<toolName>`。

MCP secret 可以通过 `$secret.<name>` 形式引用，由 registry/client 层解析到本地 secret 文件或 secrets.json。当前主 Orchestrator 已可识别显式 MCP capability，但完整 MCP tool 执行接入仍是后续扩展点。

## 15. API 面

### 15.1 健康检查

`GET /api/health`

返回 AI 配置可用性、SQLite/LanceDB 路径、文档数量、会话数量、MCP server 数量等。

### 15.2 会话

- `GET /api/conversations?projectId=&userId=&limit=&offset=`：列出会话。
- `POST /api/conversations`：创建会话。
- `GET /api/conversations/:id`：读取会话。
- `GET /api/conversations/:id/messages`：读取会话消息。
- `POST /api/conversations/:id/archive`：归档会话。

### 15.3 聊天

- `POST /api/chat`：非流式聊天。
- `POST /api/chat/stream`：SSE 流式聊天。

请求体：

```json
{
  "message": "查询数据库：Router 的职责是什么？",
  "sessionId": "optional-session-id",
  "projectId": "default",
  "userId": "optional-user-id"
}
```

### 15.4 采集内容

- `GET /api/collected`：列出采集记录。
- `GET /api/collected/:id`：读取单条采集记录。
- `POST /api/collected`：创建采集内容并入库。

### 15.5 文档与标签

- `POST /api/documents`：直接写入文档。
- `GET /api/documents/:id`：读取文档。
- `PATCH /api/documents/:id`：更新文档并按需刷新切片/向量。
- `GET /api/documents/:id/tags`：读取文档标签。
- `PUT /api/documents/:id/tags`：替换文档标签。
- `GET /api/tags`：列出标签。
- `POST /api/tags`：创建标签。
- `PATCH /api/tags/:id`：更新标签。
- `DELETE /api/tags/:id`：删除标签。

### 15.6 搜索

`POST /api/search`

请求体：

```json
{
  "query": "Router 的职责是什么？",
  "projectId": "default",
  "limit": 6,
  "skillId": "skill.lancedb_query"
}
```

### 15.7 MCP

- `GET /api/mcp/servers`：读取 MCP registry。
- `POST /api/mcp/servers`：新增/更新 MCP server。
- `POST /api/mcp/servers/from-url`：从 URL 创建 MCP server。
- `DELETE /api/mcp/servers/:id`：删除 server。
- `POST /api/mcp/servers/:id/remove`：删除 server。
- `POST /api/mcp/servers/:id/enable`：启用 server。
- `POST /api/mcp/servers/:id/disable`：停用 server。
- `GET /api/mcp/servers/:id/tools?refresh=true`：发现并可选刷新 tools。

## 16. 配置模型

配置由 `.env` 和进程环境变量合并生成，进程环境变量优先。核心分组：

### 16.1 服务与存储

| 变量 | 含义 | 默认值 |
|---|---|---|
| `PORT` | HTTP 端口 | `3000` |
| `DATA_DIR` | 数据目录 | `./data` |
| `SQLITE_PATH` | SQLite 文件路径 | `./data/orchestrator.sqlite` |
| `LANCEDB_URI` | LanceDB 目录 | `./data/lancedb` |
| `LANCEDB_DOCUMENT_TABLE` | 文档向量表 | `document_chunks` |
| `LANCEDB_MEMORY_TABLE` | memory 向量表 | `memory_items` |
| `LANCEDB_SESSION_TABLE` | session summary 向量表 | `session_summaries` |
| `LANCEDB_CAPABILITY_TABLE` | capability 向量表 | `capability_index` |
| `DEFAULT_PROJECT_ID` | 默认项目 ID | `default` |

### 16.2 AI

| 变量 | 含义 |
|---|---|
| `AI_BASE_URL` | OpenAI-compatible API base URL。 |
| `AI_API_KEY` | API Key。 |
| `AI_ROUTER_MODEL` | Router JSON 输出模型。 |
| `AI_CHAT_MODEL` | 最终回答模型。 |
| `AI_COMPRESSOR_MODEL` | 对话压缩模型。 |
| `AI_REQUIREMENT_MEMORY_MODEL` | session 用户需求 memory 模型。 |
| `AI_EMBEDDING_MODEL` | Embedding 模型。 |
| `AI_EMBEDDING_DIM` | 期望向量维度。 |
| `AI_REQUEST_TIMEOUT_MS` | 普通请求超时。 |
| `AI_STREAM_CONNECT_TIMEOUT_MS` | 流式连接超时。 |
| `AI_STREAM_FIRST_TOKEN_TIMEOUT_MS` | 首 token 超时。 |
| `AI_STREAM_IDLE_TIMEOUT_MS` | 流式空闲超时。 |
| `AI_STREAM_TOTAL_TIMEOUT_MS` | 流式总时长超时。 |

### 16.3 上下文与证据

| 变量 | 含义 | 默认值 |
|---|---|---|
| `CONTEXT_RAW_RECENT_TURNS` | 保留最近几轮原文 | `2` |
| `CONTEXT_COMPRESS_MIN_MESSAGES` | 触发压缩的最小消息数 | `6` |
| `CONTEXT_COMPRESS_MAX_MESSAGES` | 单次压缩最多覆盖消息数 | `30` |
| `EVIDENCE_CONTEXT_WINDOW` | 证据中心切片前后扩展窗口 | `1` |

### 16.4 Memory

| 变量 | 含义 | 默认值 |
|---|---|---|
| `MEMORY_DECAY_INTERVAL_HOURS` | memory 衰减周期 | `24` |
| `MEMORY_DECAY_AMOUNT` | 每次衰减分值 | `1` |
| `MEMORY_DELETE_SCORE_THRESHOLD` | 删除分数阈值 | `-5` |
| `MEMORY_DELETE_AFTER_DAYS` | 低分删除天数 | `30` |
| `MEMORY_HIT_BOOST` | 命中加分 | `1` |
| `MEMORY_DEFAULT_SCORE` | 默认分数 | `5` |

### 16.5 WeSpy

| 变量 | 含义 | 默认值 |
|---|---|---|
| `WESPY_COMMAND` | WeSpy 命令 | `wespy` |
| `WESPY_COMMAND_ARGS` | WeSpy 命令参数 | 空 |
| `WESPY_OUTPUT_DIR` | 输出目录 | `DATA_DIR/wespy` |
| `WESPY_TIMEOUT_MS` | 抓取超时 | `120000` |

## 17. 错误处理与降级策略

1. **Router 降级**：AI Router 不可用或 JSON 解析失败时，使用规则路由。
2. **标签降级**：标签生成模型不可用或失败时，使用启发式标签。
3. **生成降级**：最终生成模型未配置时，RAG 场景返回证据摘要；流式生成超时时返回基于 evidence 的 fallback 摘要。
4. **证据保护**：citation/rag 强证据请求无证据时，返回“没有找到足够证据”，不调用最终模型编造。
5. **Skill 隔离**：SkillExecutor 捕获异常并返回 failed，Orchestrator 基于 observation 决定是否继续。
6. **MCP Secret 隔离**：MCP token/secret 不写入 `.env`，通过 registry 和本地 secrets 引用管理。
7. **静态资源安全**：serveStatic 会检查解析后的文件路径必须位于 publicDir 下，防止路径穿越。

## 18. 可观测性

系统提供三类可观测数据：

- **route_logs**：每次 chat 的 RoutePlan JSON，可用于分析 Router 行为和构造评估集。
- **runs/run_steps/run_events**：流式请求的阶段事件、可见消息、调试 payload 和错误。
- **conversation_messages.metadata_json**：助手消息的 streaming/completed/fallback/failed 状态和 runId。

流式请求对 UI 友好，因为用户可以看到“正在判断处理方式”“正在查找跨对话记忆”“正在调用资料 Skill”“正在整理上下文”“正在生成最终回答”等阶段性反馈。

## 19. 安全与边界

- 当前系统默认面向本地个人使用，没有实现认证、租户级权限或公网安全防护。
- `projectId` 是逻辑隔离字段，不等价于安全边界。
- Router 和最终生成模型均不可直接执行任意代码；执行能力必须落到代码实现的 workflow/skill/mcp executor。
- MemoryHits 不是原文证据，不能用于满足 citation 的原文引用要求。
- SQLite 是事实源；不要直接依赖 LanceDB 返回字段作为完整事实。
- 文档写入中的 embedding 是外部调用，失败时需要考虑重试和一致性修复。
- MCP server 和 Skill 安装会扩大系统能力面，应在产品层补充确认机制、权限控制和风险标注。

## 20. 扩展点

### 20.1 新增 Workflow

1. 在 capability registry 中加入 workflow capability。
2. 在 Router prompt/规则中增加意图识别。
3. 在 Orchestrator.executeIfNeeded 中增加执行分支。
4. 为流式路径补充 RunTracker 阶段消息。
5. 如产生长期事实，写入 SQLite 并按需创建 memory。

### 20.2 新增 Skill

1. 在 `skills/` 下提供 SKILL.md 和必要脚本。
2. 在 `skills/registry.json` 中声明 path、capabilityId、参数和风险级别。
3. 在 SkillExecutor 中接入执行逻辑，或扩展通用脚本执行器。
4. 在 SkillObserver 中定义结果是否足够回答的规则。
5. 在 ContextBuilder 中决定如何摘要 Skill 输出。

### 20.3 完整接入 MCP tool execution

1. 让 SkillPlanner 能把 `mcp.*.*` capability 转为 SkillCall 或 ToolCall。
2. 在 SkillExecutor 或独立 McpToolExecutor 中调用 McpClientManager。
3. 将 MCP tool result 映射为 SkillExecutionResult 的 structuredContent/resourceLinks/evidencePack。
4. 对 high risk / requiresConfirmation 能力加入人工确认。
5. 将调用轨迹写入 run_events 和 route_logs。

### 20.4 检索增强

可扩展方向：

- capability_index 向量化能力选择。
- 文档级 reranker。
- 多 query expansion。
- Hybrid search：向量 + SQLite FTS/关键词。
- Evidence compression：在长文档召回后压缩 evidence。
- 引用定位：输出 chunkId、documentId、chunkIndex 和 source 的统一 citation 格式。

## 21. 关键设计原则

1. **Router 只判断，不执行**。
2. **Planner 只规划，不生成最终答案**。
3. **Executor 只执行明确能力，不解释用户意图**。
4. **ContextBuilder 只组装任务包，不改变系统状态**。
5. **最终模型只基于 FinalContext 回答，不重新选择路径**。
6. **SQLite 保存事实，LanceDB 保存索引**。
7. **Memory 可用于定位与连续性，不可替代原文证据**。
8. **证据不足时显式说明，不编造**。
9. **所有可回放决策都应持久化或可观测**。
10. **能力扩展必须通过 registry + executor 的显式边界进入系统**。

## 22. 一句话架构总结

Layer Struct AI Orchestrator 是一个以 TypeScript 代码为控制平面、以本地 SQLite/LanceDB 为长期状态、以 OpenAI-compatible 模型为 Router/Embedding/Generator 辅助能力的个人知识编排系统；它通过 RoutePlan、SkillPlan、EvidencePack 和 FinalContext 四个核心抽象，把普通对话、资料入库、资料检索、证据引用、会话记忆和能力扩展统一到一条可观测、可回放、可扩展的请求流水线中。
