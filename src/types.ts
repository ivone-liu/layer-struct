export type TaskType = "chat" | "rag_chat" | "skill_call" | "workflow";
export type CapabilityKind = "skill" | "workflow" | "mcp_tool";
export type RiskLevel = "low" | "medium" | "high";
export type CostLevel = "low" | "medium" | "high";
export type RunStatus = "running" | "completed" | "completed_with_fallback" | "failed";
export type RunStepName = "intake" | "router" | "execution" | "retrieval" | "context" | "generation";
export type RunStepStatus = "running" | "completed" | "failed";
export type AnswerStrategy = "direct" | "rag" | "citation" | "workflow" | "multi_step";


export type ConversationStatus = "active" | "archived";

export interface ConversationSession {
  id: string;
  userId?: string;
  projectId: string;
  title: string;
  status: ConversationStatus;
  messageCount: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  runId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentType: "text" | "markdown" | "json" | "error" | "workflow_result";
  metadata: Record<string, unknown>;
  tokenEstimate: number;
  createdAt: string;
}

export interface ConversationCompressedContext {
  userGoals: string[];
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  referencedDocuments: Array<{
    documentId?: string;
    title?: string;
    source?: string;
    reason: string;
  }>;
  userPreferences: string[];
  corrections: string[];
  workflowResults: string[];
  importantMessages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    reason: string;
  }>;
}

