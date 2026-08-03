import { link, mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ViewerApplication } from "../../src/application/viewer.js";
import type { ViewerRunListRecord } from "../../src/application/viewer.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type { NodeRunRecord, RunDetail, WorkflowRunRecord } from "../../src/domain/run-state.js";
import type { ExecutionPlan, WorkflowDefinitionV1 } from "../../src/domain/workflow.js";
import { nodeOutputPaths, prepareNodeOutput } from "../../src/infrastructure/process-runner.js";
import { StateStore } from "../../src/infrastructure/state-store.js";
import { decisionPacketFixture, decisionPacketJson } from "../fixtures/decision-packet.js";

const temporaryDirectories: string[] = [];

const defaultDefinition = (): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "viewer-workflow", name: "Viewer workflow" },
  nodes: [
    {
      id: "inspect",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      prompt: "Inspect the project",
    },
    {
      id: "verify",
      kind: "agent",
      runtime: "opencode",
      access: "workspace_write",
      prompt: "Verify the result",
    },
  ],
  edges: [{ from: "inspect", to: "verify" }],
});

const approvalDefinition = (): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "viewer-workflow", name: "Viewer workflow" },
  nodes: [
    {
      id: "inspect",
      kind: "agent",
      runtime: "codex",
      access: "workspace_write",
      prompt: "Inspect the project",
      model: "gpt-5",
      output: { type: "artifact", path: "reports/inspection.md" },
    },
    { id: "approve", kind: "approval", question: "Apply the inspected change?" },
    {
      id: "verify",
      kind: "agent",
      runtime: "claude-code",
      access: "read_only",
      prompt: "Verify the result",
      output: { type: "json" },
    },
  ],
  edges: [
    { from: "inspect", to: "approve" },
    { from: "inspect", to: "verify", input: "inspection" },
    { from: "approve", to: "verify" },
  ],
});

const decisionPacketDefinition = (
  outputType: "decision_packet" | "json" = "decision_packet",
): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "viewer-workflow", name: "Viewer workflow" },
  nodes: [
    {
      id: "judge",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      prompt: "Produce a business judgment",
      output: { type: outputType },
    },
  ],
  edges: [],
});

const twoGateDefinition = (): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "viewer-workflow", name: "Viewer workflow" },
  nodes: [
    { id: "gate-one", kind: "approval", question: "Approve the first gate?" },
    { id: "gate-two", kind: "approval", question: "Approve the second gate?" },
  ],
  edges: [],
});

const loopDefinition = (): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "viewer-workflow", name: "Viewer workflow" },
  nodes: [
    {
      id: "refine",
      kind: "loop",
      maxIterations: 2,
      body: {
        nodes: [
          {
            id: "draft",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Draft the bounded result",
            output: { type: "text" },
          },
          {
            id: "judge",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Judge the draft",
            output: { type: "choice", choices: ["pass", "revise"] },
          },
        ],
        edges: [{ from: "draft", to: "judge", input: "candidate" }],
      },
      decision: { node: "judge", passChoice: "pass", reviseChoice: "revise" },
      feedback: { from: "draft", to: "draft", input: "prior_feedback" },
      result: { node: "draft" },
    },
  ],
  edges: [],
});

const createFixture = async (
  definition = defaultDefinition(),
): Promise<{
  application: ViewerApplication;
  cwd: string;
  dataDirectory: string;
  plan: ExecutionPlan;
  workflowFile: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-viewer-application-"));
  temporaryDirectories.push(root);
  const cwd = join(root, "project", "workspace");
  const dataDirectory = join(root, "state");
  const workflowFile = join(root, "workflow.yaml");
  const projectRoot = join(root, "project");
  await mkdir(cwd, { recursive: true });
  const plan = compileWorkflow(definition);
  await writeFile(workflowFile, JSON.stringify(definition), "utf8");
  return {
    application: new ViewerApplication({
      definitionFile: workflowFile,
      identity: {
        scope: { kind: "project", root: projectRoot },
        workflowId: definition.workflow.id,
      },
      canonicalCwd: cwd,
      dataDirectory,
    }),
    cwd,
    dataDirectory,
    plan,
    workflowFile,
  };
};

const runRecord = (
  plan: ExecutionPlan,
  cwd: string,
  id: string,
  rerunOfRunId?: string,
): WorkflowRunRecord => ({
  id,
  revisionId: `revision-${plan.contentHash}`,
  ...(rerunOfRunId === undefined ? {} : { rerunOfRunId }),
  canonicalCwd: cwd,
  options: {
    nodeTimeoutMs: 60_000,
    approvalTimeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    maxParallel: 1,
  },
  status: "succeeded",
  startedAt: "2026-07-21T01:00:00.000Z",
  finishedAt: "2026-07-21T01:00:02.000Z",
});

