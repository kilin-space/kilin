import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures.js";
import type { ViewerScenario } from "./fixtures.js";

const nodeOutputPath = (
  scenario: ViewerScenario,
  runId: string,
  nodeDirectory: string,
  fileName: string,
): string => join(scenario.stateDirectory, "runs", runId, "nodes", nodeDirectory, fileName);

const codexActivityJsonl = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-evidence" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.started", item: { id: "item_0", type: "reasoning", text: "" } }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "reasoning", text: "**Scanning the repository**" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_1", type: "reasoning", text: "**Choosing a fix**" },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: "Done. <script>alert(1)</script> must stay inert text.",
    },
  }),
  JSON.stringify({
    type: "item.started",
    item: {
      id: "item_3",
      type: "command_execution",
      command: "pnpm test",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_3",
      type: "command_execution",
      command: "pnpm test",
      aggregated_output: "501 passed",
      exit_code: 0,
      status: "completed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_4",
      type: "command_execution",
      command: "exit 23",
      aggregated_output: "boom",
      exit_code: 23,
      status: "failed",
    },
  }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_5", type: "collab_tool_call", tool: "wait", status: "completed" },
  }),
  "{not json",
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 3_240_735, output_tokens: 15_385 },
  }),
  "",
].join("\n");

const hostileResultMarkdown = `# Audit report

Intro with **bold**, *italic*, and \`code\` spans.

- first bullet
- second bullet

1. ordered one
2. ordered two

[Approve fixes](https://example.invalid/approve)

<img src=x onerror="alert(1)">

\`\`\`bash
rm -rf / # displayed, never run
<script>alert(2)</script>
\`\`\`
`;

const claudeActivityJsonl = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking: "Plan the demo change" }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Applying the change now." },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "pnpm lint" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "lint ok" }] },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: { command: "false" } }],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu_2", content: "failed hard", is_error: true },
      ],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "tu_3", name: "Read", input: { file_path: "/repo/file.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1_200, output_tokens: 340 },
  }),
  "",
].join("\n");

const partialFirstLineJsonl = `${JSON.stringify({
  type: "item.completed",
  item: {
    id: "partial_0",
    type: "agent_message",
    text: `PARTIAL_HEAD ${"y".repeat(70_000)} PARTIAL_LINE_END_MARKER`,
  },
})}\n${JSON.stringify({
  type: "item.completed",
  item: { id: "after_0", type: "agent_message", text: "AFTER_BOUNDARY_MESSAGE" },
})}\n`;

const undeclaredMachineResult = [
  "snapshot-2026-07-21-ORDINARY_JSON_LOOKALIKE",
  '{"kind":"decision_packet","type":"inventory_policy"}',
  "def __init__(self, *args): pass",
].join("\n");

const seedEvidenceStreams = async (scenario: ViewerScenario): Promise<void> => {
  const runId = scenario.successfulRunId;
  await Promise.all([
    writeFile(nodeOutputPath(scenario, runId, "000-analyze", "stdout.log"), codexActivityJsonl, {
      mode: 0o600,
    }),
    writeFile(nodeOutputPath(scenario, runId, "000-analyze", "result.txt"), hostileResultMarkdown, {
      mode: 0o600,
    }),
    writeFile(nodeOutputPath(scenario, runId, "001-change", "stdout.log"), claudeActivityJsonl, {
      mode: 0o600,
    }),
    writeFile(
      nodeOutputPath(scenario, runId, "001-change", "result.txt"),
      undeclaredMachineResult,
      { mode: 0o600 },
    ),
    writeFile(nodeOutputPath(scenario, runId, "002-verify", "stdout.log"), partialFirstLineJsonl, {
      mode: 0o600,
    }),
  ]);
};

const openViewer = async (page: Page, launchUrl: string): Promise<void> => {
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
};

test.describe.configure({ mode: "serial" });

