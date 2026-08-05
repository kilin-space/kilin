import { dirname } from "node:path";

import type { RunEvent } from "../application/run-events.js";
import { KilinError } from "../domain/errors.js";
import type { KilinErrorCode } from "../domain/errors.js";
import type {
  AgentNodeRunRecord,
  ApprovalDecisionRecord,
  RunCancellationRequest,
  ApprovalNodeRunRecord,
  FailureInfo,
  LoopNodeRunRecord,
  NodeAttemptRecord,
  NodeOutputPaths,
  RecordedApprovalDecision,
  RunDetail,
  RunListRecord,
  WorkflowRunRecord,
} from "../domain/run-state.js";
import { elapsedMs } from "../domain/run-state.js";
import type {
  AgentNode,
  AgentOutputDeclaration,
  ExecutionPlan,
  LoopControlNode,
  PlannedLoop,
  PlannedNode,
  RuntimeId,
} from "../domain/workflow.js";
import type {
  WorkflowCatalog,
  WorkflowIdentity,
  WorkflowScopeKind,
} from "../domain/workflow-package.js";
import type { CronTriggerSource } from "../domain/workflow-trigger.js";

import { OptionError } from "./arguments.js";

export interface InitResultDocument {
  readonly outputVersion: 1;
  readonly scope: WorkflowScopeKind;
  readonly directory: string;
  readonly manifestFile: string;
  readonly definitionFile: string;
  readonly workflowId: string;
  readonly created: true;
}

export interface ValidationResultDocument {
  readonly outputVersion: 1;
  readonly valid: true;
  readonly scope: WorkflowScopeKind;
  readonly workflowId: string;
  readonly contentHash: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly executionOrder: string[];
}

export interface WorkflowCatalogDocument extends WorkflowCatalog {
  readonly outputVersion: 1;
}

export interface ViewerStartedDocument {
  readonly outputVersion: 1;
  readonly type: "viewer.started";
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly projectRoot?: string;
  readonly cwd: string;
  readonly url: string;
}

export interface CommandErrorDocument {
  readonly outputVersion: 1;
  readonly type: "error";
  readonly timestamp: string;
  readonly code: KilinErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly runId?: string;
  readonly nodeId?: string;
}

interface ErrorInfoDocument {
  readonly code: KilinErrorCode;
  readonly message: string;
  readonly path?: string;
}

interface RunIdentityDocument {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly projectRoot?: string;
  readonly revisionId: string;
  readonly rerunOfRunId?: string;
  readonly recoveryOfRunId?: string;
  readonly recoveryMode?: "retry" | "resume";
  readonly trigger?: CronTriggerSource;
  readonly cwd: string;
  readonly startedAt: string;
  readonly cancelRequestedAt?: string;
}

interface CompletionDocument {
  readonly finishedAt: string;
  readonly durationMs: number;
}

export type RunSummaryDocument = RunIdentityDocument &
  (
    | { readonly status: "running" }
    | (CompletionDocument & { readonly status: "succeeded" | "cancelled" })
    | (CompletionDocument & {
        readonly status: "failed" | "interrupted";
        readonly error: ErrorInfoDocument;
      })
  );

interface TopLevelNodeIdentityDocument {
  readonly nodeId: string;
  readonly ordinal: number;
}

interface ScopedNodeIdentityDocument {
  readonly executionId: string;
  readonly nodeId: string;
  readonly loopNodeId: string;
  readonly iteration: number;
  readonly ordinal: number;
}

type NodeIdentityDocument = TopLevelNodeIdentityDocument | ScopedNodeIdentityDocument;

type AgentNodeIdentityDocument = NodeIdentityDocument & {
  readonly kind: "agent";
  readonly runtime: RuntimeId;
  readonly model?: string;
  readonly outputType?: AgentOutputDeclaration["type"];
  readonly artifactPath?: string;
  readonly resolvedInputsPath?: string;
  readonly attempt?: number;
  readonly reusedFromRunId?: string;
  readonly reusedFromNodeId?: string;
};

interface NodeStartedDocument {
  readonly startedAt: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultPath: string;
}

export type AgentNodeSummaryDocument = AgentNodeIdentityDocument &
  (
    | { readonly status: "pending" }
    | { readonly status: "skipped"; readonly finishedAt: string }
    | (NodeStartedDocument & {
        readonly status: "running";
        readonly pid?: number;
        // Measured when this document is produced, not persisted.
        readonly durationMs: number;
      })
    | (NodeStartedDocument &
        CompletionDocument & {
          readonly status: "succeeded";
          readonly exitCode: 0;
        })
    | (NodeStartedDocument &
        CompletionDocument & {
          readonly status: "cancelled";
          readonly exitCode?: number;
        })
    | (NodeStartedDocument &
        CompletionDocument & {
          readonly status: "failed" | "interrupted";
          readonly exitCode?: number;
          readonly error: ErrorInfoDocument;
        })
  );

type ApprovalNodeIdentityDocument = NodeIdentityDocument & {
  readonly kind: "approval";
  readonly question: string;
};

interface ApprovalRequestDocument {
  readonly requestedAt: string;
  readonly deadlineAt: string;
}

