import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RunEvent } from "../../src/application/run-events.js";
import {
  parseRerunCommandArguments,
  parseResumeCommandArguments,
  parseRetryCommandArguments,
  parseRunCommandArguments,
  parseRunsCommandArguments,
  parseTriggerCommandArguments,
} from "../../src/cli/arguments.js";
import {
  createRunDetailDocument,
  renderError,
  renderRunDetail,
  renderRunEvent,
} from "../../src/cli/render.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type { NodeRunRecord, RunDetail } from "../../src/domain/run-state.js";
import type { ExecutionPlan, WorkflowDefinitionV1 } from "../../src/domain/workflow.js";
import { maximumHostTriggerRequestBytes } from "../../src/domain/workflow-trigger.js";
import { expectOptionError } from "../helpers/cli-errors.js";
import { pathExists } from "../helpers/filesystem.js";
import { parseJsonLines, readStrictJsonLines } from "../helpers/json-lines.js";
import { isCommandFailure, killProcessIfRunning, processIsRunning } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const fakeCodexFile = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

interface CliContext {
  readonly root: string;
  readonly project: string;
  readonly state: string;
  readonly workflowName: string;
  readonly workflowFile: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const workflow = (prompts: readonly string[]): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "cli-workflow", name: "CLI workflow" },
  nodes: prompts.map((prompt, index) => ({
    id: `node-${String(index)}`,
    kind: "agent",
    runtime: "codex",
    access: "read_only",
    prompt,
  })),
  edges: prompts.slice(0, -1).map((_prompt, index) => ({
    from: `node-${String(index)}`,
    to: `node-${String(index + 1)}`,
  })),
});

