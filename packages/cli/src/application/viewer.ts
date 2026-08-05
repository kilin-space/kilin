import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { compileWorkflow } from "../domain/compile-workflow.js";
import { tryParseDecisionPacket } from "../domain/decision-packet.js";
import { KilinError } from "../domain/errors.js";
import type {
  AgentNodeRunRecord,
  ApprovalNodeRunRecord,
  FailureInfo,
  LoopNodeRunRecord,
  NodeAttemptRecord,
  NodeOutputPaths,
  NodeRunRecord,
  RunDetail,
  RunListRecord,
  RunWorkspaceRecord,
  WorkflowRevisionRecord,
  WorkflowRunRecord,
} from "../domain/run-state.js";
import {
  elapsedMsOrUndefined,
  isApprovalAwaitingDecision,
  waitingApprovalNodes,
} from "../domain/run-state.js";
import type {
  AgentNode,
  ApprovalNode,
  DependencyEdge,
  ExecutionPlan,
  PlannedNode,
} from "../domain/workflow.js";
import type { WorkflowIdentity } from "../domain/workflow-package.js";
import { sameWorkflowIdentity } from "../domain/workflow-package.js";
import { openAuthorizedRunFile } from "../infrastructure/authorized-run-file.js";
import { nodeOutputPaths } from "../infrastructure/process-runner.js";
import { resolveJsonOutputSchemas } from "../infrastructure/workflow-package.js";
import { parseWorkflowBytes } from "../infrastructure/workflow-source.js";
import type {
  BoundedOutputResponse,
  CurrentWorkflowResponse,
  LoopBodyWorkflowNodeDto,
  LoopIterationDto,
  NodeRunDto,
  OutputStream,
  RunLineageDto,
  RunSummaryDto,
  ScopedRunDetailResponse,
  ScopedRunListResponse,
  StoredWorkflowRevisionDto,
  ViewerNodeAttemptDto,
  ViewerWorkspaceDto,
  ViewerFailureDto,
  WorkflowDiagnosticDto,
  WorkflowEdgeDto,
  WorkflowNodeDto,
  WorkflowGraphDto,
} from "../ui/contracts.js";
import { compileStoredWorkflowRevision } from "./workflows.js";

const outputTailBytes = 65_536;
const outputVersion = 1 as const;

export interface ViewerScope {
  readonly identity: WorkflowIdentity;
  readonly canonicalCwd: string;
}

export interface ViewerRunListRecord extends RunListRecord {
  readonly waitingApprovalCount: number;
  readonly undecidedWaitingApprovalCount: number;
}

export interface ViewerApplicationOptions {
  readonly definitionFile: string;
  readonly identity: WorkflowIdentity;
  readonly canonicalCwd: string;
  readonly dataDirectory: string;
}

const failureDto = (failure: FailureInfo | undefined): ViewerFailureDto | undefined => {
  if (failure === undefined) {
    return undefined;
  }
  return { code: failure.code, message: failure.message };
};

const workflowEdgeDto = ({ from, to, input }: DependencyEdge): WorkflowEdgeDto => ({
  from,
  to,
  ...(input === undefined ? {} : { input }),
});

const incomingDependenciesByNode = (
  edges: readonly DependencyEdge[],
): ReadonlyMap<string, readonly string[]> => {
  const dependenciesByNode = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const dependencies = dependenciesByNode.get(to);
    if (dependencies === undefined) {
      dependenciesByNode.set(to, [from]);
    } else {
      dependencies.push(from);
    }
  }
  return dependenciesByNode;
};

const executableWorkflowNodeDto = (
  node: AgentNode | ApprovalNode,
  ordinal: number,
  dependencies: readonly string[],
): LoopBodyWorkflowNodeDto => {
  if (node.kind === "approval") {
    return {
      id: node.id,
      ordinal,
      kind: node.kind,
      question: node.question,
      dependencies,
    };
  }
  return {
    id: node.id,
    ordinal,
    kind: node.kind,
    runtime: node.runtime,
    access: node.access,
    ...(node.model === undefined ? {} : { model: node.model }),
    ...(node.output === undefined ? {} : { outputType: node.output.type }),
    ...(node.output?.type === "artifact" ? { artifactPath: node.output.path } : {}),
    dependencies,
  };
};

