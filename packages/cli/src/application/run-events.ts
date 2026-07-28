import type {
  ApprovalActor,
  ApprovalDecision,
  FailureInfo,
  NodeOutputPaths,
} from "../domain/run-state.js";
import type { WorkflowScopeKind } from "../domain/workflow-package.js";

interface EventBase {
  readonly outputVersion: 1;
  readonly timestamp: string;
}

interface TopLevelNodeEventIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly ordinal: number;
}

interface ScopedNodeEventIdentity {
  readonly runId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly loopNodeId: string;
  readonly iteration: number;
  readonly ordinal: number;
}

type NodeEventIdentity = TopLevelNodeEventIdentity | ScopedNodeEventIdentity;

export interface RunStartedEvent extends EventBase {
  readonly type: "run.started";
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly projectRoot?: string;
  readonly revisionId: string;
  readonly cwd: string;
}

export type NodeStartedEvent = EventBase &
  NodeEventIdentity &
  NodeOutputPaths & {
    readonly type: "node.started";
    readonly runtime: string;
    readonly model?: string;
    readonly attempt?: number;
  };

export type AgentNodeFinishedEvent = EventBase &
  NodeEventIdentity & { readonly type: "node.finished"; readonly attempt?: number } & (
    | { readonly status: "skipped" }
    | (NodeOutputPaths & {
        readonly status: "succeeded";
        readonly durationMs: number;
        readonly exitCode: 0;
      })
    | (NodeOutputPaths & {
        readonly status: "cancelled";
        readonly durationMs: number;
        readonly exitCode?: number;
      })
    | (NodeOutputPaths & {
        readonly status: "failed" | "interrupted";
        readonly durationMs: number;
        readonly exitCode?: number;
        readonly error: FailureInfo;
        readonly willRetry?: true;
      })
  );

export type ApprovalRequestedEvent = EventBase &
  NodeEventIdentity & {
    readonly type: "approval.requested";
    readonly question: string;
    readonly deadlineAt: string;
  };

export type ApprovalResolvedEvent = EventBase &
  NodeEventIdentity & {
    readonly type: "approval.resolved";
    readonly decision: ApprovalDecision;
    readonly actor: ApprovalActor;
  };

export type ApprovalNodeFinishedEvent = EventBase &
  NodeEventIdentity & { readonly type: "node.finished"; readonly nodeKind: "approval" } & (
    | { readonly status: "skipped" }
    | { readonly status: "succeeded" | "cancelled"; readonly durationMs: number }
    | {
        readonly status: "failed" | "interrupted";
        readonly durationMs: number;
        readonly error: FailureInfo;
      }
  );

export type NodeFinishedEvent = AgentNodeFinishedEvent | ApprovalNodeFinishedEvent;

export type RunFinishedEvent = EventBase & {
  readonly type: "run.finished";
  readonly runId: string;
  readonly durationMs: number;
} & (
    | { readonly status: "succeeded" | "cancelled" }
    | { readonly status: "failed" | "interrupted"; readonly error: FailureInfo }
  );

export interface CommandErrorEvent extends EventBase, FailureInfo {
  readonly type: "error";
  readonly path?: string;
  readonly runId?: string;
  readonly nodeId?: string;
}

export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | NodeFinishedEvent
  | RunFinishedEvent
  | CommandErrorEvent;

export type RunAttentionEvent = ApprovalRequestedEvent | RunFinishedEvent;

export interface RunControl {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: RunEvent) => void;
}
