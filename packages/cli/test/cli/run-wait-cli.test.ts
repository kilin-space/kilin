import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseRunsCommandArguments } from "../../src/cli/arguments.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import type { FailureInfo } from "../../src/domain/run-state.js";
import type { WorkflowDefinitionV1 } from "../../src/domain/workflow.js";
import { StateStore } from "../../src/infrastructure/state-store.js";
import { acquireCanonicalWorkspaceLock } from "../../src/infrastructure/workspace-lock.js";
import { expectOptionError } from "../helpers/cli-errors.js";
import { parseJsonLines } from "../helpers/json-lines.js";
import { isCommandFailure } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const fakeCodexFile = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
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

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the run attention CLI condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const waitForClose = (child: ReturnType<typeof spawn>): Promise<number> =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal !== null || code === null) {
        reject(new Error(`CLI closed with signal ${signal ?? "unknown"}.`));
        return;
      }
      resolve(code);
    });
  });

beforeAll(async () => chmod(fakeCodexFile, 0o755));

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("runs wait CLI arguments", () => {
  it("accepts one run ID and the optional JSON flag", () => {
    expect(parseRunsCommandArguments(["wait", "run-1", "--json"])).toEqual({
      action: "wait",
      runId: "run-1",
      json: true,
    });
    expectOptionError(
      (): unknown => parseRunsCommandArguments(["wait", "run-1", "extra"]),
      "Unexpected argument",
    );
    expectOptionError((): unknown => parseRunsCommandArguments(["wait"]), "A run ID is required");
  });
});