const workflowGraph = (plan: ExecutionPlan): WorkflowGraphDto => {
  const topLevelPlan = plan.nodes.filter(({ loopNodeId }) => loopNodeId === undefined);
  const ordinals = new Map(topLevelPlan.map(({ nodeId, ordinal }) => [nodeId, ordinal] as const));
  const incomingTopLevelDependencies = incomingDependenciesByNode(plan.authoredDefinition.edges);
  const nodes = plan.authoredDefinition.nodes.map((node): WorkflowNodeDto => {
    const ordinal = ordinals.get(node.id);
    if (ordinal === undefined) {
      throw new KilinError(
        "INTERNAL_ERROR",
        `The workflow is missing node "${node.id}". This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.`,
      );
    }
    if (node.kind !== "loop") {
      return executableWorkflowNodeDto(
        node,
        ordinal,
        incomingTopLevelDependencies.get(node.id) ?? [],
      );
    }
    const incomingBodyDependencies = incomingDependenciesByNode(node.body.edges);
    return {
      id: node.id,
      ordinal,
      kind: "loop",
      maxIterations: node.maxIterations,
      dependencies: incomingTopLevelDependencies.get(node.id) ?? [],
      body: {
        nodes: node.body.nodes.map((bodyNode, bodyOrdinal) =>
          executableWorkflowNodeDto(
            bodyNode,
            bodyOrdinal,
            incomingBodyDependencies.get(bodyNode.id) ?? [],
          ),
        ),
        edges: node.body.edges.map(workflowEdgeDto),
      },
      decision: {
        nodeId: node.decision.node,
        passChoice: node.decision.passChoice,
        reviseChoice: node.decision.reviseChoice,
      },
      feedback: {
        fromNodeId: node.feedback.from,
        toNodeId: node.feedback.to,
        input: node.feedback.input,
      },
      resultNodeId: node.result.node,
    };
  });
  return {
    workflowId: plan.authoredDefinition.workflow.id,
    name: plan.authoredDefinition.workflow.name,
    nodes,
    edges: plan.authoredDefinition.edges.map(workflowEdgeDto),
    executionOrder: topLevelPlan.map(({ nodeId }) => nodeId),
  };
};

const runSummary = (
  run: WorkflowRunRecord,
  identity: WorkflowIdentity,
  waitingForApproval: boolean,
): RunSummaryDto => {
  if (
    (run.recoveryOfRunId === undefined) !== (run.recoveryMode === undefined) ||
    (run.rerunOfRunId !== undefined && run.recoveryOfRunId !== undefined)
  ) {
    throw storedRunCorruption();
  }
  const finishedAt = run.finishedAt;
  const failure = failureDto(run.failure);
  const durationMs = elapsedMsOrUndefined(run.startedAt, finishedAt);
  return {
    runId: run.id,
    workflowId: identity.workflowId,
    workflowScope: identity.scope.kind,
    revisionId: run.revisionId,
    ...(run.rerunOfRunId === undefined ? {} : { rerunOfRunId: run.rerunOfRunId }),
    ...(run.recoveryOfRunId === undefined
      ? {}
      : {
          recoveryOfRunId: run.recoveryOfRunId,
          recoveryMode: run.recoveryMode,
        }),
    cwd: basename(run.canonicalCwd) || "workspace",
    status: run.status,
    startedAt: run.startedAt,
    ...(run.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: run.cancelRequestedAt }),
    ...(waitingForApproval ? { waitingForApproval: true } : {}),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined ? {} : { failure }),
  };
};

const storedRevision = (
  revision: WorkflowRevisionRecord,
  plan: ExecutionPlan,
): StoredWorkflowRevisionDto => ({
  revisionId: revision.id,
  workflowScope: revision.scope.kind,
  contentHash: revision.contentHash,
  createdAt: revision.createdAt,
  workflow: workflowGraph(plan),
});

const pathForStream = (paths: NodeOutputPaths, stream: OutputStream): string => {
  switch (stream) {
    case "stdout":
      return paths.stdoutPath;
    case "stderr":
      return paths.stderrPath;
    case "result":
      return paths.resultPath;
  }
};

const matchingStoredPaths = (
  dataDirectory: string,
  runId: string,
  node: NodeRunRecord,
): NodeOutputPaths | undefined => {
  if (node.kind !== "agent" || node.outputPaths === undefined) {
    return undefined;
  }
  let expected: NodeOutputPaths;
  try {
    expected = nodeOutputPaths(dataDirectory, runId, node.nodeId, node.ordinal, node.attempt ?? 1);
  } catch {
    return undefined;
  }
  if (
    node.outputPaths.stdoutPath !== expected.stdoutPath ||
    node.outputPaths.stderrPath !== expected.stderrPath ||
    node.outputPaths.resultPath !== expected.resultPath
  ) {
    return undefined;
  }
  return expected;
};

