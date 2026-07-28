import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { parseRunsCommandArguments } from "../../src/cli/arguments.js";
import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import type { RunOptions } from "../../src/domain/run-state.js";
import type { ExecutionPlan } from "../../src/domain/workflow.js";
import { StateStore } from "../../src/infrastructure/state-store.js";
import { acquireCanonicalWorkspaceLock } from "../../src/infrastructure/workspace-lock.js";
import { expectOptionError } from "../helpers/cli-errors.js";
import { parseJsonLines } from "../helpers/json-lines.js";
import { isCommandFailure } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const temporaryDirectories: string[] = [];
const foregroundProcesses = new Set<ForegroundCli>();
const options: RunOptions = {
  nodeTimeoutMs: 60_000,
  approvalTimeoutMs: 60_000,
  maxOutputBytes: 4_096,
  maxParallel: 1,
};

interface ApprovalContext {
  readonly dataDirectory: string;
  readonly canonicalCwd: string;
  readonly runId: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface ApprovalProject {
  readonly dataDirectory: string;
  readonly canonicalCwd: string;
  readonly workflowName: string;
  readonly workflowFile: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface ForegroundResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ForegroundCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<ForegroundResult>;
  readonly stdout: () => string;
}

const approvalPlan = (): ExecutionPlan =>
  compileWorkflow({
    schemaVersion: 1,
    workflow: { id: "approval-cli", name: "Approval CLI" },
    nodes: [{ id: "gate", kind: "approval", question: "Ship this change?" }],
    edges: [],
  });

const createApprovalProject = async (): Promise<ApprovalProject> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-approval-cli-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const dataDirectory = join(root, "state");
  await mkdir(project);
  const canonicalCwd = await realpath(project);
  const workflowName = "approval-cli";
  const { definitionFile: workflowFile } = await writeTestWorkflowPackage(
    join(project, ".agents", "workflows"),
    workflowName,
    "Approval CLI test workflow",
    `schemaVersion: 1
workflow:
  id: approval-cli
  name: Approval CLI
nodes:
  - id: gate
    kind: approval
    question: Ship this change?
edges: []
`,
  );
  return {
    dataDirectory,
    canonicalCwd,
    workflowName,
    workflowFile,
    environment: { ...process.env, KILIN_DATA_DIR: dataDirectory },
  };
};

const createWaitingApproval = async (): Promise<ApprovalContext> => {
  const context = await createApprovalProject();
  const store = new StateStore(context.dataDirectory);
  const created = store.createRun({
    plan: approvalPlan(),
    identity: {
      scope: { kind: "project", root: context.canonicalCwd },
      workflowId: "approval-cli",
    },
    canonicalCwd: context.canonicalCwd,
    options,
  });
  store.requestApproval(created.run.id, "gate");
  store.close();
  return {
    dataDirectory: context.dataDirectory,
    canonicalCwd: context.canonicalCwd,
    runId: created.run.id,
    environment: context.environment,
  };
};

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

const completeJsonLines = (source: string): Record<string, unknown>[] => {
  const finalNewline = source.lastIndexOf("\n");
  return finalNewline === -1 ? [] : jsonLines(source.slice(0, finalNewline));
};

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the approval CLI condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const startCli = (arguments_: readonly string[], environment: NodeJS.ProcessEnv): ForegroundCli => {
  const child = spawn(process.execPath, [cliFile, ...arguments_], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const foreground: ForegroundCli = {
    child,
    stdout: () => stdout,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode, signal, stdout, stderr });
      });
    }),
  };
  foregroundProcesses.add(foreground);
  void foreground.completion.then(
    () => foregroundProcesses.delete(foreground),
    () => foregroundProcesses.delete(foreground),
  );
  return foreground;
};

const waitForApprovalRequest = async (process: ForegroundCli): Promise<Record<string, unknown>> => {
  await waitFor(() =>
    completeJsonLines(process.stdout()).some(({ type }) => type === "approval.requested"),
  );
  const request = completeJsonLines(process.stdout()).find(
    ({ type }) => type === "approval.requested",
  );
  if (request === undefined) {
    throw new Error("Expected the foreground CLI to request approval.");
  }
  return request;
};

const completeSeedApproval = (context: ApprovalContext): void => {
  const store = new StateStore(context.dataDirectory);
  store.recordApprovalDecision(context.runId, "gate", "approve", "human");
  store.pollApproval(context.runId, "gate");
  store.transitionRun(context.runId, { status: "succeeded" });
  store.close();
};

