import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertWorkflowScopeAllowsWorkingDirectory,
  discoverWorkflowCatalog,
  findProjectWorkflowRoot,
  parseWorkflowManifest,
  resolveWorkflowPackage,
} from "../../src/infrastructure/workflow-package.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-workflow-package-"));
  temporaryDirectories.push(directory);
  return directory;
};

const definition = (id: string): string => `schemaVersion: 1
workflow:
  id: ${id}
  name: ${id}
nodes:
  - id: main
    kind: agent
    runtime: codex
    access: read_only
    prompt: Inspect the current workspace.
edges: []
`;

const writePackage = async (
  workflowsDirectory: string,
  name: string,
  description = `Use ${name} for repository work.`,
): Promise<string> => {
  const workflowPackage = await writeTestWorkflowPackage(
    workflowsDirectory,
    name,
    description,
    definition(name),
    { instructions: "Use only when relevant." },
  );
  return workflowPackage.directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("workflow package discovery", () => {
  it("parses the strict progressive-disclosure manifest contract", () => {
    const manifest = parseWorkflowManifest(
      encoder.encode(`---
name: release-review
description: Review release readiness when preparing a deployment.
---

Confirm the repository is clean before use.
`),
      "release-review",
    );

    expect(manifest).toEqual({
      name: "release-review",
      description: "Review release readiness when preparing a deployment.",
      instructions: "Confirm the repository is clean before use.",
    });
  });

  it.each([
    ["missing frontmatter", "name: release-review\n", "must begin with YAML frontmatter"],
    [
      "unknown field",
      "---\nname: release-review\ndescription: Review releases.\nversion: 1\n---\n",
      'exactly "name" and "description"',
    ],
    [
      "invalid name",
      "---\nname: Release_Review\ndescription: Review releases.\n---\n",
      "lowercase ASCII",
    ],
    [
      "directory mismatch",
      "---\nname: release-review\ndescription: Review releases.\n---\n",
      "must match its parent directory",
    ],
    ["empty description", '---\nname: release-review\ndescription: ""\n---\n', "non-empty string"],
    [
      "alias",
      "---\nname: &name release-review\ndescription: *name\n---\n",
      "cannot contain anchors",
    ],
  ] as const)("rejects a manifest with %s", (_name, source, message) => {
    expect(() =>
      parseWorkflowManifest(
        encoder.encode(source),
        _name === "directory mismatch" ? "different-name" : "release-review",
      ),
    ).toThrow(message);
  });

  it("accepts an exact-limit manifest and rejects an oversized sparse manifest before reading it", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const workflows = join(project, ".agents", "workflows");
    const exactDirectory = await writePackage(workflows, "exact-limit");
    const exactPrefix = "---\nname: exact-limit\ndescription: Exact manifest limit.\n---\n\n";
    const exactManifest = Buffer.from(
      exactPrefix + "x".repeat(65_536 - Buffer.byteLength(exactPrefix)),
      "utf8",
    );
    await writeFile(join(exactDirectory, "WORKFLOW.md"), exactManifest);

    await expect(
      resolveWorkflowPackage("exact-limit", {
        workingDirectory: project,
        userWorkflowsDirectory: join(root, "user-workflows"),
      }),
    ).resolves.toMatchObject({ manifest: { name: "exact-limit" } });

    const oversizedDirectory = await writePackage(workflows, "oversized");
    await truncate(join(oversizedDirectory, "WORKFLOW.md"), 1_073_741_824);
    await expect(
      resolveWorkflowPackage("oversized", {
        workingDirectory: project,
        userWorkflowsDirectory: join(root, "user-workflows"),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("rejects an oversized definition before reading it", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const workflows = join(project, ".agents", "workflows");
    const oversizedDirectory = await writePackage(workflows, "oversized-definition");
    await truncate(join(oversizedDirectory, "WORKFLOW.yaml"), 1_073_741_824);

    await expect(
      resolveWorkflowPackage("oversized-definition", {
        workingDirectory: project,
        userWorkflowsDirectory: join(root, "user-workflows"),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("uses the nearest workflow root without requiring Git", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "plain-project");
    const nested = join(project, "packages", "service", "src");
    const userHome = join(root, "user");
    await mkdir(join(project, ".agents", "workflows"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await mkdir(userHome);

    await expect(
      findProjectWorkflowRoot(nested, join(userHome, ".agents", "workflows")),
    ).resolves.toBe(await realpath(project));
  });

  it("rejects symlinked project and user workflow roots", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const outsideAgents = join(root, "outside-agents");
    const outsideUserWorkflows = join(root, "outside-user-workflows");
    const userHome = join(root, "user");
    await mkdir(join(outsideAgents, "workflows"), { recursive: true });
    await mkdir(project);
    await mkdir(userHome);
    await symlink(outsideAgents, join(project, ".agents"));

    await expect(
      findProjectWorkflowRoot(project, join(userHome, ".agents", "workflows")),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
    });

    const userRootLink = join(root, "user-workflows");
    await mkdir(outsideUserWorkflows);
    await symlink(outsideUserWorkflows, userRootLink);
    await expect(
      discoverWorkflowCatalog({
        workingDirectory: root,
        userWorkflowsDirectory: userRootLink,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("lets the nearest project package override the user package", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const nested = join(project, "src");
    const userWorkflows = join(root, "user", ".agents", "workflows");
    await mkdir(nested, { recursive: true });
    await writePackage(
      join(project, ".agents", "workflows"),
      "release-review",
      "Project release review.",
    );
    await writePackage(userWorkflows, "release-review", "User release review.");
    await writePackage(userWorkflows, "personal-audit", "User-only audit.");

    const resolved = await resolveWorkflowPackage("release-review", {
      workingDirectory: nested,
      userWorkflowsDirectory: userWorkflows,
    });
    const catalog = await discoverWorkflowCatalog({
      workingDirectory: nested,
      userWorkflowsDirectory: userWorkflows,
    });

    expect(resolved.identity).toEqual({
      scope: { kind: "project", root: await realpath(project) },
      workflowId: "release-review",
    });
    expect(resolved.manifest.description).toBe("Project release review.");
    expect(catalog).toMatchObject({
      projectRoot: await realpath(project),
      workflows: [
        { name: "personal-audit", scope: "user" },
        { name: "release-review", scope: "project" },
      ],
      diagnostics: [],
    });
  });

  it("does not reinterpret the user workflow root as a project root below the user home", async () => {
    const root = await createTemporaryDirectory();
    const userHome = join(root, "home");
    const workingDirectory = join(userHome, "workspaces", "plain", "src");
    const userWorkflows = join(userHome, ".agents", "workflows");
    await mkdir(workingDirectory, { recursive: true });
    await writePackage(userWorkflows, "portable-review");

    const resolved = await resolveWorkflowPackage("portable-review", {
      workingDirectory,
      userWorkflowsDirectory: userWorkflows,
    });
    const catalog = await discoverWorkflowCatalog({
      workingDirectory,
      userWorkflowsDirectory: userWorkflows,
    });

    expect(resolved.identity).toEqual({
      scope: { kind: "user" },
      workflowId: "portable-review",
    });
    expect(catalog).toMatchObject({
      workflows: [{ name: "portable-review", scope: "user" }],
      diagnostics: [],
    });
    expect(catalog).not.toHaveProperty("projectRoot");
  });

  it("falls back to user scope only when no project candidate reserves the name", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const userWorkflows = join(root, "user-workflows");
    await mkdir(project);
    await writePackage(userWorkflows, "release-review");

    const resolved = await resolveWorkflowPackage("release-review", {
      workingDirectory: project,
      userWorkflowsDirectory: userWorkflows,
    });

    expect(resolved.identity).toEqual({
      scope: { kind: "user" },
      workflowId: "release-review",
    });
  });

  it("fails closed when an invalid project package shadows a valid user package", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const projectWorkflows = join(project, ".agents", "workflows");
    const userWorkflows = join(root, "user-workflows");
    const invalidDirectory = join(projectWorkflows, "release-review");
    await mkdir(invalidDirectory, { recursive: true });
    await writeFile(
      join(invalidDirectory, "WORKFLOW.md"),
      "---\nname: release-review\ndescription: Broken project package.\n---\n",
    );
    await writePackage(userWorkflows, "release-review");

    await expect(
      resolveWorkflowPackage("release-review", {
        workingDirectory: project,
        userWorkflowsDirectory: userWorkflows,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
    const catalog = await discoverWorkflowCatalog({
      workingDirectory: project,
      userWorkflowsDirectory: userWorkflows,
    });
    expect(catalog.workflows).toEqual([]);
    expect(catalog.diagnostics).toMatchObject([
      { scope: "project", packageName: "release-review", code: "WORKFLOW_PACKAGE_INVALID" },
    ]);
  });

  it("treats a project file as an invalid shadow of a user package with the same name", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const projectWorkflows = join(project, ".agents", "workflows");
    const userWorkflows = join(root, "user-workflows");
    await mkdir(projectWorkflows, { recursive: true });
    await writeFile(join(projectWorkflows, "release-review"), "not a workflow package");
    await writePackage(userWorkflows, "release-review");

    await expect(
      resolveWorkflowPackage("release-review", {
        workingDirectory: project,
        userWorkflowsDirectory: userWorkflows,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
    await expect(
      discoverWorkflowCatalog({
        workingDirectory: project,
        userWorkflowsDirectory: userWorkflows,
      }),
    ).resolves.toMatchObject({
      workflows: [],
      diagnostics: [
        {
          scope: "project",
          packageName: "release-review",
          code: "WORKFLOW_PACKAGE_INVALID",
        },
      ],
    });
  });

  it("does not merge an outer workflow root when a nearer root exists", async () => {
    const root = await createTemporaryDirectory();
    const inner = join(root, "packages", "service");
    const cwd = join(inner, "src");
    const userWorkflows = join(root, "user-workflows");
    await mkdir(cwd, { recursive: true });
    await writePackage(join(root, ".agents", "workflows"), "outer");
    await writePackage(join(inner, ".agents", "workflows"), "inner");

    const catalog = await discoverWorkflowCatalog({
      workingDirectory: cwd,
      userWorkflowsDirectory: userWorkflows,
    });

    expect(catalog.projectRoot).toBe(await realpath(inner));
    expect(catalog.workflows.map(({ name }) => name)).toEqual(["inner"]);
  });

  it("rejects mismatched definitions and symlinked project packages", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const workflows = join(project, ".agents", "workflows");
    const mismatched = await writePackage(workflows, "release-review");
    await writeFile(join(mismatched, "WORKFLOW.yaml"), definition("different"));

    await expect(
      resolveWorkflowPackage("release-review", {
        workingDirectory: project,
        userWorkflowsDirectory: join(root, "user-workflows"),
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      path: "workflow.id",
    });

    await rm(mismatched, { recursive: true });
    const external = join(root, "external");
    await writePackage(root, "external");
    await symlink(external, join(workflows, "release-review"));
    await expect(
      resolveWorkflowPackage("release-review", {
        workingDirectory: project,
        userWorkflowsDirectory: join(root, "user-workflows"),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_PACKAGE_INVALID" });
  });

  it("limits project workflows to their project tree while user workflows remain portable", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "outside");
    const userWorkflows = join(root, "user-workflows");
    await mkdir(outside);
    await writePackage(join(project, ".agents", "workflows"), "project-audit");
    await writePackage(userWorkflows, "user-audit");
    const projectPackage = await resolveWorkflowPackage("project-audit", {
      workingDirectory: project,
      userWorkflowsDirectory: userWorkflows,
    });
    const userPackage = await resolveWorkflowPackage("user-audit", {
      workingDirectory: outside,
      userWorkflowsDirectory: userWorkflows,
    });

    await expect(
      assertWorkflowScopeAllowsWorkingDirectory(projectPackage, outside),
    ).rejects.toMatchObject({ code: "WORKFLOW_SCOPE_INVALID" });
    await expect(assertWorkflowScopeAllowsWorkingDirectory(userPackage, outside)).resolves.toBe(
      await realpath(outside),
    );
  });
});