const availableOutputs = async (
  dataDirectory: string,
  runId: string,
  node: NodeRunRecord,
): Promise<OutputStream[]> => {
  if (node.kind !== "agent") {
    return [];
  }
  const paths = matchingStoredPaths(dataDirectory, runId, node);
  if (paths === undefined) {
    return [];
  }
  const streams: OutputStream[] = ["stdout", "stderr", "result"];
  const handles = await Promise.all(
    streams.map(async (stream) =>
      openAuthorizedRunFile(dataDirectory, pathForStream(paths, stream)),
    ),
  );
  await Promise.allSettled(handles.map(async (handle) => handle?.close()));
  return streams.filter((_stream, index) => handles[index] !== undefined);
};

const agentNodeRunDto = async (
  dataDirectory: string,
  runId: string,
  node: AgentNodeRunRecord,
  declaration: AgentNode,
  plannedNode: PlannedNode,
): Promise<NodeRunDto> => {
  const finishedAt = node.finishedAt;
  const failure = failureDto(node.failure);
  const durationMs =
    node.startedAt === undefined ? undefined : elapsedMsOrUndefined(node.startedAt, finishedAt);
  return {
    kind: "agent",
    executionId: plannedNode.executionId,
    nodeId: plannedNode.nodeId,
    ordinal: node.ordinal,
    ...(plannedNode.loopNodeId === undefined ? {} : { loopNodeId: plannedNode.loopNodeId }),
    ...(plannedNode.iteration === undefined ? {} : { iteration: plannedNode.iteration }),
    runtime: declaration.runtime,
    ...(node.requestedModel === undefined ? {} : { requestedModel: node.requestedModel }),
    ...(node.effectiveModel === undefined ? {} : { effectiveModel: node.effectiveModel }),
    ...(node.runtimeVersion === undefined ? {} : { runtimeVersion: node.runtimeVersion }),
    ...(node.outputType === undefined ? {} : { outputType: node.outputType }),
    ...(node.artifactPath === undefined ? {} : { artifactPath: node.artifactPath }),
    status: node.status,
    ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(node.exitCode === undefined ? {} : { exitCode: node.exitCode }),
    ...(node.process === undefined ? {} : { pid: node.process.pid }),
    ...(failure === undefined ? {} : { failure }),
    availableOutputs: await availableOutputs(dataDirectory, runId, node),
  };
};

const approvalNodeRunDto = (
  node: ApprovalNodeRunRecord,
  declaration: ApprovalNode,
  plannedNode: PlannedNode,
): NodeRunDto => {
  const finishedAt = node.finishedAt;
  const failure = failureDto(node.failure);
  const durationMs =
    node.requestedAt === undefined ? undefined : elapsedMsOrUndefined(node.requestedAt, finishedAt);
  return {
    kind: "approval",
    executionId: plannedNode.executionId,
    nodeId: plannedNode.nodeId,
    ordinal: node.ordinal,
    ...(plannedNode.loopNodeId === undefined ? {} : { loopNodeId: plannedNode.loopNodeId }),
    ...(plannedNode.iteration === undefined ? {} : { iteration: plannedNode.iteration }),
    question: declaration.question,
    status: node.status,
    ...(node.requestedAt === undefined ? {} : { requestedAt: node.requestedAt }),
    ...(node.deadlineAt === undefined ? {} : { deadlineAt: node.deadlineAt }),
    ...(node.decision === undefined ? {} : { decision: node.decision }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined ? {} : { failure }),
    availableOutputs: [],
  };
};

const loopNodeRunDto = (node: LoopNodeRunRecord, plannedNode: PlannedNode): NodeRunDto => {
  const finishedAt = node.finishedAt;
  const failure = failureDto(node.failure);
  const durationMs =
    node.startedAt === undefined ? undefined : elapsedMsOrUndefined(node.startedAt, finishedAt);
  return {
    kind: "loop",
    executionId: plannedNode.executionId,
    nodeId: plannedNode.nodeId,
    ordinal: node.ordinal,
    status: node.status,
    ...(node.startedAt === undefined ? {} : { startedAt: node.startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined ? {} : { failure }),
    availableOutputs: [],
  };
};

const storedRunCorruption = (): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    "The stored run nodes do not match their immutable workflow revision. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
  );

