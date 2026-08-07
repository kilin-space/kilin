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
import type { WorkflowPackage } from "../../src/domain/workflow-package.js";
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

describe("json output schema resolution", () => {
  const findingsSchema = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "file", "line", "summary"],
          properties: {
            severity: { type: "string" },
            file: { type: "string" },
            line: { type: "integer" },
            summary: { type: "string" },
          },
        },
      },
    },
  });

  const identifiedFindingsSchema = JSON.stringify({
    $id: "https://example.com/findings.schema.json",
    ...(JSON.parse(findingsSchema) as Record<string, unknown>),
  });

  const schemaDefinition = (id: string, schemaLines: string): string => `schemaVersion: 1
workflow:
  id: ${id}
  name: ${id}
nodes:
  - id: main
    kind: agent
    runtime: codex
    access: read_only
    prompt: Inspect the current workspace.
    output:
      type: json
${schemaLines}
edges: []
`;

  const writeSchemaPackage = async (
    project: string,
    name: string,
    definitionSource: string,
  ): Promise<string> => {
    const workflowPackage = await writeTestWorkflowPackage(
      join(project, ".agents", "workflows"),
      name,
      `Use ${name} for repository work.`,
      definitionSource,
    );
    return workflowPackage.directory;
  };

  const writeFindingsSchema = async (
    packageDirectory: string,
    content: string | Buffer = findingsSchema,
  ): Promise<void> => {
    await mkdir(join(packageDirectory, "schemas"), { recursive: true });
    await writeFile(join(packageDirectory, "schemas", "findings.json"), content);
  };

  const resolvePackage = async (project: string, name: string): Promise<WorkflowPackage> =>
    resolveWorkflowPackage(name, {
      workingDirectory: project,
      userWorkflowsDirectory: join(project, "user-workflows"),
    });

  it.each(["schemas/findings.json", "./schemas/findings.json"] as const)(
    "embeds the file-referenced schema declared as %s",
    async (declared) => {
      const root = await createTemporaryDirectory();
      const project = join(root, "project");
      const packageDirectory = await writeSchemaPackage(
        project,
        "schema-file",
        schemaDefinition("schema-file", `      schema: ${declared}\n`),
      );
      await writeFindingsSchema(packageDirectory);

      const resolved = await resolvePackage(project, "schema-file");

      expect(resolved.definition.nodes[0]).toMatchObject({
        output: { type: "json", schema: JSON.parse(findingsSchema) as unknown },
      });
    },
  );

  it("embeds an $id-bearing schema file referenced by two nodes", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-shared-id",
      `schemaVersion: 1
workflow:
  id: schema-shared-id
  name: schema-shared-id
nodes:
  - id: scan
    kind: agent
    runtime: codex
    access: read_only
    prompt: Scan for findings.
    output:
      type: json
      schema: schemas/findings.json
  - id: audit
    kind: agent
    runtime: codex
    access: read_only
    prompt: Audit the findings.
    output:
      type: json
      schema: schemas/findings.json
edges:
  - from: scan
    to: audit
`,
    );
    await writeFindingsSchema(packageDirectory, identifiedFindingsSchema);

    const resolved = await resolvePackage(project, "schema-shared-id");

    const embeddedSchema = JSON.parse(identifiedFindingsSchema) as unknown;
    expect(resolved.definition.nodes).toMatchObject([
      { id: "scan", output: { type: "json", schema: embeddedSchema } },
      { id: "audit", output: { type: "json", schema: embeddedSchema } },
    ]);
  });

  it("embeds a schema file that resolves local $defs references", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-local-ref",
      schemaDefinition("schema-local-ref", "      schema: schemas/findings.json\n"),
    );
    const localRefSchema = JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: {
        findings: { type: "array", items: { $ref: "#/$defs/finding" } },
      },
      $defs: {
        finding: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "file", "line", "summary"],
          properties: {
            severity: { type: "string" },
            file: { type: "string" },
            line: { type: "integer" },
            summary: { type: "string" },
          },
        },
      },
    });
    await writeFindingsSchema(packageDirectory, localRefSchema);

    const resolved = await resolvePackage(project, "schema-local-ref");

    expect(resolved.definition.nodes[0]).toMatchObject({
      output: { type: "json", schema: JSON.parse(localRefSchema) as unknown },
    });
  });

  it("resolves a schema referenced from a loop body node output", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "loop-schema",
      `schemaVersion: 1
workflow:
  id: loop-schema
  name: loop-schema
nodes:
  - id: review-loop
    kind: loop
    maxIterations: 2
    body:
      nodes:
        - id: draft
          kind: agent
          runtime: codex
          access: read_only
          prompt: Draft findings.
          output:
            type: json
            schema: schemas/findings.json
        - id: decide
          kind: agent
          runtime: codex
          access: read_only
          prompt: Decide whether the draft passes.
          output:
            type: choice
            choices: [pass, revise]
      edges:
        - from: draft
          to: decide
    decision:
      node: decide
      passChoice: pass
      reviseChoice: revise
    feedback:
      from: draft
      to: draft
      input: notes
    result:
      node: draft
edges: []
`,
    );
    await writeFindingsSchema(packageDirectory);

    const resolved = await resolvePackage(project, "loop-schema");

    expect(resolved.definition.nodes[0]).toMatchObject({
      kind: "loop",
      body: {
        nodes: [
          { id: "draft", output: { type: "json", schema: JSON.parse(findingsSchema) as unknown } },
          { id: "decide" },
        ],
      },
    });
  });

  it.each([
    ["a missing file", "schemas/missing.json", "does not exist or is unreadable"],
    ["an absolute path", "/etc/kilin-findings.json", "is invalid"],
    ["a parent escape", "../findings.json", "is invalid"],
    ["a repeated separator", "schemas//findings.json", "is invalid"],
  ] as const)(
    "rejects a schema path with %s naming the declared path",
    async (_name, declared, message) => {
      const root = await createTemporaryDirectory();
      const project = join(root, "project");
      await writeSchemaPackage(
        project,
        "schema-path",
        schemaDefinition("schema-path", `      schema: "${declared}"\n`),
      );

      const resolution = resolvePackage(project, "schema-path");
      await expect(resolution).rejects.toMatchObject({
        code: "WORKFLOW_PACKAGE_INVALID",
        message: expect.stringContaining(declared) as string,
      });
      await expect(resolution).rejects.toThrow(message);
    },
  );

  it("rejects a schema file escaping through an intermediate symlinked directory", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "findings.json"), findingsSchema);
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-escape",
      schemaDefinition("schema-escape", "      schema: schemas/findings.json\n"),
    );
    await symlink(outside, join(packageDirectory, "schemas"));

    const resolution = resolvePackage(project, "schema-escape");
    await expect(resolution).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      message: expect.stringContaining("schemas/findings.json") as string,
    });
    await expect(resolution).rejects.toThrow("outside the workflow");
  });

  it("rejects a schema that is a symlink to a regular file inside the package", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-symlink",
      schemaDefinition("schema-symlink", "      schema: schemas/findings.json\n"),
    );
    await mkdir(join(packageDirectory, "schemas"));
    await writeFile(join(packageDirectory, "schemas", "target.json"), findingsSchema);
    await symlink(
      join(packageDirectory, "schemas", "target.json"),
      join(packageDirectory, "schemas", "findings.json"),
    );

    const resolution = resolvePackage(project, "schema-symlink");
    await expect(resolution).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      message: expect.stringContaining("schemas/findings.json") as string,
    });
    await expect(resolution).rejects.toThrow("not a symlink");
  });

  it("rejects a schema file over the 256 KiB byte limit", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-oversized",
      schemaDefinition("schema-oversized", "      schema: schemas/findings.json\n"),
    );
    await writeFindingsSchema(packageDirectory);
    await truncate(join(packageDirectory, "schemas", "findings.json"), 262_145);

    const resolution = resolvePackage(project, "schema-oversized");
    await expect(resolution).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      message: expect.stringContaining("schemas/findings.json") as string,
    });
    await expect(resolution).rejects.toThrow("byte limit");
  });

  it.each([
    ["invalid JSON", "{ not json", "is not valid canonical JSON"],
    ["non-object JSON", "[1, 2, 3]", "must contain a JSON object"],
    [
      "a non-canonical number",
      '{ "type": "object", "properties": { "level": { "maximum": 1e400 } } }',
      "is not valid canonical JSON",
    ],
  ] as const)("rejects a schema file with %s", async (_name, content, message) => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-content",
      schemaDefinition("schema-content", "      schema: schemas/findings.json\n"),
    );
    await writeFindingsSchema(packageDirectory, content);

    const resolution = resolvePackage(project, "schema-content");
    await expect(resolution).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      message: expect.stringContaining("schemas/findings.json") as string,
    });
    await expect(resolution).rejects.toThrow(message);
  });

  it("maps excessively nested schema data to a package validation failure", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-nested",
      schemaDefinition("schema-nested", "      schema: schemas/findings.json\n"),
    );
    const nestedSchema = `{"allOf":${"[".repeat(4_000)}{}${"]".repeat(4_000)}}`;
    await writeFindingsSchema(packageDirectory, nestedSchema);

    await expect(resolvePackage(project, "schema-nested")).rejects.toMatchObject({
      code: "WORKFLOW_PACKAGE_INVALID",
      message: expect.stringContaining("is not valid canonical JSON") as string,
    });
  });

  it.each([
    ["an unknown keyword", '{ "type": "object", "bogusKeyword": true }', "schemas/findings.json"],
    [
      "an external $ref",
      '{ "type": "object", "properties": { "a": { "$ref": "https://example.com/shared.json" } } }',
      "schemas/findings.json",
    ],
  ] as const)("rejects a file-referenced schema with %s", async (_name, content, named) => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    const packageDirectory = await writeSchemaPackage(
      project,
      "schema-malformed",
      schemaDefinition("schema-malformed", "      schema: schemas/findings.json\n"),
    );
    await writeFindingsSchema(packageDirectory, content);

    await expect(resolvePackage(project, "schema-malformed")).rejects.toMatchObject({
      code: "WORKFLOW_SCHEMA_INVALID",
      message: expect.stringContaining(named) as string,
    });
  });

  it("rejects a malformed inline schema naming the inline source", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    await writeSchemaPackage(
      project,
      "schema-inline",
      schemaDefinition(
        "schema-inline",
        "      schema:\n        type: object\n        bogusKeyword: true\n",
      ),
    );

    await expect(resolvePackage(project, "schema-inline")).rejects.toMatchObject({
      code: "WORKFLOW_SCHEMA_INVALID",
      message: expect.stringContaining("inline") as string,
    });
  });

  it("accepts a valid inline schema", async () => {
    const root = await createTemporaryDirectory();
    const project = join(root, "project");
    await writeSchemaPackage(
      project,
      "schema-inline",
      schemaDefinition(
        "schema-inline",
        "      schema:\n        type: object\n        required: [findings]\n        properties:\n          findings: { type: array }\n",
      ),
    );

    const resolved = await resolvePackage(project, "schema-inline");

    expect(resolved.definition.nodes[0]).toMatchObject({
      output: { type: "json", schema: { type: "object", required: ["findings"] } },
    });
  });
});
