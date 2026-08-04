import type { Page, Route } from "@playwright/test";

import type {
  AgentWorkflowNodeDto,
  ApprovalDecisionResponse,
  BoundedOutputResponse,
  CurrentWorkflowResponse,
  LoopIterationDto,
  NodeRunDto,
  OutputStream,
  RunSummaryDto,
  ScopedRunDetailResponse,
  ScopedRunListResponse,
  WorkflowGraphDto,
} from "../src/ui/contracts.js";

const gateWorkflowId = "gate-viewer";
const gateQuestion = "Ship these verified changes?";

const gateWorkflowGraph = (): WorkflowGraphDto => ({
  workflowId: gateWorkflowId,
  name: "Gated release",
  nodes: [
    {
      id: "analyze",
      ordinal: 0,
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      outputType: "text",
      dependencies: [],
    },
    { id: "gate", ordinal: 1, kind: "approval", question: gateQuestion, dependencies: ["analyze"] },
    {
      id: "verify",
      ordinal: 2,
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      outputType: "text",
      dependencies: ["gate"],
    },
  ],
  edges: [
    { from: "analyze", to: "gate" },
    { from: "gate", to: "verify" },
  ],
  executionOrder: ["analyze", "gate", "verify"],
});

export const gateCurrentWorkflow = (): CurrentWorkflowResponse => ({
  outputVersion: 1,
  state: "valid",
  contentHash: "gate-content",
  workflow: gateWorkflowGraph(),
  diagnostics: [],
});

const fanOutBranches = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;

/** A graph whose seven nodes occupy six lanes, so it is taller than the collapsed graph strip. */
export const fanOutCurrentWorkflow = (): CurrentWorkflowResponse => ({
  outputVersion: 1,
  state: "valid",
  contentHash: "fan-out-content",
  workflow: {
    workflowId: "fan-out-viewer",
    name: "Fan-out review",
    nodes: [
      {
        id: "collect",
        ordinal: 0,
        kind: "agent",
        runtime: "codex",
        access: "read_only",
        outputType: "text",
        dependencies: [],
      },
      ...fanOutBranches.map((branch, index): AgentWorkflowNodeDto => ({
        id: branch,
        ordinal: index + 1,
        kind: "agent",
        runtime: "codex",
        access: "read_only",
        outputType: "text",
        dependencies: ["collect"],
      })),
    ],
    edges: fanOutBranches.map((branch) => ({ from: "collect", to: branch })),
    executionOrder: ["collect", ...fanOutBranches],
  },
  diagnostics: [],
});

const baseSummary = (runId: string): RunSummaryDto => ({
  runId,
  workflowId: gateWorkflowId,
  workflowScope: "project",
  revisionId: `${runId}-revision`,
  cwd: "workspace",
  status: "running",
  startedAt: "2026-07-26T01:00:00.000Z",
});

export const waitingGateSummary = (runId: string): RunSummaryDto => ({
  ...baseSummary(runId),
  waitingForApproval: true,
});

export const ordinaryRunningSummary = (runId: string): RunSummaryDto => baseSummary(runId);

export const cancelRequestedSummary = (runId: string): RunSummaryDto => ({
  ...baseSummary(runId),
  cancelRequestedAt: "2026-07-26T01:00:30.000Z",
});

export const succeededSummary = (runId: string): RunSummaryDto => ({
  ...baseSummary(runId),
  status: "succeeded",
  finishedAt: "2026-07-26T01:01:00.000Z",
  durationMs: 60_000,
});

const analyzeSucceeded: NodeRunDto = {
  kind: "agent",
  executionId: "analyze",
  nodeId: "analyze",
  ordinal: 0,
  runtime: "codex",
  outputType: "text",
  status: "succeeded",
  startedAt: "2026-07-26T01:00:00.000Z",
  finishedAt: "2026-07-26T01:00:01.000Z",
  durationMs: 1_000,
  exitCode: 0,
  availableOutputs: ["result"],
};

const verifyPending: NodeRunDto = {
  kind: "agent",
  executionId: "verify",
  nodeId: "verify",
  ordinal: 2,
  runtime: "codex",
  outputType: "text",
  status: "pending",
  availableOutputs: [],
};

export const waitingGateNodes = (
  executionId: string,
  deadlineAt: string,
): readonly NodeRunDto[] => [
  analyzeSucceeded,
  {
    kind: "approval",
    executionId,
    nodeId: "gate",
    ordinal: 1,
    question: gateQuestion,
    status: "waiting_for_approval",
    requestedAt: "2026-07-26T01:00:01.000Z",
    deadlineAt,
    availableOutputs: [],
  },
  verifyPending,
];

