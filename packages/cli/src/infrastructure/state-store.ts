import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { tryLock, unlock } from "fs-native-extensions";

import { serializeCanonicalJson } from "../domain/canonical-json.js";
import { KilinError } from "../domain/errors.js";
import { canonicalParameterSnapshot } from "../domain/run-parameters.js";
import type { RunParameters } from "../domain/run-parameters.js";
import {
  assertAgentNodeRunTransition,
  assertApprovalNodeRunTransition,
  assertLoopNodeRunTransition,
  assertNodeRunTransition,
  assertRunOptions,
  assertRunTransition,
} from "../domain/run-state.js";
import type {
  AgentNodeRunRecord,
  ApprovalActor,
  ApprovalDecision,
  ApprovalDecisionRecord,
  ApprovalNodeRunRecord,
  AttemptProcessIdentity,
  FailureInfo,
  LoopNodeRunRecord,
  LoopTransition,
  NodeAttemptRecord,
  NodeRunRecord,
  NodeRunStatus,
  NodeTransition,
  RunCancellationRequest,
  RunDetail,
  RunListRecord,
  RunOptions,
  RunStatus,
  RunTransition,
  RunWorkspaceRecord,
  UnreapedAttemptProcess,
  WorkflowRunRecord,
} from "../domain/run-state.js";
import type { ExecutionPlan } from "../domain/workflow.js";
import type { WorkflowIdentity } from "../domain/workflow-package.js";
import { workflowScopeRoot } from "../domain/workflow-package.js";
import { parseCronTriggerSource } from "../domain/workflow-trigger.js";
import type { CronTriggerSource } from "../domain/workflow-trigger.js";
import {
  decodeStoredAttemptProcessIdentity,
  withRunningAttemptProcesses,
  decodeStoredNodeAttemptRow as attemptFromRow,
  decodeStoredNodeRunRow as nodeFromRow,
  decodeStoredRevisionRow as revisionFromRow,
  decodeStoredRunWorkspaceRow as workspaceFromRow,
  decodeStoredRunRow as runFromRow,
  decodeStoredWorkflowScope,
} from "./state-record-decoder.js";
import type {
  StoredNodeRunRow as NodeRow,
  StoredNodeAttemptRow as NodeAttemptRow,
  StoredRevisionRow as RevisionRow,
  StoredRunWorkspaceRow as RunWorkspaceRow,
  StoredRunRow as RunRow,
} from "./state-record-decoder.js";
import { initializeStateSchema } from "./state-schema.js";

const databaseFileName = "kilin.db";
const migrationLockRetryIntervalMs = 10;
const migrationLockTimeoutMs = 5_000;
const migrationLockWaitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const stateBusyMessage =
  "Kilin could not update its local state within five seconds. Wait for the other Kilin command to finish and try again.";

export interface StateDatabaseFileClaim {
  readonly dev: number;
  readonly fileDescriptor: number;
  readonly ino: number;
}

export const claimStateDatabaseFile = (
  databasePath: string,
): StateDatabaseFileClaim | undefined => {
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(databasePath, "wx", 0o600);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      return undefined;
    }
    throw error;
  }
  try {
    const statistics = fstatSync(fileDescriptor);
    return { dev: statistics.dev, fileDescriptor, ino: statistics.ino };
  } catch (error: unknown) {
    closeSync(fileDescriptor);
    throw error;
  }
};

export const releaseStateDatabaseFileClaim = (claim: StateDatabaseFileClaim): void => {
  closeSync(claim.fileDescriptor);
};

export const removeClaimedStateDatabaseFiles = (
  databasePath: string,
  claim: StateDatabaseFileClaim,
): void => {
  let currentIdentity: Pick<StateDatabaseFileClaim, "dev" | "ino">;
  try {
    const statistics = lstatSync(databasePath);
    currentIdentity = { dev: statistics.dev, ino: statistics.ino };
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (currentIdentity.dev !== claim.dev || currentIdentity.ino !== claim.ino) {
    return;
  }
  for (const path of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
};

const acquireMigrationLock = (fileDescriptor: number): boolean => {
  const deadline = Date.now() + migrationLockTimeoutMs;
  while (!tryLock(fileDescriptor)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    Atomics.wait(
      migrationLockWaitBuffer,
      0,
      0,
      Math.min(migrationLockRetryIntervalMs, remainingMs),
    );
  }
  return true;
};

const projectScopeContains = (root: string, canonicalCwd: string): boolean => {
  if (!isAbsolute(root) || !isAbsolute(canonicalCwd)) {
    return false;
  }
  const fromRoot = relative(root, canonicalCwd);
  const parentPrefix = process.platform === "win32" ? "..\\" : "../";
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(parentPrefix) && !isAbsolute(fromRoot))
  );
};

export interface CreateRunInput {
  plan: ExecutionPlan;
  identity: WorkflowIdentity;
  canonicalCwd: string;
  options: RunOptions;
  parameters?: RunParameters;
  trigger?: CronTriggerSource;
  rerunOfRunId?: string;
  recoveryOfRunId?: string;
  recoveryMode?: "retry" | "resume";
}

export interface ListRunsQuery {
  limit?: number;
  status?: RunStatus;
}

interface RunListRow extends RunRow {
  scope_kind: string;
  scope_root: string;
  workflow_id: string;
}

interface IdentifierRow {
  id: string;
}

interface CountRow {
  count: number;
}

interface CanonicalWorkingDirectoryRow {
  canonical_cwd: string;
}

/**
 * A run row read through the validated writable connection, where `cancel_requested_at` is always
 * present and `null` is the only value that means "not latched".
 */
type ValidatedRunRow = Omit<RunRow, "status" | "cancel_requested_at"> & {
  status: RunStatus;
  cancel_requested_at: string | null;
};
type ValidatedNodeRow = Omit<NodeRow, "status"> & { status: NodeRunStatus };

const isSqliteBusy = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
};

const asStateError = (error: unknown): KilinError => {
  if (error instanceof KilinError) {
    return error;
  }
  if (isSqliteBusy(error)) {
    return new KilinError("STATE_BUSY", stateBusyMessage);
  }
  return new KilinError(
    "INTERNAL_ERROR",
    "Kilin could not read or update its local state. Check that the data directory is writable and try again.",
  );
};

export class StateStore {
  readonly #database: SqliteDatabase;
  readonly #databasePath: string;
  readonly #migrationLockPath: string;