export type ApprovalNodeSummaryDocument = ApprovalNodeIdentityDocument &
  (
    | { readonly status: "pending" }
    | { readonly status: "skipped"; readonly finishedAt: string }
    | (ApprovalRequestDocument & {
        readonly status: "waiting_for_approval";
        readonly decision?: RecordedApprovalDecision;
      })
    | (ApprovalRequestDocument &
        CompletionDocument & {
          readonly status: "succeeded";
          readonly decision: RecordedApprovalDecision & { readonly decision: "approve" };
        })
    | (ApprovalRequestDocument &
        CompletionDocument & {
          readonly status: "cancelled";
          readonly decision?: RecordedApprovalDecision;
        })
    | (ApprovalRequestDocument &
        CompletionDocument & {
          readonly status: "failed" | "interrupted";
          readonly decision?: RecordedApprovalDecision;
          readonly error: ErrorInfoDocument;
        })
  );

interface LoopNodeIdentityDocument {
  readonly kind: "loop";
  readonly nodeId: string;
  readonly ordinal: number;
  readonly maxIterations: number;
  readonly passChoice: string;
  readonly reviseChoice: string;
  readonly feedbackInputName: string;
  readonly outputType: AgentOutputDeclaration["type"];
  readonly iterations: LoopIterationSummaryDocument[];
}

interface LoopStartedDocument {
  readonly startedAt: string;
}

export type LoopNodeSummaryDocument = LoopNodeIdentityDocument &
  (
    | { readonly status: "pending" }
    | { readonly status: "skipped"; readonly finishedAt: string }
    | (LoopStartedDocument & { readonly status: "running" })
    | (LoopStartedDocument &
        CompletionDocument & {
          readonly status: "succeeded";
          readonly resultPath: string;
        })
    | ({ readonly status: "cancelled"; readonly finishedAt: string } & (
        | { readonly startedAt?: never; readonly durationMs?: never }
        | { readonly startedAt: string; readonly durationMs: number }
      ))
    | (LoopStartedDocument &
        CompletionDocument & {
          readonly status: "failed" | "interrupted";
          readonly error: ErrorInfoDocument;
        })
  );

export interface LoopIterationSummaryDocument {
  readonly iteration: number;
  readonly decisionExecutionId: string;
  readonly feedbackSourceExecutionId: string;
  readonly feedbackTargetExecutionId: string;
  readonly resultExecutionId: string;
  readonly nodes: (AgentNodeSummaryDocument | ApprovalNodeSummaryDocument)[];
}

export type NodeSummaryDocument =
  AgentNodeSummaryDocument | ApprovalNodeSummaryDocument | LoopNodeSummaryDocument;

export interface RunListResultDocument {
  readonly outputVersion: 1;
  readonly runs: RunSummaryDocument[];
}

export interface RunDetailResultDocument {
  readonly outputVersion: 1;
  readonly run: RunSummaryDocument;
  readonly nodes: NodeSummaryDocument[];
  readonly attempts?: RunDetail["attempts"];
  readonly workspaces?: RunDetail["workspaces"];
}

export interface RunCancellationResultDocument {
  readonly outputVersion: 1;
  readonly cancellationRequested: true;
  readonly runId: string;
  readonly cancelRequestedAt: string;
}

export interface ApprovalDecisionResultDocument {
  readonly outputVersion: 1;
  readonly recorded: true;
  readonly runId: string;
  readonly nodeId: string;
  readonly decision: ApprovalDecisionRecord["decision"];
  readonly actor: ApprovalDecisionRecord["actor"];
  readonly decidedAt: string;
  readonly note?: string;
}

export interface SkillsStatusDocument {
  readonly outputVersion: 1;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly preference: {
    readonly askedAt: string;
    readonly providers: readonly ("agents" | "claude")[];
  } | null;
  readonly providers: readonly {
    readonly provider: "agents" | "claude";
    readonly skillRoot: string;
    readonly skills: readonly {
      readonly skillName: string;
      readonly path: string;
      readonly status: "missing" | "ok" | "wrong-target" | "broken" | "not-link";
      readonly target?: string;
      readonly expectedTarget: string;
    }[];
  }[];
}

type JsonDocument =
  | InitResultDocument
  | ValidationResultDocument
  | WorkflowCatalogDocument
  | CommandErrorDocument
  | RunListResultDocument
  | RunDetailResultDocument
  | ApprovalDecisionResultDocument
  | RunCancellationResultDocument
  | SkillsStatusDocument
  | ViewerStartedDocument
  | RunEvent;

interface ErrorDetails {
  readonly code: KilinErrorCode;
  readonly message: string;
  readonly path?: string;
}

const errorDetails = (error: unknown): ErrorDetails => {
  if (error instanceof OptionError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof KilinError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Kilin could not complete the command. Check the input and try again.",
  };
};