test("stdout renders typed activity rows from codex and claude streams with inert hostile lines", async ({
  page,
  scenario,
  viewer,
}) => {
  await seedEvidenceStreams(scenario);
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.successfulRunId}, succeeded`) })
    .click();

  const panel = page.locator("#output-panel");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(panel.locator(".row-tag")).toHaveText([
    "Reason",
    "Message",
    "Run",
    "Run",
    "Tool",
    "Raw",
    "Turn",
  ]);
  const reasonRow = panel.locator(".activity-reason .row-body");
  await expect(reasonRow).toContainText("Scanning the repository");
  await expect(reasonRow).toContainText("Choosing a fix");
  await expect(panel.locator(".activity-message")).toContainText(
    "<script>alert(1)</script> must stay inert text.",
  );
  await expect(panel.locator("script")).toHaveCount(0);
  const passingRun = panel.locator(".activity-run").first();
  await expect(passingRun.locator(".run-command")).toHaveText("pnpm test");
  await expect(passingRun.locator(".exit-badge")).toHaveText("exit 0");
  await passingRun.locator("summary").click();
  await expect(passingRun.locator(".run-output")).toBeVisible();
  await expect(passingRun.locator(".run-output")).toHaveText("501 passed");
  const failingRun = panel.locator(".activity-run").last();
  await expect(failingRun.locator(".exit-badge")).toHaveText("exit 23");
  await expect(panel.locator(".activity-tool")).toContainText("wait");
  await expect(panel.locator(".activity-raw")).toHaveText(/Raw\{not json/u);
  await expect(panel.locator(".usage-chip")).toHaveText("3.2M in · 15.4K out");

  await page.getByRole("button", { name: "Raw" }).click();
  await expect(panel.locator(".stream-text")).toContainText('"thread.started"');
  await expect(panel.locator(".stream-text")).toContainText("{not json");
  await page.getByRole("button", { name: "Rendered" }).click();

  await page.getByRole("button", { name: /^change, step 2,/u }).click();
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(panel.locator(".row-tag")).toHaveText([
    "Reason",
    "Message",
    "Run",
    "Run",
    "Tool",
    "Turn",
  ]);
  await expect(panel.locator(".activity-reason")).toContainText("Plan the demo change");
  await expect(panel.locator(".activity-message")).toContainText("Applying the change now.");
  const lintRun = panel.locator(".activity-run").first();
  await expect(lintRun.locator(".run-command")).toHaveText("pnpm lint");
  await expect(lintRun.locator(".exit-badge")).toHaveText("ok");
  await lintRun.locator("summary").click();
  await expect(lintRun.locator(".run-output")).toHaveText("lint ok");
  const errorRun = panel.locator(".activity-run").last();
  await expect(errorRun.locator(".exit-badge")).toHaveText("error");
  await expect(panel.locator(".activity-tool .tool-label")).toHaveText("Read");
  await expect(panel.locator(".activity-tool .tool-detail")).toContainText("/repo/file.ts");
  await expect(panel.locator(".usage-chip")).toHaveText("1.2K in · 340 out");
});

test("a result without a declared prose type keeps every emitted byte verbatim", async ({
  page,
  scenario,
  viewer,
}) => {
  await seedEvidenceStreams(scenario);
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.successfulRunId}, succeeded`) })
    .click();
  await page.getByRole("button", { name: /^change, step 2,/u }).click();
  await page.getByRole("tab", { name: "Result" }).click();

  await expect
    .poll(() => page.locator("#output-panel").textContent())
    .toBe(undeclaredMachineResult);
});

test("a declared prose result renders sanitized markdown with inert links and no live HTML", async ({
  page,
  scenario,
  viewer,
}) => {
  await writeFile(
    nodeOutputPath(scenario, scenario.proseResultRunId, "000-judge", "result.txt"),
    hostileResultMarkdown,
    { mode: 0o600 },
  );
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.proseResultRunId}, succeeded`) })
    .click();

  const panel = page.locator("#output-panel");
  const document_ = panel.locator(".result-document");
  await expect(document_.getByRole("heading", { name: "Audit report" })).toBeVisible();
  await expect(document_.locator("strong")).toHaveText("bold");
  await expect(document_.locator("em")).toHaveText("italic");
  await expect(document_.locator("p code")).toHaveText("code");
  await expect(document_.locator("ul li")).toHaveText(["first bullet", "second bullet"]);
  await expect(document_.locator("ol li")).toHaveText(["ordered one", "ordered two"]);
  await expect(document_.locator(".md-link")).toHaveText("Approve fixes");
  await expect(document_.locator(".md-link")).toHaveAttribute(
    "title",
    "https://example.invalid/approve",
  );
  await expect(panel.locator("a")).toHaveCount(0);
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.locator("script")).toHaveCount(0);
  await expect(document_).toContainText('<img src=x onerror="alert(1)">');
  await expect(document_.locator(".md-code-block")).toContainText("<script>alert(2)</script>");
});

test("a truncated tail drops its partial first line for parsing while raw keeps exact bytes", async ({
  page,
  scenario,
  viewer,
}) => {
  await seedEvidenceStreams(scenario);
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.successfulRunId}, succeeded`) })
    .click();
  await page.getByRole("button", { name: /^verify, step 3,/u }).click();
  await page.getByRole("tab", { name: "Activity" }).click();

  const panel = page.locator("#output-panel");
  await expect(page.locator("#evidence-banner")).toContainText("Showing the newest 64 KiB");
  await expect(panel.locator(".activity-message")).toHaveText(/Message\s*AFTER_BOUNDARY_MESSAGE/u);
  await expect(panel).not.toContainText("PARTIAL_LINE_END_MARKER");
  await expect(panel.locator(".activity-row")).toHaveCount(1);

  await page.getByRole("button", { name: "Raw" }).click();
  await expect(panel.locator(".stream-text")).toContainText("PARTIAL_LINE_END_MARKER");
  await expect(panel.locator(".stream-text")).toContainText("AFTER_BOUNDARY_MESSAGE");
});

