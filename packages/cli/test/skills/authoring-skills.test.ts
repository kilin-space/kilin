import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { initializeWorkflowPackage } from "../../src/application/workflows.js";
import { isCommandFailure } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const publisherFile = join(
  packageRoot,
  "agent-skills/generate-kilin-workflow/scripts/publish-workflow.mjs",
);
const reducerFile = join(
  packageRoot,
  "agent-skills/discover-kilin-workflows/scripts/reduce-history.mjs",
);
const collectorFile = join(
  packageRoot,
  "agent-skills/discover-kilin-workflows/scripts/collect-history.mjs",
);
const inspectorFile = join(
  packageRoot,
  "agent-skills/discover-kilin-workflows/scripts/inspect-history-layout.mjs",
);
const cliFile = join(packageRoot, "dist/cli/main.js");
const agentSkillsLinkWrapperFile = join(packageRoot, "scripts/link-agent-skills.mjs");
const temporaryDirectories: string[] = [];

interface OpenAiMetadata {
  policy?: {
    allow_implicit_invocation?: unknown;
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Candidate {
  file: string;
  bytes: Buffer;
}

interface SyntheticHistoryRecord {
  sessionId: string;
  rootSessionId: string;
  sessionKind: "root" | "resume" | "child";
  provider: string;
  projectPath: string;
  timestamp: string;
  rootUserRequest?: string;
  toolNames?: string[];
  [excludedField: string]: unknown;
}

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-authoring-skill-"));
  temporaryDirectories.push(directory);
  return directory;
};

const createCandidate = async (
  directory: string,
  id: string,
  prompt: string,
): Promise<Candidate> => {
  const file = join(directory, `${id}-candidate-${randomUUID()}.yaml`);
  const source = stringify({
    schemaVersion: 1,
    workflow: { id, name: `Workflow ${id}` },
    nodes: [
      {
        id: "main",
        kind: "agent",
        runtime: "codex",
        access: "read_only",
        prompt,
      },
    ],
    edges: [],
  });
  const bytes = Buffer.from(source, "utf8");
  await writeFile(file, bytes);
  return { file, bytes };
};

const runPublisher = async (
  scopeRoot: string,
  candidateFile: string,
  workflowId: string,
  scope: "project" | "user" = "project",
  cwd = scopeRoot,
  environment: Readonly<Record<string, string>> = {},
): Promise<CommandResult> => {
  const manifestCandidate = `${candidateFile}.md`;
  await writeFile(
    manifestCandidate,
    `---\nname: ${workflowId}\ndescription: Test workflow ${workflowId}\n---\n`,
  );
  return runPublisherTarget(
    scopeRoot,
    manifestCandidate,
    candidateFile,
    `.agents/workflows/${workflowId}`,
    scope,
    cwd,
    environment,
  );
};

const runPublisherTarget = async (
  scopeRoot: string,
  manifestCandidate: string,
  candidateFile: string,
  target: string,
  scope: "project" | "user" = "project",
  cwd = scopeRoot,
  environment: Readonly<Record<string, string>> = {},
): Promise<CommandResult> => {
  const arguments_ = [
    publisherFile,
    "--scope",
    scope,
    "--scope-root",
    scopeRoot,
    "--cwd",
    cwd,
    "--cli",
    cliFile,
    "--manifest-candidate",
    manifestCandidate,
    "--definition-candidate",
    candidateFile,
    "--target",
    target,
  ];
  try {
    const result = await execFileAsync(process.execPath, arguments_, {
      encoding: "utf8",
      shell: false,
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

const createHistoryBundle = async (
  records: SyntheticHistoryRecord[],
  coverage: Record<string, unknown> = {},
): Promise<string> => {
  const directory = await createTemporaryDirectory();
  const shard = join(directory, "records-000001.jsonl");
  const source =
    records.length === 0
      ? ""
      : `${records.map((record, index) => JSON.stringify({ ...record, recordOrdinal: index + 1 })).join("\n")}\n`;
  await writeFile(shard, source, { mode: 0o600 });
  await writeFile(
    join(directory, "bundle.json"),
    `${JSON.stringify({
      formatVersion: 1,
      complete: true,
      salt: "0".repeat(64),
      query: {},
      coverage,
      shards: [
        {
          file: "records-000001.jsonl",
          records: records.length,
          bytes: Buffer.byteLength(source),
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  return directory;
};

const executeScript = async (
  script: string,
  arguments_: string[],
  cwd: string,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(process.execPath, [script, ...arguments_], {
      cwd,
      encoding: "utf8",
      shell: false,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

const executeReducer = async (arguments_: string[], cwd: string): Promise<CommandResult> =>
  executeScript(reducerFile, arguments_, cwd);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("generate-kilin-workflow publisher", () => {
  it("publishes and validates a representative V1 workflow", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "v1-candidate.yaml");
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "v1-review", name: "V1 review" },
      nodes: [
        {
          id: "analyze",
          kind: "agent",
          runtime: "claude-code",
          access: "read_only",
          prompt: "Analyze exactly. 你好",
          output: { type: "json" },
        },
        {
          id: "write",
          kind: "agent",
          runtime: "opencode",
          access: "workspace_write",
          prompt: "Write the approved report.",
          output: { type: "artifact", path: "outputs/报告.md" },
        },
        { id: "approve", kind: "approval", question: "Publish the report?" },
      ],
      edges: [
        { from: "analyze", to: "write", input: "analysis" },
        { from: "write", to: "approve" },
      ],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "v1-review");
    const target = join(directory, ".agents/workflows/v1-review/WORKFLOW.yaml");
    const validation = await execFileAsync(
      process.execPath,
      [cliFile, "workflow", "validate", "v1-review", "--cwd", directory, "--json"],
      { encoding: "utf8", shell: false },
    );
    const published = parse(await readFile(target, "utf8")) as {
      nodes: { prompt?: string; question?: string }[];
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(validation.stdout)).toMatchObject({
      valid: true,
      workflowId: "v1-review",
      executionOrder: ["analyze", "write", "approve"],
    });
    expect(published.nodes[0]?.prompt).toBe("Analyze exactly. 你好");
    expect(published.nodes[2]?.question).toBe("Publish the report?");
  });

  it("round-trips a hostile Unicode multiline prompt without executing or changing it", async () => {
    const directory = await createTemporaryDirectory();
    const sentinel = join(directory, "must-not-be-created");
    const prompt = `First line\n---\n!<tag> $(touch ${sentinel})\n你好 🐉\n  indented\ttext\n`;
    const candidate = await createCandidate(directory, "hostile-unicode", prompt);

    const result = await runPublisher(directory, candidate.file, "hostile-unicode");
    const target = join(directory, ".agents/workflows/hostile-unicode/WORKFLOW.yaml");
    const targetBytes = await readFile(target);
    const parsed = parse(targetBytes.toString("utf8")) as {
      nodes: { prompt: string }[];
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(targetBytes).toEqual(candidate.bytes);
    expect(parsed.nodes[0]?.prompt).toBe(prompt);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes and validates a user workflow despite a same-name project workflow", async () => {
    const directory = await createTemporaryDirectory();
    const userHome = join(directory, "home");
    const project = join(userHome, "project");
    await mkdir(project, { recursive: true });
    const candidate = await createCandidate(directory, "portable-review", "Review any workspace.");
    await writeTestWorkflowPackage(
      join(project, ".agents", "workflows"),
      "portable-review",
      "Project review",
      stringify({
        schemaVersion: 1,
        workflow: { id: "portable-review", name: "Project review" },
        nodes: [
          {
            id: "project-node",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Review only this project.",
          },
        ],
        edges: [],
      }),
    );

    const result = await runPublisher(
      userHome,
      candidate.file,
      "portable-review",
      "user",
      project,
      { HOME: userHome },
    );
    const published = JSON.parse(result.stdout) as {
      scope: string;
      directory: string;
      validation: { scope: string; executionOrder: string[] };
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(published).toMatchObject({
      scope: "user",
      directory: join(await realpath(userHome), ".agents", "workflows", "portable-review"),
      validation: { scope: "user", executionOrder: ["main"] },
    });
  });

  it("rejects a project publication when cwd is not the physical scope root", async () => {
    const directory = await createTemporaryDirectory();
    const otherProject = await createTemporaryDirectory();
    const candidate = await createCandidate(directory, "wrong-project", "Review this workspace.");

    const result = await runPublisher(
      directory,
      candidate.file,
      "wrong-project",
      "project",
      otherProject,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
    });
    expect(result.stderr).toContain(
      "Project workflow scope root must be the exact physical working directory.",
    );
    await expect(
      lstat(join(directory, ".agents", "workflows", "wrong-project")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a user publication before staging when cwd is not a directory", async () => {
    const directory = await createTemporaryDirectory();
    const userHome = join(directory, "home");
    const file = join(directory, "not-a-directory");
    await mkdir(userHome);
    await writeFile(file, "not a directory");
    const candidate = await createCandidate(directory, "invalid-cwd", "Review any workspace.");

    const result = await runPublisher(userHome, candidate.file, "invalid-cwd", "user", file, {
      HOME: userHome,
    });

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("Working directory must be a physical directory.");
    await expect(
      lstat(join(userHome, ".agents", "workflows", "invalid-cwd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a deterministic error when the workflow scope root does not exist", async () => {
    const directory = await createTemporaryDirectory();
    const missingRoot = join(directory, "missing-root");
    const candidate = await createCandidate(directory, "missing-root", "Review this workspace.");

    const result = await runPublisher(missingRoot, candidate.file, "missing-root");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toBe("Workflow scope root must be an existing physical directory.\n");
    await expect(lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a deterministic error when the working directory does not exist", async () => {
    const directory = await createTemporaryDirectory();
    const userHome = join(directory, "home");
    const missingCwd = join(userHome, "missing-project");
    await mkdir(userHome);
    const candidate = await createCandidate(directory, "missing-cwd", "Review any workspace.");

    const result = await runPublisher(userHome, candidate.file, "missing-cwd", "user", missingCwd, {
      HOME: userHome,
    });

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toBe("Working directory must be an existing physical directory.\n");
    await expect(
      lstat(join(userHome, ".agents", "workflows", "missing-cwd")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create a target when candidate validation fails", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "invalid.yaml");
    const target = join(directory, ".agents/workflows/invalid");
    await writeFile(candidate, "schemaVersion: 1\nworkflow: {}\nnodes: []\nedges: []\n");

    const result = await runPublisher(directory, candidate, "invalid");

    expect(result.exitCode).toBe(1);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(directory, ".agents/workflows"))).resolves.toEqual([]);
  });

  it("preserves every byte of an existing target", async () => {
    const directory = await createTemporaryDirectory();
    const first = await createCandidate(directory, "existing", "original prompt");
    const second = await createCandidate(directory, "existing", "replacement prompt");
    const firstResult = await runPublisher(directory, first.file, "existing");
    const target = join(directory, ".agents/workflows/existing/WORKFLOW.yaml");

    const secondResult = await runPublisher(directory, second.file, "existing");

    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(1);
    await expect(readFile(target)).resolves.toEqual(first.bytes);
  });

  it("does not overwrite an existing user workflow target", async () => {
    const directory = await createTemporaryDirectory();
    const userHome = join(directory, "home");
    const project = join(userHome, "project");
    await mkdir(project, { recursive: true });
    const first = await createCandidate(directory, "user-existing", "original prompt");
    const second = await createCandidate(directory, "user-existing", "replacement prompt");
    const environment = { HOME: userHome };
    const firstResult = await runPublisher(
      userHome,
      first.file,
      "user-existing",
      "user",
      project,
      environment,
    );
    const target = join(userHome, ".agents/workflows/user-existing/WORKFLOW.yaml");

    const secondResult = await runPublisher(
      userHome,
      second.file,
      "user-existing",
      "user",
      project,
      environment,
    );

    expect(firstResult.exitCode).toBe(0);
    expect(secondResult.exitCode).toBe(1);
    await expect(readFile(target)).resolves.toEqual(first.bytes);
  });

  it("rejects a symlinked .agents path without publishing outside the project", async () => {
    const directory = await createTemporaryDirectory();
    const outsideDirectory = await createTemporaryDirectory();
    const candidate = await createCandidate(directory, "symlinked", "safe prompt");
    await mkdir(join(outsideDirectory, "workflows"));
    await symlink(outsideDirectory, join(directory, ".agents"));

    const result = await runPublisher(directory, candidate.file, "symlinked");

    expect(result.exitCode).toBe(1);
    await expect(lstat(join(outsideDirectory, "workflows/symlinked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symlinked workflows component without publishing outside the project", async () => {
    const directory = await createTemporaryDirectory();
    const outsideDirectory = await createTemporaryDirectory();
    const candidate = await createCandidate(directory, "linked-workflows", "safe prompt");
    await mkdir(join(directory, ".agents"));
    await symlink(outsideDirectory, join(directory, ".agents/workflows"));

    const result = await runPublisher(directory, candidate.file, "linked-workflows");

    expect(result.exitCode).toBe(1);
    await expect(lstat(join(outsideDirectory, "linked-workflows"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an out-of-root target before creating workflow directories", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = await createCandidate(directory, "outside", "safe prompt");
    const manifestCandidate = `${candidate.file}.md`;
    await writeFile(manifestCandidate, "---\nname: outside\ndescription: Outside workflow\n---\n");
    const outsideTarget = join(directory, "../outside");

    const result = await runPublisherTarget(
      directory,
      manifestCandidate,
      candidate.file,
      "../outside",
    );

    expect(result.exitCode).toBe(1);
    await expect(lstat(outsideTarget)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(directory, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes exactly one complete valid target under concurrent contention", async () => {
    const directory = await createTemporaryDirectory();
    const first = await createCandidate(directory, "race", "first complete prompt");
    const second = await createCandidate(directory, "race", "second complete prompt");

    const results = await Promise.all([
      runPublisher(directory, first.file, "race"),
      runPublisher(directory, second.file, "race"),
    ]);
    const target = join(directory, ".agents/workflows/race/WORKFLOW.yaml");
    const targetBytes = await readFile(target);
    const validation = await execFileAsync(
      process.execPath,
      [cliFile, "workflow", "validate", "race", "--cwd", directory, "--json"],
      { encoding: "utf8", shell: false },
    );

    expect(results.map(({ exitCode }) => exitCode).sort()).toEqual([0, 1]);
    expect([first.bytes.equals(targetBytes), second.bytes.equals(targetBytes)]).toContain(true);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    await expect(readdir(join(directory, ".agents/workflows"))).resolves.toEqual(["race"]);
  });

  it("publishes exactly one complete package when init and the authoring skill contend", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = await createCandidate(directory, "mixed-race", "publisher prompt");
    const workflowsDirectory = join(directory, ".agents", "workflows");

    const [publisherResult, initSucceeded] = await Promise.all([
      runPublisher(directory, candidate.file, "mixed-race"),
      initializeWorkflowPackage(
        workflowsDirectory,
        "mixed-race",
        "Initialized workflow",
        "Initialized during contention.",
      ).then(
        () => true,
        () => false,
      ),
    ]);
    const packageDirectory = join(workflowsDirectory, "mixed-race");
    const validation = await execFileAsync(
      process.execPath,
      [cliFile, "workflow", "validate", "mixed-race", "--cwd", directory, "--json"],
      { encoding: "utf8", shell: false },
    );

    expect([publisherResult.exitCode === 0, initSucceeded].filter(Boolean)).toHaveLength(1);
    expect((await lstat(join(packageDirectory, "WORKFLOW.md"))).isFile()).toBe(true);
    expect((await lstat(join(packageDirectory, "WORKFLOW.yaml"))).isFile()).toBe(true);
    expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
    await expect(readdir(workflowsDirectory)).resolves.toEqual(["mixed-race"]);
    expect(
      (await readdir(join(directory, ".agents"))).some(
        (entry) => entry.startsWith(".workflow-init-") || entry.startsWith(".workflow-stage-"),
      ),
    ).toBe(false);
  });

  it("stages one copy of a json output schema shared by two nodes and validates clean", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "schema-review-candidate.yaml");
    const schemaSource = `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: { findings: { type: "array" } },
    })}\n`;
    await mkdir(join(directory, "schemas"));
    await writeFile(join(directory, "schemas", "findings.json"), schemaSource);
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "schema-review", name: "Schema review" },
      nodes: [
        {
          id: "scan",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Scan the workspace.",
          output: { type: "json", schema: "./schemas/findings.json" },
        },
        {
          id: "rescan",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Rescan the workspace.",
          output: { type: "json", schema: "./schemas/findings.json" },
        },
      ],
      edges: [{ from: "scan", to: "rescan", input: "first" }],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "schema-review");
    const packageDirectory = join(directory, ".agents/workflows/schema-review");
    const stagedSchema = join(packageDirectory, "schemas/findings.json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ validation: { valid: true } });
    await expect(readFile(stagedSchema, "utf8")).resolves.toBe(schemaSource);
    expect((await stat(stagedSchema)).mode & 0o777).toBe(0o600);
    await expect(readdir(join(packageDirectory, "schemas"))).resolves.toEqual(["findings.json"]);
  });

  it("fails loudly when a referenced json output schema file is missing", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "schema-missing-candidate.yaml");
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "schema-missing", name: "Schema missing" },
      nodes: [
        {
          id: "scan",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Scan the workspace.",
          output: { type: "json", schema: "./schemas/findings.json" },
        },
      ],
      edges: [],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "schema-missing");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      'The json output schema "./schemas/findings.json" does not exist or is unreadable.',
    );
    await expect(
      lstat(join(directory, ".agents", "workflows", "schema-missing")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an oversized sparse json output schema without target or staging residue", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "schema-oversized-candidate.yaml");
    await mkdir(join(directory, "schemas"));
    const schemaFile = join(directory, "schemas", "findings.json");
    await writeFile(schemaFile, "");
    await truncate(schemaFile, 262_145);
    await writeFile(
      candidate,
      stringify({
        schemaVersion: 1,
        workflow: { id: "schema-oversized", name: "Schema oversized" },
        nodes: [
          {
            id: "scan",
            kind: "agent",
            runtime: "codex",
            access: "read_only",
            prompt: "Scan the workspace.",
            output: { type: "json", schema: "./schemas/findings.json" },
          },
        ],
        edges: [],
      }),
    );

    const result = await runPublisher(directory, candidate, "schema-oversized");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      'The json output schema "./schemas/findings.json" exceeds the 262144 byte limit.',
    );
    await expect(
      lstat(join(directory, ".agents", "workflows", "schema-oversized")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(join(directory, ".agents"))).some((entry) =>
        entry.startsWith(".workflow-stage-"),
      ),
    ).toBe(false);
  });

  it("rejects a schema path that case-collides with a staged package file", async (context) => {
    const directory = await createTemporaryDirectory();
    const probe = join(directory, "CaseProbe");
    await writeFile(probe, "");
    const caseInsensitive = await lstat(join(directory, "caseprobe")).then(
      () => true,
      () => false,
    );
    await rm(probe);
    if (!caseInsensitive) {
      context.skip();
    }
    const candidate = join(directory, "schema-collision-candidate.yaml");
    await writeFile(
      join(directory, "Workflow.yaml"),
      `${JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["findings"],
        properties: { findings: { type: "array" } },
      })}\n`,
    );
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "schema-collision", name: "Schema collision" },
      nodes: [
        {
          id: "scan",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Scan the workspace.",
          output: { type: "json", schema: "./Workflow.yaml" },
        },
      ],
      edges: [],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "schema-collision");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain(
      'The json output schema "./Workflow.yaml" collides with another staged package file.',
    );
    expect(result.stderr).not.toContain("already exists");
    await expect(
      lstat(join(directory, ".agents", "workflows", "schema-collision")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages a json output schema referenced from a loop body and validates clean", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "loop-schema-candidate.yaml");
    const schemaSource = `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    })}\n`;
    await mkdir(join(directory, "schemas"));
    await writeFile(join(directory, "schemas", "summary.json"), schemaSource);
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "loop-schema", name: "Loop schema" },
      nodes: [
        {
          id: "refinement",
          kind: "loop",
          maxIterations: 2,
          body: {
            nodes: [
              {
                id: "worker",
                kind: "agent",
                runtime: "codex",
                access: "read_only",
                prompt: "Revise the work.",
                output: { type: "json", schema: "./schemas/summary.json" },
              },
              {
                id: "review",
                kind: "agent",
                runtime: "codex",
                access: "read_only",
                prompt: "Review the work.",
                output: { type: "text" },
              },
              {
                id: "check",
                kind: "agent",
                runtime: "codex",
                access: "read_only",
                prompt: "Decide.",
                output: { type: "choice", choices: ["pass", "revise"] },
              },
            ],
            edges: [
              { from: "worker", to: "review", input: "draft" },
              { from: "review", to: "check", input: "feedback" },
            ],
          },
          decision: { node: "check", passChoice: "pass", reviseChoice: "revise" },
          feedback: { from: "review", to: "worker", input: "feedback" },
          result: { node: "worker" },
        },
      ],
      edges: [],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "loop-schema");
    const stagedSchema = join(directory, ".agents/workflows/loop-schema/schemas/summary.json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ validation: { valid: true } });
    await expect(readFile(stagedSchema, "utf8")).resolves.toBe(schemaSource);
  });

  it("rejects a definition containing a YAML alias during collection", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "alias-guard-candidate.yaml");
    const source = [
      "schemaVersion: 1",
      "workflow: { id: alias-guard, name: Alias guard }",
      "nodes:",
      "  - id: first",
      "    kind: agent",
      "    runtime: codex",
      "    access: read_only",
      "    prompt: &shared Review the code.",
      "  - id: second",
      "    kind: agent",
      "    runtime: codex",
      "    access: read_only",
      "    prompt: *shared",
      "edges: [{ from: first, to: second }]",
      "",
    ].join("\n");
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "alias-guard");

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(result.stderr).toContain("Candidate workflow definition is not valid YAML");
    expect(result.stderr).not.toContain("Candidate validation failed");
    await expect(
      lstat(join(directory, ".agents", "workflows", "alias-guard")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages a json output schema beneath a directory whose name starts with two dots", async () => {
    const directory = await createTemporaryDirectory();
    const candidate = join(directory, "dotdot-schema-candidate.yaml");
    const schemaSource = `${JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["findings"],
      properties: { findings: { type: "array" } },
    })}\n`;
    await mkdir(join(directory, "..foo"));
    await writeFile(join(directory, "..foo", "findings.json"), schemaSource);
    const source = stringify({
      schemaVersion: 1,
      workflow: { id: "dotdot-schema", name: "Dotdot schema" },
      nodes: [
        {
          id: "scan",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Scan the workspace.",
          output: { type: "json", schema: "./..foo/findings.json" },
        },
      ],
      edges: [],
    });
    await writeFile(candidate, source);

    const result = await runPublisher(directory, candidate, "dotdot-schema");
    const stagedSchema = join(directory, ".agents/workflows/dotdot-schema/..foo/findings.json");

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ validation: { valid: true } });
    await expect(readFile(stagedSchema, "utf8")).resolves.toBe(schemaSource);
  });
});

describe("discover-kilin-workflows reducer", () => {
  it("derives bounded previews by event chronology and excludes tool evidence", async () => {
    const project = await createTemporaryDirectory();
    const canonical = await realpath(project);
    const bundle = await createHistoryBundle([
      {
        sessionId: "preview-root",
        rootSessionId: "preview-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-03T00:00:00.000Z",
        assistantResponse: `Latest outcome ${"z".repeat(2_000)}`,
        toolArguments: { command: "TOOL_ARGUMENT_MUST_NOT_BE_PREVIEWED" },
      },
      {
        sessionId: "preview-root",
        rootSessionId: "preview-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-01T00:00:00.000Z",
        rootUserRequest: `Earliest request ${"x".repeat(2_000)}`,
      },
      {
        sessionId: "preview-root",
        rootSessionId: "preview-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-02T00:00:00.000Z",
        rootUserRequest: "Later request",
        assistantResponse: "Earlier outcome",
      },
      {
        sessionId: "preview-root",
        rootSessionId: "preview-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-03T00:00:00.000Z",
        assistantResponse: `Tie-later outcome ${"y".repeat(2_000)}`,
      },
    ]);

    const result = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const family = (
      JSON.parse(result.stdout) as {
        familyManifest: {
          requestPreview: string;
          requestPreviewSource: string;
          outcomePreview: string;
        }[];
      }
    ).familyManifest[0];

    expect(result.exitCode).toBe(0);
    expect(family?.requestPreview.startsWith("Earliest request")).toBe(true);
    expect(family?.requestPreview).toHaveLength(1_024);
    expect(family?.requestPreviewSource).toBe("root");
    expect(family?.outcomePreview.startsWith("Tie-later outcome")).toBe(true);
    expect(family?.outcomePreview).toHaveLength(1_024);
    expect(result.stdout).not.toContain("TOOL_ARGUMENT_MUST_NOT_BE_PREVIEWED");
  });

  it("reconstructs family topology and keeps colliding root IDs project-scoped", async () => {
    const firstProject = await createTemporaryDirectory();
    const secondProject = await createTemporaryDirectory();
    const first = await realpath(firstProject);
    const second = await realpath(secondProject);
    const bundle = await createHistoryBundle([
      {
        sessionId: "shared-root",
        rootSessionId: "shared-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: first,
        timestamp: "2026-07-01T00:00:00.000Z",
        rootUserRequest: "Root request",
      },
      {
        sessionId: "resume",
        rootSessionId: "shared-root",
        parentSessionId: "shared-root",
        sessionKind: "resume",
        provider: "codex",
        projectPath: first,
        timestamp: "2026-07-02T00:00:00.000Z",
        assistantResponse: "Resume outcome",
      },
      {
        sessionId: "child",
        rootSessionId: "shared-root",
        parentSessionId: "shared-root",
        sessionKind: "child",
        provider: "codex",
        projectPath: first,
        timestamp: "2026-07-03T00:00:00.000Z",
        assistantResponse: "Child outcome",
      },
      {
        sessionId: "orphan-resume",
        rootSessionId: "missing-root",
        sessionKind: "resume",
        provider: "codex",
        projectPath: first,
        timestamp: "2026-07-04T00:00:00.000Z",
        assistantResponse: "Orphan outcome",
      },
      {
        sessionId: "shared-root",
        rootSessionId: "shared-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: second,
        timestamp: "2026-07-05T00:00:00.000Z",
        rootUserRequest: "Other project request",
      },
    ]);

    const manifestResult = await executeReducer(
      ["--bundle", bundle, "--output", "manifest"],
      firstProject,
    );
    const manifest = JSON.parse(manifestResult.stdout) as {
      familyManifest: { familyRef: string; sessionKinds: string[] }[];
      coverage: { missingRootFamilies: number };
    };
    const rootFamily = manifest.familyManifest.find((family) => family.sessionKinds.length === 3);
    if (rootFamily === undefined) {
      throw new Error("Expected the reconstructed root family.");
    }
    const familyResult = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", rootFamily.familyRef],
      firstProject,
    );
    const family = JSON.parse(familyResult.stdout) as {
      family: {
        sessions: { kind: string; parentage: string }[];
        events: { observedOrdinal: number; sessionKind: string }[];
      };
    };

    expect(manifestResult.exitCode).toBe(0);
    expect(manifest.familyManifest).toHaveLength(3);
    expect(manifest.coverage.missingRootFamilies).toBe(1);
    expect(family.family.sessions).toEqual([
      expect.objectContaining({ kind: "root", parentage: "root" }),
      expect.objectContaining({ kind: "resume", parentage: "known" }),
      expect.objectContaining({ kind: "child", parentage: "known" }),
    ]);
    expect(family.family.events.map((event) => event.observedOrdinal)).toEqual([1, 2, 3]);
    expect(family.family.events.map((event) => event.sessionKind)).toEqual([
      "root",
      "resume",
      "child",
    ]);
  });

  it("deduplicates transport fields while retaining sanitized complementary evidence", async () => {
    const project = await createTemporaryDirectory();
    const bundle = await createHistoryBundle([
      {
        sessionId: "sanitized-root",
        rootSessionId: "sanitized-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: await realpath(project),
        timestamp: "2026-07-01T00:00:00.000Z",
        events: [
          { actor: "user", kind: "user", text: "One admitted request" },
          { actor: "assistant", kind: "tool_call", name: "read" },
        ],
        rootUserRequest: "One admitted request",
        toolNames: ["read"],
        toolArguments: { path: "project/file.ts" },
        assistantResponse: [
          "INERT_SENTINEL $(touch /tmp/should-not-run)",
          "password: hunter2",
          "timestamp 2024-01-15 10:30:00",
          "phones +1 (415) 555-2671 and +65 9123 4567",
          "numeric id 1234567890123456",
        ].join("; "),
        authentication: "EXCLUDED_PAYLOAD_SENTINEL",
        providerPayload: { secret: "EXCLUDED_PAYLOAD_SENTINEL" },
      },
    ]);
    const manifestResult = await executeReducer(
      ["--bundle", bundle, "--output", "manifest"],
      project,
    );
    const manifest = JSON.parse(manifestResult.stdout) as {
      familyManifest: { familyRef: string }[];
      coverage: { deduplicatedFields: number; excludedFields: number };
    };
    const familyRef = manifest.familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected one sanitized family.");
    }
    const familyResult = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", familyRef],
      project,
    );

    expect(manifest.coverage.deduplicatedFields).toBe(2);
    expect(manifest.coverage.excludedFields).toBeGreaterThanOrEqual(2);
    expect(familyResult.stdout).toContain("project/file.ts");
    expect(familyResult.stdout).toContain("INERT_SENTINEL");
    expect(familyResult.stdout).toContain("password=[secret]");
    expect(familyResult.stdout).toContain("2024-01-15 10:30:00");
    expect(familyResult.stdout).toContain("numeric id 1234567890123456");
    expect(familyResult.stdout).toContain("[phone]");
    expect(familyResult.stdout).not.toContain("+1 (415) 555-2671");
    expect(familyResult.stdout).not.toContain("+65 9123 4567");
    expect(familyResult.stdout).not.toContain("$1=[secret]");
    expect(familyResult.stdout).not.toContain("EXCLUDED_PAYLOAD_SENTINEL");
    await expect(lstat("/tmp/should-not-run")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects a consented workspace without admitting a sibling-prefix project", async () => {
    const workspace = await createTemporaryDirectory();
    const nestedProject = join(workspace, "products", "application");
    const siblingProject = `${workspace}-other`;
    const claudeRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    await mkdir(nestedProject, { recursive: true });
    await mkdir(siblingProject);
    temporaryDirectories.push(siblingProject);
    const projects = [workspace, nestedProject, siblingProject];
    await Promise.all(
      projects.map(async (project, index) => {
        await writeFile(
          join(claudeRoot, `workspace-${String(index)}.jsonl`),
          `${JSON.stringify({
            type: "user",
            sessionId: `workspace-${String(index)}`,
            cwd: await realpath(project),
            timestamp: `2026-07-0${String(index + 1)}T00:00:00.000Z`,
            message: { role: "user", content: "Workspace request" },
          })}\n`,
        );
      }),
    );

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "workspace",
        "--scope-root",
        workspace,
        "--scope-consent",
        "acknowledged-after-sanitized-history-egress-disclosure",
        "--active-provider",
        "claude",
        "--providers",
        "claude",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--claude-root",
        claudeRoot,
        "--bundle",
        bundle,
      ],
      workspace,
    );
    const completion = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      coverage: {
        includedRecords: number;
        excludedFiles: { project: number };
      };
    };

    expect(result.exitCode).toBe(0);
    expect(completion.coverage.includedRecords).toBe(2);
    expect(completion.coverage.excludedFiles.project).toBe(1);
  });

  it("skips and accounts for oversized source records before JSON parsing", async () => {
    const project = await createTemporaryDirectory();
    const codexRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    await writeFile(
      join(codexRoot, "oversized-source.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "oversized-source-root", cwd: await realpath(project) },
        }),
        JSON.stringify({
          type: "unsupported",
          timestamp: "2026-07-02T00:00:00.000Z",
          payload: "x".repeat(5 * 1_024 * 1_024),
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-03T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Retained request" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "repository",
        "--scope-root",
        project,
        "--active-provider",
        "codex",
        "--providers",
        "codex",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--bundle",
        bundle,
      ],
      project,
    );
    const completion = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      coverage: {
        includedRecords: number;
        excludedSourceRecords: { oversized: number };
      };
    };

    expect(result.exitCode).toBe(0);
    expect(completion.coverage.includedRecords).toBe(1);
    expect(completion.coverage.excludedSourceRecords.oversized).toBe(1);
  }, 30_000);

  it("rejects oversized normalized bundle records before parsing", async () => {
    const project = await createTemporaryDirectory();
    const bundle = await createHistoryBundle([
      {
        sessionId: "oversized-normalized-root",
        rootSessionId: "oversized-normalized-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: await realpath(project),
        timestamp: "2026-07-01T00:00:00.000Z",
        rootUserRequest: "x".repeat(600 * 1_024),
      },
    ]);

    const result = await executeReducer(["--bundle", bundle], project);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("normalized record line 1 exceeds");
  });

  it("does not report recognized Codex metadata as unknown content", async () => {
    const project = await createTemporaryDirectory();
    const codexRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    await writeFile(
      join(codexRoot, "metadata.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "metadata-root", cwd: await realpath(project) },
        }),
        JSON.stringify({
          type: "unsupported",
          timestamp: "2026-07-02T00:00:00.000Z",
          payload: {},
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-03T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Request" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "repository",
        "--scope-root",
        project,
        "--active-provider",
        "codex",
        "--providers",
        "codex",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--bundle",
        bundle,
      ],
      project,
    );
    const completion = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      coverage: { unknownSourceRecords: number };
    };

    expect(result.exitCode).toBe(0);
    expect(completion.coverage.unknownSourceRecords).toBe(1);
  });

  it("streams more than 10,000 records and 5 MiB across bounded shards", async () => {
    const project = await createTemporaryDirectory();
    const codexRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    const sessionFile = join(codexRoot, "session.jsonl");
    const metadata = {
      type: "session_meta",
      timestamp: "2026-07-01T00:00:00.000Z",
      payload: { id: "large-session", cwd: await realpath(project) },
    };
    const records = [JSON.stringify(metadata)];
    for (let index = 0; index < 15_005; index += 1) {
      const padding = index < 10_005 ? "short" : "x".repeat(3_000);
      records.push(
        JSON.stringify({
          type: "response_item",
          timestamp: new Date(Date.parse("2026-07-02T00:00:00.000Z") + index).toISOString(),
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `${String(index)}-${padding}` }],
          },
        }),
      );
    }
    await writeFile(sessionFile, `${records.join("\n")}\n`);

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "repository",
        "--scope-root",
        project,
        "--active-provider",
        "codex",
        "--providers",
        "codex",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--bundle",
        bundle,
      ],
      project,
    );
    const manifest = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      complete: boolean;
      coverage: { includedRecords: number };
      shards: { file: string; records: number; bytes: number }[];
    };

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(manifest.complete).toBe(true);
    expect(manifest.coverage.includedRecords).toBe(15_005);
    expect(manifest.shards.length).toBeGreaterThanOrEqual(3);
    expect(manifest.shards.every((shard) => shard.records <= 10_000)).toBe(true);
    expect(manifest.shards.every((shard) => shard.bytes <= 5 * 1_024 * 1_024)).toBe(true);
    const indexResult = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const familyRef = (
      JSON.parse(indexResult.stdout) as {
        familyManifest: { familyRef: string }[];
      }
    ).familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected the large family in the manifest.");
    }
    const bounded = await execFileAsync(
      process.execPath,
      [
        "--max-old-space-size=48",
        reducerFile,
        "--bundle",
        bundle,
        "--output",
        "family",
        "--family-ref",
        familyRef,
      ],
      { cwd: project, encoding: "utf8", shell: false },
    );
    const page = JSON.parse(bounded.stdout) as {
      family: { events: unknown[] };
      page: { complete: boolean; nextCursor?: string };
    };
    expect(page.family.events).toHaveLength(512);
    expect(page.page.complete).toBe(false);
    expect(page.page.nextCursor).toMatch(/^event-position:/u);
  }, 30_000);

  it("pages every family without recency loss or unstable references", async () => {
    const project = await createTemporaryDirectory();
    const canonical = await realpath(project);
    const records = Array.from({ length: 1_469 }, (_, index) => ({
      sessionId: `root-${String(index)}`,
      rootSessionId: `root-${String(index)}`,
      sessionKind: "root" as const,
      provider: "codex",
      projectPath: canonical,
      timestamp: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      rootUserRequest: `Request ${String(index)}`,
    }));
    const bundle = await createHistoryBundle(records);
    const references: string[] = [];
    let cursor: string | undefined;
    let firstPageReferences: string[] = [];
    do {
      const arguments_ = ["--bundle", bundle, "--output", "manifest"];
      if (cursor !== undefined) {
        arguments_.push("--cursor", cursor);
      }
      const result = await executeReducer(arguments_, project);
      const output = JSON.parse(result.stdout) as {
        familyManifest: { familyRef: string }[];
        page: { complete: boolean; nextCursor?: string };
      };
      expect(result.exitCode).toBe(0);
      const pageReferences = output.familyManifest.map((family) => family.familyRef);
      if (firstPageReferences.length === 0) {
        firstPageReferences = pageReferences;
      }
      references.push(...pageReferences);
      cursor = output.page.nextCursor;
    } while (cursor !== undefined);

    expect(references).toHaveLength(1_469);
    expect(new Set(references)).toHaveLength(1_469);
    const repeatedFirstPage = await executeReducer(
      ["--bundle", bundle, "--output", "manifest"],
      project,
    );
    expect(
      (
        JSON.parse(repeatedFirstPage.stdout) as { familyManifest: { familyRef: string }[] }
      ).familyManifest.map((family) => family.familyRef),
    ).toEqual(firstPageReferences);
  }, 30_000);

  it("returns a 520-event family as exact 512 and 8 event pages", async () => {
    const project = await createTemporaryDirectory();
    const canonical = await realpath(project);
    const bundle = await createHistoryBundle([
      {
        sessionId: "paged-root",
        rootSessionId: "paged-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-01T00:00:00.000Z",
        events: Array.from({ length: 520 }, (_, index) => ({
          actor: "assistant",
          kind: "assistant",
          text: `Event ${String(index)}`,
        })),
      },
    ]);
    const manifest = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const familyRef = (JSON.parse(manifest.stdout) as { familyManifest: { familyRef: string }[] })
      .familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected one family in the synthetic bundle.");
    }
    const first = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", familyRef],
      project,
    );
    const firstOutput = JSON.parse(first.stdout) as {
      family: { events: { observedOrdinal: number }[] };
      page: { nextCursor: string };
    };
    const second = await executeReducer(
      [
        "--bundle",
        bundle,
        "--output",
        "family",
        "--family-ref",
        familyRef,
        "--cursor",
        firstOutput.page.nextCursor,
      ],
      project,
    );
    const secondOutput = JSON.parse(second.stdout) as {
      family: { events: { observedOrdinal: number }[] };
      page: { complete: boolean };
    };

    expect(firstOutput.family.events).toHaveLength(512);
    expect(firstOutput.family.events.at(-1)?.observedOrdinal).toBe(512);
    expect(secondOutput.family.events).toHaveLength(8);
    expect(secondOutput.family.events[0]?.observedOrdinal).toBe(513);
    expect(secondOutput.family.events.at(-1)?.observedOrdinal).toBe(520);
    expect(secondOutput.page.complete).toBe(true);
  });

  it("preserves identical events at the same timestamp when their sequence differs", async () => {
    const project = await createTemporaryDirectory();
    const bundle = await createHistoryBundle([
      {
        sessionId: "duplicate-looking-root",
        rootSessionId: "duplicate-looking-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: await realpath(project),
        timestamp: "2026-07-01T00:00:00.000Z",
        events: [
          { actor: "assistant", kind: "assistant", text: "Repeated output" },
          { actor: "assistant", kind: "assistant", text: "Repeated output" },
        ],
      },
    ]);
    const manifest = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const familyRef = (JSON.parse(manifest.stdout) as { familyManifest: { familyRef: string }[] })
      .familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected one duplicate-looking family.");
    }
    const family = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", familyRef],
      project,
    );
    const output = JSON.parse(family.stdout) as { family: { events: unknown[] } };

    expect(output.family.events).toHaveLength(2);
  });

  it("retains null events without dereferencing them", async () => {
    const project = await createTemporaryDirectory();
    const bundle = await createHistoryBundle([
      {
        sessionId: "null-event-root",
        rootSessionId: "null-event-root",
        sessionKind: "root",
        provider: "codex",
        projectPath: await realpath(project),
        timestamp: "2026-07-01T00:00:00.000Z",
        events: [null],
      },
    ]);
    const manifest = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const familyRef = (
      JSON.parse(manifest.stdout) as {
        familyManifest: { familyRef: string }[];
      }
    ).familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected one null-event family.");
    }

    const result = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", familyRef],
      project,
    );
    const output = JSON.parse(result.stdout) as {
      family: { events: { content: unknown }[] };
    };

    expect(result.exitCode).toBe(0);
    expect(output.family.events).toEqual([expect.objectContaining({ content: null })]);
  });

  it("bounds an aggregate structured event so one-event retrieval stays reachable", async () => {
    const project = await createTemporaryDirectory();
    const codexRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    const nestedArguments = Array.from({ length: 64 }, (_, outer) =>
      Object.fromEntries(
        Array.from({ length: 16 }, (_, inner) => [
          `field-${String(inner)}`,
          `${String(outer)}-${"x".repeat(1_000)}`,
        ]),
      ),
    );
    await writeFile(
      join(codexRoot, "oversized-event.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "oversized-event-root", cwd: await realpath(project) },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-02T00:00:00.000Z",
          payload: { type: "function_call", name: "large_tool", arguments: nestedArguments },
        }),
      ].join("\n") + "\n",
    );

    const collection = await executeScript(
      collectorFile,
      [
        "--scope",
        "repository",
        "--scope-root",
        project,
        "--active-provider",
        "codex",
        "--providers",
        "codex",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--bundle",
        bundle,
      ],
      project,
    );
    const completion = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      coverage: { truncatedValues: number };
      shards: { bytes: number }[];
    };
    const manifest = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const familyRef = (JSON.parse(manifest.stdout) as { familyManifest: { familyRef: string }[] })
      .familyManifest[0]?.familyRef;
    if (familyRef === undefined) {
      throw new Error("Expected one bounded family.");
    }
    const family = await executeReducer(
      ["--bundle", bundle, "--output", "family", "--family-ref", familyRef, "--limit", "1"],
      project,
    );

    expect(collection.exitCode).toBe(0);
    expect(completion.coverage.truncatedValues).toBeGreaterThan(0);
    expect(completion.shards.every((shard) => shard.bytes <= 5 * 1_024 * 1_024)).toBe(true);
    expect(family.exitCode).toBe(0);
    expect(family.stdout).toContain("[event-size-limit]");
  }, 30_000);

  it("collects Codex and Claude provider shapes after expanded-scope consent", async () => {
    const project = await createTemporaryDirectory();
    const canonical = await realpath(project);
    const codexRoot = await createTemporaryDirectory();
    const claudeRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    await writeFile(
      join(codexRoot, "codex.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "codex-root", cwd: canonical },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-01T12:00:00.000Z",
          payload: { type: "user_message", message: "Codex request" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-02T00:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Codex request" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-30T23:59:59.999Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Unique Codex outcome" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-07-03T00:00:00.000Z",
          payload: { type: "agent_message", message: "Unique Codex outcome" },
        }),
      ].join("\n") + "\n",
    );
    await writeFile(
      join(claudeRoot, "claude.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "claude-root",
        cwd: canonical,
        timestamp: "2026-07-02T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Claude request" }] },
      })}\n`,
    );

    const deniedBundle = await createTemporaryDirectory();
    const denied = await executeScript(
      collectorFile,
      [
        "--scope",
        "all-projects",
        "--active-provider",
        "codex",
        "--providers",
        "codex,claude",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--claude-root",
        claudeRoot,
        "--bundle",
        deniedBundle,
      ],
      project,
    );

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "all-projects",
        "--active-provider",
        "codex",
        "--providers",
        "codex,claude",
        "--scope-consent",
        "acknowledged-after-sanitized-history-egress-disclosure",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--claude-root",
        claudeRoot,
        "--bundle",
        bundle,
      ],
      project,
    );
    const reduced = await executeReducer(["--bundle", bundle, "--output", "manifest"], project);
    const output = JSON.parse(reduced.stdout) as {
      familyManifest: {
        provider: string;
        observedEventCount: number;
        requestPreview?: string;
        outcomePreview?: string;
      }[];
    };
    const completion = JSON.parse(await readFile(join(bundle, "bundle.json"), "utf8")) as {
      salt: string;
    };

    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain("sanitized-history egress disclosure");
    await expect(readdir(deniedBundle)).resolves.toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(canonical);
    expect(result.stdout).not.toContain(completion.salt);
    expect(output.familyManifest.map((family) => family.provider).sort()).toEqual([
      "claude",
      "codex",
    ]);
    const codexFamily = output.familyManifest.find((family) => family.provider === "codex");
    expect(codexFamily).toMatchObject({
      observedEventCount: 2,
      requestPreview: "Codex request",
      outcomePreview: "Unique Codex outcome",
    });
  });

  it("rejects incomplete, non-private, symlinked, and stale-cursor bundles", async () => {
    const project = await createTemporaryDirectory();
    const canonical = await realpath(project);
    const incomplete = await createTemporaryDirectory();
    const incompleteResult = await executeReducer(["--bundle", incomplete], project);
    expect(incompleteResult.stderr).toContain("bundle.json");

    const bundle = await createHistoryBundle([
      {
        sessionId: "root",
        rootSessionId: "root",
        sessionKind: "root",
        provider: "codex",
        projectPath: canonical,
        timestamp: "2026-07-01T00:00:00.000Z",
        rootUserRequest: "Request",
      },
    ]);
    await chmod(join(bundle, "records-000001.jsonl"), 0o644);
    const publicResult = await executeReducer(["--bundle", bundle], project);
    expect(publicResult.stderr).toContain("0600");
    await chmod(join(bundle, "records-000001.jsonl"), 0o600);

    const link = join(await createTemporaryDirectory(), "bundle-link");
    await symlink(bundle, link);
    const symlinkResult = await executeReducer(["--bundle", link], project);
    expect(symlinkResult.stderr).toContain("not a symbolic link");

    const cursorResult = await executeReducer(
      ["--bundle", bundle, "--cursor", "family-stale"],
      project,
    );
    expect(cursorResult.stderr).toContain("cursor");

    const legacyInput = await executeReducer(
      ["--bundle", bundle, "--input", "legacy.jsonl"],
      project,
    );
    const legacyAll = await executeReducer(["--bundle", bundle, "--output", "all"], project);
    const legacyIndex = await executeReducer(["--bundle", bundle, "--family-index", "1"], project);
    expect(legacyInput.exitCode).toBe(1);
    expect(legacyAll.stderr).toContain("manifest or family");
    expect(legacyIndex.exitCode).toBe(1);

    const shard = join(bundle, "records-000001.jsonl");
    const original = await readFile(shard, "utf8");
    await writeFile(shard, original.replace("Request", "Requfst"), { mode: 0o600 });
    const mutatedResult = await executeReducer(["--bundle", bundle], project);
    expect(mutatedResult.stderr).toContain("completion manifest");
  });

  it("removes partial bundle shards when collection fails", async () => {
    const project = await createTemporaryDirectory();
    const codexRoot = await createTemporaryDirectory();
    const bundle = await createTemporaryDirectory();
    await writeFile(
      join(codexRoot, "malformed.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "malformed-root", cwd: await realpath(project) },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-02T00:00:00.000Z",
          payload: { type: "message", role: "user", content: "Admitted before failure" },
        }),
        "{malformed",
      ].join("\n") + "\n",
    );

    const result = await executeScript(
      collectorFile,
      [
        "--scope",
        "repository",
        "--scope-root",
        project,
        "--active-provider",
        "codex",
        "--providers",
        "codex",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--now",
        "2026-07-23T00:00:00.000Z",
        "--codex-root",
        codexRoot,
        "--bundle",
        bundle,
      ],
      project,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("malformed JSON");
    await expect(readdir(bundle)).resolves.toEqual([]);
  });

  it("inspects provider schema shapes without returning source values", async () => {
    const root = await createTemporaryDirectory();
    const secretValue = "DO_NOT_RETURN_THIS_VALUE";
    await writeFile(
      join(root, "shape.jsonl"),
      `${JSON.stringify({
        type: "user",
        sessionId: "shape-session",
        cwd: "/private/project",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: {
          role: "user",
          content: secretValue,
          ["PRIVATE_DYNAMIC_KEY_7491"]: "value",
        },
      })}\n`,
    );

    const result = await executeScript(
      inspectorFile,
      ["--provider", "claude", "--root", root],
      root,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("message.content");
    expect(result.stdout).not.toContain(secretValue);
    expect(result.stdout).not.toContain("shape-session");
    expect(result.stdout).not.toContain("/private/project");
    expect(result.stdout).not.toContain("PRIVATE_DYNAMIC_KEY_7491");
  });

  it("rejects an empty history root", async () => {
    const root = await createTemporaryDirectory();

    const result = await executeScript(inspectorFile, ["--provider", "claude", "--root", ""], root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Provide --provider, --root");
  });

  it("bounds aggregate history-shape traversal", async () => {
    const root = await createTemporaryDirectory();
    const oversizedShape = Array.from({ length: 20_000 }, () => "value");
    await writeFile(
      join(root, "oversized-shape.jsonl"),
      [
        JSON.stringify({ type: "user", message: { content: oversizedShape } }),
        JSON.stringify({ type: "assistant", message: { content: "must not be scanned" } }),
      ].join("\n") + "\n",
    );

    const result = await executeScript(
      inspectorFile,
      ["--provider", "claude", "--root", root],
      root,
    );
    const output = JSON.parse(result.stdout) as { recordCount: number; truncated: boolean };

    expect(result.exitCode).toBe(0);
    expect(output.recordCount).toBe(1);
    expect(output.truncated).toBe(true);
  });
});