const runDetail = (
  plan: ExecutionPlan,
  cwd: string,
  id = "run-one",
  rerunOfRunId?: string,
): RunDetail => ({
  run: runRecord(plan, cwd, id, rerunOfRunId),
  revision: {
    id: `revision-${plan.contentHash}`,
    scope: { kind: "project", root: dirname(cwd) },
    workflowId: plan.definition.workflow.id,
    schemaVersion: plan.authoredDefinition.schemaVersion,
    contentHash: plan.contentHash,
    normalizedDefinition: plan.normalizedDefinition,
    createdAt: "2026-07-21T01:00:00.000Z",
  },
  nodes: plan.nodes.map(
    ({ node, ordinal, executionId, nodeId, loopNodeId, iteration }): NodeRunRecord => {
      const provenance = {
        ...(loopNodeId === undefined ? {} : { bodyNodeId: nodeId, loopNodeId }),
        ...(iteration === undefined ? {} : { iteration }),
      };
      if (node.kind === "loop") {
        return {
          kind: "loop",
          runId: id,
          nodeId: executionId,
          ordinal,
          outputType: node.output.type,
          status: "pending",
        };
      }
      if (node.kind === "approval") {
        return {
          kind: "approval",
          runId: id,
          nodeId: executionId,
          ordinal,
          ...provenance,
          status: "pending",
        };
      }
      return {
        kind: "agent",
        runId: id,
        nodeId: executionId,
        ordinal,
        ...provenance,
        runtime: node.runtime,
        ...(node.model === undefined ? {} : { requestedModel: node.model }),
        ...(node.output === undefined ? {} : { outputType: node.output.type }),
        ...(node.output?.type === "artifact" ? { artifactPath: node.output.path } : {}),
        status: "succeeded",
        startedAt: "2026-07-21T01:00:00.000Z",
        finishedAt: "2026-07-21T01:00:01.000Z",
        exitCode: 0,
      };
    },
  ),
});

const viewerListRecord = (
  run: WorkflowRunRecord,
  waitingApprovalCount = 0,
  undecidedWaitingApprovalCount = 0,
): ViewerRunListRecord => ({
  ...run,
  scope: { kind: "project", root: dirname(run.canonicalCwd) },
  workflowId: "viewer-workflow",
  waitingApprovalCount,
  undecidedWaitingApprovalCount,
});