test("the selected stream live-tails on the poll cadence while its node runs", async ({
  page,
  scenario,
  viewer,
}) => {
  await openViewer(page, viewer.launchUrl);
  const streaming = await scenario.startStreamingRun(4_000);
  await page.getByRole("button", { name: new RegExp(`Run ${streaming.runId}, running`) }).click();
  await page.getByRole("tab", { name: "Activity" }).click();

  const panel = page.locator("#output-panel");
  await expect(panel.locator(".activity-message").first()).toContainText("FIRST_STREAM_MESSAGE");
  await expect(page.locator("#output-meta")).toContainText("live tail");
  const outputRequestPath = `/api/runs/${streaming.runId}/nodes/0/output/stdout`;
  await page.waitForRequest((request) => new URL(request.url()).pathname === outputRequestPath);
  await page.waitForRequest((request) => new URL(request.url()).pathname === outputRequestPath);
  await expect(panel.locator(".activity-message").last()).toContainText("SECOND_STREAM_MESSAGE", {
    timeout: 15_000,
  });

  const completion = await streaming.wait();
  expect(completion.exitCode).toBe(0);
  await expect(page.getByRole("tab", { name: "Result" })).toBeVisible();
});

const installEvidenceAlertLog = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const holder = window as unknown as { __evidenceAlerts: string[] };
    holder.__evidenceAlerts = [];
    document.addEventListener("DOMContentLoaded", () => {
      const panel = document.getElementById("output-panel");
      if (panel === null) {
        return;
      }
      new MutationObserver((records) => {
        for (const record of records) {
          for (const added of Array.from(record.addedNodes)) {
            if (added instanceof Element && added.getAttribute("role") === "alert") {
              holder.__evidenceAlerts.push(added.textContent);
            }
          }
        }
      }).observe(panel, { childList: true });
    });
  });
};

const readEvidenceAlerts = async (page: Page): Promise<readonly string[]> =>
  page.evaluate(() => {
    const holder = window as unknown as { __evidenceAlerts?: string[] };
    return holder.__evidenceAlerts ?? [];
  });

const waitForRunListPoll = async (page: Page): Promise<void> => {
  await page.waitForResponse(
    (response) => response.status() === 200 && new URL(response.url()).pathname === "/api/runs",
  );
};

test("a failed evidence read offers a keyboard retry that reloads the stream", async ({
  page,
  scenario,
  viewer,
}) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await installEvidenceAlertLog(page);
  await writeFile(
    nodeOutputPath(scenario, scenario.successfulRunId, "000-analyze", "result.txt"),
    "RETRIED_EVIDENCE_BODY",
    { mode: 0o600 },
  );
  let outputReadFails = true;
  await page.route("**/api/runs/*/nodes/*/output/*", async (route) => {
    if (!outputReadFails) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        outputVersion: 1,
        error: { code: "TRANSIENT_TEST_FAILURE", message: "Synthetic evidence failure." },
      }),
    });
  });
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.successfulRunId}, succeeded`) })
    .click();

  const panel = page.locator("#output-panel");
  await expect(panel.getByRole("alert")).toContainText("Synthetic evidence failure.");
  const retry = page.getByRole("button", { name: "Retry" });
  const target = await retry.boundingBox();
  expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);

  await retry.focus();
  await waitForRunListPoll(page);
  await waitForRunListPoll(page);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent ?? null))
    .toBe("Retry");
  await expect.poll(() => readEvidenceAlerts(page)).toHaveLength(1);

  await page.keyboard.press("Enter");
  await expect.poll(() => readEvidenceAlerts(page)).toHaveLength(2);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.textContent ?? null))
    .toBe("Retry");

  outputReadFails = false;
  await page.keyboard.press("Enter");

  await expect(retry).toHaveCount(0);
  await expect(panel).toContainText("RETRIED_EVIDENCE_BODY");
});

test("refresh re-requests a failed evidence read even while polling fails", async ({
  page,
  scenario,
  viewer,
}) => {
  await writeFile(
    nodeOutputPath(scenario, scenario.successfulRunId, "000-analyze", "result.txt"),
    "REFRESHED_EVIDENCE_BODY",
    { mode: 0o600 },
  );
  let outputReadFails = true;
  await page.route("**/api/runs/*/nodes/*/output/*", async (route) => {
    if (!outputReadFails) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        outputVersion: 1,
        error: { code: "TRANSIENT_TEST_FAILURE", message: "Synthetic evidence failure." },
      }),
    });
  });
  await openViewer(page, viewer.launchUrl);
  await page
    .getByRole("button", { name: new RegExp(`Run ${scenario.successfulRunId}, succeeded`) })
    .click();

  const panel = page.locator("#output-panel");
  await expect(panel.getByRole("alert")).toContainText("Synthetic evidence failure.");

  await page.route("**/api/workflow", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        outputVersion: 1,
        error: { code: "TRANSIENT_TEST_FAILURE", message: "Synthetic refresh failure." },
      }),
    });
  });
  await expect(page.locator("#connection-status")).toContainText("Retrying");

  outputReadFails = false;
  await page.getByRole("button", { name: "Refresh" }).press("Enter");

  await expect(panel).toContainText("REFRESHED_EVIDENCE_BODY", { timeout: 3_000 });
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});