export interface ConversationSummary {
  id: string;
  sessionId: string;
  projectId: string;
  userId?: string;
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  summaryJson: ConversationCompressedContext;
  summaryText: string;
  model: string;
  tokenEstimate: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationContextPack {
  compressedContext?: ConversationCompressedContext;
  compressedText?: string;
  recentMessages: ConversationMessage[];
  summaryId?: string;
}

export type CollectedItemKind =
  | "manual_text"
  | "wechat_article"
  | "url"
  | "note"
  | "transcript"
  | "unknown";

export interface CollectedItem {
  id: string;
  projectId: string;
  userId?: string;
  sessionId?: string;
  kind: CollectedItemKind;
  title: string;
  source?: string;
  status: "pending" | "processing" | "completed" | "failed";
  documentId?: string;
  contentHash?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type MemoryKind =
  | "document_anchor"
  | "session_summary"
  | "user_preference"
  | "correction"
  | "workflow_trace";


export interface RequestContext {
  requestId: string;
  sessionId: string;
  userId?: string;
  projectId: string;
  message: string;
  createdAt: string;
}

export interface SkillCall {
  id: string;
  skillId: string;
  reason: string;
  params: Record<string, unknown>;
  required: boolean;
}

export interface SkillPlan {
  answerStrategy: AnswerStrategy;
  calls: SkillCall[];
  requiresEvidence: boolean;
  canAnswerWithoutSkill: boolean;
  rationale?: string;
}

export interface SkillExecutionResult {
  callId: string;
  skillId: string;
  status: "success" | "failed" | "empty" | "skipped";
  evidencePack?: EvidencePack;
  output?: Record<string, unknown> & { collectedItemId?: string; documentId?: string; chunkCount?: number; memoryId?: string; };
  resourceLinks?: Array<{ uri: string; title?: string; mimeType?: string }>;
  structuredContent?: unknown;
  error?: string;
}

export interface SkillObservation {
  enoughToAnswer: boolean;
  missing: string[];
  nextCalls: SkillCall[];
  rationale?: string;
}

export interface RoutePlan {
  taskType: TaskType;
  needsRag: boolean;
  needsMemory: boolean;
  needsSkill: boolean;
  needsWorkflow: boolean;
  capabilityQuery?: string;
  searchQueries: string[];
  candidateCapabilities: string[];
  extractedParams: Record<string, unknown>;
  missingParams: string[];
  confidence: number;
  rationale?: string;
  answerStrategy?: AnswerStrategy;
  requiresEvidence?: boolean;
  targetDocumentId?: string;
  targetDocumentTitle?: string;
  resolvedQuery?: string;
  skillPlan?: SkillPlan;
  documentResolution?: DocumentResolution;
}

export interface CapabilityDefinition {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  examples: string[];
  requiredParams: string[];
  optionalParams: string[];
  riskLevel: RiskLevel;
  costLevel: CostLevel;
  requiresConfirmation: boolean;
}

export interface CapabilityPlan {
  capability: CapabilityDefinition;
  params: Record<string, unknown>;
  missingParams: string[];
  riskLevel: RiskLevel;
  costLevel: CostLevel;
  requiresConfirmation: boolean;
  confidence: number;
}

export interface EvidenceItem {
  chunkId: string;
  documentId: string;
  chunkIndex?: number;
  centerChunk?: boolean;
  title: string;
  source?: string;
  content: string;
  score: number;
  projectId: string;
}

export interface ExpandedEvidenceItem extends EvidenceItem {
  contextBefore?: string;
  contextAfter?: string;
  expandedContent: string;
  centerChunkIndex?: number;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  userId?: string;
  projectId: string;
  sessionId?: string;
  documentId?: string;
  title?: string;
  source?: string;
  content: string;
  summary?: string;
  entities: string[];
  topics: string[];
  metadata: Record<string, unknown>;
  score: number;
  hitCount: number;
  lastHitAt?: string;
  lastDecayAt?: string;
  isPinned: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryHit {
  memoryId: string;
  kind: MemoryKind;
  projectId: string;
  userId?: string;
  sessionId?: string;
  documentId?: string;
  title?: string;
  source?: string;
  content: string;
  summary?: string;
  entities: string[];
  topics: string[];
  score: number;
  vectorScore: number;
  hitCount: number;
  reason: string;
}

export interface DocumentCandidate {
  documentId: string;
  title: string;
  source?: string;
  projectId: string;
  score: number;
  reason: string;
}

export interface DocumentTag {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentTagSuggestion {
  name: string;
  confidence: number;
  reason?: string;
}

export interface DocumentTagAssignment {
  documentId: string;
  tagId: string;
  name: string;
  projectId: string;
  confidence: number;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentResolution {
  status: "resolved" | "ambiguous" | "not_found";
  documentId?: string;
  title?: string;
  source?: string;
  reason: string;
  candidates: DocumentCandidate[];
}

export interface EvidencePack {
  query: string;
  skillId?: string;
  items: EvidenceItem[];
  expandedItems?: ExpandedEvidenceItem[];
  memoryHits?: MemoryHit[];
  retrievalSources?: string[];
}

export interface ExecutionResult {
  status: "success" | "failed" | "skipped";
  capabilityId?: string;
  message: string;
  output?: Record<string, unknown> & { collectedItemId?: string; documentId?: string; chunkCount?: number; memoryId?: string; };
  error?: string;
}

export interface SessionState {
  sessionId: string;
  currentDocumentId?: string;
  currentDocumentTitle?: string;
  currentDocumentSource?: string;
  updatedAt: string;
}

export interface FinalContext {
  request: RequestContext;
  routePlan: RoutePlan;
  evidencePack?: EvidencePack;
  executionResult?: ExecutionResult;
  skillPlan?: SkillPlan;
  skillResults?: SkillExecutionResult[];
  observation?: SkillObservation;
  answerStrategy?: AnswerStrategy;
  constraints: string[];
  memoryHits?: MemoryHit[];
  conversationContext?: ConversationContextPack;
}

export interface ChatResponse {
  answer: string;
  routePlan: RoutePlan;
  evidencePack?: EvidencePack;
  executionResult?: ExecutionResult;
  skillPlan?: SkillPlan;
  skillResults?: SkillExecutionResult[];
  observation?: SkillObservation;
  memoryHits?: MemoryHit[];
  conversation?: ConversationSession;
  conversationContext?: ConversationContextPack;
}

export type DocumentWriteProgressEvent =
  | { type: "document_created"; documentId: string; title: string; chunkCount: number }
  | { type: "document_updated"; documentId: string; title: string; chunkCount: number }
  | { type: "tags_generated"; documentId: string; tags: DocumentTagAssignment[] }
  | { type: "chunks_created"; documentId: string; chunkCount: number }
  | { type: "embedding_started"; documentId: string; chunkCount: number }
  | { type: "embedding_progress"; documentId: string; completed: number; total: number }
  | { type: "vectors_written"; documentId: string; vectorCount: number };

export type ChatStreamEvent =
  | { type: "conversation_created"; runId?: string; visibleMessage: string; conversation: ConversationSession }
  | { type: "conversation_updated"; runId?: string; visibleMessage: string; conversation: ConversationSession }
  | { type: "context_compression_started"; runId?: string; visibleMessage: string; sessionId: string }
  | { type: "context_compression_completed"; runId?: string; visibleMessage: string; conversationContext: ConversationContextPack }
  | { type: "collected_item_created"; runId?: string; visibleMessage: string; collectedItem: CollectedItem }
  | { type: "collected_item_completed"; runId?: string; visibleMessage: string; collectedItem: CollectedItem }
  | { type: "run_started"; runId: string; status: RunStatus; visibleMessage: string; createdAt: string }
  | {
      type: "step_started";
      runId: string;
      step: RunStepName;
      status: RunStepStatus;
      visibleMessage: string;
      debug?: Record<string, unknown>;
    }
  | {
      type: "step_completed";
      runId: string;
      step: RunStepName;
      status: RunStepStatus;
      visibleMessage: string;
      debug?: Record<string, unknown>;
    }
  | {
      type: "step_failed";
      runId: string;
      step: RunStepName;
      status: RunStepStatus;
      visibleMessage: string;
      error: string;
      debug?: Record<string, unknown>;
    }
  | { type: "skill_plan"; runId: string; visibleMessage: string; skillPlan: SkillPlan }
  | { type: "skill_started"; runId: string; visibleMessage: string; call: SkillCall }
  | { type: "skill_completed"; runId: string; visibleMessage: string; result: SkillExecutionResult }
  | { type: "skill_failed"; runId: string; visibleMessage: string; result: SkillExecutionResult }
  | { type: "observation"; runId: string; visibleMessage: string; observation: SkillObservation }
  | { type: "assistant_delta"; runId: string; content: string }
  | {
      type: "metadata";
      runId: string;
      visibleMessage?: string;
      payload?: Record<string, unknown>;
      routePlan?: RoutePlan;
      evidencePack?: EvidencePack;
      executionResult?: ExecutionResult;
      skillPlan?: SkillPlan;
      skillResults?: SkillExecutionResult[];
      observation?: SkillObservation;
      memoryHits?: MemoryHit[];
      conversation?: ConversationSession;
      conversationContext?: ConversationContextPack;
    }
  | {
      type: "done";
      runId: string;
      status: RunStatus;
      answer: string;
      routePlan: RoutePlan;
      evidencePack?: EvidencePack;
      executionResult?: ExecutionResult;
      skillPlan?: SkillPlan;
      skillResults?: SkillExecutionResult[];
      observation?: SkillObservation;
      memoryHits?: MemoryHit[];
      conversation?: ConversationSession;
      conversationContext?: ConversationContextPack;
    }
  | { type: "memory_started"; runId: string; visibleMessage: string }
  | { type: "memory_completed"; runId: string; visibleMessage: string; memoryHits: MemoryHit[] }
  | { type: "document_resolved"; runId: string; visibleMessage: string; documentResolution: DocumentResolution }
  | { type: "document_ambiguous"; runId: string; visibleMessage: string; documentResolution: DocumentResolution }
  | { type: "error"; runId?: string; status?: RunStatus; error: string; friendlyMessage?: string; recoverable?: boolean; debug?: Record<string, unknown> };

export interface ChatStreamCallbacks {
  onEvent: (event: ChatStreamEvent) => void | Promise<void>;
}

export interface StoredDocumentInput {
  title: string;
  content: string;
  source?: string;
  projectId: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StoredDocumentUpdateInput {
  id: string;
  title?: string;
  content?: string;
  source?: string | null;
  projectId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface StoredDocument {
  id: string;
  title: string;
  content: string;
  source?: string;
  projectId: string;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface StoredChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  createdAt: string;
}
