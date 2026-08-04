import type { Page, Response, Route, TestInfo } from "@playwright/test";

import type {
  CurrentWorkflowResponse,
  LoopIterationDto,
  NodeRunDto,
  RunSummaryDto,
  ScopedRunDetailResponse,
  ScopedRunListResponse,
  WorkflowGraphDto,
} from "../src/ui/contracts.js";
import {
  cancelRequestedSummary,
  decidedGateNodes,
  fulfillJson,
  fulfillTransientFailure,
  gateCurrentWorkflow,
  gateRunDetail,
  installApprovalEventLog,
  installWorldRoutes,
  loopCurrentWorkflow,
  loopRunDetail,
  loopRunListResponse,
  ordinaryRunningSummary,
  readApprovalAnnouncements,
  readApprovalEventLog,
  runListResponse,
  runningNodes,
  succeededNodes,
  succeededSummary,
  syntheticApprovalDecision,
  syntheticOutputResponse,
  waitingGateNodes,
  waitingGateSummary,
} from "./approval-world.js";
import { expect, test } from "./fixtures.js";

const openViewer = async (page: Page, launchUrl: string): Promise<Response> => {
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#connection-status")).toHaveText("Live");
  return navigation;
};

const saveScreenshot = async (
  page: Page,
  fileName: string,
  name: string,
  testInfo: TestInfo,
): Promise<void> => {
  const path = testInfo.outputPath(fileName);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
};

const documentHasNoHorizontalOverflow = async (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolveValue: (value: Value) => void = () => {
    throw new Error("The deferred browser event was resolved before initialization.");
  };
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
};

const waitForBrowserRendering = async (page: Page): Promise<void> => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
};

test.describe.configure({ mode: "serial" });

test("desktop viewer exposes the graph, stored states, bounded output, and lineage", async ({
  page,
  scenario,
  viewer,
}, testInfo) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const invocationCount = await scenario.runtimeInvocationCount();
  await openViewer(page, viewer.launchUrl);

  expect(new URL(page.url()).hash).not.toContain("token");
  await expect(page.locator("#graph-context")).toHaveText("Stored revision");
  await expect(
    page.getByRole("button", { name: new RegExp(`Run ${scenario.interruptedRunId}, interrupted`) }),
  ).toHaveAttribute("aria-current", "true");

  await page.locator("#current-workflow-button").click();
  await expect(page.locator("#graph-context")).toHaveText("Current workflow");
  await expect(page.locator("#workflow-graph title")).toHaveText(
    "Release readiness workflow graph",
  );
  await expect(page.locator("#workflow-graph desc")).toContainText(
    "3 nodes in execution order: analyze, change, verify",
  );
  await expect(page.locator("#execution-list li")).toHaveText([
    "1. analyze · starts first",
    "2. change · after analyze",
    "3. verify · after change",
  ]);
  await expect(documentHasNoHorizontalOverflow(page)).resolves.toBe(true);

  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.cancelledRunId}, cancelled`) })
    .click();
  await expect(page.locator(".dag-node.cancelled")).toHaveCount(1);
  await expect(page.locator(".dag-node.skipped")).toHaveCount(2);

  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.interruptedRunId}, interrupted`) })
    .click();
  await expect(page.locator(".dag-node.interrupted")).toHaveCount(1);
  await expect(page.locator(".dag-node.skipped")).toHaveCount(2);
  await expect(page.locator("#run-inspector .failure-reference")).toContainText(
    "RUN_INTERRUPTED at node",
  );
  await expect(page.locator("#run-inspector .failure-copy")).toHaveCount(0);
  await expect(page.locator("#node-inspector .failure-copy")).toContainText("RUN_INTERRUPTED");

  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.failedRunId}, failed`) })
    .click();
  await expect(page.locator(".dag-node.succeeded")).toHaveCount(1);
  await expect(page.locator(".dag-node.failed")).toHaveCount(1);
  await expect(page.locator(".dag-node.skipped")).toHaveCount(1);
  await expect(page.locator("#run-inspector .failure-reference")).toContainText(
    "NODE_EXIT_NONZERO at node change",
  );
  await expect(page.locator("#run-inspector .failure-copy")).toHaveCount(0);

  const analyzeNode = page.getByRole("button", { name: /^analyze, step 1,/u });
  const changeNode = page.getByRole("button", { name: /^change, step 2,/u });
  await analyzeNode.click();
  await expect(page.locator("#output-panel")).toContainText("result:analyze");
  await expect(page.locator("#run-inspector .failure-copy")).toContainText("NODE_EXIT_NONZERO");
  await expect(page.locator("#run-inspector .failure-reference")).toHaveCount(0);
  await analyzeNode.focus();
  await analyzeNode.press("ArrowRight");
  await expect(changeNode).toBeFocused();
  await changeNode.press("Enter");
  await expect(page.locator("#node-inspector .inspector-title")).toHaveText("change");
  await expect(page.locator("#node-inspector .failure-copy")).toContainText("NODE_EXIT_NONZERO");
  await expect(page.locator("#run-inspector .failure-reference")).toContainText(
    "NODE_EXIT_NONZERO at node change",
  );
  await expect(page.locator("#run-inspector .failure-copy")).toHaveCount(0);

  const resultTab = page.getByRole("tab", { name: "Result" });
  const stdoutTab = page.getByRole("tab", { name: "Activity" });
  await resultTab.focus();
  await resultTab.press("ArrowRight");
  await expect(stdoutTab).toBeFocused();
  await expect(stdoutTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#output-panel")).toContainText("BOUNDED_TAIL_MARKER");
  await expect(page.locator("#output-panel")).not.toContainText(
    "TAIL_MUST_NOT_INCLUDE_THIS_PREFIX",
  );
  await expect(page.locator("#evidence-banner")).toContainText("Showing the newest 64 KiB");
  await stdoutTab.press("ArrowRight");
  const stderrTab = page.getByRole("tab", { name: "Stderr" });
  await expect(stderrTab).toBeFocused();
  await expect(page.locator("#output-panel")).toContainText("provider partial stderr");
  await stderrTab.press("ArrowLeft");
  await expect(stdoutTab).toBeFocused();

  await saveScreenshot(page, "viewer-desktop.png", "viewer-desktop-1440x900", testInfo);

  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.rerunId}, succeeded`) })
    .click();
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText(scenario.rerunId);
  await expect(page.locator("#lineage-list .lineage-button")).toHaveCount(2);
  await expect(page.locator("#lineage-list .lineage-button").first()).toContainText(
    scenario.successfulRunId.slice(0, 12),
  );
  await expect(page.locator("#lineage-list .lineage-button").last()).toContainText(
    scenario.rerunId.slice(0, 12),
  );
  await expect(scenario.runtimeInvocationCount()).resolves.toBe(invocationCount);
});