const createContext = async (prompts: readonly string[]): Promise<CliContext> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-run-cli-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const state = join(root, "state");
  const binaries = join(root, "bin");
  const workflowName = "cli-workflow";
  const invocationLog = join(root, "codex-calls.jsonl");
  const executionLog = join(root, "codex-executions.jsonl");
  await mkdir(binaries);
  const { definitionFile: workflowFile } = await writeTestWorkflowPackage(
    join(project, ".agents", "workflows"),
    workflowName,
    "CLI lifecycle test workflow",
    JSON.stringify(workflow(prompts)),
  );
  await symlink(fakeCodexFile, join(binaries, "codex"));
  return {
    root,
    project,
    state,
    workflowName,
    workflowFile,
    environment: {
      ...process.env,
      PATH: `${binaries}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      KILIN_DATA_DIR: state,
      FAKE_CODEX_LOG: invocationLog,
      FAKE_CODEX_EXEC_LOG: executionLog,
    },
  };
};

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> => {
  try {
    const result = await execFileAsync(process.execPath, [cliFile, ...arguments_], {
      encoding: "utf8",
      env: environment,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

const jsonLines = parseJsonLines<Record<string, unknown>>;

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

const revisionForPlan = (plan: ExecutionPlan, id: string): RunDetail["revision"] => ({
  id,
  scope: { kind: "project", root: "/project" },
  workflowId: plan.definition.workflow.id,
  schemaVersion: plan.definition.schemaVersion,
  contentHash: plan.contentHash,
  normalizedDefinition: plan.normalizedDefinition,
  createdAt: "2026-07-21T00:00:00.000Z",
});

const approvalProjectionPlan = compileWorkflow({
  schemaVersion: 1,
  workflow: { id: "approval-projection", name: "Approval projection" },
  nodes: [{ id: "gate", kind: "approval", question: "Ship this change?" }],
  edges: [],
});

const approvalDetail = (node: NodeRunRecord): RunDetail => ({
  run: {
    id: "run-approval",
    revisionId: "revision-approval",
    canonicalCwd: "/project",
    options: {
      nodeTimeoutMs: 1_000,
      approvalTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      maxParallel: 1,
    },
    status: "running",
    startedAt: "2026-07-21T00:00:00.000Z",
  },
  revision: revisionForPlan(approvalProjectionPlan, "revision-approval"),
  nodes: [node],
});

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the CLI test condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeAll(async () => chmod(fakeCodexFile, 0o755));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("run CLI arguments", () => {
  it("accepts the exact inclusive execution-option boundaries", () => {
    expect(
      parseRunCommandArguments([
        "workflow.yaml",
        "--cwd",
        "/project",
        "--node-timeout",
        "1s",
        "--approval-timeout",
        "24h",
        "--max-output-bytes",
        "1024",
      ]),
    ).toMatchObject({
      options: {
        nodeTimeoutMs: 1_000,
        approvalTimeoutMs: 86_400_000,
        maxOutputBytes: 1_024,
        maxParallel: 1,
      },
    });
    expect(
      parseRunCommandArguments([
        "workflow.yaml",
        "--cwd",
        "/project",
        "--node-timeout",
        "24h",
        "--max-output-bytes",
        "104857600",
        "--json",
      ]),
    ).toEqual({
      workflowName: "workflow.yaml",
      cwd: "/project",
      options: {
        nodeTimeoutMs: 86_400_000,
        approvalTimeoutMs: 1_800_000,
        maxOutputBytes: 104_857_600,
        maxParallel: 1,
      },
      parameters: {},
      json: true,
    });
  });

  it.each([
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--cwd", "/b"]),
      "more than once",
    ],
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--json", "--json"]),
      "more than once",
    ],
    [(): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd"]), "requires a value"],
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "extra", "--cwd", "/a"]),
      "Unexpected argument",
    ],
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--unknown"]),
      "Unknown option",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--node-timeout", "0s"]),
      "positive integer",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--node-timeout", "25h"]),
      "1s through 24h",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--approval-timeout", "0s"]),
      "positive integer",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--approval-timeout", "25h"]),
      "1s through 24h",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--max-output-bytes", "1023"]),
      "1024 through 104857600",
    ],
    [
      (): unknown =>
        parseRunCommandArguments([
          "workflow.yaml",
          "--cwd",
          "/a",
          "--max-output-bytes",
          "104857601",
        ]),
      "1024 through 104857600",
    ],
    [(): unknown => parseRerunCommandArguments(["run-id", "--cwd", "/a"]), "Unknown option"],
    [(): unknown => parseRetryCommandArguments(["run-id", "--node"]), "requires a value"],
    [(): unknown => parseRunsCommandArguments(["list", "--limit", "0"]), "1 through 1000"],
    [(): unknown => parseRunsCommandArguments(["list", "--limit", "1001"]), "1 through 1000"],
    [(): unknown => parseRunsCommandArguments(["list", "--status", "pending"]), "must be one of"],
    [(): unknown => parseRunsCommandArguments(["show", "run-id", "extra"]), "Unexpected argument"],
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--param", "task"]),
      'must receive "name=value"',
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--param", "=value"]),
      'must receive "name=value"',
    ],
    [
      (): unknown =>
        parseRunCommandArguments([
          "workflow.yaml",
          "--cwd",
          "/a",
          "--param",
          "task=a",
          "--param",
          "task=b",
        ]),
      'Parameter "task" was provided more than once',
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--param", "Task=a"]),
      'Parameter name "Task" is invalid',
    ],
    [
      (): unknown => parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--param"]),
      "requires a value",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--max-parallel", "0"]),
      "1 through 8",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--max-parallel", "9"]),
      "1 through 8",
    ],
    [
      (): unknown => parseRetryCommandArguments(["run-id", "--max-parallel", "2"]),
      "Unknown option",
    ],
    [
      (): unknown => parseResumeCommandArguments(["run-id", "--max-parallel", "2"]),
      "Unknown option",
    ],
    [
      (): unknown =>
        parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--param", "--json"]),
      "requires a value",
    ],
  ] as const)("rejects invalid or ambiguous invocation %#", (operation, message) => {
    expectOptionError(operation, message);
  });

  it("accepts the concurrency bound on run and rerun only", () => {
    expect(
      parseRunCommandArguments(["workflow.yaml", "--cwd", "/a", "--max-parallel", "8"]).options
        .maxParallel,
    ).toBe(8);
    expect(parseRerunCommandArguments(["run-id", "--max-parallel", "4"])).toEqual({
      runId: "run-id",
      maxParallel: 4,
      json: false,
    });
    // Omitting the flag on rerun reproduces the stored value rather than defaulting.
    expect(parseRerunCommandArguments(["run-id"])).toEqual({ runId: "run-id", json: false });
    expect(parseResumeCommandArguments(["run-id", "--json"])).toEqual({
      runId: "run-id",
      json: true,
    });
  });

  it("collects repeatable parameter assignments without weakening the option parser", () => {
    expect(
      parseRunCommandArguments([
        "workflow.yaml",
        "--param",
        "task=Review PR 42",
        "--cwd",
        "/project",
        "--param",
        "empty=",
        "--param",
        "equation=a=b=c",
        "--json",
      ]),
    ).toEqual({
      workflowName: "workflow.yaml",
      cwd: "/project",
      options: {
        nodeTimeoutMs: 1_800_000,
        approvalTimeoutMs: 1_800_000,
        maxOutputBytes: 10_485_760,
        maxParallel: 1,
      },
      parameters: { task: "Review PR 42", empty: "", equation: "a=b=c" },
      json: true,
    });
  });

  it("accepts an optional selective retry node", () => {
    expect(parseRetryCommandArguments(["run-id", "--node", "failed-node", "--json"])).toEqual({
      runId: "run-id",
      nodeId: "failed-node",
      json: true,
    });
  });

  it("accepts only an absolute trigger request file and optional JSON output", () => {
    expect(parseTriggerCommandArguments(["--request", "/scheduler/change-review.json"])).toEqual({
      requestFile: "/scheduler/change-review.json",
      json: false,
    });
    expect(
      parseTriggerCommandArguments(["--request", "/scheduler/change-review.json", "--json"]),
    ).toEqual({
      requestFile: "/scheduler/change-review.json",
      json: true,
    });

    expectOptionError(
      (): unknown => parseTriggerCommandArguments(["--request", "relative.json"]),
      "absolute file path",
    );
    expectOptionError(
      (): unknown => parseTriggerCommandArguments([]),
      'Missing required flag "--request"',
    );
    expectOptionError(
      (): unknown =>
        parseTriggerCommandArguments([
          "--request",
          "/scheduler/one.json",
          "--request",
          "/scheduler/two.json",
        ]),
      "more than once",
    );
    expectOptionError(
      (): unknown =>
        parseTriggerCommandArguments(["--request", "/scheduler/request.json", "--install"]),
      "Unknown option",
    );
  });
});

describe("run CLI documents", () => {
  it("projects a waiting approval with its immutable question and recorded decision", () => {
    const detail = approvalDetail({
      kind: "approval",
      runId: "run-approval",
      nodeId: "gate",
      ordinal: 0,
      status: "waiting_for_approval",
      requestedAt: "2026-07-21T00:00:01.000Z",
      deadlineAt: "2026-07-21T00:01:01.000Z",
      decision: {
        decision: "approve",
        actor: "human",
        decidedAt: "2026-07-21T00:00:02.000Z",
        note: "Reviewed locally",
      },
    });

    expect(createRunDetailDocument(detail, approvalProjectionPlan).nodes).toEqual([
      {
        kind: "approval",
        nodeId: "gate",
        ordinal: 0,
        question: "Ship this change?",
        status: "waiting_for_approval",
        requestedAt: "2026-07-21T00:00:01.000Z",
        deadlineAt: "2026-07-21T00:01:01.000Z",
        decision: {
          decision: "approve",
          actor: "human",
          decidedAt: "2026-07-21T00:00:02.000Z",
          note: "Reviewed locally",
        },
      },
    ]);
  });

  it("renders workflow and runtime text without terminal control characters", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "terminal-safe-detail", name: "Terminal-safe detail" },
      nodes: [
        {
          id: "gate",
          kind: "approval",
          question: "Ship?\u001b[2J\nReview the evidence.",
        },
      ],
      edges: [],
    });
    const detail: RunDetail = {
      run: {
        id: "run-terminal-safe",
        revisionId: "revision-terminal-safe",
        canonicalCwd: "/project/\u001b[31mred",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "succeeded",
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:00:02.000Z",
      },
      revision: revisionForPlan(plan, "revision-terminal-safe"),
      nodes: [
        {
          kind: "approval",
          runId: "run-terminal-safe",
          nodeId: "gate",
          ordinal: 0,
          status: "succeeded",
          requestedAt: "2026-07-21T00:00:01.000Z",
          deadlineAt: "2026-07-21T00:01:01.000Z",
          finishedAt: "2026-07-21T00:00:02.000Z",
          decision: {
            decision: "approve",
            actor: "human",
            decidedAt: "2026-07-21T00:00:02.000Z",
            note: "Looks good\r\u001b[1m",
          },
        },
      ],
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      renderRunDetail(detail, createRunDetailDocument(detail, plan));

      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).not.toContain("\u001b");
      expect(output).toContain("Working directory: /project/\\u001b[31mred");
      expect(output).toContain("question: Ship?\\u001b[2J\\nReview the evidence.");
      expect(output).toContain("note: Looks good\\r\\u001b[1m");
    } finally {
      write.mockRestore();
    }
  });

  const approvalBase = {
    kind: "approval" as const,
    runId: "run-approval",
    nodeId: "gate",
    ordinal: 0,
  };
  const request = {
    requestedAt: "2026-07-21T00:00:01.000Z",
    deadlineAt: "2026-07-21T00:01:01.000Z",
  };
  const approve = {
    decision: "approve" as const,
    actor: "human" as const,
    decidedAt: "2026-07-21T00:00:02.000Z",
  };
  const reject = { ...approve, decision: "reject" as const };
  const finishedAt = "2026-07-21T00:00:03.000Z";

  it.each([
    ["pending", { ...approvalBase, status: "pending" }, []],
    ["skipped", { ...approvalBase, status: "skipped", finishedAt }, ["finishedAt"]],
    [
      "waiting",
      { ...approvalBase, ...request, status: "waiting_for_approval" },
      ["requestedAt", "deadlineAt"],
    ],
    [
      "approved",
      { ...approvalBase, ...request, status: "succeeded", finishedAt, decision: approve },
      ["requestedAt", "deadlineAt", "finishedAt", "durationMs", "decision"],
    ],
    [
      "cancelled",
      { ...approvalBase, ...request, status: "cancelled", finishedAt, decision: approve },
      ["requestedAt", "deadlineAt", "finishedAt", "durationMs", "decision"],
    ],
    [
      "rejected",
      {
        ...approvalBase,
        ...request,
        status: "failed",
        finishedAt,
        decision: reject,
        failure: { code: "APPROVAL_REJECTED", message: "Rejected." },
      },
      ["requestedAt", "deadlineAt", "finishedAt", "durationMs", "decision", "error"],
    ],
    [
      "timed out",
      {
        ...approvalBase,
        ...request,
        status: "failed",
        finishedAt,
        failure: { code: "APPROVAL_TIMEOUT", message: "Timed out." },
      },
      ["requestedAt", "deadlineAt", "finishedAt", "durationMs", "error"],
    ],
    [
      "interrupted",
      {
        ...approvalBase,
        ...request,
        status: "interrupted",
        finishedAt,
        decision: approve,
        failure: { code: "RUN_INTERRUPTED", message: "Interrupted." },
      },
      ["requestedAt", "deadlineAt", "finishedAt", "durationMs", "decision", "error"],
    ],
  ] satisfies readonly (readonly [string, NodeRunRecord, readonly string[]])[])(
    "projects exact %s approval fields",
    (_name, node, statusFields) => {
      const summary = createRunDetailDocument(approvalDetail(node), approvalProjectionPlan)
        .nodes[0];

      expect(summary).toMatchObject({
        kind: "approval",
        nodeId: "gate",
        ordinal: 0,
        question: "Ship this change?",
        status: node.status,
      });
      expect(sortedKeys(summary ?? {})).toEqual(
        ["kind", "nodeId", "ordinal", "question", "status", ...statusFields].sort(),
      );
      expect(summary).not.toHaveProperty("runtime");
      expect(summary).not.toHaveProperty("stdoutPath");
    },
  );

  it("projects declared agent metadata while excluding effective runtime metadata", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "workflow-1", name: "Workflow 1" },
      nodes: [
        {
          id: "node-1",
          kind: "agent",
          runtime: "codex",
          access: "workspace_write",
          prompt: "Run the task",
          model: "requested-model",
          output: { type: "artifact", path: "reports/result.md" },
        },
      ],
      edges: [],
    });
    const detail: RunDetail = {
      run: {
        id: "run-1",
        revisionId: "revision-1",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "succeeded",
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:00:01.000Z",
      },
      revision: revisionForPlan(plan, "revision-1"),
      nodes: [
        {
          kind: "agent",
          runId: "run-1",
          nodeId: "node-1",
          ordinal: 0,
          runtime: "codex",
          requestedModel: "requested-model",
          effectiveModel: "effective-model",
          outputType: "artifact",
          artifactPath: "reports/result.md",
          resolvedInputsPath: "/state/resolved-inputs.json",
          status: "succeeded",
          startedAt: "2026-07-21T00:00:00.000Z",
          finishedAt: "2026-07-21T00:00:01.000Z",
          exitCode: 0,
          outputPaths: {
            stdoutPath: "/state/stdout.log",
            stderrPath: "/state/stderr.log",
            resultPath: "/state/result.txt",
          },
        },
      ],
    };

    expect(createRunDetailDocument(detail, plan).nodes).toMatchObject([
      {
        kind: "agent",
        model: "requested-model",
        outputType: "artifact",
        artifactPath: "reports/result.md",
        resolvedInputsPath: "/state/resolved-inputs.json",
      },
    ]);
  });

  it("projects and renders cron provenance only when the run has it", () => {
    const detail = approvalDetail({
      kind: "approval",
      runId: "run-approval",
      nodeId: "gate",
      ordinal: 0,
      status: "pending",
    });
    detail.run.trigger = {
      kind: "cron",
      schedule: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
    };
    const document = createRunDetailDocument(detail, approvalProjectionPlan);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      renderRunDetail(detail, document);

      expect(document.run.trigger).toEqual(detail.run.trigger);
      expect(write.mock.calls.map(([value]) => String(value)).join("")).toContain(
        "Trigger: cron 0 9 * * 1-5 (America/Los_Angeles)",
      );
    } finally {
      write.mockRestore();
    }
  });

  it("groups contained-loop executions and projects cancellation before admission", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "loop-detail", name: "Loop detail" },
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
                prompt: "Produce a draft.",
                output: { type: "text" },
              },
              {
                id: "review",
                kind: "agent",
                runtime: "codex",
                access: "read_only",
                prompt: "Review the draft.",
                output: { type: "text" },
              },
              {
                id: "decision",
                kind: "agent",
                runtime: "codex",
                access: "read_only",
                prompt: "Choose pass or revise.",
                output: { type: "choice", choices: ["pass", "revise"] },
              },
            ],
            edges: [
              { from: "worker", to: "review", input: "draft" },
              { from: "review", to: "decision", input: "feedback" },
            ],
          },
          decision: { node: "decision", passChoice: "pass", reviseChoice: "revise" },
          feedback: { from: "review", to: "worker", input: "feedback" },
          result: { node: "worker" },
        },
      ],
      edges: [],
    });
    const startedAt = "2026-07-26T00:00:00.000Z";
    const finishedAt = "2026-07-26T00:00:03.000Z";
    const nodes: NodeRunRecord[] = plan.nodes.map((plannedNode) => {
      if (plannedNode.node.kind === "loop") {
        return {
          kind: "loop",
          runId: "run-loop-detail",
          nodeId: plannedNode.executionId,
          ordinal: plannedNode.ordinal,
          status: "succeeded",
          startedAt,
          finishedAt,
          resultPath: "/state/loop/result.txt",
          outputType: plannedNode.node.output.type,
        };
      }
      const outputType =
        plannedNode.node.kind === "agent" ? plannedNode.node.output?.type : undefined;
      if (plannedNode.iteration === 0 && plannedNode.node.kind === "agent") {
        return {
          kind: "agent",
          runId: "run-loop-detail",
          nodeId: plannedNode.executionId,
          bodyNodeId: plannedNode.nodeId,
          loopNodeId: plannedNode.loopNodeId ?? "refinement",
          iteration: plannedNode.iteration,
          ordinal: plannedNode.ordinal,
          runtime: plannedNode.node.runtime,
          status: "succeeded",
          startedAt,
          finishedAt,
          exitCode: 0,
          outputPaths: {
            stdoutPath: `/state/${plannedNode.executionId}/stdout.log`,
            stderrPath: `/state/${plannedNode.executionId}/stderr.log`,
            resultPath: `/state/${plannedNode.executionId}/result.txt`,
          },
          ...(outputType === undefined ? {} : { outputType }),
          ...(plannedNode.node.id === plan.loops[0]?.iterations[0]?.resultExecutionId
            ? { attempt: 1 }
            : {}),
        };
      }
      if (plannedNode.node.kind !== "agent" || plannedNode.iteration === undefined) {
        throw new Error("The loop fixture contains an unexpected execution.");
      }
      return {
        kind: "agent",
        runId: "run-loop-detail",
        nodeId: plannedNode.executionId,
        bodyNodeId: plannedNode.nodeId,
        loopNodeId: plannedNode.loopNodeId ?? "refinement",
        iteration: plannedNode.iteration,
        ordinal: plannedNode.ordinal,
        runtime: plannedNode.node.runtime,
        status: "skipped",
        finishedAt,
        ...(outputType === undefined ? {} : { outputType }),
      };
    });
    const workerExecutionId = plan.loops[0]?.iterations[0]?.resultExecutionId;
    const decisionExecutionId = plan.loops[0]?.iterations[0]?.decisionExecutionId;
    if (workerExecutionId === undefined || decisionExecutionId === undefined) {
      throw new Error("The loop fixture is missing its result or decision execution.");
    }
    const detail: RunDetail = {
      run: {
        id: "run-loop-detail",
        revisionId: "revision-loop-detail",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 2,
        },
        status: "succeeded",
        startedAt,
        finishedAt,
      },
      revision: revisionForPlan(plan, "revision-loop-detail"),
      nodes,
      attempts: [
        {
          runId: "run-loop-detail",
          nodeId: workerExecutionId,
          attempt: 1,
          status: "succeeded",
          startedAt,
          finishedAt,
          exitCode: 0,
          outputPaths: {
            stdoutPath: `/state/${workerExecutionId}/stdout.log`,
            stderrPath: `/state/${workerExecutionId}/stderr.log`,
            resultPath: `/state/${workerExecutionId}/result.txt`,
          },
        },
      ],
    };
    const document = createRunDetailDocument(detail, plan);
    const loop = document.nodes[0];
    expect(loop).toMatchObject({
      kind: "loop",
      nodeId: "refinement",
      status: "succeeded",
      maxIterations: 2,
      passChoice: "pass",
      reviseChoice: "revise",
      feedbackInputName: "feedback",
      resultPath: "/state/loop/result.txt",
    });
    if (loop?.kind !== "loop") {
      throw new Error("The run-detail projection is missing its loop control.");
    }
    expect(loop.iterations).toHaveLength(2);
    expect(loop.iterations[0]).toMatchObject({ iteration: 0 });
    expect(loop.iterations[0]).toMatchObject({
      decisionExecutionId,
      feedbackSourceExecutionId: plan.loops[0]?.iterations[0]?.feedbackSourceExecutionId,
      feedbackTargetExecutionId: plan.loops[0]?.iterations[0]?.feedbackTargetExecutionId,
      resultExecutionId: workerExecutionId,
    });
    expect(loop.iterations[0]?.nodes[0]).toMatchObject({
      executionId: workerExecutionId,
      nodeId: "worker",
      loopNodeId: "refinement",
      iteration: 0,
    });
    expect(loop.iterations[1]).toMatchObject({ iteration: 1 });
    expect(document).not.toHaveProperty("parameters");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      renderRunDetail(detail, document);
      const output = write.mock.calls.map(([value]) => String(value)).join("");
      const columns = output.replace(/[ \t]+/gu, " ");
      expect(columns).toContain(
        "refinement succeeded loop max-iterations=2 pass=pass revise=revise",
      );
      expect(output).toContain("Iteration 0:");
      expect(output).toContain(`decision execution: ${decisionExecutionId}`);
      expect(columns).toContain(
        `worker succeeded codex execution=${workerExecutionId} loop=refinement iteration=0`,
      );
      expect(output).toContain("attempt 1: succeeded");
      expect(output).toContain("Iteration 1:");
    } finally {
      write.mockRestore();
    }

    const cancelledNodes: NodeRunRecord[] = plan.nodes.map((plannedNode) => {
      if (plannedNode.node.kind === "loop") {
        return {
          kind: "loop",
          runId: "run-loop-cancelled-before-admission",
          nodeId: plannedNode.executionId,
          ordinal: plannedNode.ordinal,
          status: "cancelled",
          finishedAt,
        };
      }
      if (plannedNode.node.kind !== "agent" || plannedNode.iteration === undefined) {
        throw new Error("The loop fixture contains an unexpected execution.");
      }
      return {
        kind: "agent",
        runId: "run-loop-cancelled-before-admission",
        nodeId: plannedNode.executionId,
        bodyNodeId: plannedNode.nodeId,
        loopNodeId: plannedNode.loopNodeId ?? "refinement",
        iteration: plannedNode.iteration,
        ordinal: plannedNode.ordinal,
        runtime: plannedNode.node.runtime,
        status: "skipped",
        finishedAt,
        ...(plannedNode.node.output === undefined
          ? {}
          : { outputType: plannedNode.node.output.type }),
      };
    });
    const cancelledDetail: RunDetail = {
      run: {
        id: "run-loop-cancelled-before-admission",
        revisionId: "revision-loop-detail",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 2,
        },
        status: "cancelled",
        startedAt,
        finishedAt,
      },
      revision: revisionForPlan(plan, "revision-loop-detail"),
      nodes: cancelledNodes,
    };

    const cancelledLoop = createRunDetailDocument(cancelledDetail, plan).nodes[0];
    expect(cancelledLoop).toMatchObject({
      kind: "loop",
      nodeId: "refinement",
      status: "cancelled",
      finishedAt,
    });
    expect(cancelledLoop).not.toHaveProperty("startedAt");
    expect(cancelledLoop).not.toHaveProperty("durationMs");
  });

  it("renders every immutable attempt for a retried node", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "attempt-detail", name: "Attempt detail" },
      nodes: [
        {
          id: "flaky",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Run",
          retry: {
            maxAttempts: 2,
            initialBackoffMs: 0,
            maxBackoffMs: 0,
            safeToRepeat: true,
          },
        },
        {
          id: "stable",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Continue",
        },
      ],
      edges: [{ from: "flaky", to: "stable" }],
    });
    const detail: RunDetail = {
      run: {
        id: "run-attempts",
        revisionId: "revision-attempts",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "succeeded",
        startedAt: "2026-07-24T00:00:00.000Z",
        finishedAt: "2026-07-24T00:00:02.000Z",
      },
      revision: revisionForPlan(plan, "revision-attempts"),
      nodes: [
        {
          kind: "agent",
          runId: "run-attempts",
          nodeId: "flaky",
          ordinal: 0,
          runtime: "codex",
          status: "succeeded",
          attempt: 2,
          startedAt: "2026-07-24T00:00:01.000Z",
          finishedAt: "2026-07-24T00:00:02.000Z",
          exitCode: 0,
          outputPaths: {
            stdoutPath: "/state/attempt-2/stdout.log",
            stderrPath: "/state/attempt-2/stderr.log",
            resultPath: "/state/attempt-2/result.txt",
          },
        },
        {
          kind: "agent",
          runId: "run-attempts",
          nodeId: "stable",
          ordinal: 1,
          runtime: "codex",
          status: "succeeded",
          attempt: 1,
          startedAt: "2026-07-24T00:00:02.000Z",
          finishedAt: "2026-07-24T00:00:03.000Z",
          exitCode: 0,
          outputPaths: {
            stdoutPath: "/state/stable/stdout.log",
            stderrPath: "/state/stable/stderr.log",
            resultPath: "/state/stable/result.txt",
          },
        },
      ],
      attempts: [
        {
          runId: "run-attempts",
          nodeId: "flaky",
          attempt: 1,
          status: "failed",
          startedAt: "2026-07-24T00:00:00.000Z",
          finishedAt: "2026-07-24T00:00:01.000Z",
          exitCode: 23,
          failure: { code: "NODE_EXIT_NONZERO", message: "The provider exited." },
          outputPaths: {
            stdoutPath: "/state/attempt-1/stdout.log",
            stderrPath: "/state/attempt-1/stderr.log",
            resultPath: "/state/attempt-1/result.txt",
          },
        },
        {
          runId: "run-attempts",
          nodeId: "flaky",
          attempt: 2,
          status: "succeeded",
          startedAt: "2026-07-24T00:00:01.000Z",
          finishedAt: "2026-07-24T00:00:02.000Z",
          exitCode: 0,
          outputPaths: {
            stdoutPath: "/state/attempt-2/stdout.log",
            stderrPath: "/state/attempt-2/stderr.log",
            resultPath: "/state/attempt-2/result.txt",
          },
        },
      ],
    };
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      renderRunDetail(detail, createRunDetailDocument(detail, plan));

      const output = write.mock.calls.map(([value]) => String(value)).join("");
      expect(output).toContain("attempt 1: failed");
      expect(output).toContain("error: NODE_EXIT_NONZERO: The provider exited.");
      expect(output).toContain("attempt 2: succeeded");
      expect(output).toContain("/state/attempt-2/result.txt");
      expect(output.replace(/[ \t]+/gu, " ")).toContain("1. stable succeeded codex");
      expect(output).toContain("started: 2026-07-24T00:00:02.000Z");
      expect(output).toContain("finished: 2026-07-24T00:00:03.000Z");
      expect(output).toContain("exit code: 0");
      expect(output).toContain("stdout: /state/stable/stdout.log");
      expect(output).toContain("stderr: /state/stable/stderr.log");
      expect(output).toContain("result: /state/stable/result.txt");
    } finally {
      write.mockRestore();
    }
  });

  it("exposes the live process on a running summary and omits terminal fields", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "workflow-active", name: "Workflow active" },
      nodes: [
        {
          id: "running-node",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Run",
        },
        {
          id: "pending-node",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Wait",
        },
      ],
      edges: [{ from: "running-node", to: "pending-node" }],
    });
    const detail: RunDetail = {
      run: {
        id: "run-active",
        revisionId: "revision-active",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "running",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
      revision: revisionForPlan(plan, "revision-active"),
      nodes: [
        {
          kind: "agent",
          runId: "run-active",
          nodeId: "running-node",
          ordinal: 0,
          runtime: "codex",
          status: "running",
          startedAt: "2026-07-21T00:00:00.100Z",
          outputPaths: {
            stdoutPath: "/state/running/stdout.log",
            stderrPath: "/state/running/stderr.log",
            resultPath: "/state/running/result.txt",
          },
          process: { pid: 4242, processGroupId: 4242, startIdentifier: "recorded-start" },
        },
        {
          kind: "agent",
          runId: "run-active",
          nodeId: "pending-node",
          ordinal: 1,
          runtime: "codex",
          status: "pending",
        },
      ],
    };

    const document = createRunDetailDocument(detail, plan);

    expect(sortedKeys(document.run)).toEqual([
      "cwd",
      "projectRoot",
      "revisionId",
      "runId",
      "startedAt",
      "status",
      "workflowId",
      "workflowScope",
    ]);
    expect(sortedKeys(document.nodes[0] ?? {})).toEqual([
      "durationMs",
      "kind",
      "nodeId",
      "ordinal",
      "pid",
      "resultPath",
      "runtime",
      "startedAt",
      "status",
      "stderrPath",
      "stdoutPath",
    ]);
    const running = document.nodes[0];
    if (running?.kind !== "agent" || running.status !== "running") {
      throw new Error("Expected a running agent summary");
    }
    expect(running.pid).toBe(4242);
    expect(running.durationMs).toBeGreaterThanOrEqual(0);
    expect(sortedKeys(document.nodes[1] ?? {})).toEqual([
      "kind",
      "nodeId",
      "ordinal",
      "runtime",
      "status",
    ]);
  });

  it("omits the process from a running summary whose attempt recorded none", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "workflow-unrecorded", name: "Workflow unrecorded" },
      nodes: [
        {
          id: "running-node",
          kind: "agent",
          runtime: "codex",
          prompt: "run",
          access: "read_only",
        },
      ],
      edges: [],
    });
    const detail: RunDetail = {
      run: {
        id: "run-unrecorded",
        revisionId: "revision-unrecorded",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "running",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
      revision: revisionForPlan(plan, "revision-unrecorded"),
      nodes: [
        {
          kind: "agent",
          runId: "run-unrecorded",
          nodeId: "running-node",
          ordinal: 0,
          runtime: "codex",
          status: "running",
          startedAt: "2026-07-21T00:00:00.100Z",
          outputPaths: {
            stdoutPath: "/state/running/stdout.log",
            stderrPath: "/state/running/stderr.log",
            resultPath: "/state/running/result.txt",
          },
        },
      ],
    };

    const document = createRunDetailDocument(detail, plan);

    const running = document.nodes[0];
    if (running?.kind !== "agent" || running.status !== "running") {
      throw new Error("Expected a running agent summary");
    }
    expect(sortedKeys(running)).not.toContain("pid");
    expect(running.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("renders interrupted and skipped summaries without inventing skipped paths", () => {
    const plan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "workflow-interrupted", name: "Workflow interrupted" },
      nodes: [
        {
          id: "interrupted-node",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Start",
        },
        {
          id: "skipped-node",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Skip",
        },
      ],
      edges: [{ from: "interrupted-node", to: "skipped-node" }],
    });
    const failure = {
      code: "RUN_INTERRUPTED" as const,
      message: "The prior process stopped. Inspect the logs before retrying.",
    };
    const detail: RunDetail = {
      run: {
        id: "run-interrupted",
        revisionId: "revision-interrupted",
        canonicalCwd: "/project",
        options: {
          nodeTimeoutMs: 1_000,
          approvalTimeoutMs: 1_000,
          maxOutputBytes: 1_024,
          maxParallel: 1,
        },
        status: "interrupted",
        startedAt: "2026-07-21T00:00:00.000Z",
        finishedAt: "2026-07-21T00:00:01.000Z",
        failure,
      },
      revision: revisionForPlan(plan, "revision-interrupted"),
      nodes: [
        {
          kind: "agent",
          runId: "run-interrupted",
          nodeId: "interrupted-node",
          ordinal: 0,
          runtime: "codex",
          status: "interrupted",
          startedAt: "2026-07-21T00:00:00.100Z",
          finishedAt: "2026-07-21T00:00:01.000Z",
          failure,
          outputPaths: {
            stdoutPath: "/state/interrupted/stdout.log",
            stderrPath: "/state/interrupted/stderr.log",
            resultPath: "/state/interrupted/result.txt",
          },
        },
        {
          kind: "agent",
          runId: "run-interrupted",
          nodeId: "skipped-node",
          ordinal: 1,
          runtime: "codex",
          status: "skipped",
          finishedAt: "2026-07-21T00:00:01.000Z",
        },
      ],
    };

    const document = createRunDetailDocument(detail, plan);

    expect(sortedKeys(document.run)).toEqual([
      "cwd",
      "durationMs",
      "error",
      "finishedAt",
      "projectRoot",
      "revisionId",
      "runId",
      "startedAt",
      "status",
      "workflowId",
      "workflowScope",
    ]);
    expect(sortedKeys(document.nodes[0] ?? {})).toEqual([
      "durationMs",
      "error",
      "finishedAt",
      "kind",
      "nodeId",
      "ordinal",
      "resultPath",
      "runtime",
      "startedAt",
      "status",
      "stderrPath",
      "stdoutPath",
    ]);
    expect(sortedKeys(document.nodes[1] ?? {})).toEqual([
      "finishedAt",
      "kind",
      "nodeId",
      "ordinal",
      "runtime",
      "status",
    ]);
  });
});

describe("approval event documents", () => {
  it("renders an approval request with exact decision commands and no process paths", () => {
    const writes: string[] = [];
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const event: RunEvent = {
      outputVersion: 1,
      type: "approval.requested",
      timestamp: "2026-07-21T00:00:01.000Z",
      runId: "run-approval",
      nodeId: "gate",
      ordinal: 1,
      question: "Ship this change?\u001b[2J\nNow",
      deadlineAt: "2026-07-21T00:01:01.000Z",
    };

    try {
      renderRunEvent(event, false);
    } finally {
      output.mockRestore();
    }

    const source = writes.join("");
    expect(source).toContain("Ship this change?\\u001b[2J\\nNow");
    expect(source).toContain("kilin runs approve run-approval gate --actor human");
    expect(source).toContain("kilin runs reject run-approval gate --actor human");
    expect(source).not.toContain("\u001b");
    expect(source).not.toContain("stdout");
  });

  it("escapes control characters in human-readable errors", () => {
    const writes: string[] = [];
    const output = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      renderError(
        new KilinError("INTERNAL_ERROR", "unsafe\u001b[2J\nmessage", "unsafe\npath"),
        false,
      );
    } finally {
      output.mockRestore();
    }

    const source = writes.join("");
    expect(source).toContain("unsafe\\npath");
    expect(source).toContain("unsafe\\u001b[2J\\nmessage");
    expect(source).not.toContain("\u001b");
  });

  it("addresses a loop-body approval by its scoped execution ID", () => {
    const writes: string[] = [];
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const event: RunEvent = {
      outputVersion: 1,
      type: "approval.requested",
      timestamp: "2026-07-26T00:00:01.000Z",
      runId: "run-loop-approval",
      executionId: "xopaque-approval-occurrence",
      nodeId: "body-gate",
      loopNodeId: "refinement",
      iteration: 1,
      ordinal: 4,
      question: "Continue this iteration?",
      deadlineAt: "2026-07-26T00:01:01.000Z",
    };

    try {
      renderRunEvent(event, false);
    } finally {
      output.mockRestore();
    }

    const source = writes.join("");
    expect(source).toContain(
      "kilin runs approve run-loop-approval xopaque-approval-occurrence --actor human",
    );
    expect(source).toContain(
      "kilin runs reject run-loop-approval xopaque-approval-occurrence --actor human",
    );
    expect(source).not.toContain("kilin runs approve run-loop-approval body-gate");
    expect(source).not.toContain("kilin runs reject run-loop-approval body-gate");
  });

  it("writes the exact path-free approval JSON event variants", () => {
    const events: RunEvent[] = [
      {
        outputVersion: 1,
        type: "approval.requested",
        timestamp: "2026-07-21T00:00:01.000Z",
        runId: "run-approval",
        nodeId: "gate",
        ordinal: 1,
        question: "Ship this change?",
        deadlineAt: "2026-07-21T00:01:01.000Z",
      },
      {
        outputVersion: 1,
        type: "approval.resolved",
        timestamp: "2026-07-21T00:00:02.000Z",
        runId: "run-approval",
        nodeId: "gate",
        ordinal: 1,
        decision: "approve",
        actor: "human",
      },
      {
        outputVersion: 1,
        type: "node.finished",
        nodeKind: "approval",
        timestamp: "2026-07-21T00:00:03.000Z",
        runId: "run-approval",
        nodeId: "gate",
        ordinal: 1,
        status: "succeeded",
        durationMs: 2_000,
      },
      {
        outputVersion: 1,
        type: "node.finished",
        nodeKind: "approval",
        timestamp: "2026-07-21T00:00:03.000Z",
        runId: "run-approval",
        nodeId: "later-gate",
        ordinal: 2,
        status: "skipped",
      },
    ];
    const writes: string[] = [];
    const output = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      for (const event of events) {
        renderRunEvent(event, true);
      }
    } finally {
      output.mockRestore();
    }

    const source = writes.join("");
    expect(jsonLines(source)).toEqual(events);
    expect(source).not.toContain("stdoutPath");
    expect(source).not.toContain("resultPath");
    expect(source).not.toContain("note");
  });
});

describe("run CLI lifecycle", () => {
  it("emits only the exact public JSONL lifecycle while provider output stays in logs", async () => {
    const context = await createContext(["private prompt", "second prompt"]);
    const result = await runCli(
      [
        "run",
        context.workflowName,
        "--cwd",
        context.project,
        "--node-timeout",
        "1m",
        "--max-output-bytes",
        "4096",
        "--json",
      ],
      context.environment,
    );
    const events = jsonLines(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "node.started",
      "node.finished",
      "node.started",
      "node.finished",
      "run.finished",
    ]);
    expect(sortedKeys(events[0] ?? {})).toEqual([
      "cwd",
      "outputVersion",
      "projectRoot",
      "revisionId",
      "runId",
      "timestamp",
      "type",
      "workflowId",
      "workflowScope",
    ]);
    expect(sortedKeys(events[1] ?? {})).toEqual([
      "nodeId",
      "ordinal",
      "outputVersion",
      "resultPath",
      "runId",
      "runtime",
      "stderrPath",
      "stdoutPath",
      "timestamp",
      "type",
    ]);
    expect(sortedKeys(events[2] ?? {})).toEqual([
      "durationMs",
      "exitCode",
      "nodeId",
      "ordinal",
      "outputVersion",
      "resultPath",
      "runId",
      "status",
      "stderrPath",
      "stdoutPath",
      "timestamp",
      "type",
    ]);
    expect(sortedKeys(events.at(-1) ?? {})).toEqual([
      "durationMs",
      "outputVersion",
      "runId",
      "status",
      "timestamp",
      "type",
    ]);
    expect(result.stdout).not.toContain("private prompt");
    expect(result.stdout).not.toContain("provider.event");
    expect(result.stdout).not.toContain("provider diagnostic");
  });

  it("executes a bounded host trigger request through the attached run lifecycle", async () => {
    const context = await createContext(["triggered prompt"]);
    const requestFile = join(context.root, "host-trigger.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        triggerVersion: 1,
        workflow: context.workflowName,
        cwd: context.project,
        source: {
          kind: "cron",
          schedule: "0 9 * * 1-5",
          timezone: "America/Los_Angeles",
        },
      }),
    );
    await chmod(requestFile, 0o600);

    const result = await runCli(
      ["trigger", "--request", requestFile, "--json"],
      context.environment,
    );
    const events = jsonLines(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "node.started",
      "node.finished",
      "run.finished",
    ]);
    expect(events[0]).toMatchObject({
      type: "run.started",
      workflowId: "cli-workflow",
      cwd: await realpath(context.project),
    });
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "succeeded" });
  });

  it("rejects unreadable, malformed, and oversized trigger requests before runtime execution", async () => {
    const context = await createContext(["must not run"]);
    const malformedFile = join(context.root, "malformed-trigger.json");
    const oversizedFile = join(context.root, "oversized-trigger.json");
    const writableFile = join(context.root, "writable-trigger.json");
    const symlinkTarget = join(context.root, "symlink-target.json");
    const symlinkFile = join(context.root, "symlink-trigger.json");
    await writeFile(malformedFile, "{");
    await writeFile(oversizedFile, "x".repeat(maximumHostTriggerRequestBytes + 1));
    await chmod(malformedFile, 0o600);
    await chmod(oversizedFile, 0o600);
    await writeFile(writableFile, "{}");
    await chmod(writableFile, 0o666);
    await writeFile(symlinkTarget, "{}");
    await chmod(symlinkTarget, 0o600);
    await symlink(symlinkTarget, symlinkFile);

    const missing = await runCli(
      ["trigger", "--request", join(context.root, "missing.json"), "--json"],
      context.environment,
    );
    const malformed = await runCli(
      ["trigger", "--request", malformedFile, "--json"],
      context.environment,
    );
    const oversized = await runCli(
      ["trigger", "--request", oversizedFile, "--json"],
      context.environment,
    );
    const writable = await runCli(
      ["trigger", "--request", writableFile, "--json"],
      context.environment,
    );
    const linked = await runCli(
      ["trigger", "--request", symlinkFile, "--json"],
      context.environment,
    );

    for (const result of [missing, malformed, oversized, writable, linked]) {
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      expect(jsonLines(result.stdout)).toMatchObject([{ type: "error", code: "OPTION_INVALID" }]);
    }
    expect(jsonLines(missing.stdout)[0]?.message).toContain("readable regular file");
    expect(jsonLines(malformed.stdout)[0]?.message).toContain("valid JSON object");
    expect(jsonLines(oversized.stdout)[0]?.message).toContain(
      `exceeds the ${String(maximumHostTriggerRequestBytes)} byte limit`,
    );
    expect(jsonLines(writable.stdout)[0]?.message).toContain(
      "must not be group- or world-writable",
    );
    expect(jsonLines(linked.stdout)[0]?.message).toContain("readable regular file");
    await expect(pathExists(join(context.root, "codex-executions.jsonl"))).resolves.toBe(false);
  });

  it("returns one for a recorded failure and emits skipped nodes in plan order", async () => {
    const context = await createContext(["pass", "fail", "never"]);
    const environment = {
      ...context.environment,
      FAKE_CODEX_BEHAVIORS: JSON.stringify({ fail: "nonzero" }),
    };

    const result = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      environment,
    );
    const events = jsonLines(result.stdout);
    const finishedNodes = events.filter(({ type }) => type === "node.finished");
    const failedNode = finishedNodes.find(({ status }) => status === "failed") ?? {};
    const skippedNode = finishedNodes.find(({ status }) => status === "skipped") ?? {};
    const finishedRun = events.at(-1) ?? {};

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(finishedNodes.map(({ status }) => status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(sortedKeys(failedNode)).toEqual([
      "durationMs",
      "error",
      "exitCode",
      "nodeId",
      "ordinal",
      "outputVersion",
      "resultPath",
      "runId",
      "status",
      "stderrPath",
      "stdoutPath",
      "timestamp",
      "type",
    ]);
    expect(sortedKeys(skippedNode)).toEqual([
      "nodeId",
      "ordinal",
      "outputVersion",
      "runId",
      "status",
      "timestamp",
      "type",
    ]);
    expect(sortedKeys(finishedRun)).toEqual([
      "durationMs",
      "error",
      "outputVersion",
      "runId",
      "status",
      "timestamp",
      "type",
    ]);
    expect(finishedRun).toMatchObject({ type: "run.finished", status: "failed" });
    expect(JSON.stringify(finishedRun)).toContain("NODE_EXIT_NONZERO");
    expect(result.stdout).not.toContain("provider partial stdout");
    expect(result.stdout).not.toContain("provider partial stderr");
  });

  it("returns two with one public error when runtime preflight fails", async () => {
    const context = await createContext(["never runs"]);
    const environment = {
      ...context.environment,
      FAKE_CODEX_SCENARIO: "auth-required",
    };

    const result = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      environment,
    );
    const events = jsonLines(result.stdout);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outputVersion: 1,
      type: "error",
      code: "RUNTIME_AUTH_REQUIRED",
    });
    expect(sortedKeys(events[0] ?? {})).toEqual([
      "code",
      "message",
      "outputVersion",
      "timestamp",
      "type",
    ]);
    expect(result.stdout).not.toContain("AUTH_SECRET_FROM_PROVIDER");
  });

  it("cancels preflight promptly on SIGINT without a diagnostic, state, or descendant", async () => {
    const context = await createContext(["never runs"]);
    const descendantPidPath = join(context.root, "preflight-descendant.pid");
    const descendantReadyPath = join(context.root, "preflight-descendant.ready");
    const signalMarkerPath = join(context.root, "preflight-signal.txt");
    const environment = {
      ...context.environment,
      FAKE_CODEX_SCENARIO: "version-descendant-timeout",
      FAKE_CODEX_DESCENDANT_PID: descendantPidPath,
      FAKE_CODEX_DESCENDANT_READY: descendantReadyPath,
      FAKE_CODEX_SIGNAL_MARKER: signalMarkerPath,
    };
    const child = spawn(
      process.execPath,
      [cliFile, "run", context.workflowName, "--cwd", context.project, "--json"],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for preflight cancellation."));
      }, 5_000);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        if (signal !== null || code === null) {
          reject(new Error(`CLI closed with signal ${signal ?? "unknown"}.`));
          return;
        }
        resolve(code);
      });
    });
    await waitFor(() => pathExists(descendantReadyPath));
    const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
    const interruptedAt = Date.now();

    child.kill("SIGINT");
    const exitCode = await closed;

    expect(exitCode).toBe(130);
    expect(Date.now() - interruptedAt).toBeLessThan(1_500);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    await expect(pathExists(context.state)).resolves.toBe(false);
    await expect(readFile(signalMarkerPath, "utf8")).resolves.toBe("SIGTERM");
    await waitFor(() => !processIsRunning(descendantPid));
  }, 7_000);

  it("reaps the process tree an unhandleably killed run left behind when it is resumed", async () => {
    const context = await createContext(["wait forever"]);
    const descendantPidPath = join(context.root, "orphan-descendant.pid");
    const environment = {
      ...context.environment,
      FAKE_CODEX_BEHAVIOR: "cancel-child",
      FAKE_CODEX_DESCENDANT_PID: descendantPidPath,
    };
    const child = spawn(
      process.execPath,
      [cliFile, "run", context.workflowName, "--cwd", context.project, "--json"],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    await waitFor(() => pathExists(descendantPidPath));
    const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
    const runId = String(jsonLines(stdout).find(({ type }) => type === "run.started")?.runId);

    try {
      // SIGKILL cannot be handled, so no signal handler and no `finally` can clean up here. This is
      // the crash the issue describes: the provider tree outlives the Kilin process entirely.
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(processIsRunning(descendantPid)).toBe(true);

      // Inspecting the run first reconciles it to `interrupted`. The reap must survive that, since
      // looking up the run id is the normal thing to do before resuming.
      const shownBefore = await runCli(["runs", "show", runId, "--json"], environment);
      expect(JSON.parse(shownBefore.stdout)).toMatchObject({ run: { status: "interrupted" } });
      expect(processIsRunning(descendantPid)).toBe(true);

      const resumed = await runCli(["resume", runId, "--json"], {
        ...environment,
        FAKE_CODEX_BEHAVIOR: "success",
      });

      expect(resumed.exitCode).toBe(0);
      await waitFor(() => !processIsRunning(descendantPid));
    } finally {
      killProcessIfRunning(descendantPid);
    }
  }, 20_000);

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "cancels an attached run on %s, reaps the process tree, persists cancellation, and exits 130",
    async (stopSignal) => {
      const context = await createContext(["wait forever"]);
      const descendantPidPath = join(context.root, `attached-descendant-${stopSignal}.pid`);
      const environment = {
        ...context.environment,
        FAKE_CODEX_BEHAVIOR: "cancel-child",
        FAKE_CODEX_DESCENDANT_PID: descendantPidPath,
      };
      const child = spawn(
        process.execPath,
        [cliFile, "run", context.workflowName, "--cwd", context.project, "--json"],
        { env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let interrupted = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      await waitFor(() => pathExists(descendantPidPath));
      const descendantPid = Number(await readFile(descendantPidPath, "utf8"));
      interrupted = true;
      child.kill(stopSignal);

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Timed out waiting for the ${stopSignal} cancellation contract.`));
        }, 5_000);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (signal !== null || code === null) {
            reject(new Error(`CLI closed with signal ${signal ?? "unknown"}.`));
            return;
          }
          resolve(code);
        });
      });
      const events = jsonLines(stdout);

      expect(interrupted).toBe(true);
      expect(exitCode).toBe(130);
      expect(stderr).toBe("");
      await waitFor(() => !processIsRunning(descendantPid));
      expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
      expect(events.filter(({ type }) => type === "run.finished")).toHaveLength(1);

      const runId = events.find(({ type }) => type === "run.started")?.runId;
      expect(typeof runId).toBe("string");
      const shown = await runCli(["runs", "show", String(runId), "--json"], environment);
      expect(shown.exitCode).toBe(0);
      const shownDocument = JSON.parse(shown.stdout) as {
        run: Record<string, unknown>;
        nodes: Record<string, unknown>[];
      };
      expect(shownDocument).toMatchObject({ run: { status: "cancelled" } });
      expect(sortedKeys(shownDocument.run)).toEqual([
        "cwd",
        "durationMs",
        "finishedAt",
        "projectRoot",
        "revisionId",
        "runId",
        "startedAt",
        "status",
        "workflowId",
        "workflowScope",
      ]);
      expect(sortedKeys(shownDocument.nodes[0] ?? {})).toEqual([
        "durationMs",
        "finishedAt",
        "kind",
        "nodeId",
        "ordinal",
        "resultPath",
        "runtime",
        "startedAt",
        "status",
        "stderrPath",
        "stdoutPath",
      ]);
    },
    10_000,
  );
});