const awaitingApprovalDecision = (
  run: Pick<WorkflowRunRecord, "status" | "cancelRequestedAt">,
  waitingApprovalCount: number,
  undecidedWaitingApprovalCount: number,
): boolean => {
  if (waitingApprovalCount > 1) {
    throw storedRunCorruption();
  }
  return (
    run.status === "running" &&
    run.cancelRequestedAt === undefined &&
    undecidedWaitingApprovalCount === 1
  );
};

const runAwaitingApprovalDecision = (
  run: WorkflowRunRecord,
  nodes: readonly NodeRunRecord[],
): boolean => {
  const waitingApprovals = waitingApprovalNodes(nodes);
  return awaitingApprovalDecision(
    run,
    waitingApprovals.length,
    waitingApprovals.filter(isApprovalAwaitingDecision).length,
  );
};

const assertStoredNodesMatchPlan = (detail: RunDetail, plan: ExecutionPlan): void => {
  if (detail.nodes.length !== plan.nodes.length) {
    throw storedRunCorruption();
  }
  for (let index = 0; index < plan.nodes.length; index += 1) {
    const plannedNode = plan.nodes[index];
    const storedNode = detail.nodes[index];
    if (
      plannedNode === undefined ||
      storedNode === undefined ||
      storedNode.runId !== detail.run.id ||
      storedNode.nodeId !== plannedNode.executionId ||
      storedNode.ordinal !== plannedNode.ordinal ||
      storedNode.kind !== plannedNode.node.kind ||
      storedNode.bodyNodeId !==
        (plannedNode.loopNodeId === undefined ? undefined : plannedNode.nodeId) ||
      storedNode.loopNodeId !== plannedNode.loopNodeId ||
      storedNode.iteration !== plannedNode.iteration
    ) {
      throw storedRunCorruption();
    }
    if (storedNode.kind === "agent" && plannedNode.node.kind === "agent") {
      const output = plannedNode.node.output;
      if (
        storedNode.runtime !== plannedNode.node.runtime ||
        storedNode.requestedModel !== plannedNode.node.model ||
        storedNode.outputType !== output?.type ||
        storedNode.artifactPath !== (output?.type === "artifact" ? output.path : undefined)
      ) {
        throw storedRunCorruption();
      }
    }
    if (
      storedNode.kind === "loop" &&
      plannedNode.node.kind === "loop" &&
      storedNode.status === "succeeded" &&
      storedNode.outputType !== plannedNode.node.output.type
    ) {
      throw storedRunCorruption();
    }
  }
  const executionKinds = new Map(
    plan.nodes.map(({ executionId, node }) => [executionId, node.kind] as const),
  );
  for (const attempt of detail.attempts ?? []) {
    if (attempt.runId !== detail.run.id || executionKinds.get(attempt.nodeId) !== "agent") {
      throw storedRunCorruption();
    }
  }
  if ((detail.workspaces ?? []).some(({ runId }) => runId !== detail.run.id)) {
    throw storedRunCorruption();
  }
};

const nodeRunDto = async (
  dataDirectory: string,
  runId: string,
  node: NodeRunRecord,
  plannedNode: PlannedNode,
): Promise<NodeRunDto> => {
  if (node.kind === "approval" && plannedNode.node.kind === "approval") {
    return approvalNodeRunDto(node, plannedNode.node, plannedNode);
  }
  if (node.kind === "agent" && plannedNode.node.kind === "agent") {
    return agentNodeRunDto(dataDirectory, runId, node, plannedNode.node, plannedNode);
  }
  if (node.kind === "loop" && plannedNode.node.kind === "loop") {
    return loopNodeRunDto(node, plannedNode);
  }
  throw storedRunCorruption();
};

const iterationStatus = (
  executions: readonly Extract<NodeRunDto, { readonly kind: "agent" | "approval" }>[],
): LoopIterationDto["status"] => {
  const statuses = executions.map(({ status }) => status);
  for (const status of ["failed", "interrupted", "cancelled"] as const) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  if (statuses.includes("waiting_for_approval")) {
    return "waiting_for_approval";
  }
  if (statuses.includes("running")) {
    return "running";
  }
  if (statuses.every((status) => status === "succeeded")) {
    return "succeeded";
  }
  if (statuses.every((status) => status === "succeeded" || status === "skipped")) {
    return "skipped";
  }
  return "pending";
};

