export type TaskType = "chat" | "rag_chat" | "skill_call" | "workflow";
export type CapabilityKind = "skill" | "workflow";
export type RiskLevel = "low" | "medium" | "high";
export type CostLevel = "low" | "medium" | "high";
export type RunStatus = "running" | "completed" | "failed";
export type RunStepName = "intake" | "router" | "execution" | "retrieval" | "context" | "generation";
export type RunStepStatus = "running" | "completed" | "failed";
export type AnswerStrategy = "direct" | "rag" | "citation" | "workflow" | "multi_step";

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
  output?: Record<string, unknown>;
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
  title: string;
  source?: string;
  content: string;
  score: number;
  projectId: string;
}

export interface EvidencePack {
  query: string;
  skillId?: string;
  items: EvidenceItem[];
}

export interface ExecutionResult {
  status: "success" | "failed" | "skipped";
  capabilityId?: string;
  message: string;
  output?: Record<string, unknown>;
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
}

export interface ChatResponse {
  answer: string;
  routePlan: RoutePlan;
  evidencePack?: EvidencePack;
  executionResult?: ExecutionResult;
  skillPlan?: SkillPlan;
  skillResults?: SkillExecutionResult[];
  observation?: SkillObservation;
}

export type DocumentWriteProgressEvent =
  | { type: "document_created"; documentId: string; title: string; chunkCount: number }
  | { type: "chunks_created"; documentId: string; chunkCount: number }
  | { type: "embedding_started"; documentId: string; chunkCount: number }
  | { type: "embedding_progress"; documentId: string; completed: number; total: number }
  | { type: "vectors_written"; documentId: string; vectorCount: number };

export type ChatStreamEvent =
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
    }
  | { type: "error"; runId?: string; status?: RunStatus; error: string };

export interface ChatStreamCallbacks {
  onEvent: (event: ChatStreamEvent) => void | Promise<void>;
}

export interface StoredDocumentInput {
  title: string;
  content: string;
  source?: string;
  projectId: string;
  metadata?: Record<string, unknown>;
}

export interface StoredDocument {
  id: string;
  title: string;
  content: string;
  source?: string;
  projectId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface StoredChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  createdAt: string;
}