describe("run CLI history and rerun", () => {
  it("renders exact detail documents and filters newest-first history", async () => {
    const context = await createContext(["first run"]);
    const first = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      context.environment,
    );
    const firstRunId = String(jsonLines(first.stdout)[0]?.runId);
    await writeFile(context.workflowFile, JSON.stringify(workflow(["second run"])));
    const second = await runCli(["run", context.workflowName, "--cwd", context.project, "--json"], {
      ...context.environment,
      FAKE_CODEX_BEHAVIOR: "nonzero",
    });
    const secondRunId = String(jsonLines(second.stdout)[0]?.runId);

    const listed = await runCli(["runs", "list", "--json"], context.environment);
    const filtered = await runCli(
      ["runs", "list", "--status", "succeeded", "--limit", "1", "--json"],
      context.environment,
    );
    const shown = await runCli(["runs", "show", firstRunId, "--json"], context.environment);
    const failedHuman = await runCli(["runs", "show", secondRunId], context.environment);
    const listDocument = JSON.parse(listed.stdout) as Record<string, unknown>;
    const listRuns = listDocument.runs as Record<string, unknown>[];
    const filteredDocument = JSON.parse(filtered.stdout) as { runs: Record<string, unknown>[] };
    const detail = JSON.parse(shown.stdout) as {
      run: Record<string, unknown>;
      nodes: Record<string, unknown>[];
    };

    expect(second.exitCode).toBe(1);
    expect(listed.stderr).toBe("");
    expect(sortedKeys(listDocument)).toEqual(["outputVersion", "runs"]);
    expect(listRuns.map(({ runId }) => runId)).toEqual([secondRunId, firstRunId]);
    expect(filteredDocument.runs.map(({ runId }) => runId)).toEqual([firstRunId]);
    expect(sortedKeys(detail.run)).toEqual([
      "cwd",
      "durationMs",
      "finishedAt",
      "projectRoot",
      "revisionId",
      "runId",
      "startedAt",
      "status",
      "workflowId",
      "workflowScope",
    ]);
    expect(detail.run).toMatchObject({ runId: firstRunId, status: "succeeded" });
    expect(detail.nodes).toHaveLength(1);
    expect(sortedKeys(detail.nodes[0] ?? {})).toEqual([
      "durationMs",
      "exitCode",
      "finishedAt",
      "kind",
      "nodeId",
      "ordinal",
      "resultPath",
      "runtime",
      "startedAt",
      "status",
      "stderrPath",
      "stdoutPath",
    ]);
    expect(failedHuman.exitCode).toBe(0);
    expect(failedHuman.stderr).toBe("");
    expect(failedHuman.stdout).toContain("runtime version: 0.144.6");
    expect(failedHuman.stdout).toContain("started: ");
    expect(failedHuman.stdout).toContain("finished: ");
    expect(failedHuman.stdout).toContain("duration: ");
    expect(failedHuman.stdout).toContain("exit code: 23");
    expect(failedHuman.stdout).toContain("error: NODE_EXIT_NONZERO:");
  });

  it("reruns the stored revision with JSONL and rejects all execution overrides", async () => {
    const context = await createContext(["stored prompt"]);
    const original = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      context.environment,
    );
    const originalRunId = String(jsonLines(original.stdout)[0]?.runId);
    await writeFile(context.workflowFile, JSON.stringify(workflow(["changed prompt"])));

    const rerun = await runCli(["rerun", originalRunId, "--json"], context.environment);
    const rerunEvents = jsonLines(rerun.stdout);
    const rerunId = String(rerunEvents[0]?.runId);
    const shown = await runCli(["runs", "show", rerunId, "--json"], context.environment);
    const shownDocument = JSON.parse(shown.stdout) as {
      run: Record<string, unknown>;
    };
    const override = await runCli(
      ["rerun", originalRunId, "--node-timeout", "1s", "--json"],
      context.environment,
    );
    const humanList = await runCli(["runs", "list"], context.environment);

    expect(rerun.exitCode).toBe(0);
    expect(rerunEvents.map(({ type }) => type)).toEqual([
      "run.started",
      "node.started",
      "node.finished",
      "run.finished",
    ]);
    expect(shownDocument.run).toMatchObject({
      runId: rerunId,
      rerunOfRunId: originalRunId,
      status: "succeeded",
    });
    expect(override.exitCode).toBe(2);
    expect(override.stderr).toBe("");
    expect(jsonLines(override.stdout)).toMatchObject([{ type: "error", code: "OPTION_INVALID" }]);
    expect(humanList.stdout).toContain(`rerun-of=${originalRunId}`);

    const executions = await readStrictJsonLines<{ prompt: string }>(
      join(context.root, "codex-executions.jsonl"),
    );
    expect(executions.map(({ prompt }) => prompt)).toEqual(["stored prompt", "stored prompt"]);
  });

  it("reruns a failed workflow from the first node instead of retrying only the failed node", async () => {
    const context = await createContext(["already succeeded", "fails once", "previously skipped"]);
    const original = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      {
        ...context.environment,
        FAKE_CODEX_BEHAVIORS: JSON.stringify({ "fails once": "nonzero" }),
      },
    );
    const originalEvents = jsonLines(original.stdout);
    const originalRunStarted = originalEvents[0] ?? {};
    const originalRunId = String(originalRunStarted.runId);

    const rerun = await runCli(["rerun", originalRunId, "--json"], context.environment);
    const rerunEvents = jsonLines(rerun.stdout);
    const rerunStarted = rerunEvents[0] ?? {};
    const rerunId = String(rerunStarted.runId);
    const originalShown = await runCli(
      ["runs", "show", originalRunId, "--json"],
      context.environment,
    );
    const rerunShown = await runCli(["runs", "show", rerunId, "--json"], context.environment);
    const originalDetail = JSON.parse(originalShown.stdout) as {
      run: Record<string, unknown>;
    };
    const rerunDetail = JSON.parse(rerunShown.stdout) as {
      run: Record<string, unknown>;
    };

    expect(original.exitCode).toBe(1);
    expect(
      originalEvents.filter(({ type }) => type === "node.finished").map(({ status }) => status),
    ).toEqual(["succeeded", "failed", "skipped"]);
    expect(rerun.exitCode).toBe(0);
    expect(
      rerunEvents.filter(({ type }) => type === "node.finished").map(({ status }) => status),
    ).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(rerunStarted).toMatchObject({
      type: "run.started",
      revisionId: originalRunStarted.revisionId,
    });
    expect(originalDetail.run).toMatchObject({
      runId: originalRunId,
      status: "failed",
    });
    expect(rerunDetail.run).toMatchObject({
      runId: rerunId,
      rerunOfRunId: originalRunId,
      status: "succeeded",
    });

    const executions = await readStrictJsonLines<{ prompt: string }>(
      join(context.root, "codex-executions.jsonl"),
    );
    expect(executions.map(({ prompt }) => prompt)).toEqual([
      "already succeeded",
      "fails once",
      "already succeeded",
      "fails once",
      "previously skipped",
    ]);
  });

  it("selectively retries the failed frontier in a continuation run", async () => {
    const context = await createContext(["checkpoint", "fails", "after"]);
    const original = await runCli(
      ["run", context.workflowName, "--cwd", context.project, "--json"],
      {
        ...context.environment,
        FAKE_CODEX_BEHAVIORS: JSON.stringify({ fails: "nonzero" }),
      },
    );
    const originalRunId = String(jsonLines(original.stdout)[0]?.runId);

    const retry = await runCli(["retry", originalRunId, "--json"], context.environment);
    const retryEvents = jsonLines(retry.stdout);
    const retryRunId = String(retryEvents[0]?.runId);
    const shown = await runCli(["runs", "show", retryRunId, "--json"], context.environment);
    const detail = JSON.parse(shown.stdout) as {
      run: Record<string, unknown>;
      nodes: Record<string, unknown>[];
    };

    expect(original.exitCode).toBe(1);
    expect(retry.exitCode).toBe(0);
    expect(
      retryEvents.filter(({ type }) => type === "node.finished").map(({ status }) => status),
    ).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(detail.run).toMatchObject({
      runId: retryRunId,
      recoveryOfRunId: originalRunId,
      recoveryMode: "retry",
      status: "succeeded",
    });
    expect(detail.nodes[0]).toMatchObject({
      nodeId: "node-0",
      reusedFromRunId: originalRunId,
    });
    const executions = await readStrictJsonLines<{ prompt: string }>(
      join(context.root, "codex-executions.jsonl"),
    );
    expect(executions.map(({ prompt }) => prompt)).toEqual([
      "checkpoint",
      "fails",
      "fails",
      "after",
    ]);
  });

  it("prints useful human progress without provider or prompt output", async () => {
    const context = await createContext(["human private prompt"]);
    const definition = workflow(["human private prompt"]);
    await writeFile(
      context.workflowFile,
      JSON.stringify({
        ...definition,
        nodes: definition.nodes.map((node) => ({ ...node, model: "requested-model" })),
      }),
    );

    const result = await runCli(
      ["run", context.workflowName, "--cwd", context.project],
      context.environment,
    );
    const listed = await runCli(["runs", "list", "--json"], context.environment);
    const listDocument = JSON.parse(listed.stdout) as { runs: { runId: string }[] };
    const runId = listDocument.runs[0]?.runId ?? "missing";
    const shown = await runCli(["runs", "show", runId], context.environment);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Run ");
    expect(result.stdout).toContain("at revision ");
    expect(result.stdout).toContain("Inspect: kilin runs show");
    expect(result.stdout).toContain("Rerun: kilin rerun");
    expect(result.stdout).toContain("stdout:");
    expect(result.stdout).toContain("stderr:");
    expect(result.stdout).toContain("result:");
    expect(result.stdout).toContain("using model requested-model");
    expect(result.stdout).not.toContain("human private prompt");
    expect(result.stdout).not.toContain("provider.event");
    expect(shown.exitCode).toBe(0);
    expect(shown.stderr).toBe("");
    expect(shown.stdout).toContain("requested model: requested-model");
    expect(shown.stdout).toContain("runtime version: 0.144.6");
    expect(shown.stdout).toContain("started: ");
    expect(shown.stdout).toContain("finished: ");
    expect(shown.stdout).toContain("duration: ");
    expect(shown.stdout).toContain("exit code: 0");
    expect(shown.stdout).not.toContain("human private prompt");
  });
});

