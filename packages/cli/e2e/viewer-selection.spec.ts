import type { Page } from "@playwright/test";

import type { ScopedRunDetailResponse, ScopedRunListResponse } from "../src/ui/contracts.js";
import type { SyntheticWorld } from "./approval-world.js";
import {
  gateCurrentWorkflow,
  gateRunDetail,
  installWorldRoutes,
  ordinaryRunningSummary,
  runListResponse,
  runningNodes,
  waitingGateNodes,
  waitingGateSummary,
} from "./approval-world.js";
import { expect, test } from "./fixtures.js";

const openViewer = async (page: Page, launchUrl: string): Promise<void> => {
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#connection-status")).toHaveText("Live");
};

const reloadViewer = async (page: Page): Promise<void> => {
  await page.reload();
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
};

const reloadViewerWithHash = async (
  page: Page,
  origin: string,
  fragment: string,
): Promise<void> => {
  await page.goto(`${origin}/#${fragment}`);
  await reloadViewer(page);
};

const activeGraphNodeId = async (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute("data-node-id") ?? null);

test.describe.configure({ mode: "serial" });

test("opening the viewer during a waiting approval selects the gate with no clicks", async ({
  page,
  scenario,
  viewer,
}) => {
  const approvalRun = await scenario.startApprovalRun();
  try {
    await openViewer(page, viewer.launchUrl);

    await expect(
      page.getByRole("button", {
        name: new RegExp(`Run ${approvalRun.runId}, waiting for approval`),
      }),
    ).toHaveAttribute("aria-current", "true");
    const gateNode = page.locator(".dag-node.waiting_for_approval");
    await expect(gateNode).toHaveAttribute("aria-selected", "true");
    await expect(gateNode).toHaveAttribute("tabindex", "0");
    await expect.poll(() => activeGraphNodeId(page)).toBe("gate");
    await expect(page.locator("#decision-dock")).toBeVisible();
    await expect(page.locator("#decision-dock .dock-question")).toHaveText(
      "Ship these verified changes?",
    );
    await expect(page.locator("#selection-announcement")).toHaveText(
      `Opened run ${approvalRun.runId}, waiting for approval. Selected node gate.`,
    );
    expect(new URL(page.url()).hash).toContain(`run=${approvalRun.runId}`);
  } finally {
    approvalRun.cancel();
  }
  const completion = await approvalRun.wait();
  expect(completion.exitCode).toBe(130);
});

test("opening the viewer during a running run selects the running node", async ({
  page,
  scenario,
  viewer,
}) => {
  test.slow();
  const delayed = await scenario.startDelayedRun(6_000);
  try {
    await openViewer(page, viewer.launchUrl);

    await expect(
      page.getByRole("button", { name: new RegExp(`Run ${delayed.runId}, running`) }),
    ).toHaveAttribute("aria-current", "true");
    const runningNode = page.locator(".dag-node.running");
    await expect(runningNode).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => activeGraphNodeId(page)).toBe("analyze");
    // The executing node names the process it is running, so a stuck provider is identifiable
    // without searching the process table.
    await expect(page.locator("#node-inspector")).toContainText(/Process\s*[1-9]\d*/u);
    await expect(page.locator("#node-inspector [data-live-elapsed]")).toHaveCount(1);
  } finally {
    delayed.cancel();
  }
  const completion = await delayed.wait();
  expect(completion.exitCode).toBe(130);
});