const invalidStoredState = (subject: string): never => {
  throw new KilinError(
    "INTERNAL_ERROR",
    `${subject} has incomplete stored state. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
  );
};

const requiredTimestamp = (value: string | undefined, subject: string): string =>
  value ?? invalidStoredState(subject);

const requiredFailure = (value: FailureInfo | undefined, subject: string): FailureInfo =>
  value ?? invalidStoredState(subject);

const runIdentity = (run: WorkflowRunRecord, identity: WorkflowIdentity): RunIdentityDocument => ({
  runId: run.id,
  workflowId: identity.workflowId,
  workflowScope: identity.scope.kind,
  ...(identity.scope.kind === "project" ? { projectRoot: identity.scope.root } : {}),
  revisionId: run.revisionId,
  ...(run.rerunOfRunId === undefined ? {} : { rerunOfRunId: run.rerunOfRunId }),
  ...(run.recoveryOfRunId === undefined
    ? {}
    : {
        recoveryOfRunId: run.recoveryOfRunId,
        recoveryMode: run.recoveryMode,
      }),
  ...(run.trigger === undefined ? {} : { trigger: run.trigger }),
  cwd: run.canonicalCwd,
  startedAt: run.startedAt,
  ...(run.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: run.cancelRequestedAt }),
});

const runSummary = (run: WorkflowRunRecord, identity: WorkflowIdentity): RunSummaryDocument => {
  const documentIdentity = runIdentity(run, identity);
  if (run.status === "running") {
    return { ...documentIdentity, status: run.status };
  }

  const finishedAt = requiredTimestamp(run.finishedAt, `Run "${run.id}"`);
  const completion = { finishedAt, durationMs: elapsedMs(run.startedAt, finishedAt) };
  if (run.status === "succeeded" || run.status === "cancelled") {
    return { ...documentIdentity, ...completion, status: run.status };
  }
  return {
    ...documentIdentity,
    ...completion,
    status: run.status,
    error: requiredFailure(run.failure, `Run "${run.id}"`),
  };
};

const nodeIdentity = (
  node: AgentNodeRunRecord | ApprovalNodeRunRecord,
  plannedNode: PlannedNode,
): NodeIdentityDocument => {
  if (node.loopNodeId === undefined) {
    if (plannedNode.loopNodeId !== undefined || plannedNode.iteration !== undefined) {
      return invalidStoredState(`Node "${node.nodeId}"`);
    }
    return { nodeId: node.nodeId, ordinal: node.ordinal };
  }
  if (
    plannedNode.loopNodeId !== node.loopNodeId ||
    plannedNode.iteration !== node.iteration ||
    plannedNode.nodeId !== node.bodyNodeId
  ) {
    return invalidStoredState(`Node "${node.nodeId}"`);
  }
  return {
    executionId: node.nodeId,
    nodeId: node.bodyNodeId,
    loopNodeId: node.loopNodeId,
    iteration: node.iteration,
    ordinal: node.ordinal,
  };
};

const agentNodeIdentity = (
  node: AgentNodeRunRecord,
  definition: AgentNode,
  plannedNode: PlannedNode,
): AgentNodeIdentityDocument => {
  const outputType = definition.output?.type;
  const artifactPath = definition.output?.type === "artifact" ? definition.output.path : undefined;
  if (
    node.runtime !== definition.runtime ||
    node.requestedModel !== definition.model ||
    node.outputType !== outputType ||
    node.artifactPath !== artifactPath
  ) {
    return invalidStoredState(`Agent node "${node.nodeId}"`);
  }
  return {
    ...nodeIdentity(node, plannedNode),
    kind: "agent",
    runtime: definition.runtime,
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(outputType === undefined ? {} : { outputType }),
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(node.resolvedInputsPath === undefined
      ? {}
      : { resolvedInputsPath: node.resolvedInputsPath }),
    ...(node.attempt === undefined ? {} : { attempt: node.attempt }),
    ...(node.reusedFromRunId === undefined
      ? {}
      : {
          reusedFromRunId: node.reusedFromRunId,
          reusedFromNodeId: node.reusedFromNodeId,
        }),
  };
};

const nodeStarted = (node: AgentNodeRunRecord): NodeStartedDocument => {
  const paths = node.outputPaths;
  if (paths === undefined) {
    return invalidStoredState(`Node "${node.nodeId}"`);
  }
  return {
    startedAt: requiredTimestamp(node.startedAt, `Node "${node.nodeId}"`),
    ...paths,
  };
};

const terminalAgentNodeSummary = (
  node: AgentNodeRunRecord,
  identity: AgentNodeIdentityDocument,
): AgentNodeSummaryDocument => {
  const started = nodeStarted(node);
  const finishedAt = requiredTimestamp(node.finishedAt, `Node "${node.nodeId}"`);
  const completion = {
    finishedAt,
    durationMs: elapsedMs(started.startedAt, finishedAt),
  };
  if (node.status === "succeeded") {
    if (node.exitCode !== 0) {
      return invalidStoredState(`Node "${node.nodeId}"`);
    }
    return { ...identity, ...started, ...completion, status: node.status, exitCode: 0 };
  }
  if (node.status === "cancelled") {
    return {
      ...identity,
      ...started,
      ...completion,
      status: node.status,
      ...(node.exitCode === undefined ? {} : { exitCode: node.exitCode }),
    };
  }
  if (node.status === "failed" || node.status === "interrupted") {
    return {
      ...identity,
      ...started,
      ...completion,
      status: node.status,
      ...(node.exitCode === undefined ? {} : { exitCode: node.exitCode }),
      error: requiredFailure(node.failure, `Node "${node.nodeId}"`),
    };
  }
  return invalidStoredState(`Node "${node.nodeId}"`);
};

const agentNodeSummary = (
  node: AgentNodeRunRecord,
  definition: AgentNode,
  plannedNode: PlannedNode,
): AgentNodeSummaryDocument => {
  const identity = agentNodeIdentity(node, definition, plannedNode);
  if (node.status === "pending") {
    return { ...identity, status: node.status };
  }
  if (node.status === "skipped") {
    return {
      ...identity,
      status: node.status,
      finishedAt: requiredTimestamp(node.finishedAt, `Node "${node.nodeId}"`),
    };
  }
  if (node.status === "running") {
    const started = nodeStarted(node);
    return {
      ...identity,
      ...started,
      ...(node.process === undefined ? {} : { pid: node.process.pid }),
      durationMs: elapsedMs(started.startedAt, new Date().toISOString()),
      status: node.status,
    };
  }
  return terminalAgentNodeSummary(node, identity);
};

const approvalRequest = (node: ApprovalNodeRunRecord): ApprovalRequestDocument => ({
  requestedAt: requiredTimestamp(node.requestedAt, `Approval node "${node.nodeId}"`),
  deadlineAt: requiredTimestamp(node.deadlineAt, `Approval node "${node.nodeId}"`),
});

const approvalNodeSummary = (
  node: ApprovalNodeRunRecord,
  question: string,
  plannedNode: PlannedNode,
): ApprovalNodeSummaryDocument => {
  const identity: ApprovalNodeIdentityDocument = {
    ...nodeIdentity(node, plannedNode),
    kind: "approval",
    question,
  };
  if (node.status === "pending") {
    return { ...identity, status: node.status };
  }
  if (node.status === "skipped") {
    return {
      ...identity,
      status: node.status,
      finishedAt: requiredTimestamp(node.finishedAt, `Approval node "${node.nodeId}"`),
    };
  }

  const request = approvalRequest(node);
  if (node.status === "waiting_for_approval") {
    return {
      ...identity,
      ...request,
      status: node.status,
      ...(node.decision === undefined ? {} : { decision: node.decision }),
    };
  }

  const finishedAt = requiredTimestamp(node.finishedAt, `Approval node "${node.nodeId}"`);
  const completion = {
    finishedAt,
    durationMs: elapsedMs(request.requestedAt, finishedAt),
  };
  if (node.status === "succeeded") {
    if (node.decision?.decision !== "approve") {
      return invalidStoredState(`Approval node "${node.nodeId}"`);
    }
    return {
      ...identity,
      ...request,
      ...completion,
      status: node.status,
      decision: { ...node.decision, decision: "approve" },
    };
  }
  if (node.status === "cancelled") {
    return {
      ...identity,
      ...request,
      ...completion,
      status: node.status,
      ...(node.decision === undefined ? {} : { decision: node.decision }),
    };
  }
  return {
    ...identity,
    ...request,
    ...completion,
    status: node.status,
    ...(node.decision === undefined ? {} : { decision: node.decision }),
    error: requiredFailure(node.failure, `Approval node "${node.nodeId}"`),
  };
};

const executionNodeSummary = (
  node: AgentNodeRunRecord | ApprovalNodeRunRecord,
  plannedNode: PlannedNode,
): AgentNodeSummaryDocument | ApprovalNodeSummaryDocument => {
  if (
    node.nodeId !== plannedNode.executionId ||
    node.ordinal !== plannedNode.ordinal ||
    node.kind !== plannedNode.node.kind
  ) {
    return invalidStoredState(`Run "${node.runId}"`);
  }
  if (node.kind === "agent" && plannedNode.node.kind === "agent") {
    return agentNodeSummary(node, plannedNode.node, plannedNode);
  }
  if (node.kind === "approval" && plannedNode.node.kind === "approval") {
    return approvalNodeSummary(node, plannedNode.node.question, plannedNode);
  }
  return invalidStoredState(`Node "${node.nodeId}"`);
};

const loopNodeSummary = (
  node: LoopNodeRunRecord,
  definition: LoopControlNode,
  plannedNode: PlannedNode,
  iterations: LoopIterationSummaryDocument[],
  loop: PlannedLoop,
): LoopNodeSummaryDocument => {
  if (
    node.nodeId !== plannedNode.executionId ||
    node.ordinal !== plannedNode.ordinal ||
    node.kind !== plannedNode.node.kind ||
    (node.status === "succeeded"
      ? node.outputType !== definition.output.type
      : node.outputType !== undefined)
  ) {
    return invalidStoredState(`Loop node "${node.nodeId}"`);
  }
  const identity: LoopNodeIdentityDocument = {
    kind: "loop",
    nodeId: plannedNode.nodeId,
    ordinal: node.ordinal,
    maxIterations: loop.maxIterations,
    passChoice: loop.passChoice,
    reviseChoice: loop.reviseChoice,
    feedbackInputName: loop.feedbackInputName,
    outputType: definition.output.type,
    iterations,
  };
  if (node.status === "pending") {
    return { ...identity, status: node.status };
  }
  if (node.status === "skipped") {
    return {
      ...identity,
      status: node.status,
      finishedAt: requiredTimestamp(node.finishedAt, `Loop node "${node.nodeId}"`),
    };
  }
  if (node.status === "running") {
    const startedAt = requiredTimestamp(node.startedAt, `Loop node "${node.nodeId}"`);
    return { ...identity, status: node.status, startedAt };
  }
  const finishedAt = requiredTimestamp(node.finishedAt, `Loop node "${node.nodeId}"`);
  if (node.status === "cancelled") {
    if (node.startedAt === undefined) {
      return { ...identity, status: node.status, finishedAt };
    }
    return {
      ...identity,
      status: node.status,
      startedAt: node.startedAt,
      finishedAt,
      durationMs: elapsedMs(node.startedAt, finishedAt),
    };
  }
  const startedAt = requiredTimestamp(node.startedAt, `Loop node "${node.nodeId}"`);
  const completion = { finishedAt, durationMs: elapsedMs(startedAt, finishedAt) };
  if (node.status === "succeeded") {
    return {
      ...identity,
      status: node.status,
      startedAt,
      ...completion,
      resultPath: requiredTimestamp(node.resultPath, `Loop node "${node.nodeId}" result path`),
    };
  }
  return {
    ...identity,
    status: node.status,
    startedAt,
    ...completion,
    error: requiredFailure(node.failure, `Loop node "${node.nodeId}"`),
  };
};

export const createRunListDocument = (runs: readonly RunListRecord[]): RunListResultDocument => ({
  outputVersion: 1,
  runs: runs.map((run) => runSummary(run, { scope: run.scope, workflowId: run.workflowId })),
});

export const createRunDetailDocument = (
  detail: RunDetail,
  plan: ExecutionPlan,
): RunDetailResultDocument => {
  if (
    plan.normalizedDefinition !== detail.revision.normalizedDefinition ||
    plan.contentHash !== detail.revision.contentHash ||
    plan.definition.workflow.id !== detail.revision.workflowId ||
    plan.nodes.length !== detail.nodes.length
  ) {
    return invalidStoredState(`Run "${detail.run.id}"`);
  }
  const recordsByExecutionId = new Map(detail.nodes.map((node) => [node.nodeId, node]));
  const plannedByExecutionId = new Map(
    plan.nodes.map((plannedNode) => [plannedNode.executionId, plannedNode]),
  );
  const loopsByExecutionId = new Map(plan.loops.map((loop) => [loop.executionId, loop]));
  const iterationGroupsByLoop = new Map<string, LoopIterationSummaryDocument[]>();
  for (const loop of plan.loops) {
    iterationGroupsByLoop.set(
      loop.executionId,
      loop.iterations.map((iteration) => ({
        iteration: iteration.iteration,
        decisionExecutionId: iteration.decisionExecutionId,
        feedbackSourceExecutionId: iteration.feedbackSourceExecutionId,
        feedbackTargetExecutionId: iteration.feedbackTargetExecutionId,
        resultExecutionId: iteration.resultExecutionId,
        nodes: iteration.executionIds.map((executionId) => {
          const node = recordsByExecutionId.get(executionId);
          const plannedNode = plannedByExecutionId.get(executionId);
          if (
            node === undefined ||
            plannedNode === undefined ||
            node.kind === "loop" ||
            plannedNode.node.kind === "loop"
          ) {
            return invalidStoredState(`Run "${detail.run.id}"`);
          }
          return executionNodeSummary(node, plannedNode);
        }),
      })),
    );
  }
  return {
    outputVersion: 1,
    run: runSummary(detail.run, {
      scope: detail.revision.scope,
      workflowId: detail.revision.workflowId,
    }),
    nodes: plan.nodes
      .filter((plannedNode) => plannedNode.loopNodeId === undefined)
      .map((plannedNode) => {
        const node = recordsByExecutionId.get(plannedNode.executionId);
        if (node === undefined) {
          return invalidStoredState(`Run "${detail.run.id}"`);
        }
        if (node.kind !== "loop" && plannedNode.node.kind !== "loop") {
          return executionNodeSummary(node, plannedNode);
        }
        if (node.kind !== "loop" || plannedNode.node.kind !== "loop") {
          return invalidStoredState(`Node "${node.nodeId}"`);
        }
        const loop = loopsByExecutionId.get(plannedNode.executionId);
        if (loop === undefined) {
          return invalidStoredState(`Loop node "${node.nodeId}"`);
        }
        return loopNodeSummary(
          node,
          plannedNode.node,
          plannedNode,
          iterationGroupsByLoop.get(plannedNode.executionId) ?? [],
          loop,
        );
      }),
    ...(detail.attempts === undefined ? {} : { attempts: detail.attempts }),
    ...(detail.workspaces === undefined ? {} : { workspaces: detail.workspaces }),
  };
};

export const createApprovalDecisionDocument = (
  decision: ApprovalDecisionRecord,
): ApprovalDecisionResultDocument => ({
  outputVersion: 1,
  recorded: true,
  runId: decision.runId,
  nodeId: decision.nodeId,
  decision: decision.decision,
  actor: decision.actor,
  decidedAt: decision.decidedAt,
  ...(decision.note === undefined ? {} : { note: decision.note }),
});

export const renderJson = (document: JsonDocument): void => {
  process.stdout.write(`${JSON.stringify(document)}\n`);
};

export const terminalSafeText = (value: string): string =>
  Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      !(
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      )
    ) {
      return character;
    }
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${codePoint.toString(16).padStart(4, "0")}`;
    }
  }).join("");