test("bounded loops stay compact and expose scoped iterations without parsing execution IDs", async ({
  page,
  viewer,
}) => {
  const graph: WorkflowGraphDto = {
    workflowId: "loop-viewer",
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
              question: "Approve the revised result?",
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
  };
  const run = {
    runId: "loop-run",
    workflowId: "loop-viewer",
    workflowScope: "project" as const,
    revisionId: "loop-revision",
    cwd: "workspace",
    status: "running" as const,
    startedAt: "2026-07-26T01:00:00.000Z",
  };
  const firstIterationExecutions: LoopIterationDto["executions"] = [
    {
      kind: "agent" as const,
      executionId: "opaque-occurrence-alpha",
      nodeId: "draft",
      loopNodeId: "refine",
      iteration: 0,
      ordinal: 1,
      runtime: "codex" as const,
      outputType: "text" as const,
      status: "succeeded" as const,
      startedAt: "2026-07-26T01:00:00.000Z",
      finishedAt: "2026-07-26T01:00:01.000Z",
      durationMs: 1_000,
      exitCode: 0,
      availableOutputs: [],
    },
    {
      kind: "approval" as const,
      executionId: "opaque-occurrence-approved-gate",
      nodeId: "gate",
      loopNodeId: "refine",
      iteration: 0,
      ordinal: 2,
      question: "Approve the revised result?",
      status: "succeeded" as const,
      requestedAt: "2026-07-26T01:00:01.000Z",
      finishedAt: "2026-07-26T01:00:02.000Z",
      durationMs: 1_000,
      decision: {
        decision: "approve" as const,
        actor: "human" as const,
        decidedAt: "2026-07-26T01:00:02.000Z",
      },
      availableOutputs: [],
    },
    {
      kind: "agent" as const,
      executionId: "opaque-occurrence-beta",
      nodeId: "judge",
      loopNodeId: "refine",
      iteration: 0,
      ordinal: 3,
      runtime: "codex" as const,
      outputType: "choice" as const,
      status: "succeeded" as const,
      startedAt: "2026-07-26T01:00:02.000Z",
      finishedAt: "2026-07-26T01:00:03.000Z",
      durationMs: 1_000,
      exitCode: 0,
      availableOutputs: [],
    },
  ];
  const secondIterationExecutions: LoopIterationDto["executions"] = [
    {
      kind: "agent" as const,
      executionId: "opaque-occurrence-second-draft",
      nodeId: "draft",
      loopNodeId: "refine",
      iteration: 1,
      ordinal: 4,
      runtime: "codex" as const,
      outputType: "text" as const,
      status: "succeeded" as const,
      startedAt: "2026-07-26T01:00:03.000Z",
      finishedAt: "2026-07-26T01:00:04.000Z",
      durationMs: 1_000,
      exitCode: 0,
      availableOutputs: [],
    },
    {
      kind: "approval" as const,
      executionId: "opaque-occurrence-gate",
      nodeId: "gate",
      loopNodeId: "refine",
      iteration: 1,
      ordinal: 5,
      question: "Approve the revised result?",
      status: "waiting_for_approval" as const,
      requestedAt: "2026-07-26T01:00:04.000Z",
      deadlineAt: "2026-07-26T01:01:04.000Z",
      availableOutputs: [],
    },
    {
      kind: "agent" as const,
      executionId: "opaque-occurrence-second-judge",
      nodeId: "judge",
      loopNodeId: "refine",
      iteration: 1,
      ordinal: 6,
      runtime: "codex" as const,
      outputType: "choice" as const,
      status: "pending" as const,
      availableOutputs: [],
    },
  ];
  const currentWorkflow: CurrentWorkflowResponse = {
    outputVersion: 1,
    state: "valid",
    contentHash: "loop-content",
    workflow: graph,
    diagnostics: [],
  };
  const runList: ScopedRunListResponse = {
    outputVersion: 1,
    workflowId: "loop-viewer",
    workflowScope: "project",
    runs: [run],
  };
  const runDetail: ScopedRunDetailResponse = {
    outputVersion: 1,
    workflowId: "loop-viewer",
    workflowScope: "project",
    run,
    revision: {
      revisionId: "loop-revision",
      workflowScope: "project",
      contentHash: "loop-content",
      createdAt: "2026-07-26T00:59:00.000Z",
      workflow: graph,
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
      ...firstIterationExecutions,
      ...secondIterationExecutions,
    ],
    loopIterations: [
      {
        loopNodeId: "refine",
        iteration: 0,
        status: "succeeded",
        executions: firstIterationExecutions,
      },
      {
        loopNodeId: "refine",
        iteration: 1,
        status: "waiting_for_approval",
        executions: secondIterationExecutions,
      },
    ],
    attempts: [],
    workspaces: [],
    lineage: { runs: [run], selectedRunIndex: 0 },
  };
  let detailRequestCount = 0;
  await page.route(`${viewer.origin}/api/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/runs/loop-run") {
      detailRequestCount += 1;
    }
    const body =
      path === "/api/workflow"
        ? currentWorkflow
        : path === "/api/runs"
          ? runList
          : path === "/api/runs/loop-run"
            ? runDetail
            : undefined;
    if (body === undefined) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  await openViewer(page, viewer.launchUrl);
  await page.locator("#current-workflow-button").click();
  await expect(page.locator("#graph-context")).toHaveText("Current workflow");
  await expect(page.locator("#workflow-graph desc")).toContainText(
    "1 nodes in execution order: refine",
  );
  await expect(page.locator(".dag-node")).toHaveCount(1);
  await expect(page.locator(".dag-node-meta")).toHaveText("loop · up to 2");
  await page.getByRole("button", { name: /Run loop-run, running/u }).click();
  await expect(page.locator("#execution-list button")).toHaveCount(0);
  const iterationRegion = page.locator("#loop-iterations-section");
  await expect(iterationRegion).toBeVisible();
  await expect(iterationRegion.locator(".loop-iteration")).toHaveCount(2);
  await expect(
    iterationRegion.locator('[data-iteration-status="waiting_for_approval"]'),
  ).toHaveAttribute("open", "");
  await expect(iterationRegion.locator('[data-iteration-status="succeeded"]')).not.toHaveAttribute(
    "open",
    "",
  );
  await iterationRegion.locator('[data-iteration-status="succeeded"] summary').click();
  await expect(page.locator(".loop-execution-provenance").first()).toContainText(
    "executionId opaque-occurrence-alpha · bodyNodeId draft · loopNodeId refine",
  );
  await page.getByRole("button", { name: /^draft, loop refine, iteration 0,/u }).click();
  await expect(page.locator("#node-inspector")).toContainText("opaque-occurrence-alpha");
  await expect(page.locator("#node-inspector")).toContainText("Iteration0");
  const gateButton = page.getByRole("button", { name: /^gate, loop refine, iteration 1,/u });
  await gateButton.click();
  await expect(page.locator("#decision-dock")).toBeVisible();
  await expect(page.locator("#decision-dock")).toContainText("Approve the revised result?");
  await expect(page.locator(".approval-commands")).toContainText(
    "kilin runs approve loop-run opaque-occurrence-gate --actor human",
  );
  await gateButton.focus();
  await expect(gateButton).toBeFocused();
  const detailRequestsBeforePoll = detailRequestCount;
  await expect.poll(() => detailRequestCount).toBeGreaterThan(detailRequestsBeforePoll);
  await expect(gateButton).toBeFocused();
  await expect(iterationRegion.locator('[data-iteration-status="succeeded"]')).toHaveAttribute(
    "open",
    "",
  );
});

test("mobile viewer preserves layout and touch targets", async ({
  page,
  scenario,
  viewer,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const invocationCount = await scenario.runtimeInvocationCount();
  await openViewer(page, viewer.launchUrl);

  const graphRegion = await page.locator(".graph-region").boundingBox();
  const inspectorRegion = await page.locator(".inspector-region").boundingBox();
  const historyRegion = await page.locator(".history-region").boundingBox();
  expect(graphRegion?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    inspectorRegion?.y ?? Number.NEGATIVE_INFINITY,
  );
  expect(inspectorRegion?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(
    historyRegion?.y ?? Number.NEGATIVE_INFINITY,
  );
  await expect(documentHasNoHorizontalOverflow(page)).resolves.toBe(true);

  const visibleButtons = await page.locator("button").all();
  for (const button of visibleButtons) {
    if (await button.isVisible()) {
      const box = await button.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  }
  const graphNodes = await page.locator(".dag-node").all();
  for (const node of graphNodes) {
    const box = await node.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await saveScreenshot(page, "viewer-mobile.png", "viewer-mobile-390x844", testInfo);
  await expect(scenario.runtimeInvocationCount()).resolves.toBe(invocationCount);
});

test("selecting a node reveals the evidence stage and a waiting gate exposes its packet", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);
  const approvalRun = await scenario.startApprovalRun();
  let upstreamEvidenceRequests = 0;
  await page.route(
    `${viewer.origin}/api/runs/${approvalRun.runId}/nodes/0/output/result`,
    async (route) => {
      upstreamEvidenceRequests += 1;
      if (upstreamEvidenceRequests === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary failure" }),
        });
        return;
      }
      await route.continue();
    },
  );
  try {
    await page
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, waiting for approval`) })
      .click();

    const gateNode = page.locator(".dag-node.waiting_for_approval");
    await expect(gateNode).toHaveCount(1);

    await gateNode.click();
    await expect(page.locator(".approval-commands")).toContainText("kilin runs approve");
    await expect(page.locator("#decision-dock .decision-packet")).toContainText("APPROVAL_PACKET");
    expect(upstreamEvidenceRequests).toBeGreaterThan(1);

    await page.getByRole("button", { name: /^analyze, step 1,/u }).click();
    await expect(page.locator("#output-section")).toBeVisible();
    const packet = page.locator("#output-panel .decision-packet");
    await expect(packet).toBeVisible();
    await expect(packet).toContainText("APPROVAL_PACKET");
    await expect(documentHasNoHorizontalOverflow(page)).resolves.toBe(true);
  } finally {
    approvalRun.cancel();
  }
  const completion = await approvalRun.wait();
  expect(completion.exitCode).toBe(130);
});

