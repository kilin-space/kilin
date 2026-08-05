import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { resolveWorkflowPackage } from "../../src/infrastructure/workflow-package.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageDirectory = join(repositoryRoot, ".agents", "workflows", "parallel-change-review");
const scanNodeIds = ["security-scan", "performance-scan", "maintainability-scan"];

describe("bundled parallel-change-review workflow", () => {
  it("validates clean and embeds the shared findings schema in every scan node output", async () => {
    const workflowPackage = await resolveWorkflowPackage("parallel-change-review", {
      workingDirectory: repositoryRoot,
      userWorkflowsDirectory: join(repositoryRoot, "user-workflows"),
    });
    const plan = compileWorkflow(workflowPackage.definition);
    const findingsSchema = JSON.parse(
      await readFile(join(packageDirectory, "schemas", "findings.json"), "utf8"),
    ) as unknown;

    const scanOutputs = plan.definition.nodes
      .filter((node) => scanNodeIds.includes(node.id))
      .map((node) => (node.kind === "agent" ? node.output : undefined));

    expect(scanOutputs).toEqual([
      { type: "json", schema: findingsSchema },
      { type: "json", schema: findingsSchema },
      { type: "json", schema: findingsSchema },
    ]);
  });
});
