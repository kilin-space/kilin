import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures.js";
import { decisionPacketFixture } from "../test/fixtures/decision-packet.js";

const openViewer = async (page: Page, launchUrl: string): Promise<void> => {
  const navigation = await page.goto(launchUrl);
  if (navigation === null) {
    throw new Error("The viewer navigation did not return an HTTP response.");
  }
  await expect(page.locator("#app-shell")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#connection-status")).toHaveText("Live");
};

const selectPacketRun = async (
  page: Page,
  runId: string,
  status: "succeeded" | "failed" = "succeeded",
): Promise<void> => {
  await page.getByRole("button", { name: new RegExp(`Run ${runId}, ${status}`) }).click();
  await page.getByRole("button", { name: /^judge, step 1,/u }).click();
};

const noHorizontalOverflow = async (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe.configure({ mode: "serial" });

test("a valid Decision Packet renders safe cards, raw JSON, history, and rerun lineage", async ({
  page,
  scenario,
  viewer,
}) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  const requestedUrls: string[] = [];
  page.on("request", (request) => requestedUrls.push(request.url()));
  await openViewer(page, viewer.launchUrl);
  await selectPacketRun(page, scenario.decisionPacketRunId);

  const packet = page.locator("#output-panel .decision-packet");
  await expect(packet).toBeVisible();
  await expect(packet).toContainText("West Coast safety-stock policy");
  await expect(packet).toContainText("Service level");
  await expect(packet).toContainText("Operations warehouse snapshot");
  await expect(packet).toContainText("mature");
  await expect(packet).toContainText("Working-capital range");
  await expect(packet).toContainText("Recommendation");
  await expect(packet).toContainText("AI recommendation — not a Human Decision");
  await expect(packet).toContainText("Alternatives");
  await expect(packet).toContainText("Review");

  await expect(packet).toContainText(
    '<script>window.packetExecuted=true</script><img src=x onerror="alert(1)">',
  );
  await expect(packet).toContainText("javascript:alert('packet')");
  await expect(packet).toContainText("<a href=https://example.invalid>Run external action</a>");
  await expect(packet.locator("script, img, a, iframe, object, form")).toHaveCount(0);
  await expect(packet.locator("button, input, textarea, select")).toHaveCount(0);
  expect(await page.evaluate(() => "packetExecuted" in window)).toBe(false);
  expect(requestedUrls.every((url) => url.startsWith(viewer.origin))).toBe(true);

  await expect(noHorizontalOverflow(page)).resolves.toBe(true);

  await page.getByRole("button", { name: "Raw" }).click();
  await expect(page.locator("#output-panel .stream-text")).toContainText(
    '"kind":"decision_packet"',
  );
  await expect(page.locator("#output-panel .stream-text")).toContainText("HISTORY_ORIGINAL");
  await page.getByRole("button", { name: "Rendered" }).click();
  await expect(packet).toBeVisible();

  await selectPacketRun(page, scenario.decisionPacketRerunId);
  await expect(page.locator("#output-panel .decision-packet")).toContainText("HISTORY_RERUN");
  await expect(page.locator("#output-panel .decision-packet")).not.toContainText(
    "HISTORY_ORIGINAL",
  );
  await expect(page.locator("#lineage-list .lineage-button")).toHaveCount(2);
  await expect(page.locator("#lineage-list")).toContainText(
    scenario.decisionPacketRunId.slice(0, 12),
  );
  await expect(page.locator("#lineage-list")).toContainText(
    scenario.decisionPacketRerunId.slice(0, 12),
  );

  await selectPacketRun(page, scenario.ordinaryJsonRunId);
  await expect(page.locator("#output-panel .decision-packet")).toHaveCount(0);
  await expect(page.locator("#output-panel")).toContainText("ORDINARY_JSON_LOOKALIKE");

  const future = {
    ...decisionPacketFixture("FUTURE_HISTORY"),
    packetVersion: 2,
  };
  await writeFile(
    join(
      scenario.stateDirectory,
      "runs",
      scenario.decisionPacketRunId,
      "nodes",
      "000-judge",
      "result.txt",
    ),
    JSON.stringify(future),
    "utf8",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await selectPacketRun(page, scenario.decisionPacketRunId);

  await expect(page.locator("#output-panel .decision-packet")).toHaveCount(0);
  await expect(page.locator("#output-panel")).toContainText("FUTURE_HISTORY");
  await expect(noHorizontalOverflow(page)).resolves.toBe(true);

  await selectPacketRun(page, scenario.decisionPacketRerunId);
  const mobilePacket = page.locator("#output-panel .decision-packet");
  await expect(mobilePacket).toBeVisible();
  await expect(noHorizontalOverflow(page)).resolves.toBe(true);
  await expect(mobilePacket.locator(".packet-actions button")).toHaveCount(0);
});