test("permanent approval evidence failures stop after bounded retries", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);
  const approvalRun = await scenario.startApprovalRun();
  let upstreamEvidenceRequests = 0;
  await page.route(
    `${viewer.origin}/api/runs/${approvalRun.runId}/nodes/0/output/result`,
    async (route) => {
      upstreamEvidenceRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "permanent failure" }),
      });
    },
  );
  try {
    await page
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, waiting for approval`) })
      .click();
    await page.locator(".dag-node.waiting_for_approval").click();

    await expect.poll(() => upstreamEvidenceRequests, { timeout: 8_000 }).toBe(3);
    await page.waitForTimeout(2_500);
    expect(upstreamEvidenceRequests).toBe(3);
  } finally {
    approvalRun.cancel();
  }
  const completion = await approvalRun.wait();
  expect(completion.exitCode).toBe(130);
});

test("an approval decided in the viewer resumes the attached run", async ({
  page,
  scenario,
  viewer,
}): Promise<void> => {
  await openViewer(page, viewer.launchUrl);
  const approvalRun = await scenario.startApprovalRun();
  try {
    await page
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, waiting for approval`) })
      .click();
    await page.locator(".dag-node.waiting_for_approval").click();

    const dock = page.locator("#decision-dock");
    await expect(dock).toBeVisible();
    await expect(dock.locator(".dock-question")).toHaveText("Ship these verified changes?");
    await expect(dock.locator(".dock-evidence .decision-packet")).toContainText("APPROVAL_PACKET");
    await expect(dock.locator(".dock-evidence .decision-packet")).toContainText(
      "AI recommendation — not a Human Decision",
    );
    await expect(dock.locator(".packet-actions button")).toHaveCount(0);
    await expect(dock.locator(".approval-commands")).toContainText(
      `kilin runs approve ${approvalRun.runId} gate --actor human`,
    );

    await dock.locator("#decision-note").fill("Looks good");
    await dock.locator("#decision-approve").click();
    await expect(dock.locator(".decision-record")).toContainText("human");
    await expect(dock.locator(".decision-record")).toContainText("Looks good");
    await expect(dock.locator("#decision-approve")).toHaveCount(0);
    await expect(dock.locator(".approval-commands")).toHaveCount(0);
    await expect(dock.locator("[data-live-deadline]")).toHaveCount(0);
    await expect(page.locator("#node-inspector [data-live-deadline]")).toHaveCount(0);

    const completion = await approvalRun.wait();
    expect(completion.exitCode).toBe(0);
    await expect(page.locator(".dag-node.succeeded")).toHaveCount(3);
    await expect(page.locator("#node-inspector")).toContainText("approve");
  } finally {
    approvalRun.cancel();
  }
});

