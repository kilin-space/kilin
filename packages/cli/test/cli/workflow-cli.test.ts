import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { pathExists } from "../helpers/filesystem.js";
import { isCommandFailure } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

import packageManifest from "../../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const temporaryDirectories: string[] = [];

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runCli = async (
  arguments_: string[],
  cwd?: string,
  environment: Readonly<Record<string, string>> = {},
): Promise<CliResult> => {
  try {
    const result = await execFileAsync(process.execPath, [cliFile, ...arguments_], {
      encoding: "utf8",
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, ...environment },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-cli-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
};

const writePackage = async (project: string, name: string, definition: string): Promise<string> => {
  const workflowPackage = await writeTestWorkflowPackage(
    join(project, ".agents", "workflows"),
    name,
    `Test ${name} workflow`,
    definition,
  );
  return workflowPackage.directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("workflow CLI", () => {
  it("supports short and long global help with command descriptions", async () => {
    const shortHelp = await runCli(["-h"]);
    const help = await runCli(["--help"]);
    const version = await runCli(["--version"]);
    const invalid = await runCli(["--help", "workflow"]);

    expect(help).toMatchObject({ exitCode: 0, stderr: "" });
    expect(shortHelp).toEqual(help);
    expect(help.stdout).toContain("Commands:");
    expect(help.stdout).toContain("kilin workflow init <name>");
    expect(help.stdout).toContain("kilin workflow list [--cwd <directory>]");
    expect(help.stdout).toContain("kilin trigger --request <absolute-file> [--json]");
    expect(help.stdout).toContain("kilin skills link");
    expect(help.stdout).toContain("kilin skills status");
    expect(help.stdout).toContain("-h, --help");
    expect(version).toEqual({ exitCode: 0, stderr: "", stdout: `${packageManifest.version}\n` });
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("OPTION_INVALID");
  });

  it("initializes, discovers, and validates a project workflow package", async () => {
    const project = await createTemporaryDirectory();
    const packageDirectory = join(project, ".agents", "workflows", "change-review");

    const initialized = await runCli([
      "workflow",
      "init",
      "change-review",
      "--scope",
      "project",
      "--project-root",
      project,
      "--name",
      "Change review",
      "--description",
      "Review a proposed change.",
    ]);
    const manifest = await readFile(join(packageDirectory, "WORKFLOW.md"), "utf8");
    const definition = await readFile(join(packageDirectory, "WORKFLOW.yaml"), "utf8");
    const listed = await runCli(["workflow", "list"], project);
    const validated = await runCli(["workflow", "validate", "change-review"], project);

    expect(initialized).toMatchObject({ exitCode: 0, stderr: "" });
    expect(initialized.stdout).toContain(join(packageDirectory, "WORKFLOW.md"));
    expect(initialized.stdout).toContain(join(packageDirectory, "WORKFLOW.yaml"));
    expect(initialized.stdout).toContain("change-review");
    expect(manifest).toContain("description: Review a proposed change.");
    expect(definition).toContain("id: change-review");
    expect(definition).not.toContain("description:");
    expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(listed.stdout.replace(/[ \t]+/gu, " ")).toContain(
      `change-review project Review a proposed change. ${join(packageDirectory, "WORKFLOW.md")}`,
    );
    expect(validated.exitCode).toBe(0);
    expect(validated.stderr).toBe("");
    expect(validated.stdout).toContain('Workflow "change-review" is valid.');
    expect(validated.stdout).toContain("Scope: project");
    expect(validated.stdout).toContain("Nodes: 1");
    expect(validated.stdout).toContain("Edges: 0");
    expect(validated.stdout).toContain("Execution order: main");
  });

  it("does not overwrite an existing workflow package", async () => {
    const project = await createTemporaryDirectory();
    const packageDirectory = join(project, ".agents", "workflows", "replacement");
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "owned.txt"), "keep me\n");

    const result = await runCli([
      "workflow",
      "init",
      "replacement",
      "--scope",
      "project",
      "--project-root",
      project,
      "--name",
      "Replacement",
      "--description",
      "Replacement workflow.",
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INIT_TARGET_EXISTS");
    await expect(readFile(join(packageDirectory, "owned.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("keeps an isolated user package in user scope when invoked below its home", async () => {
    const root = await createTemporaryDirectory();
    const userHome = join(root, "home");
    const workingDirectory = join(userHome, "projects", "plain", "src");
    const environment = { HOME: userHome };
    await mkdir(workingDirectory, { recursive: true });

    const initialized = await runCli(
      [
        "workflow",
        "init",
        "portable-review",
        "--scope",
        "user",
        "--name",
        "Portable review",
        "--description",
        "Review changes from any workspace.",
        "--json",
      ],
      workingDirectory,
      environment,
    );
    const listed = await runCli(["workflow", "list", "--json"], workingDirectory, environment);
    const validated = await runCli(
      ["workflow", "validate", "portable-review", "--json"],
      workingDirectory,
      environment,
    );

    expect(JSON.parse(initialized.stdout)).toMatchObject({
      scope: "user",
      directory: join(userHome, ".agents", "workflows", "portable-review"),
    });
    expect(JSON.parse(listed.stdout)).toMatchObject({
      workflows: [{ name: "portable-review", scope: "user" }],
      diagnostics: [],
    });
    expect(JSON.parse(listed.stdout)).not.toHaveProperty("projectRoot");
    expect(JSON.parse(validated.stdout)).toMatchObject({
      valid: true,
      scope: "user",
      workflowId: "portable-review",
    });
  });

  it("validates an explicitly selected user workflow even when a project package shadows it", async () => {
    const root = await createTemporaryDirectory();
    const userHome = join(root, "home");
    const project = join(userHome, "project");
    const environment = { HOME: userHome };
    await mkdir(project, { recursive: true });
    await writeTestWorkflowPackage(
      join(userHome, ".agents", "workflows"),
      "shared-review",
      "Portable review",
      `schemaVersion: 1
workflow: { id: shared-review, name: Portable review }
nodes:
  - { id: user-node, kind: agent, runtime: codex, access: read_only, prompt: Review anywhere. }
edges: []
`,
    );
    const projectPackage = await writePackage(
      project,
      "shared-review",
      `schemaVersion: 1
workflow: { id: shared-review, name: Project review }
nodes:
  - { id: project-node, kind: agent, runtime: codex, access: read_only, prompt: Review here. }
edges: []
`,
    );

    const defaultValidation = await runCli(
      ["workflow", "validate", "shared-review", "--json"],
      project,
      environment,
    );
    const userValidation = await runCli(
      ["workflow", "validate", "shared-review", "--scope", "user", "--json"],
      project,
      environment,
    );
    await writeFile(join(projectPackage, "WORKFLOW.yaml"), "schemaVersion: 1\nworkflow: {}\n");
    const userValidationWithInvalidShadow = await runCli(
      ["workflow", "validate", "shared-review", "--scope", "user", "--json"],
      project,
      environment,
    );

    expect(JSON.parse(defaultValidation.stdout)).toMatchObject({
      scope: "project",
      executionOrder: ["project-node"],
    });
    expect(JSON.parse(userValidation.stdout)).toMatchObject({
      scope: "user",
      executionOrder: ["user-node"],
    });
    expect(JSON.parse(userValidationWithInvalidShadow.stdout)).toMatchObject({
      scope: "user",
      executionOrder: ["user-node"],
    });
  });

  it("does not fall back across an explicitly selected workflow scope", async () => {
    const root = await createTemporaryDirectory();
    const userHome = join(root, "home");
    const project = join(userHome, "project");
    const environment = { HOME: userHome };
    await mkdir(project, { recursive: true });
    await writeTestWorkflowPackage(
      join(userHome, ".agents", "workflows"),
      "user-only",
      "User only",
      `schemaVersion: 1
workflow: { id: user-only, name: User only }
nodes:
  - { id: main, kind: agent, runtime: codex, access: read_only, prompt: Review. }
edges: []
`,
    );
    await writePackage(
      project,
      "project-only",
      `schemaVersion: 1
workflow: { id: project-only, name: Project only }
nodes:
  - { id: main, kind: agent, runtime: codex, access: read_only, prompt: Review. }
edges: []
`,
    );

    const projectMiss = await runCli(
      ["workflow", "validate", "user-only", "--scope", "project", "--json"],
      project,
      environment,
    );
    const userMiss = await runCli(
      ["workflow", "validate", "project-only", "--scope", "user", "--json"],
      project,
      environment,
    );

    expect(JSON.parse(projectMiss.stdout)).toMatchObject({
      type: "error",
      code: "WORKFLOW_NOT_FOUND",
    });
    expect(JSON.parse(userMiss.stdout)).toMatchObject({
      type: "error",
      code: "WORKFLOW_NOT_FOUND",
    });
  });

  it("rejects invalid working directories before explicit user validation", async () => {
    const root = await createTemporaryDirectory();
    const userHome = join(root, "home");
    const project = join(userHome, "project");
    const file = join(root, "not-a-directory");
    const environment = { HOME: userHome };
    await mkdir(project, { recursive: true });
    await writeFile(file, "not a directory");
    await writeTestWorkflowPackage(
      join(userHome, ".agents", "workflows"),
      "portable-review",
      "Portable review",
      `schemaVersion: 1
workflow: { id: portable-review, name: Portable review }
nodes:
  - { id: main, kind: agent, runtime: codex, access: read_only, prompt: Review. }
edges: []
`,
    );

    const missingDirectory = await runCli(
      [
        "workflow",
        "validate",
        "portable-review",
        "--scope",
        "user",
        "--cwd",
        join(root, "missing"),
        "--json",
      ],
      project,
      environment,
    );
    const fileWorkingDirectory = await runCli(
      ["workflow", "validate", "portable-review", "--scope", "user", "--cwd", file, "--json"],
      project,
      environment,
    );

    for (const result of [missingDirectory, fileWorkingDirectory]) {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "error",
        code: "WORKING_DIRECTORY_INVALID",
      });
    }
  });

  it("renders untrusted catalog metadata as terminal-safe single lines", async () => {
    const project = await createTemporaryDirectory();
    const definition = `schemaVersion: 1
workflow:
  id: hostile
  name: Hostile
nodes:
  - id: main
    kind: agent
    runtime: codex
    access: read_only
    prompt: Inspect.
edges: []
`;
    const packageDirectory = await writePackage(project, "hostile", definition);
    await writeFile(
      join(packageDirectory, "WORKFLOW.md"),
      '---\nname: hostile\ndescription: "Trusted\\n\\u001b[31mspoof"\n---\n',
    );
    await mkdir(join(project, ".agents", "workflows", "invalid\n\u001b[31m"));

    const listed = await runCli(["workflow", "list"], project);

    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("Trusted\\n\\u001b[31mspoof");
    expect(listed.stderr).toContain('workflow "invalid\\n\\u001b[31m"');
    expect(listed.stdout).not.toContain("\u001b");
    expect(listed.stderr).not.toContain("\u001b");
    expect(listed.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(listed.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it.each([
    [["workflow", "validate", "review", "--unknown"], "Unknown option"],
    [
      [
        "workflow",
        "init",
        "review",
        "--scope",
        "project",
        "--scope",
        "user",
        "--name",
        "Review",
        "--description",
        "Review workflow.",
      ],
      "provided more than once",
    ],
    [
      ["workflow", "init", "review", "--scope", "project", "--name", "Review"],
      'requires "--project-root',
    ],
    [["workflow", "validate", "review", "--scope", "workspace"], 'must be "project" or "user"'],
  ] as const)("rejects invalid arguments %#", async (arguments_, message) => {
    const result = await runCli([...arguments_]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("OPTION_INVALID");
    expect(result.stderr).toContain(message);
  });

  it("emits exact JSON documents for initialization, listing, and validation", async () => {
    const project = await createTemporaryDirectory();
    const packageDirectory = join(project, ".agents", "workflows", "json-review");

    const initialized = await runCli([
      "workflow",
      "init",
      "json-review",
      "--scope",
      "project",
      "--project-root",
      project,
      "--name",
      "JSON review",
      "--description",
      "Review JSON changes.",
      "--json",
    ]);
    const listed = await runCli(["workflow", "list", "--cwd", project, "--json"]);
    const validated = await runCli([
      "workflow",
      "validate",
      "json-review",
      "--cwd",
      project,
      "--json",
    ]);

    expect(JSON.parse(initialized.stdout)).toEqual({
      outputVersion: 1,
      scope: "project",
      directory: packageDirectory,
      manifestFile: join(packageDirectory, "WORKFLOW.md"),
      definitionFile: join(packageDirectory, "WORKFLOW.yaml"),
      workflowId: "json-review",
      created: true,
    });
    expect(JSON.parse(listed.stdout)).toMatchObject({
      outputVersion: 1,
      projectRoot: project,
      workflows: [{ name: "json-review", scope: "project" }],
      diagnostics: [],
    });
    expect(JSON.parse(validated.stdout)).toMatchObject({
      outputVersion: 1,
      valid: true,
      scope: "project",
      workflowId: "json-review",
      nodeCount: 1,
      edgeCount: 0,
      executionOrder: ["main"],
    });
  });

  it("emits a CommandError document without human output in JSON mode", async () => {
    const result = await runCli(["workflow", "validate", "missing", "--unknown", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      outputVersion: 1,
      type: "error",
      code: "OPTION_INVALID",
    });
  });

  it("does not expose malformed workflow contents in errors", async () => {
    const project = await createTemporaryDirectory();
    const sentinelSecret = "sentinel-secret-value";
    await writePackage(
      project,
      "safe-workflow",
      `schemaVersion: 1
workflow:
  id: safe-workflow
  name: Safe workflow
  name: ${sentinelSecret}
nodes:
  - id: main
    kind: agent
    runtime: codex
    access: read_only
    prompt: Review the workflow.
edges: []
`,
    );

    const human = await runCli(["workflow", "validate", "safe-workflow"], project);
    const json = await runCli(["workflow", "validate", "safe-workflow", "--json"], project);

    expect(human.exitCode).toBe(2);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("WORKFLOW_PARSE_FAILED");
    expect(human.stderr).not.toContain(sentinelSecret);
    expect(json.stdout).not.toContain(sentinelSecret);
    expect(JSON.parse(json.stdout)).toMatchObject({
      outputVersion: 1,
      type: "error",
      code: "WORKFLOW_PARSE_FAILED",
    });
  });

  it.each([
    [
      "duplicate-edge",
      `schemaVersion: 1
workflow: { id: duplicate-edge, name: Duplicate edge }
nodes:
  - { id: first, kind: agent, runtime: codex, access: read_only, prompt: Run first. }
  - { id: second, kind: agent, runtime: codex, access: read_only, prompt: Run second. }
edges:
  - { from: first, to: second }
  - { from: first, to: second }
`,
      "WORKFLOW_GRAPH_INVALID",
      "edges[1]",
    ],
    [
      "unsupported-kind",
      `schemaVersion: 1
workflow: { id: unsupported-kind, name: Unsupported kind }
nodes:
  - { id: approval, kind: gate, runtime: codex, access: read_only, prompt: Approve. }
edges: []
`,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].kind",
    ],
  ] as const)("reports %s package errors at the exact path", async (name, source, code, path) => {
    const project = await createTemporaryDirectory();
    await writePackage(project, name, source);

    const result = await runCli(["workflow", "validate", name, "--json"], project);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "error", code, path });
  });

  it("validates inline and file-referenced json output schemas", async () => {
    const project = await createTemporaryDirectory();
    const packageDirectory = await writePackage(
      project,
      "schema-review",
      `schemaVersion: 1
workflow:
  id: schema-review
  name: Schema review
nodes:
  - id: scan
    kind: agent
    runtime: codex
    access: read_only
    prompt: Scan the change for findings.
    output:
      type: json
      schema: schemas/findings.json
  - id: summarize
    kind: agent
    runtime: codex
    access: read_only
    prompt: Summarize the findings.
    output:
      type: json
      schema:
        type: object
        required: [summary]
        properties:
          summary: { type: string }
edges:
  - from: scan
    to: summarize
`,
    );
    await mkdir(join(packageDirectory, "schemas"));
    await writeFile(
      join(packageDirectory, "schemas", "findings.json"),
      JSON.stringify({
        type: "object",
        required: ["findings"],
        properties: { findings: { type: "array" } },
      }),
    );

    const validated = await runCli(["workflow", "validate", "schema-review", "--json"], project);

    expect(validated).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(validated.stdout)).toMatchObject({
      outputVersion: 1,
      valid: true,
      workflowId: "schema-review",
      nodeCount: 2,
      edgeCount: 1,
      executionOrder: ["scan", "summarize"],
    });
  });

  it("rejects malformed or unresolvable json output schemas without invoking a model", async () => {
    const project = await createTemporaryDirectory();
    const fakeBin = join(project, "fake-bin");
    const invocationLog = join(project, "runtime-invocations.log");
    await mkdir(fakeBin);
    for (const runtime of ["codex", "claude", "opencode"]) {
      await writeFile(join(fakeBin, runtime), `#!/bin/sh\necho invoked >> "${invocationLog}"\n`, {
        mode: 0o755,
      });
    }
    const schemaPackage = (name: string, schemaLines: string): string => `schemaVersion: 1
workflow:
  id: ${name}
  name: ${name}
nodes:
  - id: main
    kind: agent
    runtime: codex
    access: read_only
    prompt: Inspect the workspace.
    output:
      type: json
${schemaLines}
edges: []
`;
    const cases: [string, string, string, string][] = [
      [
        "schema-missing",
        "      schema: schemas/missing.json\n",
        "WORKFLOW_PACKAGE_INVALID",
        "schemas/missing.json",
      ],
      [
        "schema-malformed",
        "      schema: schemas/findings.json\n",
        "WORKFLOW_SCHEMA_INVALID",
        "schemas/findings.json",
      ],
      [
        "schema-inline-malformed",
        "      schema:\n        type: object\n        bogusKeyword: true\n",
        "WORKFLOW_SCHEMA_INVALID",
        "inline",
      ],
    ];
    for (const [name, schemaLines] of cases) {
      const packageDirectory = await writePackage(project, name, schemaPackage(name, schemaLines));
      if (name === "schema-malformed") {
        await mkdir(join(packageDirectory, "schemas"));
        await writeFile(
          join(packageDirectory, "schemas", "findings.json"),
          JSON.stringify({ type: "object", bogusKeyword: true }),
        );
      }
    }

    for (const [name, , code, named] of cases) {
      const result = await runCli(["workflow", "validate", name, "--json"], project, {
        PATH: fakeBin,
      });
      expect(result).toMatchObject({ exitCode: 2, stderr: "" });
      const document = JSON.parse(result.stdout) as { code: string; message: string };
      expect(document).toMatchObject({ outputVersion: 1, type: "error", code });
      expect(document.message).toContain(named);
    }
    expect(await pathExists(invocationLog)).toBe(false);
  });
});
