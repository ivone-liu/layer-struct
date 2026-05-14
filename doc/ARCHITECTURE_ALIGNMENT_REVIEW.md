# 架构对齐 Review

本文根据 `doc/AI_Orchestrator_Architecture.pdf` 对当前 TypeScript 实现进行对齐检查，目标是确认项目基础结构是否覆盖文档中的核心链路、核心对象和边界约束。

## 1. 总体结论

当前实现已经覆盖基础链路：

1. 用户请求进入 HTTP 服务
2. 创建 `RequestContext`
3. Router 输出 `RoutePlan`
4. 写入类请求执行 Workflow
5. 查询类请求执行 RAG 召回
6. Context Builder 组装最终任务包
7. 大模型基于任务包生成回答
8. SQLite 记录文档、切片、会话和路由日志
9. LanceDB 保存和检索向量

当前项目适合作为架构文档的第一版基础结构。尚未实现完整能力注册表向量匹配、Memory、Reranker、Workflow 步骤状态、人工确认和 Agent Runtime，这些应作为后续阶段补齐。

## 2. 核心对象对齐

| 架构对象 | 文档定义 | 当前实现 | 状态 |
| --- | --- | --- | --- |
| `RequestContext` | 用户请求进入系统后的标准化上下文 | `src/types.ts`，由 `Orchestrator.chat()` 创建 | 已实现 |
| `RoutePlan` | Orchestrator 的核心判断结果 | `src/types.ts`，由 `Router.route()` 输出 | 已实现 |
| `CapabilityPlan` | 非 Chat 请求的能力执行计划 | 已定义类型，尚未形成独立运行链路 | 部分实现 |
| `EvidencePack` | 召回后经过筛选的证据包 | `DocumentService.search()` 返回 | 已实现基础版 |
| `ExecutionResult` | Skill/Workflow 执行结果 | 写入数据库返回执行结果 | 已实现基础版 |
| `FinalContext` | 交给大模型的最终上下文包 | `contextBuilder.ts` 组装 prompt | 已实现基础版 |

## 3. 请求路径对齐

| 路径 | 文档要求 | 当前实现 | 状态 |
| --- | --- | --- | --- |
| Chat | 普通问答，不依赖资料 | 直接进入最终生成模型 | 已实现 |
| RAG Chat | 基于文档、历史摘要、Memory、项目资料回答 | 基于 LanceDB 召回文档切片，再进入最终生成 | 已实现文档 RAG |
| Skill Call | 单一能力调用 | `skill.query_database` 作为候选能力，实际由 RAG 查询链路承接 | 部分实现 |
| Workflow | 固定流程任务 | `workflow.ingest_text_database` 完成文本切片、Embedding、SQLite、LanceDB 写入 | 已实现基础版 |
| Agent | 开放式多步任务 | 未接入 | 符合当前阶段边界 |

## 4. 模型分工对齐

| 组件 | 文档要求 | 当前实现 | 状态 |
| --- | --- | --- | --- |
| 小模型 Router | 分类、参数抽取、检索词生成 | `AI_ROUTER_MODEL` 输出 JSON；模型不可用时规则兜底 | 已实现 |
| Embedding | 能力匹配、RAG/Memory 召回 | 用于文档写入和数据库查询 | 已实现 RAG 部分 |
| Reranker | 召回后排序 | 尚未实现 | 待补齐 |
| 压缩模型 | 长证据压缩 | 尚未实现 | 待补齐 |
| 大模型 | 基于整理后上下文最终生成 | `AI_CHAT_MODEL` 基于 `FinalContext` 输出 | 已实现 |
| 代码规则 | 状态管理、参数校验、执行路由 | Orchestrator、SQLite、DocumentService 承担 | 已实现基础版 |

## 5. 存储设计对齐

SQLite 当前保存：

- `documents`：文档级元数据和全文
- `chunks`：文档切片
- `conversation_messages`：会话消息
- `route_logs`：路由计划日志

LanceDB 当前保存：

- `chunkId`
- `documentId`
- `projectId`
- `title`
- `source`
- `text`
- `vector`

这与文档中“可观测、可回放、可调试”的要求基本对齐。下一步应增加 Workflow step logs，用于记录固定流程每一步的状态、产物和错误。

## 6. 执行边界 Review

已对齐：

- Router 不直接回答用户
- Router 不直接执行工具
- 写入数据库走固定 Workflow
- 查询数据库走 RAG 召回
- 最终模型只接收整理后的任务包
- RoutePlan 会写入日志
- 项目数据通过 `projectId` 做基础隔离

待补齐：

- 能力注册表目前是静态列表，尚未使用 Embedding 做语义匹配
- `CapabilityPlan` 未作为独立阶段落库
- 缺少高风险动作确认机制
- 缺少 Workflow 步骤状态记录
- 缺少 Memory 与历史摘要
- 缺少 token 预算控制
- 缺少 Reranker 和证据压缩

## 7. README Review

README 已调整为只描述项目相关内容：

- 项目是什么
- 当前能力
- 快速开始
- 使用示例
- 文档入口

README 不再使用阶段性架构口号，详细设计放在 `doc/TECHNICAL_IMPLEMENTATION_PLAN.md` 与本文档中。

## 8. 建议下一步

优先级建议：

1. 增加 `workflow_runs` 与 `workflow_steps` 表，记录写入流程每一步状态。
2. 将 Registry 从静态候选升级为 Embedding 匹配，并生成独立 `CapabilityPlan`。
3. 增加 Context Builder 的预算控制和证据去重。
4. 增加 RAG 查询测试样例，统计召回质量。
5. 增加人工确认策略，为未来高风险 Skill/Workflow 预留边界。
