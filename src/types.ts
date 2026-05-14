export type TaskType = "chat" | "rag_chat" | "skill_call" | "workflow";
export type CapabilityKind = "skill" | "workflow";
export type RiskLevel = "low" | "medium" | "high";
export type CostLevel = "low" | "medium" | "high";

export interface RequestContext {
  requestId: string;
  sessionId: string;
  userId?: string;
  projectId: string;
  message: string;
  createdAt: string;
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
  title: string;
  source?: string;
  content: string;
  score: number;
  projectId: string;
}

export interface EvidencePack {
  query: string;
  items: EvidenceItem[];
}

export interface ExecutionResult {
  status: "success" | "failed" | "skipped";
  capabilityId?: string;
  message: string;
  output?: Record<string, unknown>;
  error?: string;
}

export interface FinalContext {
  request: RequestContext;
  routePlan: RoutePlan;
  evidencePack?: EvidencePack;
  executionResult?: ExecutionResult;
  constraints: string[];
}

export interface ChatResponse {
  answer: string;
  routePlan: RoutePlan;
  evidencePack?: EvidencePack;
  executionResult?: ExecutionResult;
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
