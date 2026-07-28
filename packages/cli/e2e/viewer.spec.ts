import type { Page, Response, Route, TestInfo } from "@playwright/test";

import type {
  CurrentWorkflowResponse,
  LoopIterationDto,
  ScopedRunDetailResponse,
  ScopedRunListResponse,
  WorkflowGraphDto,
} from "../src/ui/contracts.js";
import { expect, test } from "./fixtures.js";

const openViewer = async (page: Page, launchUrl: string): Promise<Response> => {
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#connection-status")).toHaveText("Attached · guarded approval");
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

  expect(new URL(page.url()).hash).toBe("");
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
  await expect(page.locator("#run-inspector .failure-copy")).toContainText("NODE_EXIT_NONZERO");
  await expect(page.locator("#run-inspector .failure-reference")).toHaveCount(0);

  const analyzeNode = page.getByRole("button", { name: /^analyze, step 1,/u });
  const changeNode = page.getByRole("button", { name: /^change, step 2,/u });
  await analyzeNode.click();
  await expect(page.locator("#output-panel")).toContainText("result:analyze");
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
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, running`) })
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
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, running`) })
      .click();
    await page.locator(".dag-node.waiting_for_approval").click();

    await expect.poll(() => upstreamEvidenceRequests, { timeout: 8_000 }).toBe(4);
    await page.waitForTimeout(2_500);
    expect(upstreamEvidenceRequests).toBe(4);
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
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, running`) })
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
      .getByRole("button", { name: new RegExp(`Run ${approvalRun.runId}, running`) })
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
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.failedRunId}, failed`) })
    .click();
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
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          outputVersion: 1,
          error: { code: "TRANSIENT_TEST_FAILURE", message: "Synthetic refresh failure." },
        }),
      });
      return;
    }
    await route.continue();
  });
  await expect(page.locator("#connection-status")).toContainText("Retrying");
  await expect(page.locator("#connection-status")).toHaveText("Attached · guarded approval");

  await page.locator("#current-workflow-button").click();
  await scenario.setWorkflowSource("schemaVersion: 1\n");
  await expect(page.locator("#graph-status")).toHaveText("invalid");
  await expect(page.locator("#diagnostics")).toContainText("SCHEMA_INVALID");
  await scenario.setWorkflowSource(scenario.workflowSource);
  await expect(page.locator("#graph-status")).toHaveText("valid");
  await expect(page.locator("#diagnostics")).toBeEmpty();
});
