import { describe, expect, it } from "vitest";

import {
  assertAgentNodeRetryReset,
  assertAttemptTransition,
  assertNodeRunTransition,
  assertRunOptions,
  assertRunTransition,
  attemptStatuses,
  canResetAgentNodeForRetry,
  canTransitionAgentNodeRun,
  canTransitionApprovalNodeRun,
  canTransitionAttempt,
  canTransitionLoopNodeRun,
  canTransitionNodeRun,
  canTransitionRun,
  defaultRunOptions,
  isTerminalNodeRunStatus,
  isTerminalRunStatus,
  isNodeRunStatus,
  isRunStatus,
  nodeRunStatuses,
  runStatuses,
} from "../../src/domain/run-state.js";
import { isKilinErrorCode, KilinError, kilinErrorCodes } from "../../src/domain/errors.js";

const expectStateError = (operation: () => void, code: string, messagePart: string): void => {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code });
    expect((error as KilinError).message).toContain(messagePart);
    return;
  }
  throw new Error("Expected the state transition to fail");
};

describe("run state", () => {
  it("owns the exact run-status vocabulary and documented default options", () => {
    expect(runStatuses).toEqual(["running", "succeeded", "failed", "cancelled", "interrupted"]);
    for (const status of runStatuses) {
      expect(isRunStatus(status)).toBe(true);
    }
    expect(isRunStatus("pending")).toBe(false);
    expect(isRunStatus(1)).toBe(false);
    expect(defaultRunOptions).toEqual({
      nodeTimeoutMs: 1_800_000,
      approvalTimeoutMs: 1_800_000,
      maxOutputBytes: 10_485_760,
      maxParallel: 1,
    });
  });

  it("owns the closed node-status and error-code vocabularies", () => {
    expect(nodeRunStatuses).toEqual([
      "pending",
      "running",
      "waiting_for_approval",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "skipped",
    ]);
    expect(nodeRunStatuses.every(isNodeRunStatus)).toBe(true);
    expect(isNodeRunStatus("unknown")).toBe(false);
    expect(kilinErrorCodes).toEqual([
      "OPTION_INVALID",
      "INIT_TARGET_EXISTS",
      "WORKFLOW_NOT_FOUND",
      "WORKFLOW_PACKAGE_INVALID",
      "WORKFLOW_SCOPE_INVALID",
      "WORKFLOW_SOURCE_NOT_FOUND",
      "WORKFLOW_PARSE_FAILED",
      "WORKFLOW_SCHEMA_INVALID",
      "WORKFLOW_GRAPH_INVALID",
      "WORKING_DIRECTORY_INVALID",
      "WORKSPACE_BUSY",
      "STATE_BUSY",
      "RUN_NOT_CANCELLABLE",
      "RUN_NOT_FOUND",
      "RUN_PARAM_INVALID",
      "RUNTIME_NOT_FOUND",
      "RUNTIME_UNSUPPORTED",
      "RUNTIME_ACCESS_UNSUPPORTED",
      "RUNTIME_CAPABILITY_MISSING",
      "RUNTIME_AUTH_REQUIRED",
      "NODE_EXIT_NONZERO",
      "NODE_TIMEOUT",
      "NODE_OUTPUT_LIMIT",
      "NODE_CAPTURE_FAILED",
      "NODE_INPUT_INVALID",
      "NODE_OUTPUT_INVALID",
      "LOOP_LIMIT_REACHED",
      "APPROVAL_NOT_WAITING",
      "APPROVAL_REJECTED",
      "APPROVAL_TIMEOUT",
      "RUN_INTERRUPTED",
      "INTERNAL_ERROR",
    ]);
    expect(kilinErrorCodes.every(isKilinErrorCode)).toBe(true);
    expect(isKilinErrorCode("UNKNOWN_ERROR")).toBe(false);
  });

  it("allows a running run to finish exactly once", () => {
    expect(canTransitionRun("running", "succeeded")).toBe(true);
    expect(canTransitionRun("running", "failed")).toBe(true);
    expect(canTransitionRun("running", "cancelled")).toBe(true);
    expect(canTransitionRun("running", "interrupted")).toBe(true);
    expect(canTransitionRun("succeeded", "failed")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });

  it("allows only the documented node lifecycle", () => {
    expect(canTransitionNodeRun("pending", "running")).toBe(true);
    expect(canTransitionNodeRun("pending", "waiting_for_approval")).toBe(true);
    expect(canTransitionNodeRun("pending", "skipped")).toBe(true);
    expect(canTransitionNodeRun("running", "succeeded")).toBe(true);
    expect(canTransitionNodeRun("running", "failed")).toBe(true);
    expect(canTransitionNodeRun("running", "cancelled")).toBe(true);
    expect(canTransitionNodeRun("running", "interrupted")).toBe(true);
    expect(canTransitionNodeRun("waiting_for_approval", "succeeded")).toBe(true);
    expect(canTransitionNodeRun("waiting_for_approval", "failed")).toBe(true);
    expect(canTransitionNodeRun("waiting_for_approval", "cancelled")).toBe(true);
    expect(canTransitionNodeRun("waiting_for_approval", "interrupted")).toBe(true);
    expect(canTransitionNodeRun("waiting_for_approval", "running")).toBe(false);
    expect(canTransitionNodeRun("pending", "succeeded")).toBe(false);
    expect(canTransitionNodeRun("skipped", "running")).toBe(false);
    expect(isTerminalNodeRunStatus("pending")).toBe(false);
    expect(isTerminalNodeRunStatus("waiting_for_approval")).toBe(false);
    expect(isTerminalNodeRunStatus("failed")).toBe(true);
  });

  it("enforces kind-specific node lifecycles", () => {
    expect(canTransitionAgentNodeRun("pending", "running")).toBe(true);
    expect(canTransitionAgentNodeRun("pending", "waiting_for_approval")).toBe(false);
    expect(canTransitionAgentNodeRun("running", "succeeded")).toBe(true);

    expect(canTransitionApprovalNodeRun("pending", "waiting_for_approval")).toBe(true);
    expect(canTransitionApprovalNodeRun("pending", "running")).toBe(false);
    expect(canTransitionApprovalNodeRun("waiting_for_approval", "failed")).toBe(true);

    expect(canTransitionLoopNodeRun("pending", "running")).toBe(true);
    expect(canTransitionLoopNodeRun("pending", "cancelled")).toBe(true);
    expect(canTransitionLoopNodeRun("pending", "skipped")).toBe(true);
    expect(canTransitionLoopNodeRun("running", "succeeded")).toBe(true);
    expect(canTransitionLoopNodeRun("running", "waiting_for_approval")).toBe(false);
  });

  it("keeps attempts immutable and makes aggregate retry reset explicit", () => {
    expect(attemptStatuses).toEqual(["running", "succeeded", "failed", "cancelled", "interrupted"]);
    expect(canTransitionAttempt("running", "succeeded")).toBe(true);
    expect(canTransitionAttempt("running", "failed")).toBe(true);
    expect(canTransitionAttempt("running", "cancelled")).toBe(true);
    expect(canTransitionAttempt("running", "interrupted")).toBe(true);
    expect(canTransitionAttempt("failed", "running")).toBe(false);

    expect(canResetAgentNodeForRetry("failed", "pending")).toBe(true);
    expect(canResetAgentNodeForRetry("interrupted", "pending")).toBe(false);
    expect(canResetAgentNodeForRetry("failed", "running")).toBe(false);
  });

  it("reports illegal transitions with a stable error code and recovery direction", () => {
    expectStateError(() => assertRunTransition("failed", "running"), "INTERNAL_ERROR", "Inspect");
    expectStateError(
      () => assertNodeRunTransition("pending", "succeeded"),
      "INTERNAL_ERROR",
      "Inspect",
    );
    expectStateError(
      () => assertAttemptTransition("failed", "running"),
      "INTERNAL_ERROR",
      "immutable",
    );
    expectStateError(
      () => assertAgentNodeRetryReset("interrupted", "pending"),
      "INTERNAL_ERROR",
      "failed",
    );
  });

  it("accepts only the documented effective execution-option ranges", () => {
    expect(() =>
      assertRunOptions({
        nodeTimeoutMs: 1_000,
        approvalTimeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxParallel: 1,
      }),
    ).not.toThrow();
    expectStateError(
      () =>
        assertRunOptions({
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 999,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        }),
      "OPTION_INVALID",
      "Approval timeout",
    );
    expect(() =>
      assertRunOptions({
        nodeTimeoutMs: 86_400_000,
        approvalTimeoutMs: 86_400_000,
        maxOutputBytes: 104_857_600,
        maxParallel: 8,
      }),
    ).not.toThrow();
    expectStateError(
      () =>
        assertRunOptions({
          nodeTimeoutMs: 999,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        }),
      "OPTION_INVALID",
      "one second",
    );
    expectStateError(
      () =>
        assertRunOptions({
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 104_857_601,
          maxParallel: 1,
        }),
      "OPTION_INVALID",
      "100 MiB",
    );
    for (const maxParallel of [0, 9, 1.5]) {
      expectStateError(
        () =>
          assertRunOptions({
            nodeTimeoutMs: 1_000,
            approvalTimeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxParallel,
          }),
        "OPTION_INVALID",
        "1 through 8",
      );
    }
  });
});