describe("Kilin authoring skill contracts", () => {
  it("installs idempotent provider links to the repository-owned skills", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const { linkAgentSkills, resolvePackageRoot } =
      await import("../../src/infrastructure/agent-skills-link.js");

    const first = await linkAgentSkills({
      homeDirectory,
      packageRoot: resolvePackageRoot(),
      providers: ["agents", "claude"],
    });
    const second = await linkAgentSkills({
      homeDirectory,
      packageRoot: resolvePackageRoot(),
      providers: ["agents", "claude"],
    });

    expect(first.installedCount).toBe(6);
    expect(second.createdCount).toBe(0);
    for (const providerRoot of [".agents", ".claude"]) {
      for (const skillName of [
        "generate-kilin-workflow",
        "discover-kilin-workflows",
        "run-kilin-workflow",
      ]) {
        const installed = join(homeDirectory, providerRoot, "skills", skillName);
        const source = join(packageRoot, "agent-skills", skillName);
        expect((await lstat(installed)).isSymbolicLink()).toBe(true);
        expect(await realpath(installed)).toBe(await realpath(source));
      }
    }
  });

  it("runs the checkout compatibility wrapper without generated output", async () => {
    const checkoutRoot = await createTemporaryDirectory();
    const checkoutPackageRoot = join(checkoutRoot, "packages", "cli");
    const scriptsRoot = join(checkoutPackageRoot, "scripts");
    const homeDirectory = join(checkoutRoot, "home");
    await mkdir(scriptsRoot, { recursive: true });
    await Promise.all([
      cp(agentSkillsLinkWrapperFile, join(scriptsRoot, "link-agent-skills.mjs")),
      cp(join(packageRoot, "agent-skills"), join(checkoutPackageRoot, "agent-skills"), {
        recursive: true,
      }),
    ]);

    const result = await executeScript(
      join(scriptsRoot, "link-agent-skills.mjs"),
      ["--home", homeDirectory, "--providers", "agents"],
      checkoutRoot,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    await expect(lstat(join(checkoutPackageRoot, "dist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const skillName of [
      "generate-kilin-workflow",
      "discover-kilin-workflows",
      "run-kilin-workflow",
    ]) {
      const installed = join(homeDirectory, ".agents", "skills", skillName);
      expect((await lstat(installed)).isSymbolicLink()).toBe(true);
      expect(await realpath(installed)).toBe(
        await realpath(join(checkoutPackageRoot, "agent-skills", skillName)),
      );
    }
  });

  it("links every bundled skill for only the selected provider roots", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const { linkAgentSkills, resolvePackageRoot } =
      await import("../../src/infrastructure/agent-skills-link.js");

    await linkAgentSkills({
      homeDirectory,
      packageRoot: resolvePackageRoot(),
      providers: ["agents"],
    });

    for (const skillName of [
      "generate-kilin-workflow",
      "discover-kilin-workflows",
      "run-kilin-workflow",
    ]) {
      const agentsLink = join(homeDirectory, ".agents", "skills", skillName);
      const claudeLink = join(homeDirectory, ".claude", "skills", skillName);
      expect((await lstat(agentsLink)).isSymbolicLink()).toBe(true);
      await expect(lstat(claudeLink)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("repairs broken skill links that point at a missing target", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const { linkAgentSkills, resolvePackageRoot } =
      await import("../../src/infrastructure/agent-skills-link.js");
    const packageRoot = resolvePackageRoot();
    const skillsRoot = join(homeDirectory, ".agents", "skills");
    await mkdir(skillsRoot, { recursive: true });
    const broken = join(skillsRoot, "discover-kilin-workflows");
    await symlink(join(homeDirectory, "missing-skill-target"), broken);

    await linkAgentSkills({
      homeDirectory,
      packageRoot,
      providers: ["agents"],
    });

    expect(await realpath(broken)).toBe(
      await realpath(join(packageRoot, "agent-skills", "discover-kilin-workflows")),
    );
  });

  it("preflights every destination before repairing a broken skill link", async () => {
    const homeDirectory = await createTemporaryDirectory();
    const { linkAgentSkills, resolvePackageRoot } =
      await import("../../src/infrastructure/agent-skills-link.js");
    const skillsRoot = join(homeDirectory, ".agents", "skills");
    const missingTarget = join(homeDirectory, "missing-skill-target");
    const broken = join(skillsRoot, "discover-kilin-workflows");
    const conflict = join(skillsRoot, "run-kilin-workflow");
    await mkdir(skillsRoot, { recursive: true });
    await symlink(missingTarget, broken);
    await writeFile(conflict, "existing configuration");

    await expect(
      linkAgentSkills({
        homeDirectory,
        packageRoot: resolvePackageRoot(),
        providers: ["agents"],
      }),
    ).rejects.toThrow("Refusing to replace an existing non-link path");

    expect((await lstat(broken)).isSymbolicLink()).toBe(true);
    expect(await readlink(broken)).toBe(missingTarget);
    await expect(readFile(conflict, "utf8")).resolves.toBe("existing configuration");
    await expect(lstat(join(skillsRoot, "generate-kilin-workflow"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("discover-kilin-workflows invocation policy", () => {
  it("keeps implicit invocation of the history-reading skill disabled", async () => {
    const metadataSource = await readFile(
      join(packageRoot, "agent-skills/discover-kilin-workflows/agents/openai.yaml"),
      "utf8",
    );
    const metadata = parse(metadataSource) as OpenAiMetadata;

    expect(metadata.policy?.allow_implicit_invocation).toBe(false);
  });
});