const loopIterations = (nodes: readonly NodeRunDto[]): LoopIterationDto[] => {
  const groups = new Map<string, Extract<NodeRunDto, { kind: "agent" | "approval" }>[]>();
  for (const node of nodes) {
    if (
      (node.kind !== "agent" && node.kind !== "approval") ||
      node.loopNodeId === undefined ||
      node.iteration === undefined
    ) {
      continue;
    }
    const key = `${node.loopNodeId}\u0000${String(node.iteration)}`;
    const executions = groups.get(key) ?? [];
    executions.push(node);
    groups.set(key, executions);
  }
  return Array.from(groups.values()).map((executions) => {
    const first = executions[0];
    if (first?.loopNodeId === undefined || first.iteration === undefined) {
      throw storedRunCorruption();
    }
    return {
      loopNodeId: first.loopNodeId,
      iteration: first.iteration,
      status: iterationStatus(executions),
      executions,
    };
  });
};

const attemptDto = (attempt: NodeAttemptRecord): ViewerNodeAttemptDto => {
  const finishedAt = attempt.finishedAt;
  const durationMs = elapsedMsOrUndefined(attempt.startedAt, finishedAt);
  const failure = failureDto(attempt.failure);
  return {
    executionId: attempt.nodeId,
    attempt: attempt.attempt,
    status: attempt.status,
    startedAt: attempt.startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(attempt.exitCode === undefined ? {} : { exitCode: attempt.exitCode }),
    ...(failure === undefined ? {} : { failure }),
  };
};

const workspaceDto = (workspace: RunWorkspaceRecord): ViewerWorkspaceDto => ({
  workspaceId: workspace.workspaceId,
  baseCommit: workspace.baseCommit,
  status: workspace.status,
  createdAt: workspace.createdAt,
});

const invalidWorkflow = (error: KilinError): CurrentWorkflowResponse => {
  const diagnostic: WorkflowDiagnosticDto = {
    code: error.code,
    message: error.message,
    severity: "error",
    ...(error.path === undefined ? {} : { path: error.path }),
  };
  return { outputVersion, state: "invalid", diagnostics: [diagnostic] };
};

const outputUnavailable = (): KilinError =>
  new KilinError(
    "RUN_NOT_FOUND",
    "The selected captured output is unavailable. Choose an output listed for this run and try again.",
  );

export class ViewerApplication {
  readonly #definitionFile: string;
  readonly #dataDirectory: string;
  readonly #scope: ViewerScope;

