import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compileStoredWorkflowRevision,
  initializeWorkflowPackage,
  inspectWorkflowPackage,
} from "../../src/application/workflows.js";
import { serializeCanonicalJson } from "../../src/domain/canonical-json.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type { WorkflowRevisionRecord } from "../../src/domain/run-state.js";
import type { ExecutionPlan } from "../../src/domain/workflow.js";
import {
  resolveWorkflowPackage,
  workflowDefinitionFileName,
  workflowManifestFileName,
} from "../../src/infrastructure/workflow-package.js";
import { parseWorkflowBytes } from "../../src/infrastructure/workflow-source.js";

const temporaryDirectories: string[] = [];

const storedRevision = (plan: ExecutionPlan): WorkflowRevisionRecord => ({
  id: "revision-1",
  scope: { kind: "user" },
  workflowId: plan.definition.workflow.id,
  schemaVersion: 1,
  contentHash: plan.contentHash,
  normalizedDefinition: plan.normalizedDefinition,
  createdAt: "2026-07-21T00:00:00.000Z",
});

const expectStoredRevisionError = (
  revision: WorkflowRevisionRecord,
  messageFragment: string,
): void => {
  try {
    compileStoredWorkflowRevision(revision);
    throw new Error("Expected stored revision compilation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    if (!(error instanceof KilinError)) {
      throw error;
    }
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toContain(messageFragment);
  }
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-application-workflows-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("application workflow use cases", () => {
  it("compiles a closed approval revision from immutable canonical state", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "stored-approval", name: "Stored approval" },
      nodes: [{ id: "gate", kind: "approval", question: "Proceed?" }],
      edges: [],
    });

    expect(compileStoredWorkflowRevision(storedRevision(plan))).toEqual(plan);
  });

  it("rejects malformed and structurally invalid stored revisions as internal state errors", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "stored-agent", name: "Stored agent" },
      nodes: [
        {
          id: "agent",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Run safely",
        },
      ],
      edges: [],
    });
    const malformed = { ...storedRevision(plan), normalizedDefinition: "{" };
    const invalidDefinition = serializeCanonicalJson({
      edges: [],
      nodes: [
        {
          access: "read_only",
          id: 1,
          kind: "agent",
          prompt: "Run unsafely",
          runtime: "codex",
        },
      ],
      schemaVersion: 1,
      workflow: { id: "stored-agent", name: "Stored agent" },
    });
    const invalid = {
      ...storedRevision(plan),
      normalizedDefinition: invalidDefinition,
      contentHash: createHash("sha256").update(invalidDefinition, "utf8").digest("hex"),
    };

    expectStoredRevisionError(malformed, "is not normalized JSON");
    expectStoredRevisionError(invalid, "is invalid");
  });

  it.each([
    [
      "normalized bytes",
      (revision: WorkflowRevisionRecord): WorkflowRevisionRecord => ({
        ...revision,
        normalizedDefinition: `${revision.normalizedDefinition}\n`,
      }),
    ],
    [
      "content hash",
      (revision: WorkflowRevisionRecord): WorkflowRevisionRecord => ({
        ...revision,
        contentHash: "0".repeat(64),
      }),
    ],
    [
      "workflow ID",
      (revision: WorkflowRevisionRecord): WorkflowRevisionRecord => ({
        ...revision,
        workflowId: "different-workflow",
      }),
    ],
  ] as const)("rejects a stored revision with mismatched %s", (_name, change) => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "stored-identity", name: "Stored identity" },
      nodes: [{ id: "gate", kind: "approval", question: "Proceed?" }],
      edges: [],
    });
    expectStoredRevisionError(change(storedRevision(plan)), "identity that does not match");
  });

  it("initializes a valid minimal workflow in a new parent directory", async () => {
    const directory = await createTemporaryDirectory();
    const workflowsDirectory = join(directory, "nested", ".agents", "workflows");
    await mkdir(join(directory, "nested"));

    const result = await initializeWorkflowPackage(
      workflowsDirectory,
      "change-review",
      "Change review",
      "Reviews a proposed change.",
    );
    const source = await readFile(result.definitionFile);
    const definition = parseWorkflowBytes(source, result.definitionFile);

    expect(result).toEqual({
      directory: join(workflowsDirectory, "change-review"),
      manifestFile: join(workflowsDirectory, "change-review", workflowManifestFileName),
      definitionFile: join(workflowsDirectory, "change-review", workflowDefinitionFileName),
      workflowId: "change-review",
      created: true,
    });
    await expect(readFile(result.manifestFile, "utf8")).resolves.toContain(
      "description: Reviews a proposed change.",
    );
    expect(definition).toEqual({
      schemaVersion: 1,
      workflow: { id: "change-review", name: "Change review" },
      nodes: [
        {
          id: "main",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Describe the task this workflow should perform.",
        },
      ],
      edges: [],
    });
  });

  it("never overwrites an existing workflow target", async () => {
    const directory = await createTemporaryDirectory();
    const workflowsDirectory = join(directory, ".agents", "workflows");
    const packageDirectory = join(workflowsDirectory, "replacement");
    const existingFile = join(packageDirectory, "owned.txt");
    const existingSource = "owned by the user\n";
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(existingFile, existingSource);

    await expect(
      initializeWorkflowPackage(
        workflowsDirectory,
        "replacement",
        "Replacement",
        "Replacement workflow.",
      ),
    ).rejects.toMatchObject({ code: "INIT_TARGET_EXISTS" });
    await expect(readFile(existingFile, "utf8")).resolves.toBe(existingSource);
  });

  it("rejects a symlinked agent directory during initialization", async () => {
    const directory = await createTemporaryDirectory();
    const outside = await createTemporaryDirectory();
    await symlink(outside, join(directory, ".agents"));

    await expect(
      initializeWorkflowPackage(
        join(directory, ".agents", "workflows"),
        "safe-workflow",
        "Safe workflow",
        "Safe workflow description.",
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
    await expect(access(join(outside, "workflows"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inspects a workflow through its compiled deterministic plan", async () => {
    const directory = await createTemporaryDirectory();
    const workflowsDirectory = join(directory, ".agents", "workflows");
    const initialized = await initializeWorkflowPackage(
      workflowsDirectory,
      "inspect-me",
      "Inspect me",
      "Inspects a workflow.",
    );
    await writeFile(
      initialized.definitionFile,
      `schemaVersion: 1
workflow:
  id: inspect-me
  name: Inspect me
nodes:
  - id: first
    kind: agent
    runtime: codex
    access: read_only
    prompt: First task
  - id: second
    kind: agent
    runtime: codex
    access: read_only
    prompt: Second task
edges:
  - from: first
    to: second
`,
    );

    const workflowPackage = await resolveWorkflowPackage("inspect-me", {
      workingDirectory: directory,
      userWorkflowsDirectory: join(directory, "user-workflows"),
    });
    const result = inspectWorkflowPackage(workflowPackage);

    expect(result).toMatchObject({
      workflowId: "inspect-me",
      nodeCount: 2,
      edgeCount: 1,
      executionOrder: ["first", "second"],
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates without creating state or invoking the runtime", async () => {
    const directory = await createTemporaryDirectory();
    const projectDirectory = join(directory, "project");
    const workflowsDirectory = join(projectDirectory, ".agents", "workflows");
    const runtimeDirectory = join(directory, "runtime");
    const runtimeMarker = join(directory, "runtime-invoked");
    const stateDirectory = join(directory, "state");
    await mkdir(projectDirectory);
    const initialized = await initializeWorkflowPackage(
      workflowsDirectory,
      "side-effect-check",
      "Side effect check",
      "Checks validation side effects.",
    );
    await writeFile(join(directory, "placeholder"), "placeholder");
    await mkdir(runtimeDirectory);
    const executable = join(runtimeDirectory, "codex");
    await writeFile(executable, `#!/bin/sh\ntouch "${runtimeMarker}"\n`);
    await chmod(executable, 0o700);
    const sourceBefore = await readFile(initialized.definitionFile);
    const projectEntriesBefore = await readdir(projectDirectory);
    const originalPath = process.env.PATH;
    const originalDataDirectory = process.env.KILIN_DATA_DIR;
    process.env.PATH = runtimeDirectory;
    process.env.KILIN_DATA_DIR = stateDirectory;

    try {
      const workflowPackage = await resolveWorkflowPackage("side-effect-check", {
        workingDirectory: projectDirectory,
        userWorkflowsDirectory: join(directory, "user-workflows"),
      });
      inspectWorkflowPackage(workflowPackage);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalDataDirectory === undefined) {
        delete process.env.KILIN_DATA_DIR;
      } else {
        process.env.KILIN_DATA_DIR = originalDataDirectory;
      }
    }

    await expect(readFile(initialized.definitionFile)).resolves.toEqual(sourceBefore);
    await expect(readdir(projectDirectory)).resolves.toEqual(projectEntriesBefore);
    await expect(access(runtimeMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