describe("runs cancel CLI", () => {
  it("cancels a live attached run from a second process and reports one terminal state", async () => {
    const context = await createContext(["wait forever"]);
    const environment = { ...context.environment, FAKE_CODEX_BEHAVIOR: "wait" };
    const child = spawn(
      process.execPath,
      [cliFile, "run", context.workflowName, "--cwd", context.project, "--json"],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      // Covers CLI startup, compilation, runtime probing, and the fixture agent reaching node.started.
      // `jsonLines` parses every line below, so the buffer has to end on a line boundary.
      await waitFor(() => stdout.includes('"type":"node.started"') && stdout.endsWith("\n"), 5_000);
      const runId = jsonLines(stdout).find(({ type }) => type === "run.started")?.runId;
      expect(typeof runId).toBe("string");

      const cancelled = await runCli(["runs", "cancel", String(runId), "--json"], environment);
      expect(cancelled.exitCode).toBe(0);
      const document = JSON.parse(cancelled.stdout) as Record<string, unknown>;
      expect(document).toMatchObject({
        outputVersion: 1,
        cancellationRequested: true,
        runId: String(runId),
      });
      expect(typeof document.cancelRequestedAt).toBe("string");

      const exitCode = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Timed out waiting for the cancellation contract."));
        }, 10_000);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          if (signal !== null || code === null) {
            reject(new Error(`CLI closed with signal ${signal ?? "unknown"}.`));
            return;
          }
          resolve(code);
        });
      });

      expect(exitCode).toBe(130);
      expect(stderr).toBe("");
      const events = jsonLines(stdout);
      expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "cancelled" });
      expect(events.filter(({ type }) => type === "run.finished")).toHaveLength(1);

      const terminal = await runCli(["runs", "cancel", String(runId), "--json"], environment);
      expect(terminal.exitCode).toBe(2);
      expect(JSON.parse(terminal.stdout) as Record<string, unknown>).toMatchObject({
        type: "error",
        code: "RUN_NOT_CANCELLABLE",
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  it("rejects an unknown runs action and a missing cancel run ID", () => {
    expectOptionError((): unknown => parseRunsCommandArguments(["cancel"]), "A run ID is required");
    expectOptionError(
      (): unknown => parseRunsCommandArguments(["cancel", "run-id", "extra"]),
      "Unexpected argument",
    );
    expect(parseRunsCommandArguments(["cancel", "run-id", "--json"])).toEqual({
      action: "cancel",
      runId: "run-id",
      json: true,
    });
  });
});