describe("runs wait CLI behavior", () => {
  it.each([
    {
      status: "failed",
      exitCode: 1,
      failure: { code: "INTERNAL_ERROR", message: "The run failed." },
    },
    {
      status: "interrupted",
      exitCode: 1,
      failure: { code: "RUN_INTERRUPTED", message: "The run was interrupted." },
    },
    { status: "cancelled", exitCode: 130 },
  ] satisfies {
    status: "failed" | "interrupted" | "cancelled";
    exitCode: number;
    failure?: FailureInfo;
  }[])("returns $exitCode for a $status run", async ({ status, exitCode, failure }) => {
    const root = await mkdtemp(join(tmpdir(), "kilin-run-wait-terminal-"));
    temporaryDirectories.push(root);
    const state = join(root, "state");
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      workflow: { id: `wait-${status}`, name: `Wait ${status}` },
      nodes: [
        {
          id: "agent",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Finish without execution.",
        },
      ],
      edges: [],
    };
    const store = new StateStore(state);
    const created = store.createRun({
      plan: compileWorkflow(definition),
      identity: { scope: { kind: "user" }, workflowId: definition.workflow.id },
      canonicalCwd: root,
      options: {
        nodeTimeoutMs: 1_000,
        approvalTimeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxParallel: 1,
      },
    });
    store.skipPendingNodes(created.run.id);
    if (status === "cancelled") {
      store.transitionRun(created.run.id, { status });
    } else {
      store.transitionRun(created.run.id, { status, failure });
    }
    store.close();

    const result = await runCli(["runs", "wait", created.run.id, "--json"], {
      ...process.env,
      KILIN_DATA_DIR: state,
    });

    expect(result.exitCode).toBe(exitCode);
    expect(jsonLines(result.stdout)).toMatchObject([
      {
        type: "run.finished",
        status,
        ...(failure === undefined ? {} : { error: failure }),
      },
    ]);
    expect(result.stderr).toBe("");
  });

  it("returns only durable approval and terminal attention while attached JSONL stays unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "kilin-run-wait-cli-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const state = join(root, "state");
    const workflowName = "wait-approval";
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      workflow: { id: workflowName, name: "Wait approval" },
      nodes: [{ id: "gate", kind: "approval", question: "Continue the run?" }],
      edges: [],
    };
    await writeTestWorkflowPackage(
      join(project, ".agents", "workflows"),
      workflowName,
      "Wait CLI approval workflow",
      JSON.stringify(definition),
    );
    const environment = {
      ...process.env,
      KILIN_DATA_DIR: state,
    };
    const runner = spawn(
      process.execPath,
      [cliFile, "run", workflowName, "--cwd", project, "--json"],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const runnerClosed = waitForClose(runner);
    let stdout = "";
    let stderr = "";
    runner.stdout.setEncoding("utf8");
    runner.stderr.setEncoding("utf8");
    runner.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    runner.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => stdout.includes('"type":"approval.requested"'));
      const approvalEvent = jsonLines(stdout).find(({ type }) => type === "approval.requested");
      const runId = String(approvalEvent?.runId);

      const approvalAttention = await runCli(["runs", "wait", runId, "--json"], environment);
      expect(approvalAttention).toEqual({
        exitCode: 0,
        stdout: `${JSON.stringify(approvalEvent)}\n`,
        stderr: "",
      });

      const approved = await runCli(
        ["runs", "approve", runId, "gate", "--actor", "agent", "--json"],
        environment,
      );
      expect(approved.exitCode).toBe(0);
      await expect(runnerClosed).resolves.toBe(0);

      const events = jsonLines(stdout);
      expect(events.map(({ type }) => type)).toEqual([
        "run.started",
        "approval.requested",
        "approval.resolved",
        "node.finished",
        "run.finished",
      ]);
      const terminalEvent = events.at(-1);
      const terminalAttention = await runCli(["runs", "wait", runId, "--json"], environment);
      expect(terminalAttention).toEqual({
        exitCode: 0,
        stdout: `${JSON.stringify(terminalEvent)}\n`,
        stderr: "",
      });
      expect(stderr).toBe("");
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) {
        runner.kill("SIGINT");
        await runnerClosed.catch(() => undefined);
      }
    }
  });

  it("stops only the waiter on SIGINT", async () => {
    const root = await mkdtemp(join(tmpdir(), "kilin-run-wait-signal-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const state = join(root, "state");
    const binaries = join(root, "bin");
    await Promise.all([mkdir(project), mkdir(binaries)]);
    await symlink(fakeCodexFile, join(binaries, "codex"));
    const canonicalCwd = await realpath(project);
    const definition: WorkflowDefinitionV1 = {
      schemaVersion: 1,
      workflow: { id: "wait-signal", name: "Wait signal" },
      nodes: [
        {
          id: "agent",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "Remain pending.",
        },
      ],
      edges: [],
    };
    const store = new StateStore(state);
    const lock = await acquireCanonicalWorkspaceLock(canonicalCwd, state);
    const created = store.createRun({
      plan: compileWorkflow(definition),
      identity: {
        scope: { kind: "project", root: canonicalCwd },
        workflowId: definition.workflow.id,
      },
      canonicalCwd,
      options: {
        nodeTimeoutMs: 1_000,
        approvalTimeoutMs: 1_000,
        maxOutputBytes: 1_024,
        maxParallel: 1,
      },
    });
    store.close();
    const readinessPath = join(state, "locks", "migrations.lock");
    await rm(readinessPath);
    const environment = {
      ...process.env,
      PATH: `${binaries}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      KILIN_DATA_DIR: state,
    };
    const waiter = spawn(process.execPath, [cliFile, "runs", "wait", created.run.id, "--json"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const waiterClosed = waitForClose(waiter);
    let stdout = "";
    let stderr = "";
    waiter.stdout.setEncoding("utf8");
    waiter.stderr.setEncoding("utf8");
    waiter.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    waiter.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() =>
        access(readinessPath).then(
          () => true,
          () => false,
        ),
      );
      waiter.kill("SIGINT");
      await expect(waiterClosed).resolves.toBe(130);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      const inspectionStore = new StateStore(state);
      try {
        expect(inspectionStore.getRun(created.run.id).run.status).toBe("running");
        expect(inspectionStore.getRun(created.run.id).nodes[0]?.status).toBe("pending");
      } finally {
        inspectionStore.close();
      }
    } finally {
      if (waiter.exitCode === null && waiter.signalCode === null) {
        waiter.kill("SIGKILL");
        await waiterClosed.catch(() => undefined);
      }
      await lock.release();
      const cleanupStore = new StateStore(state);
      cleanupStore.reconcileStaleRuns(canonicalCwd);
      cleanupStore.close();
    }
  });
});
