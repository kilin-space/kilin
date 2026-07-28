import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { projectRunAttention } from "../../src/application/run-attention.js";
import { type ExecutionEnvironment, waitForRunAttention } from "../../src/application/runs.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import type { RunDetail, RunOptions } from "../../src/domain/run-state.js";
import type { WorkflowDefinitionV1 } from "../../src/domain/workflow.js";
import { StateStore } from "../../src/infrastructure/state-store.js";
import {
  acquireCanonicalWorkspaceLock,
  type WorkspaceLock,
} from "../../src/infrastructure/workspace-lock.js";

const temporaryDirectories: string[] = [];
const runOptions: RunOptions = {
  nodeTimeoutMs: 1_000,
  approvalTimeoutMs: 1_000,
  maxOutputBytes: 1_024,
  maxParallel: 1,
};
const approvalDefinition: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  workflow: { id: "attention-approval", name: "Attention approval" },
  nodes: [{ id: "gate", kind: "approval", question: "Ship this change?" }],
  edges: [],
};
const loopApprovalDefinition: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  workflow: { id: "attention-loop-approval", name: "Attention loop approval" },
  nodes: [
    {
      id: "refinement",
      kind: "loop",
      maxIterations: 1,
      body: {
        nodes: [
          {
            id: "worker",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Produce a draft.",
            output: { type: "text" },
          },
          { id: "gate", kind: "approval", question: "Accept this iteration?" },
          {
            id: "check",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Check the approved draft.",
            output: { type: "choice", choices: ["pass", "revise"] },
          },
        ],
        edges: [
          { from: "worker", to: "gate" },
          { from: "gate", to: "check" },
          { from: "worker", to: "check", input: "draft" },
        ],
      },
      decision: { node: "check", passChoice: "pass", reviseChoice: "revise" },
      feedback: { from: "worker", to: "worker", input: "feedback" },
      result: { node: "worker" },
    },
  ],
  edges: [],
};
const agentDefinition: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  workflow: { id: "attention-agent", name: "Attention agent" },
  nodes: [
    {
      id: "agent",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      prompt: "Wait for the test.",
    },
  ],
  edges: [],
};

const detailForApproval = (): RunDetail => {
  const plan = compileWorkflow(approvalDefinition);
  return {
    run: {
      id: "run-attention",
      revisionId: "revision-attention",
      canonicalCwd: "/project",
      options: runOptions,
      status: "running",
      startedAt: "2026-07-23T00:00:00.000Z",
    },
    revision: {
      id: "revision-attention",
      scope: { kind: "project", root: "/project" },
      workflowId: approvalDefinition.workflow.id,
      schemaVersion: approvalDefinition.schemaVersion,
      contentHash: plan.contentHash,
      normalizedDefinition: plan.normalizedDefinition,
      createdAt: "2026-07-23T00:00:00.000Z",
    },
    nodes: [
      {
        kind: "approval",
        runId: "run-attention",
        nodeId: "gate",
        ordinal: 0,
        status: "waiting_for_approval",
        requestedAt: "2026-07-23T00:00:01.000Z",
        deadlineAt: "2026-07-23T00:01:01.000Z",
      },
    ],
  };
};

interface StoredRunContext {
  readonly dataDirectory: string;
  readonly canonicalCwd: string;
  readonly environment: ExecutionEnvironment;
  readonly store: StateStore;
  readonly runId: string;
  readonly lock?: WorkspaceLock;
}

