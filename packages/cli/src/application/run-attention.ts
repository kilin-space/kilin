import { KilinError } from "../domain/errors.js";
import type { ApprovalNodeRunRecord, RunDetail, WorkflowRunRecord } from "../domain/run-state.js";
import { elapsedMs } from "../domain/run-state.js";
import { compileStoredWorkflowRevision } from "./workflows.js";
import type { ApprovalRequestedEvent, RunAttentionEvent, RunFinishedEvent } from "./run-events.js";

const invalidStoredState = (subject: string): never => {
  throw new KilinError(
    "INTERNAL_ERROR",
    `${subject} has incomplete stored state. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
  );
};

const requiredTimestamp = (value: string | undefined, subject: string): string =>
  value ?? invalidStoredState(subject);

const projectTerminalAttention = (run: WorkflowRunRecord): RunFinishedEvent => {
  const finishedAt = requiredTimestamp(run.finishedAt, `Run "${run.id}"`);
  const identity = {
    outputVersion: 1 as const,
    type: "run.finished" as const,
    timestamp: finishedAt,
    runId: run.id,
    durationMs: elapsedMs(run.startedAt, finishedAt),
  };
  if (run.status === "succeeded" || run.status === "cancelled") {
    return { ...identity, status: run.status };
  }
  if ((run.status === "failed" || run.status === "interrupted") && run.failure !== undefined) {
    return { ...identity, status: run.status, error: run.failure };
  }
  return invalidStoredState(`Run "${run.id}"`);
};

const projectApprovalAttention = (
  detail: RunDetail,
  approval: ApprovalNodeRunRecord,
): ApprovalRequestedEvent => {
  if (detail.revision.id !== detail.run.revisionId) {
    return invalidStoredState(`Run "${detail.run.id}"`);
  }
  const plan = compileStoredWorkflowRevision(detail.revision);
  const plannedNode = plan.nodes.find(
    ({ executionId, ordinal }) => executionId === approval.nodeId && ordinal === approval.ordinal,
  );
  if (
    approval.runId !== detail.run.id ||
    plannedNode?.node.kind !== "approval" ||
    approval.bodyNodeId !==
      (plannedNode.loopNodeId === undefined ? undefined : plannedNode.nodeId) ||
    approval.loopNodeId !== plannedNode.loopNodeId ||
    approval.iteration !== plannedNode.iteration
  ) {
    return invalidStoredState(`Approval node "${approval.nodeId}"`);
  }
  const identity =
    approval.bodyNodeId === undefined
      ? {
          runId: approval.runId,
          nodeId: approval.nodeId,
          ordinal: approval.ordinal,
        }
      : {
          runId: approval.runId,
          executionId: approval.nodeId,
          nodeId: approval.bodyNodeId,
          loopNodeId: approval.loopNodeId,
          iteration: approval.iteration,
          ordinal: approval.ordinal,
        };
  return {
    outputVersion: 1,
    type: "approval.requested",
    timestamp: requiredTimestamp(approval.requestedAt, `Approval node "${approval.nodeId}"`),
    ...identity,
    question: plannedNode.node.question,
    deadlineAt: requiredTimestamp(approval.deadlineAt, `Approval node "${approval.nodeId}"`),
  };
};

export const projectRunAttention = (detail: RunDetail): RunAttentionEvent | undefined => {
  if (detail.run.status !== "running") {
    return projectTerminalAttention(detail.run);
  }

  const waitingApprovals = detail.nodes.filter(
    (node): node is ApprovalNodeRunRecord =>
      node.kind === "approval" && node.status === "waiting_for_approval",
  );
  if (waitingApprovals.length > 1) {
    return invalidStoredState(`Run "${detail.run.id}"`);
  }
  const approval = waitingApprovals[0];
  if (approval === undefined || approval.decision !== undefined) {
    return undefined;
  }
  return projectApprovalAttention(detail, approval);
};