const waitingRunDetail = (plan: ExecutionPlan, cwd: string, id: string): RunDetail => {
  const detail = runDetail(plan, cwd, id);
  detail.run.status = "running";
  delete detail.run.finishedAt;
  const approval = detail.nodes.find((node) => node.kind === "approval");
  if (approval?.kind !== "approval") {
    throw new Error("Expected an approval node");
  }
  approval.status = "waiting_for_approval";
  approval.requestedAt = "2026-07-21T01:00:00.500Z";
  approval.deadlineAt = "2026-07-21T01:01:00.500Z";
  return detail;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("ViewerApplication workflow and run projections", () => {
  it("shows the current compiled graph, validation diagnostics, and a changed-workflow boundary", async () => {
    const { application, workflowFile } = await createFixture();

    const valid = await application.currentWorkflow();
    expect(valid).toMatchObject({
      outputVersion: 1,
      state: "valid",
      workflow: {
        workflowId: "viewer-workflow",
        executionOrder: ["inspect", "verify"],
        edges: [{ from: "inspect", to: "verify" }],
      },
    });
    if (valid.state === "valid") {
      expect(valid.workflow.nodes).toMatchObject([
        { id: "inspect", kind: "agent", runtime: "codex" },
        { id: "verify", kind: "agent", runtime: "opencode" },
      ]);
      expect(valid.workflow.nodes.map(({ id, dependencies }) => ({ id, dependencies }))).toEqual([
        { id: "inspect", dependencies: [] },
        { id: "verify", dependencies: ["inspect"] },
      ]);
    }

    await writeFile(workflowFile, "schemaVersion: [", "utf8");
    const invalid = await application.currentWorkflow();
    expect(invalid).toMatchObject({ state: "invalid", diagnostics: [{ severity: "error" }] });
    expect(JSON.stringify(invalid)).not.toContain(workflowFile);

    const changed = {
      schemaVersion: 1,
      workflow: { id: "different-workflow", name: "Different" },
      nodes: [
        {
          id: "inspect",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Inspect",
        },
      ],
      edges: [],
    };
    await writeFile(workflowFile, JSON.stringify(changed), "utf8");
    expect(await application.currentWorkflow()).toMatchObject({
      state: "invalid",
      diagnostics: [{ code: "WORKFLOW_GRAPH_INVALID", path: "workflow.id" }],
    });
  });

  it("presents top-level nodes in dependency order regardless of authored order", async () => {
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      workflow: { id: "viewer-workflow", name: "Viewer workflow" },
      nodes: [
        {
          id: "consumer",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Consume the result",
        },
        {
          id: "producer",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Produce the result",
        },
      ],
      edges: [{ from: "producer", to: "consumer" }],
    };
    const { application } = await createFixture(definition);

    const current = await application.currentWorkflow();

    expect(current).toMatchObject({
      state: "valid",
      workflow: {
        executionOrder: ["producer", "consumer"],
        nodes: [
          { id: "consumer", ordinal: 1 },
          { id: "producer", ordinal: 0 },
        ],
      },
    });
  });

  it("scopes run lists and details without exposing absolute persistence paths", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture();
    const selected = runDetail(plan, cwd);
    const otherCwd = runRecord(plan, "/private/other-workspace", "other-cwd");
    const otherWorkflow: ViewerRunListRecord = {
      ...runRecord(plan, cwd, "other-workflow"),
      scope: { kind: "project", root: dirname(cwd) },
      workflowId: "different-workflow",
      waitingApprovalCount: 0,
      undecidedWaitingApprovalCount: 0,
    };
    const userScoped: ViewerRunListRecord = {
      ...runRecord(plan, cwd, "user-scoped"),
      scope: { kind: "user" },
      workflowId: "viewer-workflow",
      waitingApprovalCount: 0,
      undecidedWaitingApprovalCount: 0,
    };
    const otherProjectScoped: ViewerRunListRecord = {
      ...runRecord(plan, cwd, "other-project-scoped"),
      scope: { kind: "project", root: dirname(dirname(cwd)) },
      workflowId: "viewer-workflow",
      waitingApprovalCount: 0,
      undecidedWaitingApprovalCount: 0,
    };
    const records: ViewerRunListRecord[] = [
      viewerListRecord(selected.run),
      {
        ...otherCwd,
        scope: { kind: "project", root: dirname(cwd) },
        workflowId: "viewer-workflow",
        waitingApprovalCount: 0,
        undecidedWaitingApprovalCount: 0,
      },
      otherWorkflow,
      userScoped,
      otherProjectScoped,
    ];

    const list = application.runList(records);
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ runId: "run-one", cwd: "workspace", durationMs: 2_000 });
    expect(JSON.stringify(list)).not.toContain(cwd);
    expect(JSON.stringify(list)).not.toContain(dataDirectory);

    const detail = await application.runDetail(selected, [selected]);
    expect(detail).toMatchObject({
      workflowId: "viewer-workflow",
      run: { runId: "run-one", cwd: "workspace" },
      revision: { workflow: { executionOrder: ["inspect", "verify"] } },
      lineage: { selectedRunIndex: 0 },
    });
    expect(JSON.stringify(detail)).not.toContain(cwd);
    expect(JSON.stringify(detail)).not.toContain(dataDirectory);

    const source = runDetail(plan, cwd, "source");
    const retry = runDetail(plan, cwd, "retry");
    retry.run.recoveryOfRunId = source.run.id;
    retry.run.recoveryMode = "retry";
    retry.run.cancelRequestedAt = "2026-07-21T01:00:01.500Z";
    retry.attempts = [
      {
        runId: retry.run.id,
        nodeId: "inspect",
        attempt: 1,
        status: "succeeded",
        startedAt: "2026-07-21T01:00:00.000Z",
        finishedAt: "2026-07-21T01:00:01.000Z",
        exitCode: 0,
        outputPaths: nodeOutputPaths(dataDirectory, retry.run.id, "inspect", 0),
      },
    ];
    retry.workspaces = [
      {
        runId: retry.run.id,
        workspaceId: "changes",
        path: join(cwd, ".kilin", "worktrees", "changes"),
        baseCommit: "0123456789abcdef",
        status: "provisioned",
        createdAt: "2026-07-21T01:00:00.000Z",
      },
    ];
    expect(await application.runDetail(retry, [source, retry])).toMatchObject({
      run: {
        recoveryOfRunId: "source",
        recoveryMode: "retry",
        cancelRequestedAt: "2026-07-21T01:00:01.500Z",
      },
      attempts: [
        {
          executionId: "inspect",
          attempt: 1,
          status: "succeeded",
          durationMs: 1_000,
        },
      ],
      workspaces: [
        {
          workspaceId: "changes",
          baseCommit: "0123456789abcdef",
          status: "provisioned",
        },
      ],
      lineage: {
        selectedRunIndex: 1,
        runs: [{ runId: "source" }, { runId: "retry", recoveryOfRunId: "source" }],
      },
    });
    expect(JSON.stringify(await application.runDetail(retry, [source, retry]))).not.toContain(
      ".kilin/worktrees",
    );
    const invalidLineage = runDetail(plan, cwd, "invalid-lineage", source.run.id);
    invalidLineage.run.recoveryOfRunId = source.run.id;
    invalidLineage.run.recoveryMode = "resume";
    await expect(application.runDetail(invalidLineage, [invalidLineage])).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });

    const outOfScope = runDetail(plan, "/private/other-workspace", "hidden");
    await expect(application.runDetail(outOfScope, [outOfScope])).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    const userScopedDetail = runDetail(plan, cwd, "user-scoped-detail");
    userScopedDetail.revision.scope = { kind: "user" };
    await expect(application.runDetail(userScopedDetail, [userScopedDetail])).rejects.toMatchObject(
      { code: "RUN_NOT_FOUND" },
    );
    const otherProjectDetail = runDetail(plan, cwd, "other-project-detail");
    otherProjectDetail.revision.scope = {
      kind: "project",
      root: dirname(dirname(cwd)),
    };
    await expect(
      application.runDetail(otherProjectDetail, [otherProjectDetail]),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  });

  it("marks only a running run with one undecided waiting approval as waiting", async () => {
    const { application, cwd, plan } = await createFixture();
    const runningRecord = (id: string): WorkflowRunRecord => {
      const record = runRecord(plan, cwd, id);
      record.status = "running";
      delete record.finishedAt;
      return record;
    };
    const cancelRequested = runningRecord("cancel-requested");
    cancelRequested.cancelRequestedAt = "2026-07-21T01:00:01.000Z";

    const list = application.runList([
      viewerListRecord(runningRecord("waiting-undecided"), 1, 1),
      viewerListRecord(runningRecord("decided-waiting"), 1, 0),
      viewerListRecord(runningRecord("plain-running"), 0, 0),
      viewerListRecord(cancelRequested, 1, 1),
      viewerListRecord(runRecord(plan, cwd, "terminal"), 1, 1),
    ]);

    const runsById = new Map(list.runs.map((run) => [run.runId, run]));
    expect(runsById.get("waiting-undecided")).toMatchObject({ waitingForApproval: true });
    for (const runId of ["decided-waiting", "plain-running", "cancel-requested", "terminal"]) {
      expect(runsById.get(runId)).toBeDefined();
      expect(runsById.get(runId)).not.toHaveProperty("waitingForApproval");
    }
  });

  it("fails closed when a listed run reports more than one waiting approval", async () => {
    const { application, cwd, plan } = await createFixture();
    const damaged = runRecord(plan, cwd, "damaged");
    damaged.status = "running";
    delete damaged.finishedAt;

    expect(() => application.runList([viewerListRecord(damaged, 2, 1)])).toThrowError(KilinError);
    expect(() => application.runList([viewerListRecord(damaged, 2, 1)])).toThrow(
      "damaged local state",
    );
  });

  it("derives the waiting flag for the open run and each lineage entry from stored nodes", async () => {
    const { application, cwd, plan } = await createFixture(approvalDefinition());
    const decidedSource = waitingRunDetail(plan, cwd, "source");
    const decidedGate = decidedSource.nodes.find((node) => node.kind === "approval");
    if (decidedGate?.kind !== "approval") {
      throw new Error("Expected an approval node");
    }
    decidedGate.decision = {
      decision: "approve",
      actor: "human",
      decidedAt: "2026-07-21T01:00:02.000Z",
    };
    const waitingRetry = waitingRunDetail(plan, cwd, "retry");
    waitingRetry.run.rerunOfRunId = decidedSource.run.id;

    const projected = await application.runDetail(waitingRetry, [decidedSource, waitingRetry]);

    expect(projected.run).toMatchObject({ runId: "retry", waitingForApproval: true });
    expect(projected.lineage.selectedRunIndex).toBe(1);
    expect(projected.lineage.runs[0]).toMatchObject({ runId: "source" });
    expect(projected.lineage.runs[0]).not.toHaveProperty("waitingForApproval");
    expect(projected.lineage.runs[1]).toMatchObject({ runId: "retry", waitingForApproval: true });
  });

  it("keeps the flag absent for decided, cancel-requested, and terminal waiting gates", async () => {
    const { application, cwd, plan } = await createFixture(approvalDefinition());
    const decided = waitingRunDetail(plan, cwd, "decided");
    const decidedGate = decided.nodes.find((node) => node.kind === "approval");
    if (decidedGate?.kind !== "approval") {
      throw new Error("Expected an approval node");
    }
    decidedGate.decision = {
      decision: "reject",
      actor: "human",
      decidedAt: "2026-07-21T01:00:02.000Z",
    };
    const cancelRequested = waitingRunDetail(plan, cwd, "cancel-requested");
    cancelRequested.run.cancelRequestedAt = "2026-07-21T01:00:01.000Z";
    const terminal = waitingRunDetail(plan, cwd, "terminal");
    terminal.run.status = "succeeded";
    terminal.run.finishedAt = "2026-07-21T01:00:02.000Z";

    for (const detail of [decided, cancelRequested, terminal]) {
      const projected = await application.runDetail(detail, [detail]);
      expect(projected.run).not.toHaveProperty("waitingForApproval");
      expect(projected.lineage.runs[0]).not.toHaveProperty("waitingForApproval");
    }
  });

  it("fails closed when stored nodes hold more than one waiting approval", async () => {
    const { application, cwd, plan } = await createFixture(twoGateDefinition());
    const detail = runDetail(plan, cwd);
    detail.run.status = "running";
    delete detail.run.finishedAt;
    for (const node of detail.nodes) {
      if (node.kind === "approval") {
        node.status = "waiting_for_approval";
        node.requestedAt = "2026-07-21T01:00:00.500Z";
        node.deadlineAt = "2026-07-21T01:01:00.500Z";
      }
    }

    await expect(application.runDetail(detail, [detail])).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("projects typed agents, input edges, and terminal approval state without private paths", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture(approvalDefinition());
    const selected = runDetail(plan, cwd);
    const inspect = selected.nodes[0];
    const approval = selected.nodes[1];
    if (inspect?.kind !== "agent" || approval?.kind !== "approval") {
      throw new Error("Expected mixed viewer fixture nodes");
    }
    inspect.outputPaths = nodeOutputPaths(
      dataDirectory,
      selected.run.id,
      inspect.nodeId,
      inspect.ordinal,
    );
    inspect.resolvedInputsPath = join(dataDirectory, "private", "resolved-inputs.json");
    selected.nodes[1] = {
      ...approval,
      status: "succeeded",
      requestedAt: "2026-07-21T01:00:00.250Z",
      deadlineAt: "2026-07-21T01:01:00.250Z",
      decision: {
        decision: "approve",
        actor: "human",
        decidedAt: "2026-07-21T01:00:01.000Z",
        note: "Reviewed locally",
      },
      finishedAt: "2026-07-21T01:00:02.750Z",
    };

    const projected = await application.runDetail(selected, [selected]);

    expect(projected.revision.workflow.nodes).toEqual([
      expect.objectContaining({
        id: "inspect",
        kind: "agent",
        outputType: "artifact",
        artifactPath: "reports/inspection.md",
      }),
      {
        id: "approve",
        ordinal: 1,
        kind: "approval",
        question: "Apply the inspected change?",
        dependencies: ["inspect"],
      },
      expect.objectContaining({
        id: "verify",
        kind: "agent",
        runtime: "claude-code",
        outputType: "json",
      }),
    ]);
    expect(projected.revision.workflow.edges).toContainEqual({
      from: "inspect",
      to: "verify",
      input: "inspection",
    });
    expect(projected.nodes).toEqual([
      expect.objectContaining({
        kind: "agent",
        nodeId: "inspect",
        outputType: "artifact",
        artifactPath: "reports/inspection.md",
      }),
      {
        kind: "approval",
        executionId: "approve",
        nodeId: "approve",
        ordinal: 1,
        question: "Apply the inspected change?",
        status: "succeeded",
        requestedAt: "2026-07-21T01:00:00.250Z",
        deadlineAt: "2026-07-21T01:01:00.250Z",
        decision: {
          decision: "approve",
          actor: "human",
          decidedAt: "2026-07-21T01:00:01.000Z",
          note: "Reviewed locally",
        },
        finishedAt: "2026-07-21T01:00:02.750Z",
        durationMs: 2_500,
        availableOutputs: [],
      },
      expect.objectContaining({ kind: "agent", nodeId: "verify", outputType: "json" }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("resolvedInputsPath");
    expect(JSON.stringify(projected)).not.toContain(dataDirectory);
  });

  it("projects one authored loop and groups stored occurrences from explicit scope metadata", async () => {
    const { application, cwd, plan } = await createFixture(loopDefinition());
    const current = await application.currentWorkflow();
    expect(current).toMatchObject({
      state: "valid",
      workflow: {
        executionOrder: ["refine"],
        nodes: [
          {
            id: "refine",
            kind: "loop",
            maxIterations: 2,
            body: {
              nodes: [
                { id: "draft", kind: "agent" },
                { id: "judge", kind: "agent" },
              ],
              edges: [{ from: "draft", to: "judge", input: "candidate" }],
            },
            decision: { nodeId: "judge", passChoice: "pass", reviseChoice: "revise" },
            feedback: {
              fromNodeId: "draft",
              toNodeId: "draft",
              input: "prior_feedback",
            },
            resultNodeId: "draft",
          },
        ],
      },
    });
    if (current.state !== "valid") {
      throw new Error("Expected a valid loop workflow");
    }
    expect(current.workflow.nodes).toHaveLength(1);

    const detail = runDetail(plan, cwd);
    const projected = await application.runDetail(detail, [detail]);
    expect(projected.nodes).toHaveLength(5);
    expect(projected.loopIterations).toHaveLength(2);
    for (const [iteration, group] of projected.loopIterations.entries()) {
      expect(group).toMatchObject({
        loopNodeId: "refine",
        iteration,
        status: "succeeded",
        executions: [
          { nodeId: "draft", loopNodeId: "refine", iteration },
          { nodeId: "judge", loopNodeId: "refine", iteration },
        ],
      });
      expect(group.executions.map(({ executionId }) => executionId)).toEqual(
        plan.loops[0]?.iterations[iteration]?.executionIds,
      );
    }

    const bodyOccurrence = detail.nodes.find(({ bodyNodeId }) => bodyNodeId === "draft");
    if (bodyOccurrence === undefined) {
      throw new Error("Expected a stored loop body occurrence");
    }
    bodyOccurrence.bodyNodeId = "judge";
    await expect(application.runDetail(detail, [detail])).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("projects a mixed succeeded and skipped loop iteration as skipped", async () => {
    const { application, cwd, plan } = await createFixture(loopDefinition());
    const detail = runDetail(plan, cwd);
    const skippedNode = detail.nodes.find(
      (node) => node.bodyNodeId === "draft" && node.iteration === 0,
    );
    if (skippedNode?.kind !== "agent") {
      throw new Error("Expected the first loop body occurrence");
    }
    skippedNode.status = "skipped";
    delete skippedNode.startedAt;
    delete skippedNode.exitCode;

    const projected = await application.runDetail(detail, [detail]);

    expect(projected.loopIterations[0]).toMatchObject({
      loopNodeId: "refine",
      iteration: 0,
      status: "skipped",
      executions: [{ status: "skipped" }, { status: "succeeded" }],
    });
  });

  it("accepts pending and running loop controls decoded from the state store", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture(loopDefinition());
    const store = new StateStore(dataDirectory);
    try {
      const created = store.createRun({
        plan,
        identity: {
          scope: { kind: "project", root: dirname(cwd) },
          workflowId: plan.authoredDefinition.workflow.id,
        },
        canonicalCwd: cwd,
        options: {
          nodeTimeoutMs: 60_000,
          approvalTimeoutMs: 60_000,
          maxOutputBytes: 1_048_576,
          maxParallel: 1,
        },
      });
      const pendingProjection = await application.runDetail(created, [created]);
      expect(pendingProjection.nodes[0]).toMatchObject({
        kind: "loop",
        nodeId: "refine",
        status: "pending",
      });

      store.startLoop(created.run.id, "refine");
      const running = store.getRun(created.run.id);
      const runningProjection = await application.runDetail(running, [running]);
      expect(runningProjection.nodes[0]).toMatchObject({
        kind: "loop",
        nodeId: "refine",
        status: "running",
      });
      const runningLoop = runningProjection.nodes[0];
      if (runningLoop?.kind !== "loop") {
        throw new Error("Expected the running loop control projection");
      }
      expect(typeof runningLoop.startedAt).toBe("string");

      const cancelled = store.createRun({
        plan,
        identity: {
          scope: { kind: "project", root: dirname(cwd) },
          workflowId: plan.authoredDefinition.workflow.id,
        },
        canonicalCwd: cwd,
        options: {
          nodeTimeoutMs: 60_000,
          approvalTimeoutMs: 60_000,
          maxOutputBytes: 1_048_576,
          maxParallel: 1,
        },
      });
      store.requestRunCancellation(cancelled.run.id);
      store.startLoop(cancelled.run.id, "refine");
      const cancelledBeforeAdmission = store.getRun(cancelled.run.id);
      const projected = await application.runDetail(cancelledBeforeAdmission, [
        cancelledBeforeAdmission,
      ]);
      expect(projected.nodes[0]).toMatchObject({
        kind: "loop",
        nodeId: "refine",
        status: "cancelled",
      });
      const cancelledLoop = projected.nodes[0];
      if (cancelledLoop?.kind !== "loop") {
        throw new Error("Expected the cancelled loop control projection");
      }
      expect(typeof cancelledLoop.finishedAt).toBe("string");
      expect(cancelledLoop).not.toHaveProperty("startedAt");
      expect(cancelledLoop).not.toHaveProperty("durationMs");
    } finally {
      store.close();
    }
  });

  it("fails closed when stored run nodes do not match their immutable revision", async () => {
    const { application, cwd, plan } = await createFixture(approvalDefinition());
    const corruptions: ((detail: RunDetail) => void)[] = [
      (detail): void => {
        detail.nodes.pop();
      },
      (detail): void => {
        detail.nodes.reverse();
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node === undefined) throw new Error("Expected a stored node");
        detail.nodes[0] = { ...node, nodeId: "other" };
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node === undefined) throw new Error("Expected a stored node");
        detail.nodes[0] = { ...node, ordinal: 9 };
      },
      (detail): void => {
        detail.nodes[0] = {
          kind: "approval",
          runId: detail.run.id,
          nodeId: "inspect",
          ordinal: 0,
          status: "pending",
        };
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node?.kind === "agent") node.runtime = "opencode";
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node?.kind === "agent") node.requestedModel = "other-model";
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node?.kind === "agent") node.outputType = "json";
      },
      (detail): void => {
        const node = detail.nodes[0];
        if (node?.kind === "agent") node.artifactPath = "reports/other.md";
      },
    ];

    for (const corrupt of corruptions) {
      const detail = runDetail(plan, cwd);
      corrupt(detail);
      await expect(application.runDetail(detail, [detail])).rejects.toMatchObject({
        code: "INTERNAL_ERROR",
      });
    }
  });
});

