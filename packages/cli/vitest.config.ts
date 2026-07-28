import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    env: {
      KILIN_SKIP_SETUP_PROMPT: "true",
    },
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20_000,
  },
});