export const decidedGateNodes = (executionId: string, note?: string): readonly NodeRunDto[] => [
  analyzeSucceeded,
  {
    kind: "approval",
    executionId,
    nodeId: "gate",
    ordinal: 1,
    question: gateQuestion,
    status: "succeeded",
    requestedAt: "2026-07-26T01:00:01.000Z",
    finishedAt: "2026-07-26T01:00:02.000Z",
    durationMs: 1_000,
    decision: {
      decision: "approve",
      actor: "human",
      decidedAt: "2026-07-26T01:00:02.000Z",
      ...(note === undefined ? {} : { note }),
    },
    availableOutputs: [],
  },
  verifyPending,
];

export const runningNodes = (): readonly NodeRunDto[] => [
  {
    kind: "agent",
    executionId: "analyze",
    nodeId: "analyze",
    ordinal: 0,
    runtime: "codex",
    outputType: "text",
    status: "running",
    startedAt: "2026-07-26T01:00:00.000Z",
    availableOutputs: [],
  },
  {
    kind: "approval",
    executionId: "gate",
    nodeId: "gate",
    ordinal: 1,
    question: gateQuestion,
    status: "pending",
    availableOutputs: [],
  },
  verifyPending,
];

export const succeededNodes = (): readonly NodeRunDto[] => [
  analyzeSucceeded,
  {
    kind: "approval",
    executionId: "gate",
    nodeId: "gate",
    ordinal: 1,
    question: gateQuestion,
    status: "succeeded",
    requestedAt: "2026-07-26T01:00:01.000Z",
    finishedAt: "2026-07-26T01:00:02.000Z",
    durationMs: 1_000,
    decision: { decision: "approve", actor: "human", decidedAt: "2026-07-26T01:00:02.000Z" },
    availableOutputs: [],
  },
  {
    kind: "agent",
    executionId: "verify",
    nodeId: "verify",
    ordinal: 2,
    runtime: "codex",
    outputType: "text",
    status: "succeeded",
    startedAt: "2026-07-26T01:00:02.000Z",
    finishedAt: "2026-07-26T01:00:03.000Z",
    durationMs: 1_000,
    exitCode: 0,
    availableOutputs: [],
  },
];

export const gateRunDetail = (
  summary: RunSummaryDto,
  nodes: readonly NodeRunDto[],
): ScopedRunDetailResponse => ({
  outputVersion: 1,
  workflowId: summary.workflowId,
  workflowScope: summary.workflowScope,
  run: summary,
  revision: {
    revisionId: summary.revisionId,
    workflowScope: summary.workflowScope,
    contentHash: `${summary.runId}-content`,
    createdAt: "2026-07-26T00:59:00.000Z",
    workflow: gateWorkflowGraph(),
  },
  nodes,
  loopIterations: [],
  attempts: [],
  workspaces: [],
  lineage: { runs: [summary], selectedRunIndex: 0 },
});

const loopWorkflowId = "loop-viewer";
const loopGateQuestion = "Approve the revised result?";

const loopWorkflowGraph = (): WorkflowGraphDto => ({
  workflowId: loopWorkflowId,
  name: "Bounded review",
  nodes: [
    {
      id: "refine",
      ordinal: 0,
      kind: "loop",
      maxIterations: 2,
      dependencies: [],
      body: {
        nodes: [
          {
            id: "draft",
            ordinal: 0,
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            outputType: "text",
            dependencies: [],
          },
          {
            id: "gate",
            ordinal: 1,
            kind: "approval",
            question: loopGateQuestion,
            dependencies: ["draft"],
          },
          {
            id: "judge",
            ordinal: 2,
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            outputType: "choice",
            dependencies: ["gate"],
          },
        ],
        edges: [
          { from: "draft", to: "gate" },
          { from: "gate", to: "judge" },
        ],
      },
      decision: { nodeId: "judge", passChoice: "pass", reviseChoice: "revise" },
      feedback: { fromNodeId: "draft", toNodeId: "draft", input: "prior_feedback" },
      resultNodeId: "draft",
    },
  ],
  edges: [],
  executionOrder: ["refine"],
});

export const loopCurrentWorkflow = (): CurrentWorkflowResponse => ({
  outputVersion: 1,
  state: "valid",
  contentHash: "loop-content",
  workflow: loopWorkflowGraph(),
  diagnostics: [],
});

const loopRunSummary = (waiting: boolean): RunSummaryDto => ({
  runId: "loop-run",
  workflowId: loopWorkflowId,
  workflowScope: "project",
  revisionId: "loop-revision",
  cwd: "workspace",
  status: "running",
  startedAt: "2026-07-26T01:00:00.000Z",
  ...(waiting ? { waitingForApproval: true } : {}),
});