const approveForegroundRun = async (
  context: { readonly environment: NodeJS.ProcessEnv },
  runId: string,
): Promise<CliResult> =>
  runCli(["runs", "approve", runId, "gate", "--actor", "human", "--json"], context.environment);

afterEach(async () => {
  const processes = [...foregroundProcesses];
  for (const process of processes) {
    process.child.kill("SIGKILL");
  }
  await Promise.allSettled(processes.map(({ completion }) => completion));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("approval CLI arguments", () => {
  it("parses the closed decision syntax and enforces actor and note bounds", () => {
    expect(
      parseRunsCommandArguments([
        "approve",
        "run-1",
        "gate",
        "--actor",
        "human",
        "--note",
        "Reviewed locally",
        "--json",
      ]),
    ).toEqual({
      action: "approve",
      runId: "run-1",
      nodeId: "gate",
      actor: "human",
      note: "Reviewed locally",
      json: true,
    });
    expect(
      parseRunsCommandArguments([
        "reject",
        "run-2",
        "gate",
        "--actor",
        "agent",
        "--note",
        "😀".repeat(1_000),
      ]),
    ).toMatchObject({ action: "reject", actor: "agent" });

    expectOptionError(
      (): unknown => parseRunsCommandArguments(["approve", "run-1", "gate"]),
      'Missing required flag "--actor"',
    );
    expectOptionError(
      (): unknown => parseRunsCommandArguments(["approve", "run-1", "gate", "--actor", "operator"]),
      "agent or human",
    );
    expectOptionError(
      (): unknown =>
        parseRunsCommandArguments([
          "approve",
          "run-1",
          "gate",
          "--actor",
          "human",
          "--note",
          "😀".repeat(1_001),
        ]),
      "at most 1000 characters",
    );
    expectOptionError(
      (): unknown => parseRunsCommandArguments(["approve", "run-1", "--actor", "human"]),
      "A node ID is required",
    );
  });
});

describe("approval CLI decisions", () => {
  it.each([
    ["approve", "human", "Reviewed locally"],
    ["reject", "agent", undefined],
  ] as const)("records one live %s intent without consuming it", async (decision, actor, note) => {
    const context = await createWaitingApproval();
    const lock = await acquireCanonicalWorkspaceLock(context.canonicalCwd, context.dataDirectory);
    try {
      const result = await runCli(
        [
          "runs",
          decision,
          context.runId,
          "gate",
          "--actor",
          actor,
          ...(note === undefined ? [] : ["--note", note]),
          "--json",
        ],
        context.environment,
      );
      const document = JSON.parse(result.stdout) as Record<string, unknown>;

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.keys(document).sort()).toEqual(
        [
          "actor",
          "decidedAt",
          "decision",
          "nodeId",
          ...(note === undefined ? [] : ["note"]),
          "outputVersion",
          "recorded",
          "runId",
        ].sort(),
      );
      expect(document).toMatchObject({
        outputVersion: 1,
        recorded: true,
        runId: context.runId,
        nodeId: "gate",
        decision,
        actor,
        ...(note === undefined ? {} : { note }),
      });

      const duplicate = await runCli(
        ["runs", decision, context.runId, "gate", "--actor", actor, "--json"],
        context.environment,
      );
      expect(duplicate.exitCode).toBe(2);
      expect(JSON.parse(duplicate.stdout)).toMatchObject({
        outputVersion: 1,
        type: "error",
        code: "APPROVAL_NOT_WAITING",
      });

      const store = new StateStore(context.dataDirectory);
      expect(store.getRun(context.runId).nodes[0]).toMatchObject({
        kind: "approval",
        status: "waiting_for_approval",
        decision: { decision, actor, ...(note === undefined ? {} : { note }) },
      });
      store.close();

      const shown = await runCli(["runs", "show", context.runId, "--json"], context.environment);
      const shownDocument = JSON.parse(shown.stdout) as {
        nodes: Record<string, unknown>[];
      };
      expect(shown.exitCode).toBe(0);
      expect(shown.stderr).toBe("");
      expect(shownDocument.nodes[0]).toMatchObject({
        kind: "approval",
        nodeId: "gate",
        ordinal: 0,
        question: "Ship this change?",
        status: "waiting_for_approval",
        decision: { decision, actor, ...(note === undefined ? {} : { note }) },
      });
      expect(Object.keys(shownDocument.nodes[0] ?? {}).sort()).toEqual([
        "deadlineAt",
        "decision",
        "kind",
        "nodeId",
        "ordinal",
        "question",
        "requestedAt",
        "status",
      ]);

      const shownHuman = await runCli(["runs", "show", context.runId], context.environment);
      expect(shownHuman.stdout).toContain("question: Ship this change?");
      expect(shownHuman.stdout).toContain(`decision: ${decision} by ${actor}`);
      if (note !== undefined) {
        expect(shownHuman.stdout).toContain(`note: ${note}`);
      }
      expect(shownHuman.stdout).not.toContain("stdout:");
      expect(shownHuman.stdout).not.toContain("runtime version:");
    } finally {
      await lock.release();
    }
  });

  it("reconciles a waiting gate when no foreground owner holds the workspace lock", async () => {
    const context = await createWaitingApproval();

    const result = await runCli(
      ["runs", "approve", context.runId, "gate", "--actor", "human", "--json"],
      context.environment,
    );
    const error = JSON.parse(result.stdout) as Record<string, unknown>;
    const store = new StateStore(context.dataDirectory);
    const detail = store.getRun(context.runId);
    store.close();

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe("");
    expect(error).toMatchObject({ outputVersion: 1, type: "error", code: "APPROVAL_NOT_WAITING" });
    expect(detail.run.status).toBe("interrupted");
    expect(detail.nodes[0]).toMatchObject({
      kind: "approval",
      status: "interrupted",
    });
    expect(detail.nodes[0]).not.toHaveProperty("decision");
  });
});

describe("approval foreground CLI lifecycle", () => {
  it("runs an authored approval workflow and accepts a decision from a second process", async () => {
    const context = await createApprovalProject();
    const foreground = startCli(
      [
        "run",
        context.workflowName,
        "--cwd",
        context.canonicalCwd,
        "--node-timeout",
        "10s",
        "--json",
      ],
      context.environment,
    );
    const request = await waitForApprovalRequest(foreground);
    const runId = String(request.runId);

    const approval = await approveForegroundRun(context, runId);
    const completed = await foreground.completion;
    const events = jsonLines(completed.stdout);

    expect(approval).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(approval.stdout)).toMatchObject({
      outputVersion: 1,
      recorded: true,
      runId,
      nodeId: "gate",
      decision: "approve",
      actor: "human",
    });
    expect(completed).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "approval.requested",
      "approval.resolved",
      "node.finished",
      "run.finished",
    ]);
    expect(events.every(({ outputVersion }) => outputVersion === 1)).toBe(true);
    expect(events.map(({ runId: eventRunId }) => eventRunId)).toEqual([
      runId,
      runId,
      runId,
      runId,
      runId,
    ]);
    expect(events[1]).toMatchObject({ nodeId: "gate", question: "Ship this change?" });
    expect(events[2]).toMatchObject({ nodeId: "gate", decision: "approve", actor: "human" });
    expect(events[3]).toMatchObject({ nodeKind: "approval", status: "succeeded" });
    expect(events[4]).toMatchObject({ status: "succeeded" });
  });

  it("holds the workspace lock while accepting approval and emits the exact lifecycle order", async () => {
    const context = await createWaitingApproval();
    completeSeedApproval(context);
    const foreground = startCli(["rerun", context.runId, "--json"], context.environment);
    const request = await waitForApprovalRequest(foreground);
    const rerunId = String(request.runId);

    const competing = await runCli(["rerun", context.runId, "--json"], context.environment);
    expect(competing.exitCode).toBe(2);
    expect(jsonLines(competing.stdout)).toMatchObject([{ type: "error", code: "WORKSPACE_BUSY" }]);

    const approval = await approveForegroundRun(context, rerunId);
    const completed = await foreground.completion;
    const events = jsonLines(completed.stdout);

    expect(approval.exitCode).toBe(0);
    expect(approval.stderr).toBe("");
    expect(JSON.parse(approval.stdout)).toMatchObject({
      recorded: true,
      runId: rerunId,
      nodeId: "gate",
      decision: "approve",
      actor: "human",
    });
    expect(completed).toMatchObject({ exitCode: 0, signal: null, stderr: "" });
    expect(events.map(({ type }) => type)).toEqual([
      "run.started",
      "approval.requested",
      "approval.resolved",
      "node.finished",
      "run.finished",
    ]);
    expect(events.slice(1).map(({ runId }) => runId)).toEqual([rerunId, rerunId, rerunId, rerunId]);
    expect(events[1]).toMatchObject({ nodeId: "gate", question: "Ship this change?" });
    expect(events[2]).toMatchObject({ nodeId: "gate", decision: "approve", actor: "human" });
    expect(events[3]).toMatchObject({ nodeId: "gate", nodeKind: "approval", status: "succeeded" });
    expect(events[4]).toMatchObject({ status: "succeeded" });
  });

  it("creates a fresh undecided approval gate each time a completed run is rerun", async () => {
    const context = await createWaitingApproval();
    completeSeedApproval(context);
    const first = startCli(["rerun", context.runId, "--json"], context.environment);
    const firstRequest = await waitForApprovalRequest(first);
    const firstRunId = String(firstRequest.runId);
    expect((await approveForegroundRun(context, firstRunId)).exitCode).toBe(0);
    expect((await first.completion).exitCode).toBe(0);

    const second = startCli(["rerun", firstRunId, "--json"], context.environment);
    const secondRequest = await waitForApprovalRequest(second);
    const secondRunId = String(secondRequest.runId);
    const store = new StateStore(context.dataDirectory);
    const waiting = store.getRun(secondRunId);
    store.close();

    expect(secondRunId).not.toBe(firstRunId);
    expect(waiting.run).toMatchObject({ status: "running", rerunOfRunId: firstRunId });
    expect(waiting.nodes[0]).toMatchObject({
      kind: "approval",
      nodeId: "gate",
      status: "waiting_for_approval",
    });
    expect(waiting.nodes[0]).not.toHaveProperty("decision");
    expect(second.child.exitCode).toBeNull();

    expect((await approveForegroundRun(context, secondRunId)).exitCode).toBe(0);
    const secondCompleted = await second.completion;
    expect(secondCompleted.exitCode).toBe(0);
    expect(jsonLines(secondCompleted.stdout).map(({ type }) => type)).toEqual([
      "run.started",
      "approval.requested",
      "approval.resolved",
      "node.finished",
      "run.finished",
    ]);
  });

  it("reconciles a SIGKILLed waiting run before a fresh approval gate succeeds", async () => {
    const context = await createWaitingApproval();
    completeSeedApproval(context);
    const killed = startCli(["rerun", context.runId, "--json"], context.environment);
    const killedRequest = await waitForApprovalRequest(killed);
    const killedRunId = String(killedRequest.runId);

    expect(killed.child.kill("SIGKILL")).toBe(true);
    const killedResult = await killed.completion;
    expect(killedResult).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    const beforeReconciliationStore = new StateStore(context.dataDirectory);
    const durableWaiting = beforeReconciliationStore.getRun(killedRunId);
    beforeReconciliationStore.close();
    expect(durableWaiting.run.status).toBe("running");
    expect(durableWaiting.nodes[0]).toMatchObject({ status: "waiting_for_approval" });

    const recovered = startCli(["rerun", killedRunId, "--json"], context.environment);
    const recoveredRequest = await waitForApprovalRequest(recovered);
    const recoveredRunId = String(recoveredRequest.runId);
    const reconciledStore = new StateStore(context.dataDirectory);
    const interrupted = reconciledStore.getRun(killedRunId);
    const fresh = reconciledStore.getRun(recoveredRunId);
    reconciledStore.close();

    expect(interrupted.run).toMatchObject({
      status: "interrupted",
      failure: { code: "RUN_INTERRUPTED" },
    });
    expect(interrupted.nodes[0]).toMatchObject({
      status: "interrupted",
      failure: { code: "RUN_INTERRUPTED" },
    });
    expect(fresh.run).toMatchObject({ status: "running", rerunOfRunId: killedRunId });
    expect(fresh.nodes[0]).toMatchObject({ status: "waiting_for_approval" });

    expect((await approveForegroundRun(context, recoveredRunId)).exitCode).toBe(0);
    const recoveredResult = await recovered.completion;
    expect(recoveredResult.exitCode).toBe(0);
    expect(jsonLines(recoveredResult.stdout).map(({ type }) => type)).toEqual([
      "run.started",
      "approval.requested",
      "approval.resolved",
      "node.finished",
      "run.finished",
    ]);
  });
});