test("terminal runs and approval gates do not keep live timers", async ({
  page,
  scenario,
  viewer,
}): Promise<void> => {
  const approvalRun = await scenario.startApprovalRun();
  approvalRun.cancel();
  const completion = await approvalRun.wait();
  expect(completion.exitCode).toBe(130);

  await page.route(
    `${viewer.origin}/api/runs/${approvalRun.runId}`,
    async (route): Promise<void> => {
      const response = await route.fetch();
      const detail = (await response.json()) as ScopedRunDetailResponse;
      const run = { ...detail.run };
      Reflect.deleteProperty(run, "durationMs");
      const nodes = detail.nodes.map((node): (typeof detail.nodes)[number] => {
        const withoutDuration = { ...node };
        Reflect.deleteProperty(withoutDuration, "durationMs");
        return withoutDuration;
      });
      await route.fulfill({
        response,
        body: JSON.stringify({ ...detail, run, nodes } satisfies ScopedRunDetailResponse),
      });
    },
  );

  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, cancelled`) })
    .click();
  await page.locator(".dag-node.cancelled").click();

  await expect(page.locator("#run-inspector [data-live-elapsed]")).toHaveCount(0);
  await expect(page.locator("#node-inspector [data-live-elapsed]")).toHaveCount(0);
  await expect(page.locator("#node-inspector [data-live-deadline]")).toHaveCount(0);
  await expect(page.locator("#decision-dock [data-live-deadline]")).toHaveCount(0);
  await expect(page.locator("#decision-dock .dock-deadline")).not.toContainText(/left|overdue/u);
});

test("a rejection decided in the viewer fails the gate and stops the attached run", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);
  const approvalRun = await scenario.startApprovalRun();
  try {
    await page
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, waiting for approval`) })
      .click();
    await page.locator(".dag-node.waiting_for_approval").click();

    const dock = page.locator("#decision-dock");
    await dock.locator("#decision-reject").click();

    const completion = await approvalRun.wait();
    expect(completion.exitCode).toBe(1);
    await expect(page.locator("#node-inspector .failure-copy")).toContainText("APPROVAL_REJECTED");
    await expect(page.locator(".dag-node.skipped")).toHaveCount(1);
  } finally {
    approvalRun.cancel();
  }
});