const loopFirstIterationExecutions = (): LoopIterationDto["executions"] => [
  {
    kind: "agent",
    executionId: "opaque-occurrence-alpha",
    nodeId: "draft",
    loopNodeId: "refine",
    iteration: 0,
    ordinal: 1,
    runtime: "codex",
    outputType: "text",
    status: "succeeded",
    startedAt: "2026-07-26T01:00:00.000Z",
    finishedAt: "2026-07-26T01:00:01.000Z",
    durationMs: 1_000,
    exitCode: 0,
    availableOutputs: [],
  },
  {
    kind: "approval",
    executionId: "opaque-occurrence-approved-gate",
    nodeId: "gate",
    loopNodeId: "refine",
    iteration: 0,
    ordinal: 2,
    question: loopGateQuestion,
    status: "succeeded",
    requestedAt: "2026-07-26T01:00:01.000Z",
    finishedAt: "2026-07-26T01:00:02.000Z",
    durationMs: 1_000,
    decision: { decision: "approve", actor: "human", decidedAt: "2026-07-26T01:00:02.000Z" },
    availableOutputs: [],
  },
  {
    kind: "agent",
    executionId: "opaque-occurrence-beta",
    nodeId: "judge",
    loopNodeId: "refine",
    iteration: 0,
    ordinal: 3,
    runtime: "codex",
    outputType: "choice",
    status: "succeeded",
    startedAt: "2026-07-26T01:00:02.000Z",
    finishedAt: "2026-07-26T01:00:03.000Z",
    durationMs: 1_000,
    exitCode: 0,
    availableOutputs: [],
  },
];

const loopSecondIterationExecutions = (
  waiting: boolean,
  deadlineAt: string,
): LoopIterationDto["executions"] => [
  {
    kind: "agent",
    executionId: "opaque-occurrence-second-draft",
    nodeId: "draft",
    loopNodeId: "refine",
    iteration: 1,
    ordinal: 4,
    runtime: "codex",
    outputType: "text",
    status: "succeeded",
    startedAt: "2026-07-26T01:00:03.000Z",
    finishedAt: "2026-07-26T01:00:04.000Z",
    durationMs: 1_000,
    exitCode: 0,
    availableOutputs: [],
  },
  waiting
    ? {
        kind: "approval",
        executionId: "opaque-occurrence-gate",
        nodeId: "gate",
        loopNodeId: "refine",
        iteration: 1,
        ordinal: 5,
        question: loopGateQuestion,
        status: "waiting_for_approval",
        requestedAt: "2026-07-26T01:00:04.000Z",
        deadlineAt,
        availableOutputs: [],
      }
    : {
        kind: "approval",
        executionId: "opaque-occurrence-gate",
        nodeId: "gate",
        loopNodeId: "refine",
        iteration: 1,
        ordinal: 5,
        question: loopGateQuestion,
        status: "succeeded",
        requestedAt: "2026-07-26T01:00:04.000Z",
        finishedAt: "2026-07-26T01:00:05.000Z",
        durationMs: 1_000,
        decision: { decision: "approve", actor: "human", decidedAt: "2026-07-26T01:00:05.000Z" },
        availableOutputs: [],
      },
  {
    kind: "agent",
    executionId: "opaque-occurrence-second-judge",
    nodeId: "judge",
    loopNodeId: "refine",
    iteration: 1,
    ordinal: 6,
    runtime: "codex",
    outputType: "choice",
    status: "pending",
    availableOutputs: [],
  },
];

export const loopRunDetail = (waiting: boolean, deadlineAt: string): ScopedRunDetailResponse => {
  const summary = loopRunSummary(waiting);
  const firstIteration = loopFirstIterationExecutions();
  const secondIteration = loopSecondIterationExecutions(waiting, deadlineAt);
  return {
    outputVersion: 1,
    workflowId: loopWorkflowId,
    workflowScope: "project",
    run: summary,
    revision: {
      revisionId: "loop-revision",
      workflowScope: "project",
      contentHash: "loop-content",
      createdAt: "2026-07-26T00:59:00.000Z",
      workflow: loopWorkflowGraph(),
    },
    nodes: [
      {
        kind: "loop",
        executionId: "refine",
        nodeId: "refine",
        ordinal: 0,
        status: "running",
        startedAt: "2026-07-26T01:00:00.000Z",
        availableOutputs: [],
      },
      ...firstIteration,
      ...secondIteration,
    ],
    loopIterations: [
      { loopNodeId: "refine", iteration: 0, status: "succeeded", executions: firstIteration },
      {
        loopNodeId: "refine",
        iteration: 1,
        status: waiting ? "waiting_for_approval" : "succeeded",
        executions: secondIteration,
      },
    ],
    attempts: [],
    workspaces: [],
    lineage: { runs: [summary], selectedRunIndex: 0 },
  };
};

