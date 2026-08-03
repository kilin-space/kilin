import { KilinError } from "./errors.js";
import type { KilinErrorCode } from "./errors.js";
import type { RunParameters } from "./run-parameters.js";
import type { AgentOutputDeclaration, WorkflowSchemaVersion } from "./workflow.js";
import type { WorkflowScope } from "./workflow-package.js";
import type { CronTriggerSource } from "./workflow-trigger.js";

export const runStatuses = ["running", "succeeded", "failed", "cancelled", "interrupted"] as const;

export type RunStatus = (typeof runStatuses)[number];

export type TerminalRunStatus = Exclude<RunStatus, "running">;

export const nodeRunStatuses = [
  "pending",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
] as const;

export type NodeRunStatus = (typeof nodeRunStatuses)[number];

export type TerminalNodeRunStatus = Exclude<
  NodeRunStatus,
  "pending" | "running" | "waiting_for_approval"
>;

export const attemptStatuses = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type AttemptStatus = (typeof attemptStatuses)[number];

export type TerminalAttemptStatus = Exclude<AttemptStatus, "running">;

export interface RunOptions {
  nodeTimeoutMs: number;
  approvalTimeoutMs: number;
  maxOutputBytes: number;
  maxParallel: number;
}

export const defaultRunOptions: Readonly<RunOptions> = {
  nodeTimeoutMs: 1_800_000,
  approvalTimeoutMs: 1_800_000,
  maxOutputBytes: 10_485_760,
  maxParallel: 1,
};

export const minimumNodeTimeoutMs = 1_000;
export const maximumNodeTimeoutMs = 86_400_000;
export const minimumApprovalTimeoutMs = 1_000;
export const maximumApprovalTimeoutMs = 86_400_000;
export const minimumOutputBytes = 1_024;
export const maximumOutputBytes = 104_857_600;
export const minimumMaxParallel = 1;
export const maximumMaxParallel = 8;

export interface FailureInfo {
  code: KilinErrorCode;
  message: string;
}

export type ApprovalDecision = "approve" | "reject";

export type ApprovalActor = "agent" | "human";

export const maximumApprovalNoteCharacters = 1_000;

export const elapsedMs = (startedAt: string, finishedAt: string): number =>
  Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));

export const elapsedMsOrUndefined = (
  startedAt: string,
  finishedAt: string | undefined,
): number | undefined => {
  if (finishedAt === undefined) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return undefined;
  }
  return Math.max(0, finished - started);
};

export interface RecordedApprovalDecision {
  decision: ApprovalDecision;
  actor: ApprovalActor;
  decidedAt: string;
  note?: string;
}

export interface ApprovalDecisionRecord extends RecordedApprovalDecision {
  runId: string;
  nodeId: string;
}

export interface WorkflowRevisionRecord {
  id: string;
  scope: WorkflowScope;
  workflowId: string;
  schemaVersion: WorkflowSchemaVersion;
  contentHash: string;
  normalizedDefinition: string;
  createdAt: string;
}

export interface WorkflowRunRecord {
  id: string;
  revisionId: string;
  rerunOfRunId?: string;
  recoveryOfRunId?: string;
  recoveryMode?: "retry" | "resume";
  trigger?: CronTriggerSource;
  canonicalCwd: string;
  options: RunOptions;
  parameters?: RunParameters;
  status: RunStatus;
  startedAt: string;
  cancelRequestedAt?: string;
  finishedAt?: string;
  failure?: FailureInfo;
}

export interface RunCancellationRequest {
  runId: string;
  cancelRequestedAt: string;
}

export interface NodeOutputPaths {
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

export type NodeExecutionProvenance =
  | {
      bodyNodeId?: never;
      loopNodeId?: never;
      iteration?: never;
    }
  | {
      bodyNodeId: string;
      loopNodeId: string;
      iteration: number;
    };

export type AgentNodeRunStatus = Exclude<NodeRunStatus, "waiting_for_approval">;

export type AgentNodeRunRecord = NodeExecutionProvenance & {
  kind: "agent";
  runId: string;
  nodeId: string;
  ordinal: number;
  runtime: string;
  requestedModel?: string;
  effectiveModel?: string;
  runtimeVersion?: string;
  status: AgentNodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  failure?: FailureInfo;
  outputPaths?: NodeOutputPaths;
  resolvedInputsPath?: string;
  outputType?: AgentOutputDeclaration["type"];
  artifactPath?: string;
  attempt?: number;
  reusedFromRunId?: string;
  reusedFromNodeId?: string;
};

export type ApprovalNodeRunStatus = Exclude<NodeRunStatus, "running">;

export type ApprovalNodeRunRecord = NodeExecutionProvenance & {
  kind: "approval";
  runId: string;
  nodeId: string;
  ordinal: number;
  status: ApprovalNodeRunStatus;
  requestedAt?: string;
  deadlineAt?: string;
  decision?: RecordedApprovalDecision;
  finishedAt?: string;
  failure?: FailureInfo;
  runtime?: never;
  requestedModel?: never;
  effectiveModel?: never;
  runtimeVersion?: never;
  startedAt?: never;
  exitCode?: never;
  outputPaths?: never;
  resolvedInputsPath?: never;
  outputType?: never;
  artifactPath?: never;
  attempt?: never;
  reusedFromRunId?: never;
  reusedFromNodeId?: never;
};

export type LoopNodeRunStatus = Exclude<NodeRunStatus, "waiting_for_approval">;

export interface LoopNodeRunRecord {
  kind: "loop";
  runId: string;
  nodeId: string;
  ordinal: number;
  status: LoopNodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  failure?: FailureInfo;
  resultPath?: string;
  outputType?: AgentOutputDeclaration["type"];
  bodyNodeId?: never;
  loopNodeId?: never;
  iteration?: never;
  runtime?: never;
  requestedModel?: never;
  effectiveModel?: never;
  runtimeVersion?: never;
  exitCode?: never;
  resolvedInputsPath?: never;
  artifactPath?: never;
  attempt?: never;
  reusedFromRunId?: never;
  reusedFromNodeId?: never;
  requestedAt?: never;
  deadlineAt?: never;
  decision?: never;
  outputPaths?: never;
}

export type NodeRunRecord = AgentNodeRunRecord | ApprovalNodeRunRecord | LoopNodeRunRecord;

export interface NodeAttemptRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  status: AttemptStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  failure?: FailureInfo;
  outputPaths: NodeOutputPaths;
}