export const renderInit = (document: InitResultDocument): void => {
  const scopeRoot = dirname(dirname(dirname(document.directory)));
  process.stdout.write(
    [
      `Created ${document.scope} workflow "${document.workflowId}".`,
      `Manifest: ${terminalSafeText(document.manifestFile)}`,
      `Definition: ${terminalSafeText(document.definitionFile)}`,
      `Next: from ${terminalSafeText(scopeRoot)}, run kilin workflow validate ${document.workflowId}`,
    ].join("\n") + "\n",
  );
};

export const renderValidation = (document: ValidationResultDocument): void => {
  process.stdout.write(
    [
      `Workflow "${document.workflowId}" is valid.`,
      `Scope: ${document.scope}`,
      `Content hash: ${document.contentHash}`,
      `Nodes: ${String(document.nodeCount)}`,
      `Edges: ${String(document.edgeCount)}`,
      `Execution order: ${document.executionOrder.join(" -> ")}`,
    ].join("\n") + "\n",
  );
};

export const renderWorkflowCatalog = (document: WorkflowCatalogDocument): void => {
  if (document.workflows.length === 0) {
    process.stdout.write("No workflows found.\n");
  } else {
    for (const workflow of document.workflows) {
      process.stdout.write(
        `${terminalSafeText(workflow.name)}  ${workflow.scope}  ${terminalSafeText(workflow.description)}  ${terminalSafeText(workflow.location)}\n`,
      );
    }
  }
  for (const diagnostic of document.diagnostics) {
    process.stderr.write(
      `${diagnostic.code}: ${diagnostic.scope} workflow "${terminalSafeText(diagnostic.packageName)}": ${terminalSafeText(diagnostic.message)}\n`,
    );
  }
};

