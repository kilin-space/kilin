import { isAbsolute } from "node:path";

import { parseCanonicalJson } from "../domain/canonical-json.js";
import { isKilinErrorCode, KilinError } from "../domain/errors.js";
import { maximumParameterSnapshotBytes, parsedStoredParameters } from "../domain/run-parameters.js";
import type { RunParameters } from "../domain/run-parameters.js";
import {
  assertRunOptions,
  isNodeRunStatus,
  isRunStatus,
  maximumApprovalNoteCharacters,
} from "../domain/run-state.js";
import type {
  AgentNodeRunRecord,
  ApprovalNodeRunRecord,
  AttemptProcessIdentity,
  FailureInfo,
  LoopNodeRunRecord,
  NodeRunRecord,
  NodeRunStatus,
  NodeAttemptRecord,
  NodeOutputPaths,
  RecordedApprovalDecision,
  RunWorkspaceRecord,
  RunOptions,
  WorkflowRevisionRecord,
  WorkflowRunRecord,
} from "../domain/run-state.js";
import type { WorkflowScope } from "../domain/workflow-package.js";
import { isLowercaseIdentifier } from "../domain/workflow-package.js";
import { isWorkflowNodeIdentifier } from "../domain/workflow.js";
import type { AgentOutputDeclaration } from "../domain/workflow.js";
import { parseStoredCronTriggerSource } from "../domain/workflow-trigger.js";
import type { CronTriggerSource } from "../domain/workflow-trigger.js";
import { isGitObjectId } from "./git-workspace.js";

export interface StoredRevisionRow {
  readonly id: string;
  readonly scope_kind: string;
  readonly scope_root: string;
  readonly workflow_id: string;
  readonly schema_version: number;
  readonly content_hash: string;
  readonly normalized_definition: string;
  readonly created_at: string;
}

export interface StoredRunRow {
  readonly id: string;
  readonly revision_id: string;
  readonly rerun_of_run_id: string | null;
  readonly recovery_of_run_id: string | null;
  readonly recovery_mode: string | null;
  readonly canonical_cwd: string;
  readonly options_json: string;
  readonly parameters_json: string | null;
  readonly trigger_source_json: string | null;
  readonly status: string;
  readonly started_at: string;
  readonly cancel_requested_at: string | null;
  readonly finished_at: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
}

export interface StoredNodeRunRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly body_node_id: string | null;
  readonly loop_node_id: string | null;
  readonly iteration: number | null;
  readonly runtime: string | null;
  readonly requested_model: string | null;
  readonly effective_model: string | null;
  readonly runtime_version: string | null;
  readonly status: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly exit_code: number | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly stdout_path: string | null;
  readonly stderr_path: string | null;
  readonly result_path: string | null;
  readonly resolved_inputs_path: string | null;
  readonly output_type: string | null;
  readonly declared_output_type: string | null;
  readonly artifact_path: string | null;
  readonly approval_decision: string | null;
  readonly approval_actor: string | null;
  readonly approval_note: string | null;
  readonly approval_requested_at: string | null;
  readonly approval_deadline_at: string | null;
  readonly approval_decided_at: string | null;
  readonly current_attempt: number;
  readonly reused_from_run_id: string | null;
  readonly reused_from_node_id: string | null;
}

export interface StoredNodeAttemptRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly status: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly exit_code: number | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly stdout_path: string;
  readonly stderr_path: string;
  readonly result_path: string;
  readonly process_pid: number | null;
  readonly process_group_id: number | null;
  readonly process_start_identifier: string | null;
}

export interface StoredRunWorkspaceRow {
  readonly run_id: unknown;
  readonly workspace_id: unknown;
  readonly path: unknown;
  readonly base_commit: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
}