test("the location hash restores the run, node, stream, and view after reload", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);

  await reloadViewerWithHash(page, viewer.origin, `run=${scenario.failedRunId}`);
  await expect(
    page.getByRole("button", { name: new RegExp(`Run ${scenario.failedRunId}, failed`) }),
  ).toHaveAttribute("aria-current", "true");
  const failedNode = page.locator(".dag-node.failed");
  await expect(failedNode).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#node-inspector .failure-copy")).toContainText("NODE_EXIT_NONZERO");

  await page.getByRole("button", { name: /^analyze, step 1,/u }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Raw" }).click();
  await expect.poll(() => new URL(page.url()).hash).toContain("view=raw");
  const hash = new URL(page.url()).hash;
  expect(hash).toContain(`run=${scenario.failedRunId}`);
  expect(hash).toContain("node=analyze");
  expect(hash).toContain("stream=stdout");

  await reloadViewer(page);
  const analyzeNode = page.getByRole("button", { name: /^analyze, step 1,/u });
  await expect(analyzeNode).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => activeGraphNodeId(page)).toBe("analyze");
  await expect(page.getByRole("tab", { name: "Activity" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "Raw" })).toHaveAttribute("aria-pressed", "true");
});

test("a stale hash run id falls back without an error state and Current persists", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);

  await reloadViewerWithHash(page, viewer.origin, "run=run-that-never-existed");
  await expect(page.locator("#connection-status")).toHaveText("Live");
  await expect(
    page.getByRole("button", { name: new RegExp(`Run ${scenario.interruptedRunId}, interrupted`) }),
  ).toHaveAttribute("aria-current", "true");

  await page.locator("#current-workflow-button").click();
  await expect.poll(() => new URL(page.url()).hash).toBe("#current");
  await reloadViewer(page);
  await expect(page.locator("#current-workflow-button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#graph-context")).toHaveText("Current workflow");
});

test("with no stored runs the viewer keeps the definition view", async ({ page, viewer }) => {
  const emptyRunList: ScopedRunListResponse = {
    outputVersion: 1,
    workflowId: "viewer-release",
    workflowScope: "project",
    runs: [],
  };
  await page.route(`${viewer.origin}/api/runs`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(emptyRunList),
    });
  });
  await openViewer(page, viewer.launchUrl);

  await expect(page.locator("#history-empty")).toBeVisible();
  await expect(page.locator("#graph-context")).toHaveText("Current workflow");
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/runs" && response.status() === 200,
  );
  await expect(page.locator("#graph-context")).toHaveText("Current workflow");
  expect(new URL(page.url()).hash).toBe("");
});

const gatedSelectionWorld = (deadlineAt: string): SyntheticWorld => ({
  currentWorkflow: gateCurrentWorkflow,
  runList: () =>
    runListResponse([
      ordinaryRunningSummary("run-new"),
      waitingGateSummary("run-wait-a"),
      waitingGateSummary("run-wait-b"),
    ]),
  runDetail: (runId): ScopedRunDetailResponse | undefined => {
    if (runId === "run-new") {
      return gateRunDetail(ordinaryRunningSummary("run-new"), runningNodes());
    }
    if (runId === "run-wait-a") {
      return gateRunDetail(
        waitingGateSummary("run-wait-a"),
        waitingGateNodes("gate-execution-a", deadlineAt),
      );
    }
    if (runId === "run-wait-b") {
      return gateRunDetail(
        waitingGateSummary("run-wait-b"),
        waitingGateNodes("gate-execution-b", deadlineAt),
      );
    }
    return undefined;
  },
});

test("initial selection prefers the first waiting run over a newer ordinary running run", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  await installWorldRoutes(page, viewer.origin, gatedSelectionWorld(deadlineAt));
  await openViewer(page, viewer.launchUrl);

  await expect(
    page.getByRole("button", { name: /^Run run-wait-a, waiting for approval,/u }),
  ).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#decision-needed-banner")).toBeVisible();
  await expect(page.locator("#selection-announcement")).toHaveText(
    "Opened run run-wait-a, waiting for approval. Selected node gate.",
  );
});

test("an explicit valid hash wins over waiting-first initial selection", async ({
  page,
  viewer,
}) => {
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();
  await installWorldRoutes(page, viewer.origin, gatedSelectionWorld(deadlineAt));
  await openViewer(page, viewer.launchUrl);

  await reloadViewerWithHash(page, viewer.origin, "run=run-new");
  await expect(page.getByRole("button", { name: /^Run run-new, running,/u })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("#decision-needed-banner")).toBeHidden();
});
