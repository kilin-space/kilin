import type {
  AgentNodeRunStatus,
  ApprovalNodeRunStatus,
  AttemptStatus,
  LoopNodeRunStatus,
  NodeRunStatus,
  RecordedApprovalDecision,
  RunStatus,
} from "../domain/run-state.js";
import type { WorkflowScopeKind } from "../domain/workflow-package.js";
import type { AgentOutputDeclaration, NodeAccess, RuntimeId } from "../domain/workflow.js";
import type { DecisionPacketV1 } from "../domain/decision-packet.js";

export type ViewerOutputVersion = 1;

export type OutputStream = "stdout" | "stderr" | "result";

export interface ViewerFailureDto {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface WorkflowDiagnosticDto extends ViewerFailureDto {
  readonly severity: "error" | "warning";
}

interface WorkflowNodeBaseDto {
  readonly id: string;
  readonly ordinal: number;
  readonly dependencies: readonly string[];
}

export interface AgentWorkflowNodeDto extends WorkflowNodeBaseDto {
  readonly kind: "agent";
  readonly runtime: RuntimeId;
  readonly access: NodeAccess;
  readonly model?: string;
  readonly outputType?: AgentOutputDeclaration["type"];
  readonly artifactPath?: string;
}

export interface ApprovalWorkflowNodeDto extends WorkflowNodeBaseDto {
  readonly kind: "approval";
  readonly question: string;
}

export type LoopBodyWorkflowNodeDto = AgentWorkflowNodeDto | ApprovalWorkflowNodeDto;

export interface LoopWorkflowNodeDto extends WorkflowNodeBaseDto {
  readonly kind: "loop";
  readonly maxIterations: number;
  readonly body: {
    readonly nodes: readonly LoopBodyWorkflowNodeDto[];
    readonly edges: readonly WorkflowEdgeDto[];
  };
  readonly decision: {
    readonly nodeId: string;
    readonly passChoice: string;
    readonly reviseChoice: string;
  };
  readonly feedback: {
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly input: string;
  };
  readonly resultNodeId: string;
}

export type WorkflowNodeDto = AgentWorkflowNodeDto | ApprovalWorkflowNodeDto | LoopWorkflowNodeDto;

export interface WorkflowEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly input?: string;
}

export interface WorkflowGraphDto {
  readonly workflowId: string;
  readonly name: string;
  readonly description?: string;
  readonly nodes: readonly WorkflowNodeDto[];
  readonly edges: readonly WorkflowEdgeDto[];
  readonly executionOrder: readonly string[];
}

export interface ValidCurrentWorkflowResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly state: "valid";
  readonly contentHash: string;
  readonly workflow: WorkflowGraphDto;
  readonly diagnostics: readonly [];
}

export interface InvalidCurrentWorkflowResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly state: "invalid";
  readonly diagnostics: readonly WorkflowDiagnosticDto[];
}

export type CurrentWorkflowResponse = ValidCurrentWorkflowResponse | InvalidCurrentWorkflowResponse;

export interface RunSummaryDto {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly revisionId: string;
  readonly rerunOfRunId?: string;
  readonly recoveryOfRunId?: string;
  readonly recoveryMode?: "retry" | "resume";
  readonly cwd: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly cancelRequestedAt?: string;
  /**
   * True iff the run is running, has no cancellation requested, and has exactly one approval
   * node waiting for approval with no recorded decision. Absence means false. The flag is a
   * presentation hint only; it never authorizes a decision.
   */
  readonly waitingForApproval?: boolean;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly failure?: ViewerFailureDto;
}

export interface ScopedRunListResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly runs: readonly RunSummaryDto[];
}

interface NodeRunBaseDto {
  readonly executionId: string;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly loopNodeId?: string;
  readonly iteration?: number;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly failure?: ViewerFailureDto;
  readonly availableOutputs: readonly OutputStream[];
}

export interface AgentNodeRunDto extends NodeRunBaseDto {
  readonly kind: "agent";
  readonly runtime: RuntimeId;
  readonly requestedModel?: string;
  readonly effectiveModel?: string;
  readonly runtimeVersion?: string;
  readonly outputType?: AgentOutputDeclaration["type"];
  readonly artifactPath?: string;
  readonly status: AgentNodeRunStatus;
  readonly startedAt?: string;
  readonly exitCode?: number;
  /** Operating-system process of the running attempt; absent once the node is terminal. */
  readonly pid?: number;
}

export interface ApprovalNodeRunDto extends NodeRunBaseDto {
  readonly kind: "approval";
  readonly question: string;
  readonly status: ApprovalNodeRunStatus;
  readonly requestedAt?: string;
  readonly deadlineAt?: string;
  readonly decision?: RecordedApprovalDecision;
  readonly availableOutputs: readonly [];
}

export interface LoopNodeRunDto extends NodeRunBaseDto {
  readonly kind: "loop";
  readonly status: LoopNodeRunStatus;
  readonly startedAt?: string;
  readonly availableOutputs: readonly [];
}

export type NodeRunDto = AgentNodeRunDto | ApprovalNodeRunDto | LoopNodeRunDto;

export interface LoopIterationDto {
  readonly loopNodeId: string;
  readonly iteration: number;
  readonly status: NodeRunStatus;
  readonly executions: readonly (AgentNodeRunDto | ApprovalNodeRunDto)[];
}

export interface ViewerNodeAttemptDto {
  readonly executionId: string;
  readonly attempt: number;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly failure?: ViewerFailureDto;
}

export interface ViewerWorkspaceDto {
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly status: "provisioned";
  readonly createdAt: string;
}

export interface StoredWorkflowRevisionDto {
  readonly revisionId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly workflow: WorkflowGraphDto;
}

export interface RunLineageDto {
  readonly runs: readonly RunSummaryDto[];
  readonly selectedRunIndex: number;
}

export interface ScopedRunDetailResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly workflowId: string;
  readonly workflowScope: WorkflowScopeKind;
  readonly run: RunSummaryDto;
  readonly revision: StoredWorkflowRevisionDto;
  readonly nodes: readonly NodeRunDto[];
  readonly loopIterations: readonly LoopIterationDto[];
  readonly attempts: readonly ViewerNodeAttemptDto[];
  readonly workspaces: readonly ViewerWorkspaceDto[];
  readonly lineage: RunLineageDto;
}

export interface BoundedOutputResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly runId: string;
  readonly ordinal: number;
  readonly stream: OutputStream;
  readonly text: string;
  readonly totalBytes: number;
  readonly returnedBytes: number;
  readonly truncated: boolean;
  readonly decisionPacket?: DecisionPacketV1;
}

export type ViewerApprovalDecision = "approved" | "rejected";

export interface ApprovalDecisionRequest {
  readonly decision: ViewerApprovalDecision;
  readonly note?: string;
}

export interface ApprovalDecisionResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly runId: string;
  readonly nodeId: string;
  readonly decision: RecordedApprovalDecision;
}

export interface RunCancellationResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly runId: string;
  readonly cancelRequestedAt: string;
}

export interface SessionBootstrapResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly csrfToken: string;
  readonly pollIntervalMs: number;
}

export interface ViewerApiErrorResponse {
  readonly outputVersion: ViewerOutputVersion;
  readonly error: ViewerFailureDto;
}