test("the newest output selection wins an out-of-order same-stream response race", async ({
  page,
  scenario,
  viewer,
}) => {
  const invocationCount = await scenario.runtimeInvocationCount();
  const firstResultRoute = deferred<Route>();
  const secondResultRoute = deferred<Route>();
  let requestCount = 0;
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.failedRunId}, failed`) })
    .click();
  await page.getByRole("button", { name: /^analyze, step 1,/u }).click();
  await expect(page.locator("#output-panel")).toContainText("result:analyze");
  await page.route(
    `${viewer.origin}/api/runs/${scenario.failedRunId}/nodes/1/output/result`,
    async (route) => {
      requestCount += 1;
      if (requestCount === 1) {
        firstResultRoute.resolve(route);
        return;
      }
      if (requestCount === 2) {
        secondResultRoute.resolve(route);
        return;
      }
      await route.continue();
    },
  );
  await page.getByRole("button", { name: /^change, step 2,/u }).click();
  const firstRoute = await firstResultRoute.promise;

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.locator("#output-panel")).toContainText("BOUNDED_TAIL_MARKER");
  await page.getByRole("tab", { name: "Result" }).click();
  const secondRoute = await secondResultRoute.promise;
  const newerResponse = page.waitForResponse(
    (response) => response.headers()["x-e2e-output-generation"] === "newer",
  );
  await secondRoute.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "X-E2E-Output-Generation": "newer" },
    body: JSON.stringify({
      outputVersion: 1,
      runId: scenario.failedRunId,
      ordinal: 1,
      stream: "result",
      text: "newer-tail",
      totalBytes: 10,
      returnedBytes: 10,
      truncated: false,
    }),
  });
  await (await newerResponse).finished();
  await expect(page.locator("#output-panel")).toHaveText("newer-tail");

  const olderResponse = page.waitForResponse(
    (response) => response.headers()["x-e2e-output-generation"] === "older",
  );
  await firstRoute.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "X-E2E-Output-Generation": "older" },
    body: JSON.stringify({
      outputVersion: 1,
      runId: scenario.failedRunId,
      ordinal: 1,
      stream: "result",
      text: "older-tail",
      totalBytes: 10,
      returnedBytes: 10,
      truncated: false,
    }),
  });
  await (await olderResponse).finished();
  await waitForBrowserRendering(page);
  await expect(page.locator("#output-panel")).toHaveText("newer-tail");
  await expect(scenario.runtimeInvocationCount()).resolves.toBe(invocationCount);
});

test("polling reports lifecycle changes, retries after a transient error, and recovers validation", async ({
  page,
  scenario,
  viewer,
}) => {
  test.slow();
  await openViewer(page, viewer.launchUrl);

  const delayed = await scenario.startDelayedRun(1_800);
  const delayedRunButton = page.getByRole("button", {
    name: new RegExp(`Run ${delayed.runId}, running`),
  });
  await expect(delayedRunButton).toBeVisible();
  await delayedRunButton.click();
  const runningNode = page.locator(".dag-node.running");
  await expect(runningNode).toHaveCount(1);
  const runningNodeId = await runningNode.getAttribute("data-node-id");
  if (runningNodeId === null) {
    throw new Error("The running graph node did not expose its stable node identity.");
  }
  await runningNode.click();

  const focusedNode = page.getByRole("button", {
    name: new RegExp(`^${runningNodeId}, step`, "u"),
  });
  await focusedNode.focus();
  const successfulPoll = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      new URL(response.url()).pathname === `/api/runs/${delayed.runId}`,
  );
  await successfulPoll;
  await expect(focusedNode).toBeFocused();
  const completion = await delayed.wait();
  expect(completion.exitCode).toBe(0);

  let failedOnePoll = false;
  await page.route("**/api/runs", async (route) => {
    if (!failedOnePoll) {
      failedOnePoll = true;
      await fulfillTransientFailure(route, "Synthetic refresh failure.");
      return;
    }
    await route.continue();
  });
  await expect(page.locator("#connection-status")).toContainText("Retrying");
  await expect(page.locator("#connection-status")).toHaveText("Live");

  await page.locator("#current-workflow-button").click();
  await scenario.setWorkflowSource("schemaVersion: 1\n");
  await expect(page.locator("#graph-status")).toHaveText("Definition invalid");
  await expect(page.locator("#graph-status")).toHaveClass(/\binvalid\b/u);
  await expect(page.locator("#diagnostics")).toContainText("SCHEMA_INVALID");
  await scenario.setWorkflowSource(scenario.workflowSource);
  await expect(page.locator("#graph-status")).toHaveText("Definition valid");
  await expect(page.locator("#diagnostics")).toBeEmpty();
});

const withAncestorLineage = async (page: Page, origin: string, runId: string): Promise<void> => {
  const ancestorRunId = `${runId}-ancestor`;
  await page.route(`${origin}/api/runs/${runId}`, async (route) => {
    const response = await route.fetch();
    const detail = (await response.json()) as ScopedRunDetailResponse;
    const ancestor: RunSummaryDto = {
      runId: ancestorRunId,
      workflowId: detail.run.workflowId,
      workflowScope: detail.run.workflowScope,
      revisionId: detail.run.revisionId,
      cwd: detail.run.cwd,
      status: "succeeded",
      startedAt: detail.run.startedAt,
      finishedAt: detail.run.startedAt,
      durationMs: 0,
    };
    const selected: RunSummaryDto = { ...detail.run, rerunOfRunId: ancestorRunId };
    await fulfillJson(route, {
      ...detail,
      run: selected,
      lineage: { runs: [ancestor, selected], selectedRunIndex: 1 },
    });
  });
};

test("the decision-needed banner tracks the waiting gate and clears when approved", async ({
  page,
  scenario,
  viewer,
}) => {
  const approvalRun = await scenario.startApprovalRun();
  try {
    await withAncestorLineage(page, viewer.origin, approvalRun.runId);
    await openViewer(page, viewer.launchUrl);

    const banner = page.locator("#decision-needed-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAccessibleName(/^Decision needed, deadline /u);

    const waitingRow = page.getByRole("button", {
      name: new RegExp(`^Run ${approvalRun.runId}, waiting for approval`, "u"),
    });
    await expect(waitingRow).toHaveAttribute("aria-current", "true");
    await expect(waitingRow).toContainText("Waiting for approval");
    await expect(waitingRow.locator(".status-glyph.waiting_for_approval")).toHaveCount(1);
    const lineageButton = page.locator("#lineage-list .lineage-button").last();
    await expect(lineageButton).toContainText("waiting for approval");
    await expect(lineageButton).toHaveAccessibleName(
      new RegExp(`^Inspect lineage run ${approvalRun.runId}, waiting for approval$`, "u"),
    );

    const [bannerCountdown, dockCountdown] = await page.evaluate(() => {
      const bannerText = document.querySelector(
        "#decision-needed-banner [data-live-deadline]",
      )?.textContent;
      const dockText = document.querySelector("#decision-dock .dock-deadline")?.textContent;
      return [bannerText ?? null, dockText ?? null] as const;
    });
    expect(bannerCountdown).not.toBeNull();
    expect(bannerCountdown).toContain("left");
    expect(bannerCountdown).toBe(dockCountdown);

    await banner.click();
    await expect(page.locator(".dag-node.waiting_for_approval")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#decision-approve")).toBeFocused();

    await page.locator("#decision-approve").click();
    await expect(banner).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`^Run ${approvalRun.runId}, waiting for approval`, "u"),
      }),
    ).toHaveCount(0);
    await expect(lineageButton).not.toContainText("waiting for approval");

    const completion = await approvalRun.wait();
    expect(completion.exitCode).toBe(0);
    await expect(
      page.getByRole("button", { name: new RegExp(`^Run ${approvalRun.runId}, succeeded`, "u") }),
    ).toHaveCount(1);
    await expect(lineageButton).toContainText("succeeded");
  } finally {
    approvalRun.cancel();
  }
});

test("the banner countdown matches the dock when the deadline is overdue", async ({
  page,
  scenario,
  viewer,
}) => {
  const approvalRun = await scenario.startApprovalRun();
  try {
    const pastDeadline = new Date(Date.now() - 90_000).toISOString();
    await page.route(`${viewer.origin}/api/runs/${approvalRun.runId}`, async (route) => {
      const response = await route.fetch();
      const detail = (await response.json()) as ScopedRunDetailResponse;
      const nodes = detail.nodes.map((node): NodeRunDto => {
        if (node.kind === "approval" && node.status === "waiting_for_approval") {
          return { ...node, deadlineAt: pastDeadline };
        }
        return node;
      });
      await route.fulfill({ response, body: JSON.stringify({ ...detail, nodes }) });
    });
    await openViewer(page, viewer.launchUrl);

    const banner = page.locator("#decision-needed-banner");
    await expect(banner).toBeVisible();
    const bannerCountdown = banner.locator("[data-live-deadline]");
    await expect(bannerCountdown).toContainText("overdue by");
    await expect(page.locator("#decision-dock .dock-deadline")).toContainText("overdue by");
    const [bannerText, dockText] = await page.evaluate(() => {
      const bannerNode = document.querySelector("#decision-needed-banner [data-live-deadline]");
      const dockNode = document.querySelector("#decision-dock .dock-deadline");
      return [bannerNode?.textContent ?? null, dockNode?.textContent ?? null] as const;
    });
    expect(bannerText).not.toBeNull();
    expect(bannerText).toBe(dockText);
  } finally {
    approvalRun.cancel();
  }
  const completion = await approvalRun.wait();
  expect(completion.exitCode).toBe(130);
});

test("the banner stays hidden for ordinary running and finished runs", async ({ page, viewer }) => {
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () =>
      runListResponse([ordinaryRunningSummary("run-ordinary"), succeededSummary("run-finished")]),
    runDetail: (runId) => {
      if (runId === "run-ordinary") {
        return gateRunDetail(ordinaryRunningSummary("run-ordinary"), runningNodes());
      }
      if (runId === "run-finished") {
        return gateRunDetail(succeededSummary("run-finished"), succeededNodes());
      }
      return undefined;
    },
  });
  await openViewer(page, viewer.launchUrl);

  const banner = page.locator("#decision-needed-banner");
  await expect(page.getByRole("button", { name: /^Run run-ordinary, running,/u })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(banner).toBeHidden();

  await page.getByRole("button", { name: /^Run run-finished, succeeded,/u }).click();
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText("run-finished");
  await expect(banner).toBeHidden();
});

test("a cancellation request hides the banner and clears the waiting label on the next poll", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let cancelRequested = false;
  let listRequests = 0;
  const summary = (): ReturnType<typeof waitingGateSummary> =>
    cancelRequested ? cancelRequestedSummary("run-gated") : waitingGateSummary("run-gated");
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => {
      listRequests += 1;
      return runListResponse([summary()]);
    },
    runDetail: (runId) =>
      runId === "run-gated"
        ? gateRunDetail(summary(), waitingGateNodes("gate-execution-1", deadlineAt))
        : undefined,
  });
  await openViewer(page, viewer.launchUrl);

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Run run-gated, waiting for approval,/u }),
  ).toHaveCount(1);

  const pollsBeforeFlip = listRequests;
  cancelRequested = true;
  await expect.poll(() => listRequests, { timeout: 10_000 }).toBeGreaterThan(pollsBeforeFlip);
  await expect(banner).toBeHidden();
  await expect(page.getByRole("button", { name: /^Run run-gated, running,/u })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /^Run run-gated, waiting for approval,/u }),
  ).toHaveCount(0);
});

test("the banner targets the outer loop node and occurrence of a waiting loop gate", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let decided = false;
  let decisionBody: string | null = null;
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: loopCurrentWorkflow,
    runList: () => loopRunListResponse(!decided),
    runDetail: (runId) => (runId === "loop-run" ? loopRunDetail(!decided, deadlineAt) : undefined),
  });
  await page.route(
    `${viewer.origin}/api/runs/loop-run/nodes/opaque-occurrence-gate/decision`,
    async (route) => {
      decisionBody = route.request().postData();
      await fulfillJson(route, syntheticApprovalDecision("loop-run", "opaque-occurrence-gate"));
    },
  );
  await openViewer(page, viewer.launchUrl);

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await banner.click();

  const outerNode = page.locator('.dag-node[data-node-id="refine"]');
  await expect(outerNode).toHaveAttribute("aria-selected", "true");
  const dock = page.locator("#decision-dock");
  await expect(dock).toBeVisible();
  await expect(dock.locator(".dock-question")).toHaveText("Approve the revised result?");
  await expect(dock.locator(".approval-commands")).toContainText(
    "kilin runs approve loop-run opaque-occurrence-gate --actor human",
  );
  await expect(page.locator("#decision-approve")).toBeFocused();

  decided = true;
  await page.locator("#decision-approve").click();
  await expect(banner).toBeHidden();
  expect(decisionBody).toBe(JSON.stringify({ decision: "approved" }));
});

test("the approval live region announces the waiting gate once and stays silent across identical polls", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let detailRequests = 0;
  await installApprovalEventLog(page);
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => runListResponse([waitingGateSummary("run-wait")]),
    runDetail: (runId) => {
      if (runId !== "run-wait") {
        return undefined;
      }
      detailRequests += 1;
      return gateRunDetail(
        waitingGateSummary("run-wait"),
        waitingGateNodes("gate-execution-1", deadlineAt),
      );
    },
  });
  await openViewer(page, viewer.launchUrl);

  await expect(page.locator("#decision-needed-banner")).toBeVisible();
  await expect(page.locator("#selection-announcement")).toHaveText(
    "Opened run run-wait, waiting for approval. Selected node gate.",
  );
  await expect.poll(() => readApprovalAnnouncements(page)).toHaveLength(1);
  expect((await readApprovalAnnouncements(page))[0]).toMatch(
    /^Decision needed for gate gate, deadline /u,
  );

  const observedRequests = detailRequests;
  await expect
    .poll(() => detailRequests, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(observedRequests + 2);
  expect(await readApprovalAnnouncements(page)).toHaveLength(1);
  await expect(page.locator("#selection-announcement")).toHaveText(
    "Opened run run-wait, waiting for approval. Selected node gate.",
  );
});

test("a replacement waiting gate announces once more", async ({ page, viewer }) => {
  const firstDeadline = new Date(Date.now() + 3_600_000).toISOString();
  const secondDeadline = new Date(Date.now() + 7_200_000).toISOString();
  let replacement = false;
  let detailRequests = 0;
  await installApprovalEventLog(page);
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => runListResponse([waitingGateSummary("run-wait")]),
    runDetail: (runId) => {
      if (runId !== "run-wait") {
        return undefined;
      }
      detailRequests += 1;
      return gateRunDetail(
        waitingGateSummary("run-wait"),
        waitingGateNodes(
          replacement ? "gate-execution-2" : "gate-execution-1",
          replacement ? secondDeadline : firstDeadline,
        ),
      );
    },
  });
  await openViewer(page, viewer.launchUrl);

  await expect(page.locator("#decision-needed-banner")).toBeVisible();
  await expect.poll(() => readApprovalAnnouncements(page)).toHaveLength(1);

  const observedRequests = detailRequests;
  replacement = true;
  await expect.poll(() => detailRequests, { timeout: 10_000 }).toBeGreaterThan(observedRequests);
  await expect.poll(() => readApprovalAnnouncements(page)).toHaveLength(2);
  const texts = await readApprovalAnnouncements(page);
  expect(texts[0]).toMatch(/^Decision needed for gate gate, deadline /u);
  expect(texts[1]).toMatch(/^Decision needed for gate gate, deadline /u);
  expect(texts[1]).not.toBe(texts[0]);
});

test("the live region announces the cleared gate after the recorded decision", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let decided = false;
  await installApprovalEventLog(page);
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () =>
      runListResponse([
        decided ? ordinaryRunningSummary("run-wait") : waitingGateSummary("run-wait"),
      ]),
    runDetail: (runId) => {
      if (runId !== "run-wait") {
        return undefined;
      }
      return decided
        ? gateRunDetail(ordinaryRunningSummary("run-wait"), decidedGateNodes("gate-execution-1"))
        : gateRunDetail(
            waitingGateSummary("run-wait"),
            waitingGateNodes("gate-execution-1", deadlineAt),
          );
    },
  });
  await page.route(
    `${viewer.origin}/api/runs/run-wait/nodes/gate-execution-1/decision`,
    async (route) => {
      await fulfillJson(route, syntheticApprovalDecision("run-wait", "gate-execution-1"));
    },
  );
  await openViewer(page, viewer.launchUrl);

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await banner.click();
  await expect(page.locator("#decision-approve")).toBeFocused();

  decided = true;
  await page.locator("#decision-approve").click();
  await expect(banner).toBeHidden();

  await expect.poll(() => readApprovalAnnouncements(page)).toHaveLength(2);
  const texts = await readApprovalAnnouncements(page);
  expect(texts[0]).toMatch(/^Decision needed for gate gate, deadline /u);
  expect(texts[1]).toBe("Approval gate gate is no longer waiting for a decision.");
  await expect(page.locator("#selection-announcement")).toHaveText(
    "Opened run run-wait, waiting for approval. Selected node gate.",
  );
});

test("focus moves from the disappearing banner to the gate's loop graph node", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let waiting = true;
  let detailRequests = 0;
  await installApprovalEventLog(page);
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: loopCurrentWorkflow,
    runList: () => loopRunListResponse(waiting),
    runDetail: (runId) => {
      if (runId !== "loop-run") {
        return undefined;
      }
      detailRequests += 1;
      return loopRunDetail(waiting, deadlineAt);
    },
  });
  await openViewer(page, viewer.launchUrl);
  await page.bringToFront();

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await banner.focus();
  await expect(banner).toBeFocused();

  const observedRequests = detailRequests;
  waiting = false;
  await expect.poll(() => detailRequests, { timeout: 10_000 }).toBeGreaterThan(observedRequests);
  await expect(banner).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-node-id") ?? null))
    .toBe("refine");

  const log = await readApprovalEventLog(page);
  const disappearance = "Approval gate gate is no longer waiting for a decision.";
  expect(log.some((entry) => entry.type === "announcement" && entry.text === disappearance)).toBe(
    true,
  );
  expect(
    log.some(
      (entry) =>
        entry.type === "focusin" &&
        entry.key === "refine" &&
        entry.announcementAtFocus === disappearance,
    ),
  ).toBe(true);
});

test("focus falls back to the waiting run's history button after a run switch", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  const heldDetailRoute = deferred<Route>();
  let holdRunBDetail = false;
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => runListResponse([waitingGateSummary("run-a"), ordinaryRunningSummary("run-b")]),
    runDetail: (runId) => {
      if (runId === "run-a") {
        return gateRunDetail(
          waitingGateSummary("run-a"),
          waitingGateNodes("gate-execution-1", deadlineAt),
        );
      }
      if (runId === "run-b") {
        return gateRunDetail(ordinaryRunningSummary("run-b"), runningNodes());
      }
      return undefined;
    },
  });
  await page.route(`${viewer.origin}/api/runs/run-b`, async (route) => {
    if (holdRunBDetail) {
      heldDetailRoute.resolve(route);
      return;
    }
    await fulfillJson(route, gateRunDetail(ordinaryRunningSummary("run-b"), runningNodes()));
  });
  await openViewer(page, viewer.launchUrl);
  await page.bringToFront();

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await banner.focus();
  await expect(banner).toBeFocused();

  holdRunBDetail = true;
  await page.evaluate(() => {
    const button = document.querySelector('.history-button[data-run-id="run-b"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("The synthetic ordinary run did not render its history button.");
    }
    button.click();
  });
  await expect(page.locator('.history-button[data-run-id="run-a"]')).toBeFocused();

  const heldDetail = await heldDetailRoute.promise;
  await fulfillJson(heldDetail, gateRunDetail(ordinaryRunningSummary("run-b"), runningNodes()));
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText("run-b");
});

test("a decision recorded during a run switch clears the row and ignores the aborted stale poll", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  let armed = false;
  const staleListRoute = deferred<Route>();
  const staleDetailRoute = deferred<Route>();
  const heldDecisionRoute = deferred<Route>();
  await page.route(`${viewer.origin}/api/workflow`, async (route) => {
    await fulfillJson(route, gateCurrentWorkflow());
  });
  await page.route(`${viewer.origin}/api/runs`, async (route) => {
    if (armed) {
      staleListRoute.resolve(route);
      return;
    }
    await fulfillJson(
      route,
      runListResponse([waitingGateSummary("run-a"), ordinaryRunningSummary("run-b")]),
    );
  });
  await page.route(`${viewer.origin}/api/runs/run-a`, async (route) => {
    if (armed) {
      staleDetailRoute.resolve(route);
      return;
    }
    await fulfillJson(
      route,
      gateRunDetail(waitingGateSummary("run-a"), waitingGateNodes("gate-execution-1", deadlineAt)),
    );
  });
  await page.route(`${viewer.origin}/api/runs/run-b`, async (route) => {
    await fulfillJson(route, gateRunDetail(ordinaryRunningSummary("run-b"), runningNodes()));
  });
  await page.route(`${viewer.origin}/api/runs/run-a/nodes/0/output/result`, async (route) => {
    await fulfillJson(route, syntheticOutputResponse("run-a", 0, "result"));
  });
  await page.route(`${viewer.origin}/api/runs/run-a/nodes/gate-execution-1/decision`, (route) => {
    heldDecisionRoute.resolve(route);
  });
  await openViewer(page, viewer.launchUrl);
  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  await banner.click();
  await expect(page.locator("#decision-approve")).toBeFocused();

  armed = true;
  const staleList = await staleListRoute.promise;
  const staleDetail = await staleDetailRoute.promise;
  await page.locator("#decision-approve").click();
  const heldDecision = await heldDecisionRoute.promise;

  await page.getByRole("button", { name: /^Run run-b, running,/u }).click();
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText("run-b");

  await fulfillJson(heldDecision, syntheticApprovalDecision("run-a", "gate-execution-1"));
  await fulfillJson(
    staleList,
    runListResponse([waitingGateSummary("run-a"), ordinaryRunningSummary("run-b")]),
  );
  await fulfillJson(
    staleDetail,
    gateRunDetail(waitingGateSummary("run-a"), waitingGateNodes("gate-execution-1", deadlineAt)),
  );
  await waitForBrowserRendering(page);

  await expect(page.getByRole("button", { name: /^Run run-a, running,/u })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: /^Run run-a, waiting for approval,/u }),
  ).toHaveCount(0);
  await expect(banner).toBeHidden();
});

test("the banner fits the narrow topbar without overlap or overflow at 390x844", async ({
  page,
  viewer,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  await installWorldRoutes(page, viewer.origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => runListResponse([waitingGateSummary("run-wait")]),
    runDetail: (runId) =>
      runId === "run-wait"
        ? gateRunDetail(
            waitingGateSummary("run-wait"),
            waitingGateNodes("gate-execution-1", deadlineAt),
          )
        : undefined,
  });
  await openViewer(page, viewer.launchUrl);

  const banner = page.locator("#decision-needed-banner");
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const brandBox = await page.locator(".brand-block").boundingBox();
  const statusBox = await page.locator("#connection-status").boundingBox();
  const topbarBox = await page.locator(".topbar").boundingBox();
  const graphBox = await page.locator(".graph-region").boundingBox();
  if (
    bannerBox === null ||
    brandBox === null ||
    statusBox === null ||
    topbarBox === null ||
    graphBox === null
  ) {
    throw new Error("The banner geometry contract could not locate every topbar region.");
  }
  const overlaps = (
    first: { x: number; y: number; width: number; height: number },
    second: { x: number; y: number; width: number; height: number },
  ): boolean =>
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height;
  expect(overlaps(bannerBox, brandBox)).toBe(false);
  expect(overlaps(bannerBox, statusBox)).toBe(false);
  expect(overlaps(brandBox, statusBox)).toBe(false);
  expect(bannerBox.x).toBeGreaterThanOrEqual(0);
  expect(bannerBox.y).toBeGreaterThanOrEqual(0);
  expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(390);
  expect(bannerBox.y + bannerBox.height).toBeLessThanOrEqual(844);
  expect(bannerBox.width).toBeGreaterThanOrEqual(44);
  expect(bannerBox.height).toBeGreaterThanOrEqual(44);
  expect(topbarBox.y + topbarBox.height).toBeLessThanOrEqual(graphBox.y);
  await expect(documentHasNoHorizontalOverflow(page)).resolves.toBe(true);

  await saveScreenshot(page, "viewer-banner-mobile.png", "viewer-banner-mobile-390x844", testInfo);
});

test("refresh polls at once and restarts the poll backoff after failures", async ({
  page,
  viewer,
}) => {
  test.slow();
  await openViewer(page, viewer.launchUrl);

  let pollRequests = 0;
  let pollFails = true;
  await page.route("**/api/workflow", async (route) => {
    pollRequests += 1;
    if (!pollFails) {
      await route.continue();
      return;
    }
    await fulfillTransientFailure(route, `Synthetic refresh failure ${String(pollRequests)}.`);
  });

  const status = page.locator("#connection-status");
  await expect(status).toContainText("Synthetic refresh failure 2.", { timeout: 15_000 });

  const refresh = page.getByRole("button", { name: "Refresh" });
  const beforeManualCycle = pollRequests;
  await refresh.press("Enter");
  await expect.poll(() => pollRequests, { timeout: 1_000 }).toBeGreaterThan(beforeManualCycle);

  const afterManualCycle = pollRequests;
  await expect.poll(() => pollRequests, { timeout: 6_000 }).toBeGreaterThan(afterManualCycle);
  await expect(status).toContainText("Synthetic refresh failure 4.");

  pollFails = false;
  const beforeRecovery = pollRequests;
  await refresh.press("Enter");
  await expect.poll(() => pollRequests, { timeout: 2_000 }).toBeGreaterThan(beforeRecovery);
  await expect(status).toHaveText("Live", { timeout: 3_000 });
});

const historyWorld = async (
  page: Page,
  origin: string,
  runs: readonly RunSummaryDto[],
): Promise<void> => {
  await installWorldRoutes(page, origin, {
    currentWorkflow: gateCurrentWorkflow,
    runList: () => runListResponse(runs),
    runDetail: (runId) => {
      const summary = runs.find((run) => run.runId === runId);
      if (summary === undefined) {
        return undefined;
      }
      return gateRunDetail(
        summary,
        summary.status === "running" ? runningNodes() : succeededNodes(),
      );
    },
  });
};

const runningThreeMinutesAgo = (now: number): RunSummaryDto => ({
  ...ordinaryRunningSummary("0f2b8c14-9a3d-4a71-8b52-6c1d9e4f2a37"),
  startedAt: new Date(now - 210_000).toISOString(),
});

const succeededTwoDaysAgo = (now: number): RunSummaryDto => {
  const startedAt = new Date(now - 216_000_000).toISOString();
  return {
    ...succeededSummary("5c7e1a92-4d68-4f03-9e21-7b0a3c6d5e84"),
    startedAt,
    finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(),
    durationMs: 60_000,
  };
};

test("run history states recency in words and keeps the exact start time reachable", async ({
  page,
  viewer,
}) => {
  const now = Date.now();
  const running = runningThreeMinutesAgo(now);
  const finished = succeededTwoDaysAgo(now);
  await historyWorld(page, viewer.origin, [running, finished]);
  await openViewer(page, viewer.launchUrl);

  const runningRow = page.locator(`.history-button[data-run-id="${running.runId}"]`);
  const finishedRow = page.locator(`.history-button[data-run-id="${finished.runId}"]`);
  await expect(runningRow.locator("[data-live-relative]")).toHaveText("3 min ago");
  await expect(finishedRow.locator("[data-live-relative]")).toHaveText("2 days ago");

  const absolute = await page.evaluate(
    (iso) =>
      new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    finished.startedAt,
  );
  await expect(finishedRow.locator("[data-live-relative]")).toHaveAttribute("title", absolute);
  const accessibleName = await finishedRow.getAttribute("aria-label");
  expect(accessibleName).toContain(absolute);
  expect(accessibleName).toContain(finished.runId);

  const statusRow = (runId: string): Promise<string | null> =>
    page.locator(`.history-button[data-run-id="${runId}"] .history-meta`).first().textContent();
  const recordedDuration = "Succeeded · 1m 00s";
  expect(await statusRow(finished.runId)).toBe(recordedDuration);
  const runningElapsed = await statusRow(running.runId);
  await expect.poll(() => statusRow(running.runId)).not.toBe(runningElapsed);
  expect(await statusRow(finished.runId)).toBe(recordedDuration);
});

test("a history row shows a short run id while copy still yields the whole id", async ({
  page,
  viewer,
}) => {
  const running = runningThreeMinutesAgo(Date.now());
  await historyWorld(page, viewer.origin, [running]);
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: viewer.origin });
  await openViewer(page, viewer.launchUrl);

  const row = page.locator(`.history-button[data-run-id="${running.runId}"]`);
  await expect(row.locator(".history-run-id")).toHaveText(`${running.runId.slice(0, 12)}…`);
  await page.locator(`.copy-run-id[data-run-id="${running.runId}"]`).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(running.runId);
});

test("the run inspector offers a cancel fallback only while the run is live", async ({
  page,
  viewer,
}) => {
  const now = Date.now();
  const running = runningThreeMinutesAgo(now);
  const finished = succeededTwoDaysAgo(now);
  const draining = cancelRequestedSummary("9b41d7e0-2c85-4a19-b6f3-8e5a0d1c7f26");
  await historyWorld(page, viewer.origin, [running, draining, finished]);
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin: viewer.origin });
  await openViewer(page, viewer.launchUrl);

  await expect(page.locator("#run-inspector .inspector-title")).toHaveText(running.runId);
  await expect(page.locator("#lineage-section")).toBeHidden();
  await expect(
    page.locator("#run-inspector .property-list dt").filter({ hasText: "Revision" }),
  ).toHaveText("Revision (content hash)");

  const commands = page.locator("#run-inspector .run-commands");
  const command = `kilin runs cancel ${running.runId}`;
  await expect(commands.locator("code")).toHaveText(command);
  await commands.getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  const focusedCommand = (): Promise<string | null> =>
    page.evaluate(() => document.activeElement?.getAttribute("data-copy-command") ?? null);
  await commands.getByRole("button", { name: "Copy" }).focus();
  expect(await focusedCommand()).toBe(command);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/runs/${running.runId}`,
    );
  }
  expect(await focusedCommand()).toBe(command);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(commands.locator("code")).toBeVisible();
  await expect(documentHasNoHorizontalOverflow(page)).resolves.toBe(true);

  await page.locator(`.history-button[data-run-id="${draining.runId}"]`).click();
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText(draining.runId);
  await expect(
    page.locator("#run-inspector .property-list dt").filter({ hasText: "Cancellation requested" }),
  ).toHaveCount(1);
  await expect(page.locator("#run-inspector .run-commands")).toHaveCount(0);

  await page.locator(`.history-button[data-run-id="${finished.runId}"]`).click();
  await expect(page.locator("#run-inspector .inspector-title")).toHaveText(finished.runId);
  await expect(page.locator("#run-inspector .run-commands")).toHaveCount(0);
});