const storedStateError = (detail: string): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    `Stored state ${detail}. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
  );

const failureFromRow = (code: string | null, message: string | null): FailureInfo | undefined => {
  if (code === null && message === null) {
    return undefined;
  }
  if (code === null || message === null) {
    throw new KilinError(
      "INTERNAL_ERROR",
      "Stored state has incomplete failure information. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
    );
  }
  if (!isKilinErrorCode(code)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Stored state uses unknown failure code "${code}". This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
    );
  }
  return { code, message };
};

const parseStoredTimestamp = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw storedStateError(`has an invalid ${field} timestamp`);
  }
  return value;
};

const invalidStoredRunOptions = (): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    "A stored run has invalid execution options. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
  );

const parseOptions = (optionsJson: string): RunOptions => {
  let value: unknown;
  try {
    value = JSON.parse(optionsJson);
  } catch {
    throw invalidStoredRunOptions();
  }
  if (typeof value !== "object" || value === null) {
    throw invalidStoredRunOptions();
  }
  if (
    !("nodeTimeoutMs" in value) ||
    typeof value.nodeTimeoutMs !== "number" ||
    !("approvalTimeoutMs" in value) ||
    typeof value.approvalTimeoutMs !== "number" ||
    !("maxOutputBytes" in value) ||
    typeof value.maxOutputBytes !== "number" ||
    !("maxParallel" in value) ||
    typeof value.maxParallel !== "number"
  ) {
    throw invalidStoredRunOptions();
  }
  const options: RunOptions = {
    nodeTimeoutMs: value.nodeTimeoutMs,
    approvalTimeoutMs: value.approvalTimeoutMs,
    maxOutputBytes: value.maxOutputBytes,
    maxParallel: value.maxParallel,
  };
  try {
    assertRunOptions(options);
  } catch {
    throw invalidStoredRunOptions();
  }
  return options;
};

const parseStoredParameters = (parametersJson: string | null): RunParameters | undefined => {
  if (parametersJson === null) {
    return undefined;
  }
  const invalid = (): KilinError =>
    new KilinError(
      "INTERNAL_ERROR",
      "A stored run has an invalid parameter snapshot. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
    );
  if (Buffer.byteLength(parametersJson, "utf8") > maximumParameterSnapshotBytes) {
    throw invalid();
  }
  let value: unknown;
  try {
    value = parseCanonicalJson(parametersJson);
  } catch {
    throw invalid();
  }
  const parameters = parsedStoredParameters(value);
  if (parameters === undefined) {
    throw invalid();
  }
  return parameters;
};

const parseStoredTrigger = (sourceJson: string): CronTriggerSource => {
  try {
    const value: unknown = JSON.parse(sourceJson);
    return parseStoredCronTriggerSource(value);
  } catch {
    throw storedStateError("has invalid trigger provenance");
  }
};

export const decodeStoredWorkflowScope = (kind: string, root: string): WorkflowScope => {
  if (kind === "user" && root === "") {
    return { kind };
  }
  if (kind === "project" && isAbsolute(root)) {
    return { kind, root };
  }
  throw storedStateError("has an invalid workflow scope");
};

export const decodeStoredRevisionRow = (row: StoredRevisionRow): WorkflowRevisionRecord => {
  if (row.schema_version !== 1) {
    throw storedStateError(
      `uses unsupported workflow schema version "${String(row.schema_version)}"`,
    );
  }
  return {
    id: row.id,
    scope: decodeStoredWorkflowScope(row.scope_kind, row.scope_root),
    workflowId: row.workflow_id,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
    normalizedDefinition: row.normalized_definition,
    createdAt: parseStoredTimestamp(row.created_at, "workflow revision creation"),
  };
};

export const decodeStoredRunRow = (row: StoredRunRow): WorkflowRunRecord => {
  if (!isRunStatus(row.status)) {
    throw storedStateError(`uses unknown run status "${row.status}"`);
  }
  const startedAt = parseStoredTimestamp(row.started_at, "run start");
  const finishedAt =
    row.finished_at === null ? undefined : parseStoredTimestamp(row.finished_at, "run finish");
  const failure = failureFromRow(row.failure_code, row.failure_message);

  if (row.status === "running" && (finishedAt !== undefined || failure !== undefined)) {
    throw storedStateError("has a running run with terminal state");
  }
  if (
    (row.status === "succeeded" || row.status === "cancelled") &&
    (finishedAt === undefined || failure !== undefined)
  ) {
    throw storedStateError(`has an invalid ${row.status} run lifecycle`);
  }
  if (
    (row.status === "failed" || row.status === "interrupted") &&
    (finishedAt === undefined || failure === undefined)
  ) {
    throw storedStateError(`has an invalid ${row.status} run lifecycle`);
  }

  const parameters = parseStoredParameters(row.parameters_json);
  const run: WorkflowRunRecord = {
    id: row.id,
    revisionId: row.revision_id,
    canonicalCwd: row.canonical_cwd,
    options: parseOptions(row.options_json),
    ...(parameters === undefined ? {} : { parameters }),
    status: row.status,
    startedAt,
    ...(row.cancel_requested_at === null
      ? {}
      : {
          cancelRequestedAt: parseStoredTimestamp(
            row.cancel_requested_at,
            "run cancellation request",
          ),
        }),
  };
  if (row.rerun_of_run_id !== null) {
    run.rerunOfRunId = row.rerun_of_run_id;
  }
  if (row.recovery_of_run_id !== null) {
    if (row.recovery_mode !== "retry" && row.recovery_mode !== "resume") {
      throw storedStateError("has invalid recovery lineage");
    }
    run.recoveryOfRunId = row.recovery_of_run_id;
    run.recoveryMode = row.recovery_mode;
  } else if (row.recovery_mode !== null) {
    throw storedStateError("has a recovery mode without a source run");
  }
  if (row.trigger_source_json !== null) {
    run.trigger = parseStoredTrigger(row.trigger_source_json);
  }
  if (finishedAt !== undefined) {
    run.finishedAt = finishedAt;
  }
  if (failure !== undefined) {
    run.failure = failure;
  }
  return run;
};

interface DecodedNodeState {
  status: NodeRunStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  failure?: FailureInfo;
  outputPaths?: NodeOutputPaths;
}

const decodeCommonNodeState = (row: StoredNodeRunRow): DecodedNodeState => {
  if (!isNodeRunStatus(row.status)) {
    throw storedStateError(`uses unknown node status "${row.status}"`);
  }
  if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 0) {
    throw storedStateError("has a node with an invalid ordinal");
  }
  if (row.exit_code !== null && !Number.isInteger(row.exit_code)) {
    throw storedStateError("has a node with a non-integer exit code");
  }
  const startedAt =
    row.started_at === null ? undefined : parseStoredTimestamp(row.started_at, "node start");
  const finishedAt =
    row.finished_at === null ? undefined : parseStoredTimestamp(row.finished_at, "node finish");
  const failure = failureFromRow(row.failure_code, row.failure_message);
  const hasStdoutPath = row.stdout_path !== null;
  const hasStderrPath = row.stderr_path !== null;
  const hasResultPath = row.result_path !== null;
  if (hasStdoutPath !== hasStderrPath || (row.kind !== "loop" && hasStdoutPath !== hasResultPath)) {
    throw new KilinError(
      "INTERNAL_ERROR",
      "A stored node has incomplete output paths. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
    );
  }
  const outputPaths =
    row.stdout_path !== null && row.stderr_path !== null && row.result_path !== null
      ? {
          stdoutPath: row.stdout_path,
          stderrPath: row.stderr_path,
          resultPath: row.result_path,
        }
      : undefined;
  return {
    status: row.status,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(failure === undefined ? {} : { failure }),
    ...(outputPaths === undefined ? {} : { outputPaths }),
  };
};

const executionProvenanceFromRow = (
  row: StoredNodeRunRow,
):
  | { bodyNodeId?: never; loopNodeId?: never; iteration?: never }
  | { bodyNodeId: string; loopNodeId: string; iteration: number } => {
  const bodyNodeId = row.body_node_id ?? null;
  const loopNodeId = row.loop_node_id ?? null;
  const iteration = row.iteration ?? null;
  if (bodyNodeId === null && loopNodeId === null && iteration === null) {
    return {};
  }
  if (
    !isWorkflowNodeIdentifier(bodyNodeId) ||
    !isWorkflowNodeIdentifier(loopNodeId) ||
    typeof iteration !== "number" ||
    !Number.isSafeInteger(iteration) ||
    iteration < 0
  ) {
    throw storedStateError("has invalid loop execution provenance");
  }
  return { bodyNodeId, loopNodeId, iteration };
};

const approvalDecisionFromRow = (row: StoredNodeRunRow): RecordedApprovalDecision | undefined => {
  if (
    row.approval_decision === null &&
    row.approval_actor === null &&
    row.approval_note === null &&
    row.approval_decided_at === null
  ) {
    return undefined;
  }
  if (
    (row.approval_decision !== "approve" && row.approval_decision !== "reject") ||
    (row.approval_actor !== "agent" && row.approval_actor !== "human") ||
    row.approval_decided_at === null ||
    (row.approval_note !== null &&
      (typeof row.approval_note !== "string" ||
        Array.from(row.approval_note).length > maximumApprovalNoteCharacters))
  ) {
    throw storedStateError("has invalid approval decision metadata");
  }
  return {
    decision: row.approval_decision,
    actor: row.approval_actor,
    decidedAt: parseStoredTimestamp(row.approval_decided_at, "approval decision"),
    ...(row.approval_note === null ? {} : { note: row.approval_note }),
  };
};

const decodeStoredApprovalNodeRunRow = (
  row: StoredNodeRunRow,
  state: DecodedNodeState,
): ApprovalNodeRunRecord => {
  if (
    row.runtime !== null ||
    row.requested_model !== null ||
    row.effective_model !== null ||
    row.runtime_version !== null ||
    state.startedAt !== undefined ||
    state.exitCode !== undefined ||
    state.outputPaths !== undefined ||
    row.resolved_inputs_path !== null ||
    row.output_type !== null ||
    row.declared_output_type !== null ||
    row.artifact_path !== null
  ) {
    throw storedStateError("has agent execution metadata on an approval node");
  }
  if (state.status === "running") {
    throw storedStateError("has an approval node with running status");
  }
  const requestedAt =
    row.approval_requested_at === null
      ? undefined
      : parseStoredTimestamp(row.approval_requested_at, "approval request");
  const deadlineAt =
    row.approval_deadline_at === null
      ? undefined
      : parseStoredTimestamp(row.approval_deadline_at, "approval deadline");
  if ((requestedAt === undefined) !== (deadlineAt === undefined)) {
    throw storedStateError("has incomplete approval request metadata");
  }
  const decision = approvalDecisionFromRow(row);
  if (
    requestedAt !== undefined &&
    deadlineAt !== undefined &&
    (Date.parse(deadlineAt) <= Date.parse(requestedAt) ||
      (decision !== undefined &&
        (Date.parse(decision.decidedAt) < Date.parse(requestedAt) ||
          Date.parse(decision.decidedAt) >= Date.parse(deadlineAt))))
  ) {
    throw storedStateError("has an invalid approval timeline");
  }
  if (
    state.status === "pending" &&
    (state.finishedAt !== undefined ||
      state.failure !== undefined ||
      requestedAt !== undefined ||
      decision !== undefined)
  ) {
    throw storedStateError("has a pending approval node with lifecycle state");
  }
  if (
    state.status === "skipped" &&
    (state.finishedAt === undefined ||
      state.failure !== undefined ||
      requestedAt !== undefined ||
      decision !== undefined)
  ) {
    throw storedStateError("has an invalid skipped approval lifecycle");
  }
  if (
    state.status === "waiting_for_approval" &&
    (state.finishedAt !== undefined || state.failure !== undefined || requestedAt === undefined)
  ) {
    throw storedStateError("has an invalid waiting approval lifecycle");
  }
  if (
    state.status === "succeeded" &&
    (state.finishedAt === undefined ||
      state.failure !== undefined ||
      requestedAt === undefined ||
      decision?.decision !== "approve")
  ) {
    throw storedStateError("has an invalid succeeded approval lifecycle");
  }
  if (
    state.status === "failed" &&
    (state.finishedAt === undefined ||
      state.failure?.code !==
        (decision?.decision === "reject" ? "APPROVAL_REJECTED" : "APPROVAL_TIMEOUT") ||
      requestedAt === undefined ||
      decision?.decision === "approve")
  ) {
    throw storedStateError("has an invalid failed approval lifecycle");
  }
  if (
    state.status === "cancelled" &&
    (state.finishedAt === undefined || state.failure !== undefined || requestedAt === undefined)
  ) {
    throw storedStateError("has an invalid cancelled approval lifecycle");
  }
  if (
    state.status === "interrupted" &&
    (state.finishedAt === undefined ||
      state.failure?.code !== "RUN_INTERRUPTED" ||
      requestedAt === undefined)
  ) {
    throw storedStateError("has an invalid interrupted approval lifecycle");
  }
  return {
    kind: "approval",
    runId: row.run_id,
    nodeId: row.node_id,
    ordinal: row.ordinal,
    ...executionProvenanceFromRow(row),
    status: state.status,
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    ...(decision === undefined ? {} : { decision }),
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
  };
};

const decodeStoredAgentNodeRunRow = (
  row: StoredNodeRunRow,
  state: DecodedNodeState,
): AgentNodeRunRecord => {
  const outputType = row.declared_output_type ?? row.output_type;
  if (row.runtime === null) {
    throw storedStateError("has an agent node without a runtime");
  }
  if (
    row.approval_decision !== null ||
    row.approval_actor !== null ||
    row.approval_note !== null ||
    row.approval_requested_at !== null ||
    row.approval_deadline_at !== null ||
    row.approval_decided_at !== null
  ) {
    throw storedStateError("has approval metadata on an agent node");
  }
  if (
    outputType !== null &&
    outputType !== "text" &&
    outputType !== "json" &&
    outputType !== "decision_packet" &&
    outputType !== "artifact" &&
    outputType !== "choice"
  ) {
    throw storedStateError(`uses unknown output type "${outputType}"`);
  }
  if (row.declared_output_type !== null && row.output_type !== "json") {
    throw storedStateError("has an invalid declared output type projection");
  }
  if (
    (outputType === "artifact" && row.artifact_path === null) ||
    (outputType !== "artifact" && row.artifact_path !== null)
  ) {
    throw storedStateError("has incompatible artifact output metadata");
  }
  if (state.status === "waiting_for_approval") {
    throw storedStateError("has an agent node waiting for approval");
  }
  const hasObservedRuntimeMetadata = row.effective_model !== null || row.runtime_version !== null;

  if (
    state.status === "pending" &&
    (state.startedAt !== undefined ||
      state.finishedAt !== undefined ||
      state.outputPaths !== undefined ||
      state.exitCode !== undefined ||
      state.failure !== undefined ||
      hasObservedRuntimeMetadata ||
      row.resolved_inputs_path !== null)
  ) {
    throw storedStateError("has a pending node with execution state");
  }
  if (
    state.status === "skipped" &&
    (state.startedAt !== undefined ||
      state.finishedAt === undefined ||
      state.outputPaths !== undefined ||
      state.exitCode !== undefined ||
      state.failure !== undefined ||
      hasObservedRuntimeMetadata ||
      row.resolved_inputs_path !== null)
  ) {
    throw storedStateError("has an invalid skipped node lifecycle");
  }
  if (
    state.status === "running" &&
    (state.startedAt === undefined ||
      state.finishedAt !== undefined ||
      state.outputPaths === undefined ||
      state.exitCode !== undefined ||
      state.failure !== undefined)
  ) {
    throw storedStateError("has an invalid running node lifecycle");
  }
  if (
    state.status === "succeeded" &&
    (state.startedAt === undefined ||
      state.finishedAt === undefined ||
      state.outputPaths === undefined ||
      state.exitCode !== 0 ||
      state.failure !== undefined)
  ) {
    throw storedStateError("has an invalid succeeded node lifecycle");
  }
  if (
    (state.status === "failed" || state.status === "interrupted") &&
    (state.startedAt === undefined ||
      state.finishedAt === undefined ||
      state.outputPaths === undefined ||
      state.failure === undefined)
  ) {
    throw storedStateError(`has an invalid ${state.status} node lifecycle`);
  }
  if (
    state.status === "cancelled" &&
    (state.startedAt === undefined ||
      state.finishedAt === undefined ||
      state.outputPaths === undefined ||
      state.failure !== undefined)
  ) {
    throw storedStateError("has an invalid cancelled node lifecycle");
  }

  const node: AgentNodeRunRecord = {
    kind: "agent",
    runId: row.run_id,
    nodeId: row.node_id,
    ordinal: row.ordinal,
    ...executionProvenanceFromRow(row),
    runtime: row.runtime,
    status: state.status,
  };
  if (row.requested_model !== null) {
    node.requestedModel = row.requested_model;
  }
  if (row.effective_model !== null) {
    node.effectiveModel = row.effective_model;
  }
  if (row.runtime_version !== null) {
    node.runtimeVersion = row.runtime_version;
  }
  if (state.startedAt !== undefined) {
    node.startedAt = state.startedAt;
  }
  if (state.finishedAt !== undefined) {
    node.finishedAt = state.finishedAt;
  }
  if (state.exitCode !== undefined) {
    node.exitCode = state.exitCode;
  }
  if (state.failure !== undefined) {
    node.failure = state.failure;
  }
  if (state.outputPaths !== undefined) {
    node.outputPaths = state.outputPaths;
  }
  if (row.resolved_inputs_path !== null) {
    node.resolvedInputsPath = row.resolved_inputs_path;
  }
  if (outputType !== null) {
    node.outputType = outputType;
  }
  if (row.artifact_path !== null) {
    node.artifactPath = row.artifact_path;
  }
  if (row.current_attempt !== 1) {
    if (!Number.isSafeInteger(row.current_attempt) || row.current_attempt < 1) {
      throw storedStateError("has an invalid current attempt");
    }
    node.attempt = row.current_attempt;
  }
  if (row.reused_from_run_id !== null) {
    node.reusedFromRunId = row.reused_from_run_id;
    node.reusedFromNodeId = row.reused_from_node_id ?? row.node_id;
  } else if (row.reused_from_node_id !== null) {
    throw storedStateError("has a reused node ID without a source run");
  }
  return node;
};

const decodeStoredLoopNodeRunRow = (
  row: StoredNodeRunRow,
  state: DecodedNodeState,
): LoopNodeRunRecord => {
  const outputType = row.declared_output_type ?? row.output_type;
  if (
    row.runtime !== null ||
    row.requested_model !== null ||
    row.effective_model !== null ||
    row.runtime_version !== null ||
    row.exit_code !== null ||
    row.stdout_path !== null ||
    row.stderr_path !== null ||
    row.resolved_inputs_path !== null ||
    row.artifact_path !== null ||
    row.approval_decision !== null ||
    row.approval_actor !== null ||
    row.approval_note !== null ||
    row.approval_requested_at !== null ||
    row.approval_deadline_at !== null ||
    row.approval_decided_at !== null ||
    row.current_attempt !== 1 ||
    row.reused_from_run_id !== null ||
    row.reused_from_node_id !== null
  ) {
    throw storedStateError("has execution metadata on a loop control");
  }
  if (Object.keys(executionProvenanceFromRow(row)).length !== 0) {
    throw storedStateError("has body provenance on a loop control");
  }
  if (
    outputType === null ||
    (outputType !== "text" &&
      outputType !== "json" &&
      outputType !== "decision_packet" &&
      outputType !== "choice") ||
    (row.declared_output_type !== null && row.output_type !== "json")
  ) {
    throw storedStateError("has an invalid loop result type");
  }
  const validatedOutputType: AgentOutputDeclaration["type"] = outputType;
  if (state.status === "waiting_for_approval") {
    throw storedStateError("has a loop control waiting for approval");
  }
  if (
    state.status === "pending" &&
    (state.startedAt !== undefined ||
      state.finishedAt !== undefined ||
      state.failure !== undefined ||
      row.result_path !== null)
  ) {
    throw storedStateError("has a pending loop control with lifecycle state");
  }
  if (
    state.status === "running" &&
    (state.startedAt === undefined ||
      state.finishedAt !== undefined ||
      state.failure !== undefined ||
      row.result_path !== null)
  ) {
    throw storedStateError("has an invalid running loop lifecycle");
  }
  if (
    state.status === "succeeded" &&
    (state.startedAt === undefined ||
      state.finishedAt === undefined ||
      state.failure !== undefined ||
      row.result_path === null)
  ) {
    throw storedStateError("has an invalid succeeded loop lifecycle");
  }
  if (
    (state.status === "failed" || state.status === "interrupted") &&
    (state.startedAt === undefined ||
      state.finishedAt === undefined ||
      state.failure === undefined ||
      row.result_path !== null)
  ) {
    throw storedStateError(`has an invalid ${state.status} loop lifecycle`);
  }
  if (
    state.status === "cancelled" &&
    (state.finishedAt === undefined || state.failure !== undefined || row.result_path !== null)
  ) {
    throw storedStateError("has an invalid cancelled loop lifecycle");
  }
  if (
    state.status === "skipped" &&
    (state.startedAt !== undefined ||
      state.finishedAt === undefined ||
      state.failure !== undefined ||
      row.result_path !== null)
  ) {
    throw storedStateError("has an invalid skipped loop lifecycle");
  }
  const resultProjection =
    state.status === "succeeded" && row.result_path !== null
      ? { resultPath: row.result_path, outputType: validatedOutputType }
      : {};
  return {
    kind: "loop",
    runId: row.run_id,
    nodeId: row.node_id,
    ordinal: row.ordinal,
    status: state.status,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.finishedAt === undefined ? {} : { finishedAt: state.finishedAt }),
    ...(state.failure === undefined ? {} : { failure: state.failure }),
    ...resultProjection,
  };
};

export const decodeStoredNodeRunRow = (row: StoredNodeRunRow): NodeRunRecord => {
  const state = decodeCommonNodeState(row);
  if (row.kind === "approval") {
    return decodeStoredApprovalNodeRunRow(row, state);
  }
  if (row.kind === "agent") {
    return decodeStoredAgentNodeRunRow(row, state);
  }
  if (row.kind === "loop") {
    return decodeStoredLoopNodeRunRow(row, state);
  }
  throw storedStateError(`uses unsupported node kind "${row.kind}"`);
};

/**
 * Decodes the process identity recorded while an attempt was running. The schema keeps the three
 * columns all-or-nothing, so a partial triple here means the row was written outside Kilin.
 */
export const decodeStoredAttemptProcessIdentity = (
  row: Pick<StoredNodeAttemptRow, "process_pid" | "process_group_id" | "process_start_identifier">,
): AttemptProcessIdentity | undefined => {
  if (
    row.process_pid === null &&
    row.process_group_id === null &&
    row.process_start_identifier === null
  ) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(row.process_pid) ||
    Number(row.process_pid) < 1 ||
    !Number.isSafeInteger(row.process_group_id) ||
    Number(row.process_group_id) < 1 ||
    typeof row.process_start_identifier !== "string" ||
    row.process_start_identifier.length === 0
  ) {
    throw storedStateError("has an invalid node attempt process identity");
  }
  return {
    pid: Number(row.process_pid),
    processGroupId: Number(row.process_group_id),
    startIdentifier: row.process_start_identifier,
  };
};

/** Attaches the recorded process to every agent node that is still running. */
export const withRunningAttemptProcesses = (
  nodes: readonly NodeRunRecord[],
  attemptRows: readonly StoredNodeAttemptRow[],
): NodeRunRecord[] => {
  const running = new Map<string, AttemptProcessIdentity>();
  for (const row of attemptRows) {
    const identity = decodeStoredAttemptProcessIdentity(row);
    if (identity !== undefined) {
      running.set(`${row.node_id} ${String(row.attempt)}`, identity);
    }
  }
  return nodes.map((node) => {
    if (node.kind !== "agent" || node.status !== "running") {
      return node;
    }
    const identity = running.get(`${node.nodeId} ${String(node.attempt ?? 1)}`);
    return identity === undefined ? node : { ...node, process: identity };
  });
};

export const decodeStoredNodeAttemptRow = (row: StoredNodeAttemptRow): NodeAttemptRecord => {
  if (
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 1 ||
    !["running", "succeeded", "failed", "cancelled", "interrupted"].includes(row.status)
  ) {
    throw storedStateError("has an invalid node attempt identity or status");
  }
  const startedAt = parseStoredTimestamp(row.started_at, "node attempt start");
  const finishedAt =
    row.finished_at === null
      ? undefined
      : parseStoredTimestamp(row.finished_at, "node attempt finish");
  const failure = failureFromRow(row.failure_code, row.failure_message);
  if (
    (row.status === "running" && (finishedAt !== undefined || failure !== undefined)) ||
    (row.status === "succeeded" &&
      (finishedAt === undefined || row.exit_code !== 0 || failure !== undefined)) ||
    ((row.status === "failed" || row.status === "interrupted") &&
      (finishedAt === undefined || failure === undefined)) ||
    (row.status === "cancelled" && (finishedAt === undefined || failure !== undefined))
  ) {
    throw storedStateError("has an invalid node attempt lifecycle");
  }
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    status: row.status as NodeAttemptRecord["status"],
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(failure === undefined ? {} : { failure }),
    outputPaths: {
      stdoutPath: row.stdout_path,
      stderrPath: row.stderr_path,
      resultPath: row.result_path,
    },
  };
};

export const decodeStoredRunWorkspaceRow = (
  row: StoredRunWorkspaceRow,
  expectedRunId: string,
): RunWorkspaceRecord => {
  if (
    row.run_id !== expectedRunId ||
    typeof row.workspace_id !== "string" ||
    !isLowercaseIdentifier(row.workspace_id) ||
    row.workspace_id === "source" ||
    typeof row.path !== "string" ||
    row.path.includes("\u0000") ||
    !isAbsolute(row.path) ||
    typeof row.base_commit !== "string" ||
    !isGitObjectId(row.base_commit) ||
    row.status !== "provisioned"
  ) {
    throw storedStateError("has an invalid run workspace");
  }
  return {
    runId: expectedRunId,
    workspaceId: row.workspace_id,
    path: row.path,
    baseCommit: row.base_commit,
    status: row.status,
    createdAt: parseStoredTimestamp(row.created_at, "run workspace creation"),
  };
};