  public constructor(options: ViewerApplicationOptions) {
    this.#definitionFile = options.definitionFile;
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#scope = {
      identity: options.identity,
      canonicalCwd: options.canonicalCwd,
    };
  }

  public get scope(): ViewerScope {
    return this.#scope;
  }

  public async currentWorkflow(): Promise<CurrentWorkflowResponse> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.#definitionFile);
    } catch {
      return invalidWorkflow(
        new KilinError(
          "WORKFLOW_SOURCE_NOT_FOUND",
          "The workflow source could not be read. Restore the file or close and restart the viewer.",
        ),
      );
    }
    try {
      const definition = parseWorkflowBytes(bytes, "Workflow source");
      await resolveJsonOutputSchemas(definition, dirname(this.#definitionFile));
      const plan = compileWorkflow(definition);
      if (plan.definition.workflow.id !== this.#scope.identity.workflowId) {
        return invalidWorkflow(
          new KilinError(
            "WORKFLOW_GRAPH_INVALID",
            `The workflow ID changed from "${this.#scope.identity.workflowId}" to "${plan.definition.workflow.id}". Restart the viewer to inspect a different workflow.`,
            "workflow.id",
          ),
        );
      }
      return {
        outputVersion,
        state: "valid",
        contentHash: plan.contentHash,
        workflow: workflowGraph(plan),
        diagnostics: [],
      };
    } catch (error: unknown) {
      if (error instanceof KilinError) {
        return invalidWorkflow(error);
      }
      throw error;
    }
  }

  public runList(records: readonly ViewerRunListRecord[]): ScopedRunListResponse {
    const runs = records
      .filter(
        (record) =>
          sameWorkflowIdentity(
            { scope: record.scope, workflowId: record.workflowId },
            this.#scope.identity,
          ) && record.canonicalCwd === this.#scope.canonicalCwd,
      )
      .slice(0, 50)
      .map((record) =>
        runSummary(
          record,
          { scope: record.scope, workflowId: record.workflowId },
          awaitingApprovalDecision(
            record,
            record.waitingApprovalCount,
            record.undecidedWaitingApprovalCount,
          ),
        ),
      );
    return {
      outputVersion,
      workflowId: this.#scope.identity.workflowId,
      workflowScope: this.#scope.identity.scope.kind,
      runs,
    };
  }

  public async runDetail(
    detail: RunDetail,
    lineageDetails: readonly RunDetail[],
  ): Promise<ScopedRunDetailResponse> {
    const plan = this.#assertRunScope(detail);
    const lineageRuns = lineageDetails.map((lineageDetail) => {
      this.#assertRunScope(lineageDetail);
      return runSummary(
        lineageDetail.run,
        {
          scope: lineageDetail.revision.scope,
          workflowId: lineageDetail.revision.workflowId,
        },
        runAwaitingApprovalDecision(lineageDetail.run, lineageDetail.nodes),
      );
    });
    const selectedRunIndex = lineageRuns.findIndex(({ runId }) => runId === detail.run.id);
    if (selectedRunIndex === -1) {
      throw new KilinError(
        "INTERNAL_ERROR",
        "The selected run is missing from its stored lineage. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.",
      );
    }
    const lineage: RunLineageDto = { runs: lineageRuns, selectedRunIndex };
    const nodes = await Promise.all(
      detail.nodes.map(async (node, index) => {
        const plannedNode = plan.nodes[index];
        if (plannedNode === undefined) {
          throw storedRunCorruption();
        }
        return nodeRunDto(this.#dataDirectory, detail.run.id, node, plannedNode);
      }),
    );
    return {
      outputVersion,
      workflowId: this.#scope.identity.workflowId,
      workflowScope: this.#scope.identity.scope.kind,
      run: runSummary(
        detail.run,
        {
          scope: detail.revision.scope,
          workflowId: detail.revision.workflowId,
        },
        runAwaitingApprovalDecision(detail.run, detail.nodes),
      ),
      revision: storedRevision(detail.revision, plan),
      nodes,
      loopIterations: loopIterations(nodes),
      attempts: (detail.attempts ?? []).map(attemptDto),
      workspaces: (detail.workspaces ?? []).map(workspaceDto),
      lineage,
    };
  }

  public async output(
    detail: RunDetail,
    ordinal: number,
    stream: OutputStream,
  ): Promise<BoundedOutputResponse> {
    const plan = this.#assertRunScope(detail);
    const node = detail.nodes.find((candidate) => candidate.ordinal === ordinal);
    if (node?.kind !== "agent") {
      throw outputUnavailable();
    }
    const paths = matchingStoredPaths(this.#dataDirectory, detail.run.id, node);
    if (paths === undefined) {
      throw outputUnavailable();
    }
    const path = pathForStream(paths, stream);
    const handle = await openAuthorizedRunFile(this.#dataDirectory, path);
    if (handle === undefined) {
      throw outputUnavailable();
    }
    try {
      const metadata = await handle.stat();
      const start = Math.max(0, metadata.size - outputTailBytes);
      const requestedBytes = metadata.size - start;
      const buffer = Buffer.alloc(requestedBytes);
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, start);
      const response: BoundedOutputResponse = {
        outputVersion,
        runId: detail.run.id,
        ordinal,
        stream,
        text: new TextDecoder().decode(buffer.subarray(0, bytesRead)),
        totalBytes: metadata.size,
        returnedBytes: bytesRead,
        truncated: start > 0,
      };
      const plannedNode = plan.nodes.find((candidate) => candidate.ordinal === ordinal);
      if (
        stream === "result" &&
        !response.truncated &&
        plannedNode?.node.kind === "agent" &&
        plannedNode.node.output?.type === "decision_packet"
      ) {
        const packet = tryParseDecisionPacket(response.text);
        if (packet !== undefined) {
          return { ...response, decisionPacket: packet };
        }
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof KilinError) {
        throw error;
      }
      throw outputUnavailable();
    } finally {
      await handle.close();
    }
  }

  #assertRunScope(detail: RunDetail): ExecutionPlan {
    if (
      !sameWorkflowIdentity(
        { scope: detail.revision.scope, workflowId: detail.revision.workflowId },
        this.#scope.identity,
      ) ||
      detail.run.canonicalCwd !== this.#scope.canonicalCwd ||
      detail.run.revisionId !== detail.revision.id
    ) {
      throw new KilinError(
        "RUN_NOT_FOUND",
        "The selected run is not available in this viewer. Choose a run shown in this viewer and try again.",
      );
    }
    const plan = compileStoredWorkflowRevision(detail.revision);
    assertStoredNodesMatchPlan(detail, plan);
    return plan;
  }
}