const humanDuration = (duration: number | undefined): string =>
  duration === undefined ? "active" : `${String(duration)} ms`;

const workflowScopeLabel = (scope: WorkflowScopeKind, projectRoot: string | undefined): string =>
  scope === "project"
    ? `project:${terminalSafeText(projectRoot ?? invalidStoredState("Project workflow scope"))}`
    : scope;

export const renderRunList = (document: RunListResultDocument): void => {
  if (document.runs.length === 0) {
    process.stdout.write("No runs found.\n");
    return;
  }
  for (const run of document.runs) {
    const duration = "durationMs" in run ? run.durationMs : undefined;
    const rerunSource = run.rerunOfRunId === undefined ? "" : `  rerun-of=${run.rerunOfRunId}`;
    const triggerSource =
      run.trigger === undefined
        ? ""
        : `  trigger=${run.trigger.kind}:${run.trigger.schedule}@${run.trigger.timezone}`;
    const cancellation =
      run.cancelRequestedAt === undefined ? "" : `  cancel-requested=${run.cancelRequestedAt}`;
    process.stdout.write(
      `${run.runId}  ${run.status}  ${run.workflowId}  scope=${workflowScopeLabel(run.workflowScope, run.projectRoot)}  revision=${run.revisionId}${rerunSource}${triggerSource}${cancellation}  ${run.startedAt}  ${humanDuration(duration)}  ${run.cwd}\n`,
    );
  }
};