  public constructor(dataDirectory: string) {
    this.#databasePath = join(dataDirectory, databaseFileName);
    const locksDirectory = join(dataDirectory, "locks");
    this.#migrationLockPath = join(locksDirectory, "migrations.lock");
    let openedDatabase: SqliteDatabase | undefined;
    let lockFileDescriptor: number | undefined;
    let migrationLockHeld = false;
    let databaseFileClaim: StateDatabaseFileClaim | undefined;
    try {
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(locksDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        chmodSync(dataDirectory, 0o700);
        chmodSync(locksDirectory, 0o700);
      }
      lockFileDescriptor = openSync(this.#migrationLockPath, "a", 0o600);
      if (process.platform !== "win32") {
        chmodSync(this.#migrationLockPath, 0o600);
      }
      if (!acquireMigrationLock(lockFileDescriptor)) {
        throw new KilinError("STATE_BUSY", stateBusyMessage);
      }
      migrationLockHeld = true;
      databaseFileClaim = claimStateDatabaseFile(this.#databasePath);
      openedDatabase = new Database(this.#databasePath);
      this.#database = openedDatabase;
      this.#database.pragma("busy_timeout = 5000");
      this.#database.pragma("foreign_keys = ON");
      initializeStateSchema(
        this.#database,
        new Date().toISOString(),
        databaseFileClaim !== undefined,
      );
      this.#database.pragma("journal_mode = WAL");
      this.#database.pragma("synchronous = FULL");
      this.#protectDatabaseFiles();
    } catch (error: unknown) {
      if (openedDatabase?.open === true) {
        openedDatabase.close();
      }
      if (databaseFileClaim !== undefined) {
        removeClaimedStateDatabaseFiles(this.#databasePath, databaseFileClaim);
      }
      throw asStateError(error);
    } finally {
      if (databaseFileClaim !== undefined) {
        releaseStateDatabaseFileClaim(databaseFileClaim);
      }
      if (migrationLockHeld && lockFileDescriptor !== undefined) {
        unlock(lockFileDescriptor);
      }
      if (lockFileDescriptor !== undefined) {
        closeSync(lockFileDescriptor);
      }
    }
  }

  public createRun(input: CreateRunInput): RunDetail {
    return this.#createRun(input, false);
  }

  public createRunAfterStaleReconciliation(input: CreateRunInput): RunDetail {
    return this.#createRun(input, true);
  }

  /**
   * Records a monotonic cancellation request for a live run. Durable commit order, not this call,
   * decides the cancellation/completion race: a request that commits after run finalization finds a
   * terminal run and is rejected.
   */
  public requestRunCancellation(runId: string): RunCancellationRequest {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "RUN_NOT_CANCELLABLE",
            `Run "${runId}" is ${run.status} and cannot be cancelled. Use "kilin runs list --status running" to choose a live run.`,
          );
        }
        if (run.cancel_requested_at !== null) {
          return { runId, cancelRequestedAt: run.cancel_requested_at };
        }
        const cancelRequestedAt = new Date().toISOString();
        const result = this.#database
          .prepare(
            `
          UPDATE workflow_runs SET cancel_requested_at = ?
          WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
        `,
          )
          .run(cancelRequestedAt, runId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Run "${runId}" changed while its cancellation was being recorded. Inspect the run before retrying.`,
          );
        }
        return { runId, cancelRequestedAt };
      });
      const request = transact.immediate();
      this.#protectDatabaseFiles();
      return request;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  /** Reads the cancellation latch for the run this process owns. */
  public readCancellationRequest(runId: string): string | undefined {
    try {
      const row = this.#database
        .prepare("SELECT cancel_requested_at FROM workflow_runs WHERE id = ?")
        .get(runId) as { cancel_requested_at: string | null } | undefined;
      return row?.cancel_requested_at ?? undefined;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public reconcileStaleRuns(canonicalCwd: string): RunDetail[] {
    try {
      const reconcile = this.#database.transaction(() => this.#reconcileStaleRuns(canonicalCwd));
      const reconciled = reconcile.immediate();
      this.#protectDatabaseFiles();
      return reconciled;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public startLoop(runId: string, nodeId: string): LoopNodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" cannot start because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "loop") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" in run "${runId}" is not a loop control. Inspect the stored workflow before retrying.`,
          );
        }
        const status = run.cancel_requested_at === null ? "running" : "cancelled";
        assertLoopNodeRunTransition(current.status, status);
        const timestamp = new Date().toISOString();
        const result = this.#database
          .prepare(
            status === "running"
              ? `
                UPDATE node_runs SET status = 'running', started_at = ?
                WHERE run_id = ? AND node_id = ? AND kind = 'loop' AND status = 'pending'
              `
              : `
                UPDATE node_runs SET status = 'cancelled', finished_at = ?
                WHERE run_id = ? AND node_id = ? AND kind = 'loop' AND status = 'pending'
              `,
          )
          .run(timestamp, runId, nodeId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" changed while it was starting. Inspect run "${runId}" before retrying.`,
          );
        }
        return this.#loopRecord(runId, nodeId);
      });
      const loop = transact.immediate();
      this.#protectDatabaseFiles();
      return loop;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public finishLoop(runId: string, nodeId: string, transition: LoopTransition): LoopNodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        if (transition.status === "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" must start through startLoop before it can finish.`,
          );
        }
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" cannot finish because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "loop") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" in run "${runId}" is not a loop control. Inspect the stored workflow before retrying.`,
          );
        }
        const effectiveTransition =
          run.cancel_requested_at !== null &&
          transition.status !== "cancelled" &&
          transition.status !== "skipped"
            ? ({ status: "cancelled" } as const)
            : transition;
        assertLoopNodeRunTransition(current.status, effectiveTransition.status);
        if (
          effectiveTransition.status === "succeeded" &&
          (current.output_type !==
            (effectiveTransition.outputType === "choice"
              ? "json"
              : effectiveTransition.outputType) ||
            current.declared_output_type !==
              (effectiveTransition.outputType === "choice" ? "choice" : null))
        ) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" result type does not match its stored output contract. Inspect the stored workflow before retrying.`,
          );
        }
        const timestamp = new Date().toISOString();
        const result =
          effectiveTransition.status === "succeeded"
            ? this.#database
                .prepare(
                  `
                    UPDATE node_runs
                    SET status = 'succeeded', finished_at = ?, result_path = ?
                    WHERE run_id = ? AND node_id = ? AND kind = 'loop' AND status = 'running'
                      AND EXISTS (
                        SELECT 1 FROM workflow_runs
                        WHERE id = ? AND status = 'running' AND cancel_requested_at IS NULL
                      )
                  `,
                )
                .run(timestamp, effectiveTransition.resultPath, runId, nodeId, runId)
            : effectiveTransition.status === "failed" ||
                effectiveTransition.status === "interrupted"
              ? this.#database
                  .prepare(
                    `
                      UPDATE node_runs
                      SET status = ?, finished_at = ?, failure_code = ?, failure_message = ?
                      WHERE run_id = ? AND node_id = ? AND kind = 'loop' AND status = 'running'
                    `,
                  )
                  .run(
                    effectiveTransition.status,
                    timestamp,
                    effectiveTransition.failure.code,
                    effectiveTransition.failure.message,
                    runId,
                    nodeId,
                  )
              : this.#database
                  .prepare(
                    `
                      UPDATE node_runs SET status = ?, finished_at = ?
                      WHERE run_id = ? AND node_id = ? AND kind = 'loop' AND status = ?
                    `,
                  )
                  .run(effectiveTransition.status, timestamp, runId, nodeId, current.status);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Loop "${nodeId}" changed while it was finishing. Inspect run "${runId}" before retrying.`,
          );
        }
        return this.#loopRecord(runId, nodeId);
      });
      const loop = transact.immediate();
      this.#protectDatabaseFiles();
      return loop;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public requestApproval(runId: string, nodeId: string): ApprovalNodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const runRow = this.#getRunRow(runId);
        if (runRow.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" cannot start waiting because run "${runId}" is already ${runRow.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" in run "${runId}" is not an approval node. Inspect the stored workflow before retrying.`,
          );
        }
        assertApprovalNodeRunTransition(current.status, "waiting_for_approval");
        if (runRow.cancel_requested_at !== null) {
          return this.#approvalRecord(runId, nodeId, current);
        }
        const requestedAt = new Date();
        const deadlineAt = new Date(
          requestedAt.getTime() + runFromRow(runRow).options.approvalTimeoutMs,
        );
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs
          SET status = 'waiting_for_approval', approval_requested_at = ?, approval_deadline_at = ?
          WHERE run_id = ? AND node_id = ? AND kind = 'approval' AND status = 'pending'
        `,
          )
          .run(requestedAt.toISOString(), deadlineAt.toISOString(), runId, nodeId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed while its request was being recorded. Inspect run "${runId}" before retrying.`,
          );
        }
        const node = nodeFromRow(this.#getNodeRow(runId, nodeId));
        if (node.kind !== "approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed kind while its request was being recorded. Inspect run "${runId}" before retrying.`,
          );
        }
        return node;
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public pollApproval(runId: string, nodeId: string): ApprovalNodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" cannot be polled because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "approval" || current.status !== "waiting_for_approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" in run "${runId}" is not waiting for approval. Inspect the run before retrying.`,
          );
        }
        if (current.approval_deadline_at === null) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" has no deadline. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
          );
        }
        const timestamp = new Date().toISOString();
        if (run.cancel_requested_at !== null) {
          // A cancellation request committed first, so this still-waiting gate settles cancelled
          // whatever decision or deadline would otherwise apply. Any recorded decision is retained
          // as evidence but is not consumed.
          const cancelResult = this.#database
            .prepare(
              `
            UPDATE node_runs SET status = 'cancelled', finished_at = ?
            WHERE run_id = ? AND node_id = ? AND kind = 'approval'
              AND status = 'waiting_for_approval'
          `,
            )
            .run(timestamp, runId, nodeId);
          if (cancelResult.changes !== 1) {
            throw new KilinError(
              "INTERNAL_ERROR",
              `Approval node "${nodeId}" changed while cancellation was being applied. Inspect run "${runId}" before retrying.`,
            );
          }
          return this.#approvalRecord(runId, nodeId, this.#getNodeRow(runId, nodeId));
        }
        let result: Database.RunResult | undefined;
        if (current.approval_decision === "approve") {
          result = this.#database
            .prepare(
              `
            UPDATE node_runs SET status = 'succeeded', finished_at = ?
            WHERE run_id = ? AND node_id = ? AND kind = 'approval'
              AND status = 'waiting_for_approval' AND approval_decision = 'approve'
          `,
            )
            .run(timestamp, runId, nodeId);
        } else if (current.approval_decision === "reject") {
          result = this.#database
            .prepare(
              `
            UPDATE node_runs
            SET status = 'failed', finished_at = ?, failure_code = 'APPROVAL_REJECTED',
                failure_message = ?
            WHERE run_id = ? AND node_id = ? AND kind = 'approval'
              AND status = 'waiting_for_approval' AND approval_decision = 'reject'
          `,
            )
            .run(
              timestamp,
              `Approval node "${nodeId}" was rejected. Inspect the recorded decision and rerun the workflow after addressing it.`,
              runId,
              nodeId,
            );
        } else if (Date.parse(timestamp) >= Date.parse(current.approval_deadline_at)) {
          result = this.#database
            .prepare(
              `
            UPDATE node_runs
            SET status = 'failed', finished_at = ?, failure_code = 'APPROVAL_TIMEOUT',
                failure_message = ?
            WHERE run_id = ? AND node_id = ? AND kind = 'approval'
              AND status = 'waiting_for_approval' AND approval_decision IS NULL
          `,
            )
            .run(
              timestamp,
              `Approval node "${nodeId}" timed out at ${current.approval_deadline_at}. Rerun the workflow to request approval again.`,
              runId,
              nodeId,
            );
        }
        if (result !== undefined && result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed while its decision was being consumed. Inspect run "${runId}" before retrying.`,
          );
        }
        const node = nodeFromRow(result === undefined ? current : this.#getNodeRow(runId, nodeId));
        if (node.kind !== "approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed kind while it was being polled. Inspect run "${runId}" before retrying.`,
          );
        }
        return node;
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public cancelApproval(runId: string, nodeId: string): ApprovalNodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" cannot be cancelled because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "approval" || current.status !== "waiting_for_approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" in run "${runId}" is not waiting for approval. Inspect the run before retrying.`,
          );
        }
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs SET status = 'cancelled', finished_at = ?
          WHERE run_id = ? AND node_id = ? AND kind = 'approval'
            AND status = 'waiting_for_approval'
        `,
          )
          .run(new Date().toISOString(), runId, nodeId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed while it was being cancelled. Inspect run "${runId}" before retrying.`,
          );
        }
        const node = nodeFromRow(this.#getNodeRow(runId, nodeId));
        if (node.kind !== "approval") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed kind while it was being cancelled. Inspect run "${runId}" before retrying.`,
          );
        }
        return node;
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public recordApprovalDecision(
    runId: string,
    nodeId: string,
    decision: ApprovalDecision,
    actor: ApprovalActor,
    note?: string,
  ): ApprovalDecisionRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "APPROVAL_NOT_WAITING",
            `Run "${runId}" is ${run.status}, so node "${nodeId}" cannot accept a decision. Rerun the workflow to request a new approval.`,
          );
        }
        const decidedAt = new Date().toISOString();
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs
          SET approval_decision = ?, approval_actor = ?, approval_note = ?, approval_decided_at = ?
          WHERE run_id = ? AND node_id = ? AND kind = 'approval'
            AND status = 'waiting_for_approval' AND approval_decision IS NULL
            AND approval_requested_at <= ? AND approval_deadline_at > ?
        `,
          )
          .run(decision, actor, note ?? null, decidedAt, runId, nodeId, decidedAt, decidedAt);
        if (result.changes !== 1) {
          const node = this.#database
            .prepare(
              `
            SELECT kind, status, approval_decision, approval_requested_at,
                   approval_decided_at, approval_deadline_at
            FROM node_runs WHERE run_id = ? AND node_id = ?
          `,
            )
            .get(runId, nodeId) as
            | Pick<
                NodeRow,
                | "kind"
                | "status"
                | "approval_decision"
                | "approval_requested_at"
                | "approval_decided_at"
                | "approval_deadline_at"
              >
            | undefined;
          if (node === undefined) {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `Run "${runId}" does not contain node "${nodeId}". Use "kilin runs show ${runId}" to choose a waiting approval.`,
            );
          }
          if (node.kind !== "approval") {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `Node "${nodeId}" in run "${runId}" is an agent node, not an approval gate. Choose a waiting approval shown by "kilin runs show ${runId}".`,
            );
          }
          if (node.status !== "waiting_for_approval") {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `Approval node "${nodeId}" in run "${runId}" is ${node.status}, not waiting for approval. Rerun the workflow if a new decision is needed.`,
            );
          }
          if (node.approval_decision !== null) {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `Approval node "${nodeId}" in run "${runId}" already recorded decision "${node.approval_decision}". Wait for the attached run to consume it or inspect the run.`,
            );
          }
          if (node.approval_requested_at !== null && node.approval_requested_at > decidedAt) {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `The system clock is earlier than approval node "${nodeId}" was requested. Correct the clock and retry before the deadline.`,
            );
          }
          if (node.approval_deadline_at !== null && node.approval_deadline_at <= decidedAt) {
            throw new KilinError(
              "APPROVAL_NOT_WAITING",
              `Approval node "${nodeId}" in run "${runId}" expired at ${node.approval_deadline_at}. Rerun the workflow to request a new approval.`,
            );
          }
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" changed while its decision was being recorded. Inspect run "${runId}" before retrying.`,
          );
        }
        return {
          runId,
          nodeId,
          decision,
          actor,
          decidedAt,
          ...(note === undefined ? {} : { note }),
        };
      });
      const recorded = transact.immediate();
      this.#protectDatabaseFiles();
      return recorded;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public transitionNode(runId: string, nodeId: string, transition: NodeTransition): NodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" cannot change because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        if (current.kind !== "agent") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Approval node "${nodeId}" cannot use an agent lifecycle transition. Use the approval lifecycle operation instead.`,
          );
        }
        assertAgentNodeRunTransition(current.status, transition.status);
        const effective = this.#effectiveNodeTransition(run.cancel_requested_at, transition);
        if (effective === undefined) {
          return nodeFromRow(current);
        }
        const timestamp = new Date().toISOString();
        const result =
          effective.status === "running"
            ? this.#database
                .prepare(
                  `
              UPDATE node_runs
              SET status = 'running', started_at = ?, stdout_path = ?, stderr_path = ?, result_path = ?,
                  runtime_version = ?, effective_model = ?
              WHERE run_id = ? AND node_id = ? AND status = 'pending'
            `,
                )
                .run(
                  timestamp,
                  effective.stdoutPath,
                  effective.stderrPath,
                  effective.resultPath,
                  effective.runtimeVersion ?? null,
                  effective.effectiveModel ?? null,
                  runId,
                  nodeId,
                )
            : this.#finishNode(runId, nodeId, current.status, effective, timestamp);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" changed while its status was being updated. Inspect run "${runId}" before retrying.`,
          );
        }
        if (effective.status === "running") {
          this.#database
            .prepare(
              `
            INSERT INTO node_attempts (
              run_id, node_id, attempt, status, started_at,
              stdout_path, stderr_path, result_path
            ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
          `,
            )
            .run(
              runId,
              nodeId,
              current.current_attempt,
              timestamp,
              effective.stdoutPath,
              effective.stderrPath,
              effective.resultPath,
            );
        } else if (effective.status !== "skipped") {
          const failure = "failure" in effective ? effective.failure : undefined;
          const exitCode = "exitCode" in effective ? effective.exitCode : undefined;
          const attemptResult = this.#database
            .prepare(
              `
            UPDATE node_attempts
            SET status = ?, finished_at = ?, exit_code = ?,
                failure_code = ?, failure_message = ?,
                process_pid = NULL, process_group_id = NULL, process_start_identifier = NULL
            WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'running'
          `,
            )
            .run(
              effective.status,
              timestamp,
              exitCode ?? null,
              failure?.code ?? null,
              failure?.message ?? null,
              runId,
              nodeId,
              current.current_attempt,
            );
          if (attemptResult.changes !== 1) {
            throw new KilinError(
              "INTERNAL_ERROR",
              `Node "${nodeId}" attempt ${String(current.current_attempt)} was not running while its terminal state was recorded.`,
            );
          }
        }
        return nodeFromRow(this.#getNodeRow(runId, nodeId));
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  /**
   * Reschedules one retry attempt. The compare-and-set requires the expected failed occurrence, its
   * expected attempt, a running run, and no cancellation latch; when cancellation wins, the
   * committed failed attempt stays truthful and the returned record is still failed.
   */
  public retryNode(runId: string, nodeId: string, expectedAttempt: number): NodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        const current = this.#getNodeRow(runId, nodeId);
        if (
          run.status !== "running" ||
          current.kind !== "agent" ||
          (current.status !== "failed" && current.status !== "interrupted")
        ) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" can only be retried after a failed or interrupted attempt in a running run.`,
          );
        }
        if (run.cancel_requested_at !== null) {
          return nodeFromRow(current);
        }
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs
          SET status = 'pending', current_attempt = current_attempt + 1,
              effective_model = NULL, runtime_version = NULL,
              started_at = NULL, finished_at = NULL, exit_code = NULL,
              failure_code = NULL, failure_message = NULL,
              stdout_path = NULL, stderr_path = NULL, result_path = NULL,
              resolved_inputs_path = NULL,
              reused_from_run_id = NULL, reused_from_node_id = NULL
          WHERE run_id = ? AND node_id = ?
            AND kind = 'agent' AND status IN ('failed', 'interrupted')
            AND current_attempt = ?
        `,
          )
          .run(runId, nodeId, expectedAttempt);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" changed while its retry was being scheduled.`,
          );
        }
        return nodeFromRow(this.#getNodeRow(runId, nodeId));
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public reuseNode(
    runId: string,
    nodeId: string,
    source: NodeRunRecord,
    outputPaths: { stdoutPath: string; stderrPath: string; resultPath: string },
    resolvedInputsPath?: string,
  ): NodeRunRecord {
    if (source.kind !== "agent" || source.status !== "succeeded") {
      throw new KilinError(
        "INTERNAL_ERROR",
        `Node "${nodeId}" cannot reuse a source node that did not succeed as an agent node.`,
      );
    }
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        const current = this.#getNodeRow(runId, nodeId);
        if (run.status !== "running" || current.kind !== "agent" || current.status !== "pending") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" cannot record a reused checkpoint in its current state.`,
          );
        }
        if (run.cancel_requested_at !== null) {
          // A cancellation request committed first, so this still-pending node must not settle
          // succeeded. Leaving it pending lets the run skip it with the rest of its pending work.
          return nodeFromRow(current);
        }
        const timestamp = new Date().toISOString();
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs
          SET status = 'succeeded', started_at = ?, finished_at = ?, exit_code = 0,
              effective_model = ?, runtime_version = ?,
              stdout_path = ?, stderr_path = ?, result_path = ?,
              resolved_inputs_path = ?,
              reused_from_run_id = ?, reused_from_node_id = ?
          WHERE run_id = ? AND node_id = ? AND kind = 'agent' AND status = 'pending'
        `,
          )
          .run(
            timestamp,
            timestamp,
            source.effectiveModel ?? null,
            source.runtimeVersion ?? null,
            outputPaths.stdoutPath,
            outputPaths.stderrPath,
            outputPaths.resultPath,
            resolvedInputsPath ?? null,
            source.runId,
            source.nodeId,
            runId,
            nodeId,
          );
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" changed while its reused checkpoint was being recorded.`,
          );
        }
        return nodeFromRow(this.#getNodeRow(runId, nodeId));
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  /**
   * Records the operating-system process a running attempt started. The identity stays on the row
   * until the attempt finishes through the ordinary path, which clears it — so a row that still
   * carries one names a process Kilin never observed ending.
   */
  public recordAttemptProcess(
    runId: string,
    nodeId: string,
    attempt: number,
    identity: AttemptProcessIdentity,
  ): void {
    try {
      this.#database
        .prepare(
          `
        UPDATE node_attempts
        SET process_pid = ?, process_group_id = ?, process_start_identifier = ?
        WHERE run_id = ? AND node_id = ? AND attempt = ? AND status = 'running'
      `,
        )
        .run(
          identity.pid,
          identity.processGroupId,
          identity.startIdentifier,
          runId,
          nodeId,
          attempt,
        );
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  /**
   * Every attempt of a run whose recorded process was never observed ending, newest attempt last.
   * Status is deliberately not part of the predicate: reconciliation rewrites a stale attempt to
   * `interrupted` without touching the process, so filtering on status would hide exactly the
   * orphans this exists to find.
   */
  public listUnreapedAttemptProcesses(runId: string): UnreapedAttemptProcess[] {
    try {
      const rows = this.#database
        .prepare(
          `
        SELECT * FROM node_attempts
        WHERE run_id = ? AND process_pid IS NOT NULL ORDER BY node_id, attempt
      `,
        )
        .all(runId) as NodeAttemptRow[];
      return rows.flatMap((row) => {
        const identity = decodeStoredAttemptProcessIdentity(row);
        return identity === undefined
          ? []
          : [
              {
                nodeId: row.node_id,
                attempt: row.attempt,
                startedAt: row.started_at,
                process: identity,
              },
            ];
      });
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  /** Forgets a reaped identity so a later recovery cannot signal a recycled pid. */
  public clearAttemptProcess(runId: string, nodeId: string, attempt: number): void {
    try {
      this.#database
        .prepare(
          `
        UPDATE node_attempts
        SET process_pid = NULL, process_group_id = NULL, process_start_identifier = NULL
        WHERE run_id = ? AND node_id = ? AND attempt = ?
      `,
        )
        .run(runId, nodeId, attempt);
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public listNodeAttempts(runId: string, nodeId?: string): NodeAttemptRecord[] {
    try {
      this.#getRunRow(runId);
      const rows =
        nodeId === undefined
          ? this.#database
              .prepare(
                `
            SELECT * FROM node_attempts
            WHERE run_id = ? ORDER BY node_id, attempt
          `,
              )
              .all(runId)
          : this.#database
              .prepare(
                `
            SELECT * FROM node_attempts
            WHERE run_id = ? AND node_id = ? ORDER BY attempt
          `,
              )
              .all(runId, nodeId);
      return (rows as NodeAttemptRow[]).map(attemptFromRow);
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public recordRunWorkspace(
    runId: string,
    workspaceId: string,
    path: string,
    baseCommit: string,
  ): RunWorkspaceRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Workspace "${workspaceId}" cannot be recorded because run "${runId}" is ${run.status}.`,
          );
        }
        const createdAt = new Date().toISOString();
        this.#database
          .prepare(
            `
          INSERT INTO run_workspaces (
            run_id, workspace_id, path, base_commit, status, created_at
          ) VALUES (?, ?, ?, ?, 'provisioned', ?)
        `,
          )
          .run(runId, workspaceId, path, baseCommit, createdAt);
        return {
          runId,
          workspaceId,
          path,
          baseCommit,
          status: "provisioned" as const,
          createdAt,
        };
      });
      const workspace = transact.immediate();
      this.#protectDatabaseFiles();
      return workspace;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public listRunWorkspaces(runId: string): RunWorkspaceRecord[] {
    try {
      this.#getRunRow(runId);
      return this.#listRunWorkspaceRecords(runId);
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public recordResolvedInputs(runId: string, nodeId: string, path: string): NodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        const current = this.#getNodeRow(runId, nodeId);
        if (run.status !== "running" || current.kind !== "agent" || current.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" cannot record resolved inputs unless it is running. Inspect run "${runId}" before retrying.`,
          );
        }
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs SET resolved_inputs_path = ?
          WHERE run_id = ? AND node_id = ? AND status = 'running' AND resolved_inputs_path IS NULL
        `,
          )
          .run(path, runId, nodeId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" already recorded resolved inputs or changed concurrently. Inspect run "${runId}" before retrying.`,
          );
        }
        return nodeFromRow(this.#getNodeRow(runId, nodeId));
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public transitionRun(runId: string, transition: RunTransition): WorkflowRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const current = this.#getRunRow(runId);
        assertRunTransition(current.status, transition.status);
        // A cancellation request that committed before finalization wins the run outcome.
        const effective: RunTransition =
          current.cancel_requested_at === null ? transition : { status: "cancelled" };
        const activeNodes = this.#database
          .prepare(
            `
          SELECT COUNT(*) AS count FROM node_runs
          WHERE run_id = ? AND status IN ('pending', 'running', 'waiting_for_approval')
        `,
          )
          .get(runId) as CountRow;
        if (activeNodes.count !== 0) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Run "${runId}" still has pending, running, or waiting for approval nodes. Finish or skip them before completing the run.`,
          );
        }
        if (effective.status === "succeeded") {
          const unsuccessfulNodes = this.#database
            .prepare(
              `
            SELECT COUNT(*) AS count FROM node_runs
            WHERE run_id = ? AND status NOT IN ('succeeded', 'skipped')
          `,
            )
            .get(runId) as CountRow;
          if (unsuccessfulNodes.count !== 0) {
            throw new KilinError(
              "INTERNAL_ERROR",
              `Run "${runId}" contains a node that did not succeed. Choose the matching terminal run status.`,
            );
          }
        }
        const failure = "failure" in effective ? effective.failure : undefined;
        const result = this.#database
          .prepare(
            `
          UPDATE workflow_runs
          SET status = ?, finished_at = ?, failure_code = ?, failure_message = ?
          WHERE id = ? AND status = 'running'
        `,
          )
          .run(
            effective.status,
            new Date().toISOString(),
            failure?.code ?? null,
            failure?.message ?? null,
            runId,
          );
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Run "${runId}" changed while its status was being updated. Inspect the run before retrying.`,
          );
        }
        return runFromRow(this.#getRunRow(runId));
      });
      const run = transact.immediate();
      this.#protectDatabaseFiles();
      return run;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public skipPendingNodes(runId: string): NodeRunRecord[] {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Pending nodes cannot be skipped because run "${runId}" is already ${run.status}. Inspect the run before retrying.`,
          );
        }
        const pendingNodes = this.#database
          .prepare(
            `
          SELECT node_id AS id FROM node_runs
          WHERE run_id = ? AND status = 'pending'
          ORDER BY ordinal
        `,
          )
          .all(runId) as IdentifierRow[];
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs SET status = 'skipped', finished_at = ?
          WHERE run_id = ? AND status = 'pending'
        `,
          )
          .run(new Date().toISOString(), runId);
        if (result.changes !== pendingNodes.length) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Pending nodes changed while run "${runId}" was being updated. Inspect the run before retrying.`,
          );
        }
        const skippedNodeIds = new Set(pendingNodes.map(({ id }) => id));
        return this.#listNodeRows(runId)
          .filter((node) => skippedNodeIds.has(node.node_id))
          .map(nodeFromRow);
      });
      const nodes = transact.immediate();
      this.#protectDatabaseFiles();
      return nodes;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public skipNode(runId: string, nodeId: string): NodeRunRecord {
    try {
      const transact = this.#database.transaction(() => {
        const run = this.#getRunRow(runId);
        if (run.status !== "running") {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" cannot be skipped because run "${runId}" is already ${run.status}.`,
          );
        }
        const current = this.#getNodeRow(runId, nodeId);
        assertNodeRunTransition(current.status, "skipped");
        const result = this.#database
          .prepare(
            `
          UPDATE node_runs SET status = 'skipped', finished_at = ?
          WHERE run_id = ? AND node_id = ? AND status = 'pending'
        `,
          )
          .run(new Date().toISOString(), runId, nodeId);
        if (result.changes !== 1) {
          throw new KilinError(
            "INTERNAL_ERROR",
            `Node "${nodeId}" changed while its conditional skip was recorded.`,
          );
        }
        return nodeFromRow(this.#getNodeRow(runId, nodeId));
      });
      const node = transact.immediate();
      this.#protectDatabaseFiles();
      return node;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public getRun(runId: string): RunDetail {
    try {
      return this.#getRunDetail(runId);
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public listRuns(query: ListRunsQuery = {}): RunListRecord[] {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new KilinError(
        "OPTION_INVALID",
        "Run list limit must be an integer from 1 through 1000. Choose a value in that range.",
      );
    }
    try {
      const rows =
        query.status === undefined
          ? (this.#database
              .prepare(
                `
            SELECT workflow_runs.*, workflow_revisions.scope_kind,
                   workflow_revisions.scope_root, workflow_revisions.workflow_id
            FROM workflow_runs
            JOIN workflow_revisions ON workflow_revisions.id = workflow_runs.revision_id
            ORDER BY workflow_runs.started_at DESC, workflow_runs.rowid DESC
            LIMIT ?
          `,
              )
              .all(limit) as RunListRow[])
          : (this.#database
              .prepare(
                `
            SELECT workflow_runs.*, workflow_revisions.scope_kind,
                   workflow_revisions.scope_root, workflow_revisions.workflow_id
            FROM workflow_runs
            JOIN workflow_revisions ON workflow_revisions.id = workflow_runs.revision_id
            WHERE workflow_runs.status = ?
            ORDER BY workflow_runs.started_at DESC, workflow_runs.rowid DESC
            LIMIT ?
          `,
              )
              .all(query.status, limit) as RunListRow[]);
      return rows.map((row) => ({
        ...runFromRow(row),
        scope: decodeStoredWorkflowScope(row.scope_kind, row.scope_root),
        workflowId: row.workflow_id,
      }));
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public listActiveCanonicalWorkingDirectories(): string[] {
    try {
      const rows = this.#database
        .prepare(
          `
        SELECT DISTINCT canonical_cwd FROM workflow_runs
        WHERE status = 'running'
        ORDER BY canonical_cwd
      `,
        )
        .all() as CanonicalWorkingDirectoryRow[];
      return rows.map(({ canonical_cwd: canonicalWorkingDirectory }) => canonicalWorkingDirectory);
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  public close(): void {
    this.#database.close();
  }

  #createRun(input: CreateRunInput, reconcileStale: boolean): RunDetail {
    assertRunOptions(input.options);
    if (input.rerunOfRunId !== undefined && input.recoveryOfRunId !== undefined) {
      throw new KilinError(
        "OPTION_INVALID",
        "A run cannot be both a rerun and a recovery run. Choose one source relationship.",
      );
    }
    const trigger =
      input.trigger === undefined
        ? undefined
        : parseCronTriggerSource(input.trigger, "Run trigger provenance");
    if ((input.recoveryOfRunId === undefined) !== (input.recoveryMode === undefined)) {
      throw new KilinError(
        "INTERNAL_ERROR",
        "A recovery run must declare both its source run and recovery mode.",
      );
    }
    if (input.identity.workflowId !== input.plan.definition.workflow.id) {
      throw new KilinError(
        "INTERNAL_ERROR",
        "The resolved workflow identity does not match the compiled definition. Resolve and validate the workflow package again.",
      );
    }
    if (
      input.identity.scope.kind === "project" &&
      !projectScopeContains(input.identity.scope.root, input.canonicalCwd)
    ) {
      throw new KilinError(
        "WORKFLOW_SCOPE_INVALID",
        "The project workflow scope does not contain the run working directory.",
      );
    }
    try {
      const transact = this.#database.transaction(() => {
        if (reconcileStale) {
          this.#reconcileStaleRuns(input.canonicalCwd);
        }
        if (input.rerunOfRunId !== undefined) {
          this.#getRunRow(input.rerunOfRunId);
        }
        if (input.recoveryOfRunId !== undefined) {
          const recoverySource = this.#getRunRow(input.recoveryOfRunId);
          if (recoverySource.status === "running") {
            throw new KilinError(
              "OPTION_INVALID",
              `Run "${input.recoveryOfRunId}" is still running. Wait for it to finish or reconcile it before creating a recovery run.`,
            );
          }
        }
        const timestamp = new Date().toISOString();
        const proposedRevisionId = randomUUID();
        this.#database
          .prepare(
            `
          INSERT INTO workflow_revisions (
            id, scope_kind, scope_root, workflow_id, schema_version, content_hash,
            normalized_definition, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (scope_kind, scope_root, workflow_id, content_hash) DO NOTHING
        `,
          )
          .run(
            proposedRevisionId,
            input.identity.scope.kind,
            workflowScopeRoot(input.identity.scope),
            input.plan.definition.workflow.id,
            input.plan.definition.schemaVersion,
            input.plan.contentHash,
            input.plan.normalizedDefinition,
            timestamp,
          );
        const revision = this.#database
          .prepare(
            `
          SELECT * FROM workflow_revisions
          WHERE scope_kind = ? AND scope_root = ? AND workflow_id = ? AND content_hash = ?
        `,
          )
          .get(
            input.identity.scope.kind,
            workflowScopeRoot(input.identity.scope),
            input.plan.definition.workflow.id,
            input.plan.contentHash,
          ) as RevisionRow | undefined;
        if (revision === undefined) {
          throw new KilinError(
            "INTERNAL_ERROR",
            "Kilin could not persist the workflow revision. Check the local database and try again.",
          );
        }
        if (
          revision.schema_version !== input.plan.definition.schemaVersion ||
          revision.normalized_definition !== input.plan.normalizedDefinition
        ) {
          throw new KilinError(
            "INTERNAL_ERROR",
            "The stored workflow revision contents do not match the compiled workflow. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
          );
        }
        const runId = randomUUID();
        this.#database
          .prepare(
            `
          INSERT INTO workflow_runs (
            id, revision_id, rerun_of_run_id, recovery_of_run_id, recovery_mode,
            canonical_cwd, options_json, parameters_json, trigger_source_json,
            status, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
        `,
          )
          .run(
            runId,
            revision.id,
            input.rerunOfRunId ?? null,
            input.recoveryOfRunId ?? null,
            input.recoveryMode ?? null,
            input.canonicalCwd,
            JSON.stringify(input.options),
            input.parameters === undefined ? null : canonicalParameterSnapshot(input.parameters),
            trigger === undefined ? null : serializeCanonicalJson(trigger),
            timestamp,
          );
        const insertNode = this.#database.prepare(`
          INSERT INTO node_runs (
            run_id, node_id, ordinal, kind, body_node_id, loop_node_id, iteration,
            runtime, requested_model,
            output_type, declared_output_type, artifact_path, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `);
        for (const plannedNode of input.plan.nodes) {
          const { node } = plannedNode;
          const output = node.kind === "approval" ? undefined : node.output;
          insertNode.run(
            runId,
            plannedNode.executionId,
            plannedNode.ordinal,
            node.kind,
            plannedNode.loopNodeId === undefined ? null : plannedNode.nodeId,
            plannedNode.loopNodeId ?? null,
            plannedNode.iteration ?? null,
            node.kind === "agent" ? node.runtime : null,
            node.kind === "agent" ? (node.model ?? null) : null,
            output?.type === "choice" ? "json" : (output?.type ?? null),
            output?.type === "choice" ? "choice" : null,
            output?.type === "artifact" ? output.path : null,
          );
        }
        return this.#getRunDetail(runId);
      });
      const detail = transact.immediate();
      this.#protectDatabaseFiles();
      return detail;
    } catch (error: unknown) {
      throw asStateError(error);
    }
  }

  #reconcileStaleRuns(canonicalCwd: string): RunDetail[] {
    const runIds = this.#database
      .prepare(
        `
      SELECT id FROM workflow_runs WHERE canonical_cwd = ? AND status = 'running'
      ORDER BY started_at, id
    `,
      )
      .all(canonicalCwd) as IdentifierRow[];
    if (runIds.length === 0) {
      return [];
    }
    const timestamp = new Date().toISOString();
    const failure: FailureInfo = {
      code: "RUN_INTERRUPTED",
      message:
        "The prior Kilin process stopped before this run finished. Inspect the workspace and logs before starting another run.",
    };
    const updateActiveNodes = this.#database.prepare(`
      UPDATE node_runs
      SET status = 'interrupted', finished_at = ?, failure_code = ?, failure_message = ?
      WHERE run_id = ? AND status IN ('running', 'waiting_for_approval')
    `);
    const cancelActiveNodes = this.#database.prepare(`
      UPDATE node_runs SET status = 'cancelled', finished_at = ?
      WHERE run_id = ? AND status IN ('running', 'waiting_for_approval')
    `);
    const cancelActiveAttempts = this.#database.prepare(`
      UPDATE node_attempts SET status = 'cancelled', finished_at = ?
      WHERE run_id = ? AND status = 'running'
    `);
    const cancelRun = this.#database.prepare(`
      UPDATE workflow_runs SET status = 'cancelled', finished_at = ?
      WHERE id = ? AND status = 'running'
    `);
    const updatePendingNodes = this.#database.prepare(`
      UPDATE node_runs SET status = 'skipped', finished_at = ?
      WHERE run_id = ? AND status = 'pending'
    `);
    const updateActiveAttempts = this.#database.prepare(`
      UPDATE node_attempts
      SET status = 'interrupted', finished_at = ?,
          failure_code = ?, failure_message = ?
      WHERE run_id = ? AND status = 'running'
    `);
    const updateRun = this.#database.prepare(`
      UPDATE workflow_runs
      SET status = 'interrupted', finished_at = ?, failure_code = ?, failure_message = ?
      WHERE id = ? AND status = 'running'
    `);
    const countRunningAgentNodes = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM node_runs
      WHERE run_id = ? AND kind = 'agent' AND status = 'running'
    `);
    for (const { id } of runIds) {
      const runningNodes = this.#countNodes(id, "running");
      const runningAgentNodes = (countRunningAgentNodes.get(id) as CountRow).count;
      const waitingApprovalNodes = this.#countNodes(id, "waiting_for_approval");
      const pendingNodes = this.#countNodes(id, "pending");
      // A latched request outlives owner loss: reconcile as cancelled rather than interrupted.
      const cancelled = this.readCancellationRequest(id) !== undefined;
      const activeResult = cancelled
        ? cancelActiveNodes.run(timestamp, id)
        : updateActiveNodes.run(timestamp, failure.code, failure.message, id);
      const activeAttemptResult = cancelled
        ? cancelActiveAttempts.run(timestamp, id)
        : updateActiveAttempts.run(timestamp, failure.code, failure.message, id);
      const pendingResult = updatePendingNodes.run(timestamp, id);
      const runResult = cancelled
        ? cancelRun.run(timestamp, id)
        : updateRun.run(timestamp, failure.code, failure.message, id);
      if (
        activeResult.changes !== runningNodes + waitingApprovalNodes ||
        activeAttemptResult.changes !== runningAgentNodes ||
        pendingResult.changes !== pendingNodes ||
        runResult.changes !== 1
      ) {
        throw new KilinError(
          "INTERNAL_ERROR",
          `Run "${id}" changed during stale-run reconciliation. Inspect the stored run before retrying.`,
        );
      }
    }
    return runIds.map(({ id }) => this.#getRunDetail(id));
  }

  #finishNode(
    runId: string,
    nodeId: string,
    expectedStatus: NodeRunStatus,
    transition: Exclude<NodeTransition, { status: "running" }>,
    timestamp: string,
  ): Database.RunResult {
    const failure = "failure" in transition ? transition.failure : undefined;
    const exitCode = "exitCode" in transition ? transition.exitCode : undefined;
    const runtimeVersion = "runtimeVersion" in transition ? transition.runtimeVersion : undefined;
    const effectiveModel = "effectiveModel" in transition ? transition.effectiveModel : undefined;
    return this.#database
      .prepare(
        `
      UPDATE node_runs
      SET status = ?, finished_at = ?, exit_code = ?, failure_code = ?, failure_message = ?,
          runtime_version = COALESCE(?, runtime_version), effective_model = COALESCE(?, effective_model)
      WHERE run_id = ? AND node_id = ? AND status = ?
    `,
      )
      .run(
        transition.status,
        timestamp,
        exitCode ?? null,
        failure?.code ?? null,
        failure?.message ?? null,
        runtimeVersion ?? null,
        effectiveModel ?? null,
        runId,
        nodeId,
        expectedStatus,
      );
  }

  /**
   * Applies cancellation outcome precedence by durable commit order. A cancellation request that
   * committed first prevents an admission (`undefined`, leaving the occurrence pending for the
   * caller to skip) and rewrites a still-active occurrence's non-cancel outcome to `cancelled`. An
   * outcome that committed before the request keeps its truthful status, because this method only
   * ever sees transitions that have not been written yet.
   */
  #effectiveNodeTransition(
    cancelRequestedAt: string | null,
    transition: NodeTransition,
  ): NodeTransition | undefined {
    if (cancelRequestedAt === null) {
      return transition;
    }
    if (transition.status === "running") {
      return undefined;
    }
    if (transition.status === "cancelled" || transition.status === "skipped") {
      return transition;
    }
    const exitCode = "exitCode" in transition ? transition.exitCode : undefined;
    return {
      status: "cancelled",
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(transition.runtimeVersion === undefined
        ? {}
        : { runtimeVersion: transition.runtimeVersion }),
      ...(transition.effectiveModel === undefined
        ? {}
        : { effectiveModel: transition.effectiveModel }),
    };
  }

  #approvalRecord(runId: string, nodeId: string, row: NodeRow): ApprovalNodeRunRecord {
    const node = nodeFromRow(row);
    if (node.kind !== "approval") {
      throw new KilinError(
        "INTERNAL_ERROR",
        `Approval node "${nodeId}" changed kind while run "${runId}" was being updated. Inspect the run before retrying.`,
      );
    }
    return node;
  }

  #loopRecord(runId: string, nodeId: string): LoopNodeRunRecord {
    const node = nodeFromRow(this.#getNodeRow(runId, nodeId));
    if (node.kind !== "loop") {
      throw new KilinError(
        "INTERNAL_ERROR",
        `Loop "${nodeId}" changed kind while run "${runId}" was being updated. Inspect the run before retrying.`,
      );
    }
    return node;
  }

  #getRunDetail(runId: string): RunDetail {
    const run = this.#getRunRow(runId);
    const revision = this.#database
      .prepare("SELECT * FROM workflow_revisions WHERE id = ?")
      .get(run.revision_id) as RevisionRow | undefined;
    if (revision === undefined) {
      throw new KilinError(
        "INTERNAL_ERROR",
        `Run "${runId}" references a missing workflow revision. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
      );
    }
    const nodes = withRunningAttemptProcesses(
      this.#listNodeRows(runId).map(nodeFromRow),
      this.#listRunningAttemptRows(runId),
    );
    const retriedNodeIds = new Set(
      nodes
        .filter(
          (node): node is AgentNodeRunRecord =>
            node.kind === "agent" && node.attempt !== undefined && node.attempt > 1,
        )
        .map((node) => node.nodeId),
    );
    const attempts =
      retriedNodeIds.size === 0 ? [] : this.#listRetriedNodeAttempts(runId, retriedNodeIds);
    const workspaces = this.#listRunWorkspaceRecords(runId);
    return {
      run: runFromRow(run),
      revision: revisionFromRow(revision),
      nodes,
      ...(attempts.length === 0 ? {} : { attempts }),
      ...(workspaces.length === 0 ? {} : { workspaces }),
    };
  }

  #listRunningAttemptRows(runId: string): NodeAttemptRow[] {
    return this.#database
      .prepare("SELECT * FROM node_attempts WHERE run_id = ? AND process_pid IS NOT NULL")
      .all(runId) as NodeAttemptRow[];
  }

  #listRetriedNodeAttempts(
    runId: string,
    retriedNodeIds: ReadonlySet<string>,
  ): NodeAttemptRecord[] {
    const placeholders = [...retriedNodeIds].map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `
      SELECT * FROM node_attempts
      WHERE run_id = ? AND node_id IN (${placeholders}) ORDER BY node_id, attempt
    `,
      )
      .all(runId, ...retriedNodeIds) as NodeAttemptRow[];
    return rows.map(attemptFromRow);
  }

  #listRunWorkspaceRecords(runId: string): RunWorkspaceRecord[] {
    const rows = this.#database
      .prepare(
        `
      SELECT * FROM run_workspaces WHERE run_id = ? ORDER BY workspace_id
    `,
      )
      .all(runId) as RunWorkspaceRow[];
    return rows.map((row) => workspaceFromRow(row, runId));
  }

  #getRunRow(runId: string): ValidatedRunRow {
    const row = this.#database.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as
      RunRow | undefined;
    if (row === undefined) {
      throw new KilinError(
        "RUN_NOT_FOUND",
        `Run "${runId}" does not exist. Use "kilin runs list" to choose an existing run.`,
      );
    }
    const run = runFromRow(row);
    return { ...row, status: run.status, cancel_requested_at: row.cancel_requested_at ?? null };
  }

  #getNodeRow(runId: string, nodeId: string): ValidatedNodeRow {
    this.#getRunRow(runId);
    const row = this.#database
      .prepare(
        `
      SELECT * FROM node_runs WHERE run_id = ? AND node_id = ?
    `,
      )
      .get(runId, nodeId) as NodeRow | undefined;
    if (row === undefined) {
      throw new KilinError(
        "INTERNAL_ERROR",
        `Run "${runId}" does not contain node "${nodeId}". Inspect the stored run before retrying.`,
      );
    }
    const node = nodeFromRow(row);
    return { ...row, status: node.status };
  }

  #listNodeRows(runId: string): NodeRow[] {
    return this.#database
      .prepare(
        `
      SELECT * FROM node_runs WHERE run_id = ? ORDER BY ordinal
    `,
      )
      .all(runId) as NodeRow[];
  }

  #countNodes(runId: string, status: NodeRunStatus): number {
    const row = this.#database
      .prepare(
        `
      SELECT COUNT(*) AS count FROM node_runs WHERE run_id = ? AND status = ?
    `,
      )
      .get(runId, status) as CountRow;
    return row.count;
  }

  #protectDatabaseFiles(): void {
    if (process.platform === "win32") {
      return;
    }
    for (const path of [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
      this.#migrationLockPath,
    ]) {
      if (existsSync(path)) {
        chmodSync(path, 0o600);
      }
    }
  }
}