export interface RunWorkspaceRecord {
  runId: string;
  workspaceId: string;
  path: string;
  baseCommit: string;
  status: "provisioned";
  createdAt: string;
}

export interface RunDetail {
  run: WorkflowRunRecord;
  revision: WorkflowRevisionRecord;
  nodes: NodeRunRecord[];
  attempts?: NodeAttemptRecord[];
  workspaces?: RunWorkspaceRecord[];
}

export interface RunListRecord extends WorkflowRunRecord {
  scope: WorkflowScope;
  workflowId: string;
}

export type StartNodeTransition = NodeOutputPaths & {
  status: "running";
  runtimeVersion?: string;
  effectiveModel?: string;
};

export type FinishNodeTransition =
  | {
      status: "succeeded";
      exitCode: 0;
      runtimeVersion?: string;
      effectiveModel?: string;
    }
  | {
      status: "failed" | "interrupted";
      exitCode?: number;
      failure: FailureInfo;
      runtimeVersion?: string;
      effectiveModel?: string;
    }
  | {
      status: "cancelled";
      exitCode?: number;
      runtimeVersion?: string;
      effectiveModel?: string;
    }
  | {
      status: "skipped";
    };

export type NodeTransition = StartNodeTransition | FinishNodeTransition;

export type LoopTransition =
  | { status: "running" }
  | {
      status: "succeeded";
      resultPath: string;
      outputType: AgentOutputDeclaration["type"];
    }
  | {
      status: "failed" | "interrupted";
      failure: FailureInfo;
    }
  | { status: "cancelled" | "skipped" };

export type RunTransition =
  | { status: "succeeded" | "cancelled" }
  | { status: "failed" | "interrupted"; failure: FailureInfo };

const legalRunTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const terminalNodeTransitions: Readonly<
  Pick<Record<NodeRunStatus, readonly NodeRunStatus[]>, TerminalNodeRunStatus>
> = {
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  skipped: [],
};

const legalNodeTransitions: Readonly<Record<NodeRunStatus, readonly NodeRunStatus[]>> = {
  pending: ["running", "waiting_for_approval", "skipped"],
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  waiting_for_approval: ["succeeded", "failed", "cancelled", "interrupted"],
  ...terminalNodeTransitions,
};

const legalAgentNodeTransitions: Readonly<Record<NodeRunStatus, readonly NodeRunStatus[]>> = {
  pending: ["running", "skipped"],
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  waiting_for_approval: [],
  ...terminalNodeTransitions,
};

const legalApprovalNodeTransitions: Readonly<Record<NodeRunStatus, readonly NodeRunStatus[]>> = {
  pending: ["waiting_for_approval", "skipped"],
  running: [],
  waiting_for_approval: ["succeeded", "failed", "cancelled", "interrupted"],
  ...terminalNodeTransitions,
};

const legalLoopNodeTransitions: Readonly<Record<NodeRunStatus, readonly NodeRunStatus[]>> = {
  pending: ["running", "cancelled", "skipped"],
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  waiting_for_approval: [],
  ...terminalNodeTransitions,
};