describe("ViewerApplication captured output", () => {
  it("adds a validated Decision Packet projection only for a matching complete result", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture(
      decisionPacketDefinition(),
    );
    const detail = runDetail(plan, cwd);
    const node = detail.nodes[0];
    if (node?.kind !== "agent") {
      throw new Error("Expected a Decision Packet agent node");
    }
    const paths = nodeOutputPaths(dataDirectory, detail.run.id, node.nodeId, node.ordinal);
    await prepareNodeOutput(paths);
    const raw = decisionPacketJson("VIEWER_PACKET");
    await writeFile(paths.resultPath, raw, "utf8");
    await writeFile(paths.stdoutPath, raw, "utf8");
    node.outputPaths = paths;

    const result = await application.output(detail, node.ordinal, "result");
    const stdout = await application.output(detail, node.ordinal, "stdout");

    expect(result.text).toBe(raw);
    expect(result.decisionPacket).toEqual(decisionPacketFixture("VIEWER_PACKET"));
    expect(stdout.text).toBe(raw);
    expect(stdout).not.toHaveProperty("decisionPacket");
    expect(JSON.stringify(result.decisionPacket)).not.toContain(dataDirectory);
    expect(JSON.stringify(result.decisionPacket)).not.toContain(cwd);
  });

  it.each([
    ["ordinary JSON lookalike", "json", decisionPacketJson("JSON_LOOKALIKE")],
    ["malformed packet", "decision_packet", '{"kind":"decision_packet"'],
    [
      "old packet version",
      "decision_packet",
      JSON.stringify({ ...decisionPacketFixture("OLD_PACKET"), packetVersion: 0 }),
    ],
    [
      "future packet version",
      "decision_packet",
      JSON.stringify({ ...decisionPacketFixture("FUTURE_PACKET"), packetVersion: 2 }),
    ],
    [
      "missing packet field",
      "decision_packet",
      JSON.stringify(
        ((): Partial<ReturnType<typeof decisionPacketFixture>> => {
          const packet = { ...decisionPacketFixture("MISSING_FIELD") } as Partial<
            ReturnType<typeof decisionPacketFixture>
          >;
          delete packet.objective;
          return packet;
        })(),
      ),
    ],
    [
      "unknown packet field",
      "decision_packet",
      JSON.stringify({
        ...decisionPacketFixture("UNKNOWN_FIELD"),
        internalAbsolutePath: "/private/state/secret",
      }),
    ],
  ] as const)("keeps %s on the existing safe output fallback", async (_name, outputType, raw) => {
    const { application, cwd, dataDirectory, plan } = await createFixture(
      decisionPacketDefinition(outputType),
    );
    const detail = runDetail(plan, cwd);
    const node = detail.nodes[0];
    if (node?.kind !== "agent") {
      throw new Error("Expected an agent node");
    }
    const paths = nodeOutputPaths(dataDirectory, detail.run.id, node.nodeId, node.ordinal);
    await prepareNodeOutput(paths);
    await writeFile(paths.resultPath, raw, "utf8");
    node.outputPaths = paths;

    const response = await application.output(detail, node.ordinal, "result");

    expect(response.text).toBe(raw);
    expect(response).not.toHaveProperty("decisionPacket");
  });

  it("does not project a truncated Decision Packet result", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture(
      decisionPacketDefinition(),
    );
    const detail = runDetail(plan, cwd);
    const node = detail.nodes[0];
    if (node?.kind !== "agent") {
      throw new Error("Expected a Decision Packet agent node");
    }
    const paths = nodeOutputPaths(dataDirectory, detail.run.id, node.nodeId, node.ordinal);
    await prepareNodeOutput(paths);
    await writeFile(
      paths.resultPath,
      `${" ".repeat(70_000)}${decisionPacketJson("TRUNCATED_PACKET")}`,
      "utf8",
    );
    node.outputPaths = paths;

    const response = await application.output(detail, node.ordinal, "result");

    expect(response.truncated).toBe(true);
    expect(response).not.toHaveProperty("decisionPacket");
  });

  it("returns only the 64 KiB tail from the exact stored regular output file", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture();
    const detail = runDetail(plan, cwd);
    const node = detail.nodes[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      return;
    }
    const paths = nodeOutputPaths(dataDirectory, detail.run.id, node.nodeId, node.ordinal);
    await prepareNodeOutput(paths);
    await writeFile(paths.stdoutPath, `${"x".repeat(70_000)}tail`, "utf8");
    node.outputPaths = paths;

    const response = await application.output(detail, node.ordinal, "stdout");

    expect(response).toMatchObject({
      outputVersion: 1,
      runId: detail.run.id,
      ordinal: node.ordinal,
      stream: "stdout",
      totalBytes: 70_004,
      returnedBytes: 65_536,
      truncated: true,
    });
    expect(response.text).toHaveLength(65_536);
    expect(response.text.endsWith("tail")).toBe(true);
    const projected = await application.runDetail(detail, [detail]);
    expect(projected.nodes[0]?.availableOutputs).toEqual(["stdout", "stderr", "result"]);
  });

  it("authorizes output paths for the stored retry attempt", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture(
      decisionPacketDefinition("json"),
    );
    const store = new StateStore(dataDirectory);
    let runId: string;
    let nodeId: string;
    let ordinal: number;
    let attemptOnePaths: ReturnType<typeof nodeOutputPaths>;
    try {
      const created = store.createRun({
        plan,
        identity: {
          scope: { kind: "project", root: dirname(cwd) },
          workflowId: plan.definition.workflow.id,
        },
        canonicalCwd: cwd,
        options: {
          nodeTimeoutMs: 60_000,
          approvalTimeoutMs: 60_000,
          maxOutputBytes: 1_048_576,
          maxParallel: 1,
        },
      });
      const node = created.nodes[0];
      if (node?.kind !== "agent") {
        throw new Error("Expected an agent node");
      }
      runId = created.run.id;
      nodeId = node.nodeId;
      ordinal = node.ordinal;
      attemptOnePaths = nodeOutputPaths(dataDirectory, runId, nodeId, ordinal);
      await prepareNodeOutput(attemptOnePaths);
      await writeFile(attemptOnePaths.resultPath, "attempt one", "utf8");
      store.transitionNode(runId, nodeId, { status: "running", ...attemptOnePaths });
      store.transitionNode(runId, nodeId, {
        status: "failed",
        exitCode: 1,
        failure: { code: "NODE_EXIT_NONZERO", message: "retry" },
      });
      store.retryNode(runId, nodeId, 1);
      const attemptTwoPaths = nodeOutputPaths(dataDirectory, runId, nodeId, ordinal, 2);
      await prepareNodeOutput(attemptTwoPaths);
      await writeFile(attemptTwoPaths.resultPath, "attempt two", "utf8");
      store.transitionNode(runId, nodeId, { status: "running", ...attemptTwoPaths });
      store.transitionNode(runId, nodeId, { status: "succeeded", exitCode: 0 });
      store.transitionRun(runId, { status: "succeeded" });
    } finally {
      store.close();
    }
    const reloadedStore = new StateStore(dataDirectory);
    let detail: RunDetail;
    try {
      detail = reloadedStore.getRun(runId);
    } finally {
      reloadedStore.close();
    }
    const node = detail.nodes[0];
    if (node?.kind !== "agent") {
      throw new Error("Expected a decoded agent node");
    }

    await expect(application.output(detail, ordinal, "result")).resolves.toMatchObject({
      text: "attempt two",
    });
    const projected = await application.runDetail(detail, [detail]);
    expect(projected.nodes[0]?.availableOutputs).toEqual(["stdout", "stderr", "result"]);

    const forgedDetail = structuredClone(detail);
    const forgedNode = forgedDetail.nodes[0];
    if (forgedNode?.kind !== "agent") {
      throw new Error("Expected a forged agent node");
    }
    forgedNode.outputPaths = attemptOnePaths;
    await expect(application.output(forgedDetail, ordinal, "result")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
  });

  it("rejects stored path traversal, symbolic links, and hard-link substitution", async () => {
    const { application, cwd, dataDirectory, plan } = await createFixture();
    const detail = runDetail(plan, cwd);
    const node = detail.nodes[0];
    expect(node).toBeDefined();
    if (node === undefined) {
      return;
    }
    const paths = nodeOutputPaths(dataDirectory, detail.run.id, node.nodeId, node.ordinal);
    await prepareNodeOutput(paths);
    node.outputPaths = { ...paths, resultPath: join(dataDirectory, "..", "secret.txt") };
    await expect(application.output(detail, node.ordinal, "result")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });

    node.outputPaths = paths;
    const secretPath = join(dirname(dataDirectory), "secret.txt");
    await writeFile(secretPath, "secret", "utf8");
    await unlink(paths.resultPath);
    await symlink(secretPath, paths.resultPath);
    await expect(application.output(detail, node.ordinal, "result")).rejects.toBeInstanceOf(
      KilinError,
    );
    const projected = await application.runDetail(detail, [detail]);
    expect(projected.nodes[0]?.availableOutputs).toEqual(["stdout", "stderr"]);

    await unlink(paths.resultPath);
    await link(secretPath, paths.resultPath);
    await expect(application.output(detail, node.ordinal, "result")).rejects.toMatchObject({
      code: "RUN_NOT_FOUND",
    });
    const hardLinkProjection = await application.runDetail(detail, [detail]);
    expect(hardLinkProjection.nodes[0]?.availableOutputs).toEqual(["stdout", "stderr"]);
  });
});