interface NodeEvidenceLines {
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly outputPaths?: NodeOutputPaths;
  readonly failure?: ErrorInfoDocument;
}

const pushNodeEvidenceLines = (
  lines: string[],
  indent: string,
  evidence: NodeEvidenceLines,
): void => {
  if (evidence.startedAt !== undefined) {
    lines.push(`${indent}started: ${evidence.startedAt}`);
  }
  if (evidence.finishedAt !== undefined) {
    lines.push(`${indent}finished: ${evidence.finishedAt}`);
  }
  if (evidence.durationMs !== undefined) {
    lines.push(`${indent}duration: ${String(evidence.durationMs)} ms`);
  }
  if (evidence.exitCode !== undefined) {
    lines.push(`${indent}exit code: ${String(evidence.exitCode)}`);
  }
  if (evidence.outputPaths !== undefined) {
    lines.push(`${indent}stdout: ${terminalSafeText(evidence.outputPaths.stdoutPath)}`);
    lines.push(`${indent}stderr: ${terminalSafeText(evidence.outputPaths.stderrPath)}`);
    lines.push(`${indent}result: ${terminalSafeText(evidence.outputPaths.resultPath)}`);
  }
  if (evidence.failure !== undefined) {
    lines.push(
      `${indent}error: ${evidence.failure.code}: ${terminalSafeText(evidence.failure.message)}`,
    );
  }
};

const renderExecutionSummary = (
  lines: string[],
  node: AgentNodeSummaryDocument | ApprovalNodeSummaryDocument,
  storedNode: AgentNodeRunRecord | ApprovalNodeRunRecord,
  attemptsByExecutionId: ReadonlyMap<string, NodeAttemptRecord[]>,
  indent: string,
): void => {
  const executionId = "executionId" in node ? node.executionId : node.nodeId;
  const nodeAttempts = attemptsByExecutionId.get(executionId);
  const scope =
    "executionId" in node
      ? `  execution=${node.executionId}  loop=${node.loopNodeId}  iteration=${String(node.iteration)}`
      : "";
  if (node.kind === "approval") {
    lines.push(
      `${indent}${String(node.ordinal)}. ${node.nodeId}  ${node.status}  approval${scope}`,
    );
    lines.push(`${indent}   question: ${terminalSafeText(node.question)}`);
    if ("requestedAt" in node) {
      lines.push(`${indent}   requested: ${node.requestedAt}`);
      lines.push(`${indent}   deadline: ${node.deadlineAt}`);
    }
    if ("decision" in node) {
      lines.push(
        `${indent}   decision: ${node.decision.decision} by ${node.decision.actor} at ${node.decision.decidedAt}`,
      );
      if (node.decision.note !== undefined) {
        lines.push(`${indent}   note: ${terminalSafeText(node.decision.note)}`);
      }
    }
  } else {
    if (storedNode.kind !== "agent") {
      return invalidStoredState(`Node "${node.nodeId}"`);
    }
    lines.push(
      `${indent}${String(node.ordinal)}. ${node.nodeId}  ${node.status}  ${node.runtime}${scope}`,
    );
    if (storedNode.requestedModel !== undefined) {
      lines.push(`${indent}   requested model: ${terminalSafeText(storedNode.requestedModel)}`);
    }
    if (storedNode.effectiveModel !== undefined) {
      lines.push(`${indent}   effective model: ${terminalSafeText(storedNode.effectiveModel)}`);
    }
    if (storedNode.runtimeVersion !== undefined) {
      lines.push(`${indent}   runtime version: ${terminalSafeText(storedNode.runtimeVersion)}`);
    }
    if (node.outputType !== undefined) {
      lines.push(`${indent}   output type: ${node.outputType}`);
    }
    if (node.artifactPath !== undefined) {
      lines.push(`${indent}   artifact: ${terminalSafeText(node.artifactPath)}`);
    }
    if (node.resolvedInputsPath !== undefined) {
      lines.push(`${indent}   resolved inputs: ${terminalSafeText(node.resolvedInputsPath)}`);
    }
    if (node.attempt !== undefined) {
      lines.push(`${indent}   attempt: ${String(node.attempt)}`);
    }
    if ("pid" in node) {
      lines.push(`${indent}   process: ${String(node.pid)}`);
    }
    if (nodeAttempts !== undefined) {
      for (const attempt of nodeAttempts) {
        lines.push(`${indent}   attempt ${String(attempt.attempt)}: ${attempt.status}`);
        pushNodeEvidenceLines(lines, `${indent}     `, attempt);
      }
    }
    if (node.reusedFromRunId !== undefined) {
      lines.push(
        `${indent}   reused from: ${node.reusedFromRunId}/${node.reusedFromNodeId ?? node.nodeId}`,
      );
    }
  }
  if (nodeAttempts === undefined) {
    pushNodeEvidenceLines(lines, `${indent}   `, {
      ...("startedAt" in node ? { startedAt: node.startedAt } : {}),
      ...("finishedAt" in node ? { finishedAt: node.finishedAt } : {}),
      ...("durationMs" in node ? { durationMs: node.durationMs } : {}),
      ...("exitCode" in node ? { exitCode: node.exitCode } : {}),
      ...("stdoutPath" in node
        ? {
            outputPaths: {
              stdoutPath: node.stdoutPath,
              stderrPath: node.stderrPath,
              resultPath: node.resultPath,
            },
          }
        : {}),
      ...("error" in node ? { failure: node.error } : {}),
    });
  }
};