const legalAttemptTransitions: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  running: ["succeeded", "failed", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export const isTerminalRunStatus = (status: RunStatus): status is TerminalRunStatus =>
  status !== "running";

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" && runStatuses.some((status) => status === value);

export const isTerminalNodeRunStatus = (status: NodeRunStatus): status is TerminalNodeRunStatus =>
  status !== "pending" && status !== "running" && status !== "waiting_for_approval";

export const isNodeRunStatus = (value: unknown): value is NodeRunStatus =>
  typeof value === "string" && nodeRunStatuses.some((status) => status === value);

/**
 * Lifecycle predicate: the approval node holds its stored waiting status and has no recorded
 * decision. It never authorizes a decision; decision eligibility stays with the guarded store
 * transition.
 */
export const isApprovalAwaitingDecision = (node: ApprovalNodeRunRecord): boolean =>
  node.status === "waiting_for_approval" && node.decision === undefined;

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean =>
  legalRunTransitions[from].includes(to);

export const canTransitionNodeRun = (from: NodeRunStatus, to: NodeRunStatus): boolean =>
  legalNodeTransitions[from].includes(to);

export const canTransitionAgentNodeRun = (from: NodeRunStatus, to: NodeRunStatus): boolean =>
  legalAgentNodeTransitions[from].includes(to);

export const canTransitionApprovalNodeRun = (from: NodeRunStatus, to: NodeRunStatus): boolean =>
  legalApprovalNodeTransitions[from].includes(to);

export const canTransitionLoopNodeRun = (from: NodeRunStatus, to: NodeRunStatus): boolean =>
  legalLoopNodeTransitions[from].includes(to);

export const canTransitionAttempt = (from: AttemptStatus, to: AttemptStatus): boolean =>
  legalAttemptTransitions[from].includes(to);

export const canResetAgentNodeForRetry = (from: NodeRunStatus, to: NodeRunStatus): boolean =>
  from === "failed" && to === "pending";

export const assertRunTransition = (from: RunStatus, to: RunStatus): void => {
  if (!canTransitionRun(from, to)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Run status cannot change from "${from}" to "${to}". Inspect the stored run before retrying.`,
    );
  }
};

export const assertNodeRunTransition = (from: NodeRunStatus, to: NodeRunStatus): void => {
  if (!canTransitionNodeRun(from, to)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Node status cannot change from "${from}" to "${to}". Inspect the stored run before retrying.`,
    );
  }
};

const assertKindSpecificNodeTransition = (
  kind: "agent" | "approval" | "loop",
  from: NodeRunStatus,
  to: NodeRunStatus,
  isAllowed: boolean,
): void => {
  if (!isAllowed) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `${kind} node status cannot change from "${from}" to "${to}". Inspect the stored node before retrying.`,
    );
  }
};

export const assertAgentNodeRunTransition = (from: NodeRunStatus, to: NodeRunStatus): void => {
  assertKindSpecificNodeTransition("agent", from, to, canTransitionAgentNodeRun(from, to));
};

export const assertApprovalNodeRunTransition = (from: NodeRunStatus, to: NodeRunStatus): void => {
  assertKindSpecificNodeTransition("approval", from, to, canTransitionApprovalNodeRun(from, to));
};

export const assertLoopNodeRunTransition = (from: NodeRunStatus, to: NodeRunStatus): void => {
  assertKindSpecificNodeTransition("loop", from, to, canTransitionLoopNodeRun(from, to));
};

export const assertAttemptTransition = (from: AttemptStatus, to: AttemptStatus): void => {
  if (!canTransitionAttempt(from, to)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Attempt status cannot change from "${from}" to "${to}". Attempt evidence is immutable after it becomes terminal.`,
    );
  }
};

export const assertAgentNodeRetryReset = (from: NodeRunStatus, to: NodeRunStatus): void => {
  if (!canResetAgentNodeForRetry(from, to)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Agent retry reset requires a failed aggregate node and a pending destination, not "${from}" to "${to}".`,
    );
  }
};

export const assertRunOptions = (options: RunOptions): void => {
  if (
    !Number.isInteger(options.nodeTimeoutMs) ||
    options.nodeTimeoutMs < minimumNodeTimeoutMs ||
    options.nodeTimeoutMs > maximumNodeTimeoutMs
  ) {
    throw new KilinError(
      "OPTION_INVALID",
      "Node timeout must be an integer from 1000 through 86400000 milliseconds. Choose a duration from one second through 24 hours.",
    );
  }
  if (
    !Number.isInteger(options.approvalTimeoutMs) ||
    options.approvalTimeoutMs < minimumApprovalTimeoutMs ||
    options.approvalTimeoutMs > maximumApprovalTimeoutMs
  ) {
    throw new KilinError(
      "OPTION_INVALID",
      "Approval timeout must be an integer from 1000 through 86400000 milliseconds. Choose a duration from one second through 24 hours.",
    );
  }
  if (
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < minimumOutputBytes ||
    options.maxOutputBytes > maximumOutputBytes
  ) {
    throw new KilinError(
      "OPTION_INVALID",
      "Maximum output must be an integer from 1024 through 104857600 bytes. Choose a limit from 1 KiB through 100 MiB.",
    );
  }
  if (
    !Number.isInteger(options.maxParallel) ||
    options.maxParallel < minimumMaxParallel ||
    options.maxParallel > maximumMaxParallel
  ) {
    throw new KilinError(
      "OPTION_INVALID",
      "Maximum parallel executions must be an integer from 1 through 8. Choose a bound in that range.",
    );
  }
};