export const runListResponse = (runs: readonly RunSummaryDto[]): ScopedRunListResponse => ({
  outputVersion: 1,
  workflowId: gateWorkflowId,
  workflowScope: "project",
  runs,
});

export const loopRunListResponse = (waiting: boolean): ScopedRunListResponse => ({
  outputVersion: 1,
  workflowId: loopWorkflowId,
  workflowScope: "project",
  runs: [loopRunSummary(waiting)],
});

export const syntheticApprovalDecision = (
  runId: string,
  executionId: string,
  note?: string,
): ApprovalDecisionResponse => ({
  outputVersion: 1,
  runId,
  nodeId: executionId,
  decision: {
    decision: "approve",
    actor: "human",
    decidedAt: "2026-07-26T01:00:05.000Z",
    ...(note === undefined ? {} : { note }),
  },
});

export const syntheticOutputResponse = (
  runId: string,
  ordinal: number,
  stream: OutputStream,
): BoundedOutputResponse => ({
  outputVersion: 1,
  runId,
  ordinal,
  stream,
  text: "seeded synthetic evidence",
  totalBytes: 25,
  returnedBytes: 25,
  truncated: false,
});

export const fulfillJson = async (route: Route, body: unknown): Promise<void> => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
};

export const fulfillTransientFailure = async (route: Route, message: string): Promise<void> => {
  await route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      outputVersion: 1,
      error: { code: "TRANSIENT_TEST_FAILURE", message },
    }),
  });
};

export interface SyntheticWorld {
  readonly currentWorkflow: () => CurrentWorkflowResponse;
  readonly runList: () => ScopedRunListResponse;
  readonly runDetail: (runId: string) => ScopedRunDetailResponse | undefined;
}

export const installWorldRoutes = async (
  page: Page,
  origin: string,
  world: SyntheticWorld,
): Promise<void> => {
  await page.route(`${origin}/api/**`, async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      await route.continue();
      return;
    }
    const path = new URL(request.url()).pathname;
    const detailMatch = /^\/api\/runs\/([^/]+)$/u.exec(path);
    const outputMatch =
      /^\/api\/runs\/([^/]+)\/nodes\/(\d+)\/output\/(stdout|stderr|result)$/u.exec(path);
    if (path === "/api/workflow") {
      await fulfillJson(route, world.currentWorkflow());
      return;
    }
    if (path === "/api/runs") {
      await fulfillJson(route, world.runList());
      return;
    }
    if (detailMatch?.[1] !== undefined) {
      const detail = world.runDetail(decodeURIComponent(detailMatch[1]));
      if (detail === undefined) {
        await route.continue();
        return;
      }
      await fulfillJson(route, detail);
      return;
    }
    const stream = outputMatch?.[3];
    if (
      outputMatch?.[1] !== undefined &&
      outputMatch[2] !== undefined &&
      (stream === "stdout" || stream === "stderr" || stream === "result")
    ) {
      await fulfillJson(
        route,
        syntheticOutputResponse(decodeURIComponent(outputMatch[1]), Number(outputMatch[2]), stream),
      );
      return;
    }
    await route.continue();
  });
};

export interface ApprovalEventLogEntry {
  readonly type: "announcement" | "focusin";
  readonly text?: string;
  readonly key?: string;
  readonly announcementAtFocus?: string | null;
}

export const installApprovalEventLog = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const holder = window as unknown as { __approvalEventLog: ApprovalEventLogEntry[] };
    holder.__approvalEventLog = [];
    const log = holder.__approvalEventLog;
    document.addEventListener("DOMContentLoaded", () => {
      const region = document.getElementById("approval-status");
      if (region === null) {
        return;
      }
      new MutationObserver(() => {
        log.push({ type: "announcement", text: region.textContent });
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const key =
        target.id !== ""
          ? target.id
          : (target.getAttribute("data-node-id") ??
            target.getAttribute("data-run-id") ??
            target.tagName.toLowerCase());
      log.push({
        type: "focusin",
        key,
        announcementAtFocus: document.getElementById("approval-status")?.textContent ?? null,
      });
    });
  });
};

export const readApprovalEventLog = async (page: Page): Promise<readonly ApprovalEventLogEntry[]> =>
  page.evaluate(() => {
    const holder = window as unknown as { __approvalEventLog?: ApprovalEventLogEntry[] };
    return holder.__approvalEventLog ?? [];
  });

export const readApprovalAnnouncements = async (
  page: Page,
): Promise<readonly (string | undefined)[]> =>
  (await readApprovalEventLog(page))
    .filter((entry) => entry.type === "announcement")
    .map((entry) => entry.text);