export const renderRunDetail = (detail: RunDetail, document: RunDetailResultDocument): void => {
  const runDuration = "durationMs" in document.run ? document.run.durationMs : undefined;
  const lines = [
    `Run: ${document.run.runId}`,
    `Workflow: ${document.run.workflowId}`,
    `Workflow scope: ${workflowScopeLabel(document.run.workflowScope, document.run.projectRoot)}`,
    `Revision: ${document.run.revisionId}`,
    `Status: ${document.run.status}`,
    `Working directory: ${terminalSafeText(document.run.cwd)}`,
    `Started: ${document.run.startedAt}`,
    `Duration: ${humanDuration(runDuration)}`,
  ];
  if ("finishedAt" in document.run) {
    lines.push(`Finished: ${document.run.finishedAt}`);
  }
  if (document.run.rerunOfRunId !== undefined) {
    lines.push(`Rerun of: ${document.run.rerunOfRunId}`);
  }
  if (document.run.recoveryOfRunId !== undefined) {
    lines.push(
      `${document.run.recoveryMode === "resume" ? "Resumed" : "Retried"} from: ${document.run.recoveryOfRunId}`,
    );
  }
  if (document.run.trigger !== undefined) {
    lines.push(
      `Trigger: ${document.run.trigger.kind} ${document.run.trigger.schedule} (${document.run.trigger.timezone})`,
    );
  }
  if (document.run.cancelRequestedAt !== undefined) {
    lines.push(`Cancellation requested: ${document.run.cancelRequestedAt}`);
  }
  if ("error" in document.run) {
    lines.push(
      `Error: ${document.run.error.code}: ${terminalSafeText(document.run.error.message)}`,
    );
  }
  lines.push("Nodes:");
  const attemptsByExecutionId = new Map<string, NodeAttemptRecord[]>();
  for (const attempt of detail.attempts ?? []) {
    const collected = attemptsByExecutionId.get(attempt.nodeId);
    if (collected === undefined) {
      attemptsByExecutionId.set(attempt.nodeId, [attempt]);
    } else {
      collected.push(attempt);
    }
  }
  const recordsByExecutionId = new Map(detail.nodes.map((node) => [node.nodeId, node]));
  for (const node of document.nodes) {
    if (node.kind === "loop") {
      const storedNode = recordsByExecutionId.get(node.nodeId);
      if (storedNode?.kind !== "loop") {
        return invalidStoredState(`Loop node "${node.nodeId}"`);
      }
      lines.push(
        `  ${String(node.ordinal)}. ${node.nodeId}  ${node.status}  loop  max-iterations=${String(node.maxIterations)}  pass=${node.passChoice}  revise=${node.reviseChoice}  feedback-input=${node.feedbackInputName}  output=${node.outputType}`,
      );
      pushNodeEvidenceLines(lines, "     ", {
        ...("startedAt" in node ? { startedAt: node.startedAt } : {}),
        ...("finishedAt" in node ? { finishedAt: node.finishedAt } : {}),
        ...("durationMs" in node ? { durationMs: node.durationMs } : {}),
        ...("error" in node ? { failure: node.error } : {}),
      });
      if ("resultPath" in node) {
        lines.push(`     result: ${terminalSafeText(node.resultPath)}`);
      }
      for (const iteration of node.iterations) {
        lines.push(`     Iteration ${String(iteration.iteration)}:`);
        lines.push(`       decision execution: ${iteration.decisionExecutionId}`);
        lines.push(
          `       feedback executions: ${iteration.feedbackSourceExecutionId} -> ${iteration.feedbackTargetExecutionId}`,
        );
        lines.push(`       result execution: ${iteration.resultExecutionId}`);
        for (const bodyNode of iteration.nodes) {
          if (!("executionId" in bodyNode)) {
            return invalidStoredState(`Loop node "${node.nodeId}"`);
          }
          const storedBodyNode = recordsByExecutionId.get(bodyNode.executionId);
          if (storedBodyNode === undefined || storedBodyNode.kind === "loop") {
            return invalidStoredState(`Node "${bodyNode.executionId}"`);
          }
          renderExecutionSummary(lines, bodyNode, storedBodyNode, attemptsByExecutionId, "       ");
        }
      }
      continue;
    }
    const storedNode = recordsByExecutionId.get(node.nodeId);
    if (storedNode === undefined || storedNode.kind === "loop") {
      return invalidStoredState(`Node "${node.nodeId}"`);
    }
    renderExecutionSummary(lines, node, storedNode, attemptsByExecutionId, "  ");
  }
  if (document.workspaces !== undefined) {
    lines.push("Workspaces:");
    for (const workspace of document.workspaces) {
      lines.push(
        `  ${workspace.workspaceId}  ${workspace.status}  base=${workspace.baseCommit}  ${terminalSafeText(workspace.path)}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
};

export const createRunCancellationDocument = (
  request: RunCancellationRequest,
): RunCancellationResultDocument => ({
  outputVersion: 1,
  cancellationRequested: true,
  runId: request.runId,
  cancelRequestedAt: request.cancelRequestedAt,
});

/**
 * Acknowledges the recorded request only. The attached owner still needs one poll interval plus its
 * process-group termination grace, so this must never claim the run has already stopped.
 */
export const renderRunCancellation = (
  document: RunCancellationResultDocument,
  json: boolean,
): void => {
  if (json) {
    renderJson(document);
    return;
  }
  process.stdout.write(
    `Requested cancellation of run "${document.runId}" at ${document.cancelRequestedAt}. The attached Kilin process stops its active work shortly.\n`,
  );
};

export const renderApprovalDecision = (
  document: ApprovalDecisionResultDocument,
  json: boolean,
): void => {
  if (json) {
    renderJson(document);
    return;
  }
  process.stdout.write(
    `Recorded ${document.decision} for approval node "${document.nodeId}" in run "${document.runId}" as ${document.actor}.\n`,
  );
};

export const renderRunEvent = (event: RunEvent, json: boolean): void => {
  if (json) {
    renderJson(event);
    return;
  }
  switch (event.type) {
    case "error": {
      const path = event.path === undefined ? "" : ` (${terminalSafeText(event.path)})`;
      process.stderr.write(`${event.code}${path}: ${terminalSafeText(event.message)}\n`);
      return;
    }
    case "run.started":
      process.stdout.write(
        `Run ${event.runId} started for ${workflowScopeLabel(event.workflowScope, event.projectRoot)} workflow "${event.workflowId}" at revision ${event.revisionId}.\nInspect: kilin runs show ${event.runId}\n`,
      );
      return;
    case "node.started": {
      const model =
        event.model === undefined ? "" : ` using model ${terminalSafeText(event.model)}`;
      const attempt = event.attempt === undefined ? "" : ` (attempt ${String(event.attempt)})`;
      process.stdout.write(
        `Node ${String(event.ordinal)} "${event.nodeId}" started with ${event.runtime}${model}${attempt}.\nstdout: ${terminalSafeText(event.stdoutPath)}\nstderr: ${terminalSafeText(event.stderrPath)}\nresult: ${terminalSafeText(event.resultPath)}\n`,
      );
      return;
    }
    case "approval.requested": {
      const decisionTarget = "executionId" in event ? event.executionId : event.nodeId;
      process.stdout.write(
        `Approval ${String(event.ordinal)} "${event.nodeId}" requested: ${terminalSafeText(event.question)}\nDeadline: ${event.deadlineAt}\nApprove: kilin runs approve ${event.runId} ${decisionTarget} --actor human\nReject: kilin runs reject ${event.runId} ${decisionTarget} --actor human\n`,
      );
      return;
    }
    case "approval.resolved":
      process.stdout.write(
        `Approval ${String(event.ordinal)} "${event.nodeId}" recorded ${event.decision} by ${event.actor}.\n`,
      );
      return;
    case "node.finished": {
      const subject = "nodeKind" in event ? "Approval" : "Node";
      const attempt = "attempt" in event ? ` attempt ${String(event.attempt)}` : "";
      const retrying = "willRetry" in event ? "; retrying" : "";
      process.stdout.write(
        `${subject} ${String(event.ordinal)} "${event.nodeId}"${attempt} ${event.status}${"durationMs" in event ? ` in ${String(event.durationMs)} ms` : ""}${retrying}.\n`,
      );
      return;
    }
    case "run.finished":
      process.stdout.write(
        `Run ${event.runId} ${event.status} in ${String(event.durationMs)} ms.\nInspect: kilin runs show ${event.runId}\nRerun: kilin rerun ${event.runId}\n`,
      );
  }
};

export const renderError = (error: unknown, json: boolean): void => {
  const details = errorDetails(error);
  if (json) {
    const document: CommandErrorDocument = {
      outputVersion: 1,
      type: "error",
      timestamp: new Date().toISOString(),
      ...details,
    };
    renderJson(document);
    return;
  }
  const path = details.path === undefined ? "" : ` (${terminalSafeText(details.path)})`;
  process.stderr.write(`${details.code}${path}: ${terminalSafeText(details.message)}\n`);
};