const createStoredRun = async (
  definition: WorkflowDefinitionV1,
  holdWorkspaceLock: boolean,
): Promise<StoredRunContext> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-run-attention-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const dataDirectory = join(root, "state");
  await mkdir(project);
  const canonicalCwd = await realpath(project);
  const store = new StateStore(dataDirectory);
  const lock = holdWorkspaceLock
    ? await acquireCanonicalWorkspaceLock(canonicalCwd, dataDirectory)
    : undefined;
  const plan = compileWorkflow(definition);
  const created = store.createRun({
    plan,
    identity: {
      scope: { kind: "project", root: canonicalCwd },
      workflowId: definition.workflow.id,
    },
    canonicalCwd,
    options: runOptions,
  });
  return {
    dataDirectory,
    canonicalCwd,
    environment: {
      dataDirectory,
      userWorkflowsDirectory: join(root, "user-workflows"),
      runtimeExecutables: {
        codex: "/unused/codex",
        "claude-code": "/unused/claude",
        opencode: "/unused/opencode",
      },
      environment: {},
      attentionPollIntervalMs: 5,
    },
    store,
    runId: created.run.id,
    ...(lock === undefined ? {} : { lock }),
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("run attention projection", () => {
  it("projects an unresolved approval using the immutable stored question", () => {
    expect(projectRunAttention(detailForApproval())).toEqual({
      outputVersion: 1,
      type: "approval.requested",
      timestamp: "2026-07-23T00:00:01.000Z",
      runId: "run-attention",
      nodeId: "gate",
      ordinal: 0,
      question: "Ship this change?",
      deadlineAt: "2026-07-23T00:01:01.000Z",
    });
  });

  it("does not repeat an approval after its durable decision is recorded", () => {
    const detail = detailForApproval();
    const node = detail.nodes[0];
    if (node?.kind !== "approval") {
      throw new Error("Expected an approval node.");
    }
    detail.nodes[0] = {
      ...node,
      decision: {
        decision: "approve",
        actor: "agent",
        decidedAt: "2026-07-23T00:00:02.000Z",
      },
    };

    expect(projectRunAttention(detail)).toBeUndefined();
  });

  it("projects a terminal failure as the existing run.finished event", () => {
    const detail = detailForApproval();
    detail.run = {
      ...detail.run,
      status: "failed",
      finishedAt: "2026-07-23T00:00:03.000Z",
      failure: { code: "APPROVAL_REJECTED", message: "Approval was rejected." },
    };

    expect(projectRunAttention(detail)).toEqual({
      outputVersion: 1,
      type: "run.finished",
      timestamp: "2026-07-23T00:00:03.000Z",
      runId: "run-attention",
      durationMs: 3_000,
      status: "failed",
      error: { code: "APPROVAL_REJECTED", message: "Approval was rejected." },
    });
  });
});

describe("run attention wait", () => {
  it("returns a durable approval while the foreground owner holds the workspace lock", async () => {
    const context = await createStoredRun(approvalDefinition, true);
    try {
      context.store.requestApproval(context.runId, "gate");

      await expect(
        waitForRunAttention(context.runId, undefined, context.environment),
      ).resolves.toMatchObject({
        outputVersion: 1,
        type: "approval.requested",
        runId: context.runId,
        nodeId: "gate",
        question: "Ship this change?",
      });
    } finally {
      await context.lock?.release();
      context.store.close();
    }
  });

  it("returns the scoped identity for a durable loop approval", async () => {
    const plan = compileWorkflow(loopApprovalDefinition);
    const plannedApproval = plan.nodes.find(
      ({ node, iteration }) => node.kind === "approval" && iteration === 0,
    );
    if (plannedApproval === undefined) {
      throw new Error("Expected a compiled loop approval.");
    }
    const context = await createStoredRun(loopApprovalDefinition, true);
    try {
      const waiting = context.store.requestApproval(context.runId, plannedApproval.executionId);

      await expect(
        waitForRunAttention(context.runId, undefined, context.environment),
      ).resolves.toEqual({
        outputVersion: 1,
        type: "approval.requested",
        timestamp: waiting.requestedAt,
        runId: context.runId,
        executionId: plannedApproval.executionId,
        nodeId: "gate",
        loopNodeId: "refinement",
        iteration: 0,
        ordinal: plannedApproval.ordinal,
        question: "Accept this iteration?",
        deadlineAt: waiting.deadlineAt,
      });
    } finally {
      await context.lock?.release();
      context.store.close();
    }
  });

  it("aborts only the waiter and leaves the live run unchanged", async () => {
    const context = await createStoredRun(agentDefinition, true);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 20);
    try {
      await expect(
        waitForRunAttention(context.runId, controller.signal, context.environment),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(context.store.getRun(context.runId).run.status).toBe("running");
      expect(context.store.getRun(context.runId).nodes[0]?.status).toBe("pending");
    } finally {
      clearTimeout(abortTimer);
      await context.lock?.release();
      context.store.close();
    }
  });

  it("reconciles an ownerless run and returns interrupted terminal attention", async () => {
    const context = await createStoredRun(agentDefinition, false);
    context.store.close();

    await expect(
      waitForRunAttention(context.runId, undefined, context.environment),
    ).resolves.toMatchObject({
      outputVersion: 1,
      type: "run.finished",
      runId: context.runId,
      status: "interrupted",
      error: { code: "RUN_INTERRUPTED" },
    });

    const store = new StateStore(context.dataDirectory);
    try {
      expect(store.getRun(context.runId).run.status).toBe("interrupted");
      expect(store.getRun(context.runId).nodes[0]?.status).toBe("skipped");
    } finally {
      store.close();
    }
  });
});
