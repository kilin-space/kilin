import type { JsonObject } from "./canonical-json.js";

export type WorkflowSchemaVersion = 1;

export const runtimeIds = ["codex", "claude-code", "opencode"] as const;

export type RuntimeId = (typeof runtimeIds)[number];

const workflowNodeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const isWorkflowNodeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && workflowNodeIdentifierPattern.test(value);

export type NodeKind = "agent" | "approval" | "loop";

export type NodeAccess = "read_only" | "workspace_write";

export type NodeJoin = "all" | "any";

export const retryableFailureCodes = [
  "NODE_OUTPUT_INVALID",
  "NODE_EXIT_NONZERO",
  "NODE_TIMEOUT",
] as const;

export type RetryableFailureCode = (typeof retryableFailureCodes)[number];

export interface AgentRetryPolicy {
  maxAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  on?: readonly RetryableFailureCode[];
  safeToRepeat: true;
}

export interface AgentOutputDeclarationInput {
  type: string;
  path?: string;
  choices?: readonly string[];
  schema?: unknown;
}

export interface TextOutputDeclaration {
  type: "text";
}

export interface JsonOutputDeclaration {
  type: "json";
  schema?: JsonObject;
}

export interface DecisionPacketOutputDeclaration {
  type: "decision_packet";
}

export interface ArtifactOutputDeclaration {
  type: "artifact";
  path: string;
}

export interface ChoiceOutputDeclaration {
  type: "choice";
  choices: string[];
}

export type AgentOutputDeclaration =
  | TextOutputDeclaration
  | JsonOutputDeclaration
  | DecisionPacketOutputDeclaration
  | ArtifactOutputDeclaration
  | ChoiceOutputDeclaration;

export interface WorkflowMetadata {
  id: string;
  name: string;
}

export interface AgentNode {
  id: string;
  kind: "agent";
  runtime: RuntimeId;
  access: NodeAccess;
  prompt: string;
  timeoutMs?: number;
  model?: string;
  output?: AgentOutputDeclaration;
  retry?: AgentRetryPolicy;
  join?: NodeJoin;
  workspace?: string;
  parameters?: string[];
}

export interface ApprovalNode {
  id: string;
  kind: "approval";
  question: string;
  join?: NodeJoin;
}

export interface LoopDecision {
  node: string;
  passChoice: string;
  reviseChoice: string;
}

export interface LoopFeedback {
  from: string;
  to: string;
  input: string;
}

export interface LoopResult {
  node: string;
}

export interface LoopBody {
  nodes: (AgentNode | ApprovalNode)[];
  edges: DependencyEdge[];
}

export interface LoopNode {
  id: string;
  kind: "loop";
  maxIterations: number;
  body: LoopBody;
  decision: LoopDecision;
  feedback: LoopFeedback;
  result: LoopResult;
}

export interface LoopControlNode {
  id: string;
  kind: "loop";
  output: AgentOutputDeclaration;
}

export type WorkflowNode = AgentNode | ApprovalNode | LoopNode;
export type ExecutionNode = AgentNode | ApprovalNode | LoopControlNode;

export interface WorkflowNodeInput {
  id: string;
  kind: string;
  runtime: string;
  access: NodeAccess;
  prompt: string;
  timeoutMs?: unknown;
  model?: string;
  output?: AgentOutputDeclarationInput;
  retry?: AgentRetryPolicy;
  join?: NodeJoin;
  workspace?: string;
  parameters?: readonly unknown[];
  question?: never;
}

export interface ApprovalNodeInput {
  id: string;
  kind: "approval";
  question: string;
  runtime?: never;
  access?: never;
  prompt?: never;
  timeoutMs?: never;
  model?: never;
  output?: never;
  retry?: never;
  join?: NodeJoin;
  workspace?: never;
  parameters?: never;
}

export interface LoopNodeInput {
  id: string;
  kind: "loop";
  maxIterations: unknown;
  body: unknown;
  decision: unknown;
  feedback: unknown;
  result: unknown;
}

export interface ChoiceEdgeCondition {
  choice: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  input?: string;
  when?: ChoiceEdgeCondition;
}

/**
 * Identifies the producer of one resolved input. An execution source names a concrete execution
 * occurrence, never only an authored node ID; a parameter source names a declared run parameter.
 */
export type ResolvedInputSource =
  { kind: "execution"; sourceExecutionId: string } | { kind: "parameter"; parameterName: string };

export interface InputBinding {
  inputName: string;
  source: ResolvedInputSource;
}

export interface WorkflowDefinitionV1 {
  schemaVersion: WorkflowSchemaVersion;
  workflow: WorkflowMetadata;
  parameters?: string[];
  nodes: WorkflowNode[];
  edges: DependencyEdge[];
}

export interface WorkflowDefinitionInput {
  schemaVersion: WorkflowSchemaVersion;
  workflow: WorkflowMetadata;
  parameters?: readonly unknown[];
  nodes: WorkflowNodeInput[];
  edges: DependencyEdge[];
}

export type WorkflowCompilationInput = Omit<WorkflowDefinitionInput, "nodes"> & {
  nodes: (WorkflowNodeInput | ApprovalNodeInput | LoopNodeInput)[];
};

export interface PlannedNode {
  ordinal: number;
  node: ExecutionNode;
  executionId: string;
  nodeId: string;
  loopNodeId?: string;
  iteration?: number;
  dependencies: string[];
  inputBindings: InputBinding[];
}

export interface PlannedLoopIteration {
  iteration: number;
  executionIds: string[];
  rootExecutionIds: string[];
  decisionExecutionId: string;
  feedbackSourceExecutionId: string;
  feedbackTargetExecutionId: string;
  resultExecutionId: string;
}

export interface PlannedLoop {
  executionId: string;
  nodeId: string;
  maxIterations: number;
  passChoice: string;
  reviseChoice: string;
  feedbackInputName: string;
  iterations: PlannedLoopIteration[];
}

export interface WorkflowExecutionDefinition {
  schemaVersion: WorkflowSchemaVersion;
  workflow: WorkflowMetadata;
  parameters?: string[];
  nodes: ExecutionNode[];
  edges: DependencyEdge[];
}

export interface ExecutionPlan {
  authoredDefinition: WorkflowDefinitionV1;
  definition: WorkflowExecutionDefinition;
  normalizedDefinition: string;
  contentHash: string;
  nodes: PlannedNode[];
  edges: DependencyEdge[];
  loops: PlannedLoop[];
}
