import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "/tmp/kilin/playwright-results",
  reporter: [["line"]],
  timeout: 30_000,
  use: {
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
});
