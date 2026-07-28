import { execFile, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Readable } from "node:stream";

import { expect, test as base } from "@playwright/test";

import { compileWorkflow } from "../src/domain/compile-workflow.js";
import { defaultRunOptions } from "../src/domain/run-state.js";
import { nodeOutputPaths } from "../src/infrastructure/process-runner.js";
import { StateStore } from "../src/infrastructure/state-store.js";
import { parseWorkflowBytes } from "../src/infrastructure/workflow-source.js";
import { decisionPacketFixture, decisionPacketJson } from "../test/fixtures/decision-packet.js";
import { parseJsonLines as jsonLines } from "../test/helpers/json-lines.js";
import { isCommandFailure } from "../test/helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../test/helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const fakeCodexFile = fileURLToPath(new URL("../test/fixtures/fake-codex.mjs", import.meta.url));
const launchUrlPattern = /^Viewer: (http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+)$/mu;

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunStartedEvent {
  readonly type: "run.started";
  readonly runId: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
}

export interface RunningCli {
  readonly runId: string;
  wait(): Promise<CommandResult>;
  cancel(): void;
}

interface BackgroundRun extends RunningCli {
  output(): string;
}

export interface ViewerScenario {
  readonly root: string;
  readonly project: string;
  readonly otherProject: string;
  readonly stateDirectory: string;
  readonly workflowName: string;
  readonly workflowFile: string;
  readonly workflowSource: string;
  readonly successfulRunId: string;
  readonly rerunId: string;
  readonly decisionPacketRunId: string;
  readonly decisionPacketRerunId: string;
  readonly ordinaryJsonRunId: string;
  readonly proseResultRunId: string;
  readonly failedRunId: string;
  readonly cancelledRunId: string;
  readonly interruptedRunId: string;
  readonly otherWorkflowRunId: string;
  readonly otherWorkingDirectoryRunId: string;
  readonly environment: NodeJS.ProcessEnv;
  runtimeInvocationCount(): Promise<number>;
  startDelayedRun(delayMs?: number): Promise<RunningCli>;
  startStreamingRun(streamDelayMs?: number): Promise<RunningCli>;
  startApprovalRun(): Promise<RunningCli>;
  setWorkflowSource(source: string): Promise<void>;
}

export interface ViewerTermination {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ViewerHarness {
  readonly origin: string;
  readonly launchUrl: string;
  readonly launchToken: string;
  readonly stdout: string;
  stop(): Promise<ViewerTermination>;
  forceStop(): Promise<ViewerTermination>;
}

interface TestFixtures {
  scenario: ViewerScenario;
  viewer: ViewerHarness;
}

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(process.execPath, [cliFile, ...arguments_], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 2 * 1_024 * 1_024,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

const isRunStartedEvent = (value: unknown): value is RunStartedEvent =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  value.type === "run.started" &&
  "runId" in value &&
  typeof value.runId === "string";

const runIdFrom = (result: CommandResult): string => {
  const event = jsonLines(result.stdout).find(isRunStartedEvent);
  if (event === undefined) {
    throw new Error(`Kilin did not emit run.started. stderr: ${result.stderr}`);
  }
  return event.runId;
};

const lineCount = async (path: string): Promise<number> => {
  try {
    const source = await readFile(path, "utf8");
    return source.split("\n").filter(Boolean).length;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
};

const approvalWorkflowSource = (workflowId: string): string => `schemaVersion: 1
workflow:
  id: ${workflowId}
  name: Release readiness
nodes:
  - id: analyze
    kind: agent
    runtime: codex
    access: read_only
    prompt: analyze
    output:
      type: decision_packet
  - id: gate
    kind: approval
    question: Ship these verified changes?
  - id: verify
    kind: agent
    runtime: codex
    access: read_only
    prompt: verify
edges:
  - from: analyze
    to: gate
  - from: gate
    to: verify
`;

const decisionPacketWorkflowSource = (
  workflowId: string,
  outputType: "decision_packet" | "json" | "text" = "decision_packet",
): string => `schemaVersion: 1
workflow:
  id: ${workflowId}
  name: Business judgment
nodes:
  - id: judge
    kind: agent
    runtime: codex
    access: read_only
    prompt: judge
    output:
      type: ${outputType}
edges: []
`;

const workflowSource = (workflowId: string): string => `schemaVersion: 1
workflow:
  id: ${workflowId}
  name: Release readiness
nodes:
  - id: analyze
    kind: agent
    runtime: codex
    access: read_only
    prompt: analyze
  - id: change
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: change
  - id: verify
    kind: agent
    runtime: codex
    access: read_only
    prompt: verify
edges:
  - from: analyze
    to: change
  - from: change
    to: verify
`;

const requireSuccessfulCommand = (result: CommandResult, operation: string): string => {
  if (result.exitCode !== 0 || result.stderr !== "") {
    throw new Error(
      `${operation} failed with exit ${String(result.exitCode)}. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
  }
  return runIdFrom(result);
};

const completionFor = (child: CapturedChild): Promise<CommandResult> => {
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
  return new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (exitCode, signal) => {
      resolveCompletion({
        exitCode: exitCode ?? (signal === "SIGINT" ? 130 : 1),
        stdout,
        stderr,
      });
    });
  });
};

const waitForStartedRun = async (child: CapturedChild, output: () => string): Promise<string> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const completeLines = output().split("\n").slice(0, -1).join("\n");
    const event =
      completeLines === "" ? undefined : jsonLines(completeLines).find(isRunStartedEvent);
    if (event !== undefined) {
      return event.runId;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Kilin exited before emitting run.started for the delayed E2E run.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Kilin to emit run.started for the delayed E2E run.");
};

const waitForNodeStart = async (child: CapturedChild, output: () => string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (output().includes('"type":"node.started"')) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Kilin exited before starting the cancellable E2E node.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Kilin to start the cancellable E2E node.");
};

const createCancelledRun = async (
  workflowName: string,
  project: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  const child = spawn(
    process.execPath,
    [cliFile, "run", workflowName, "--cwd", project, "--json"],
    {
      env: {
        ...environment,
        FAKE_CODEX_BEHAVIORS: JSON.stringify({ analyze: "wait" }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const completion = completionFor(child);
  await waitForNodeStart(child, () => stdout);
  child.kill("SIGINT");
  const result = await completion;
  if (result.exitCode !== 130 || result.stderr !== "") {
    throw new Error(
      `cancelled seed run did not exit 130 cleanly. stdout: ${result.stdout} stderr: ${result.stderr}`,
    );
  }
  return runIdFrom(result);
};

const createInterruptedRun = async (
  source: string,
  sourceName: string,
  project: string,
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  const definition = parseWorkflowBytes(new TextEncoder().encode(source), sourceName);
  const plan = compileWorkflow(definition);
  const canonicalCwd = await realpath(project);
  const store = new StateStore(stateDirectory);
  let runId: string;
  try {
    const created = store.createRun({
      plan,
      identity: {
        scope: { kind: "project", root: canonicalCwd },
        workflowId: plan.definition.workflow.id,
      },
      canonicalCwd,
      options: { ...defaultRunOptions },
    });
    runId = created.run.id;
    store.transitionNode(runId, "analyze", {
      status: "running",
      runtimeVersion: "0.144.6",
      ...nodeOutputPaths(stateDirectory, runId, "analyze", 0),
    });
  } finally {
    store.close();
  }
  const reconciliation = await runCli(["runs", "list", "--json"], environment);
  if (reconciliation.exitCode !== 0 || reconciliation.stderr !== "") {
    throw new Error(
      `stale seed run did not reconcile cleanly. stdout: ${reconciliation.stdout} stderr: ${reconciliation.stderr}`,
    );
  }
  return runId;
};

const startBackgroundRun = async (
  workflowName: string,
  project: string,
  environment: NodeJS.ProcessEnv,
): Promise<BackgroundRun> => {
  const child = spawn(
    process.execPath,
    [cliFile, "run", workflowName, "--cwd", project, "--json"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const completion = completionFor(child);
  const runId = await waitForStartedRun(child, () => stdout);
  return {
    runId,
    wait: async () => completion,
    cancel: (): void => {
      child.kill("SIGINT");
    },
    output: () => stdout,
  };
};

const createScenario = async (root: string): Promise<ViewerScenario> => {
  const project = join(root, "project");
  const otherProject = join(project, "other-workspace");
  const stateDirectory = join(root, "state");
  const binariesDirectory = join(root, "bin");
  const workflowName = "viewer-release";
  const otherWorkflowName = "out-of-scope-workflow";
  const workflowsDirectory = join(project, ".agents", "workflows");
  const invocationLog = join(root, "runtime-invocations.jsonl");
  const source = workflowSource("viewer-release");
  await Promise.all([
    mkdir(otherProject, { recursive: true }),
    mkdir(binariesDirectory),
    chmod(fakeCodexFile, 0o755),
  ]);
  const [workflowPackage] = await Promise.all([
    writeTestWorkflowPackage(workflowsDirectory, workflowName, "Viewer release workflow", source, {
      definitionMode: 0o600,
    }),
    writeTestWorkflowPackage(
      workflowsDirectory,
      otherWorkflowName,
      "Out-of-scope viewer workflow",
      workflowSource("out-of-scope-workflow"),
      { definitionMode: 0o600 },
    ),
  ]);
  const workflowFile = workflowPackage.definitionFile;
  await symlink(fakeCodexFile, join(binariesDirectory, "codex"));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binariesDirectory}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    KILIN_DATA_DIR: stateDirectory,
    KILIN_SKIP_SETUP_PROMPT: "true",
    FAKE_CODEX_LOG: invocationLog,
  };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;

  const first = await runCli(
    ["run", workflowName, "--cwd", project, "--max-output-bytes", "1048576", "--json"],
    environment,
  );
  const successfulRunId = requireSuccessfulCommand(first, "successful seed run");
  const rerun = await runCli(["rerun", successfulRunId, "--json"], environment);
  const rerunId = requireSuccessfulCommand(rerun, "seed rerun");
  const hostilePacket = decisionPacketFixture("HISTORY_ORIGINAL");
  const hostileMetric = hostilePacket.observations[0]?.metrics[0];
  const hostileAction = hostilePacket.proposedActions[0];
  if (hostileMetric === undefined || hostileAction === undefined) {
    throw new Error("Decision Packet fixture is missing required hostile-test fields.");
  }
  hostilePacket.recommendation.summary =
    '<script>window.packetExecuted=true</script><img src=x onerror="alert(1)">';
  hostileMetric.source.reference = "javascript:alert('packet')";
  hostileAction.summary = "<a href=https://example.invalid>Run external action</a>";
  await writeFile(workflowFile, decisionPacketWorkflowSource(workflowName), { mode: 0o600 });
  const decisionPacketRun = await runCli(
    ["run", workflowName, "--cwd", project, "--max-output-bytes", "1048576", "--json"],
    { ...environment, FAKE_CODEX_RESULT: JSON.stringify(hostilePacket) },
  );
  const decisionPacketRunId = requireSuccessfulCommand(
    decisionPacketRun,
    "Decision Packet seed run",
  );
  const decisionPacketRerun = await runCli(["rerun", decisionPacketRunId, "--json"], {
    ...environment,
    FAKE_CODEX_RESULT: decisionPacketJson("HISTORY_RERUN"),
  });
  const decisionPacketRerunId = requireSuccessfulCommand(
    decisionPacketRerun,
    "Decision Packet seed rerun",
  );
  await writeFile(workflowFile, decisionPacketWorkflowSource(workflowName, "json"), {
    mode: 0o600,
  });
  const ordinaryJsonRun = await runCli(
    ["run", workflowName, "--cwd", project, "--max-output-bytes", "1048576", "--json"],
    { ...environment, FAKE_CODEX_RESULT: decisionPacketJson("ORDINARY_JSON_LOOKALIKE") },
  );
  const ordinaryJsonRunId = requireSuccessfulCommand(ordinaryJsonRun, "ordinary JSON seed run");
  await writeFile(workflowFile, decisionPacketWorkflowSource(workflowName, "text"), {
    mode: 0o600,
  });
  const proseResultRun = await runCli(
    ["run", workflowName, "--cwd", project, "--max-output-bytes", "1048576", "--json"],
    { ...environment, FAKE_CODEX_RESULT: "seeded prose result" },
  );
  const proseResultRunId = requireSuccessfulCommand(proseResultRun, "prose result seed run");
  await writeFile(workflowFile, source, { mode: 0o600 });
  const failed = await runCli(
    ["run", workflowName, "--cwd", project, "--max-output-bytes", "1048576", "--json"],
    { ...environment, FAKE_CODEX_BEHAVIORS: JSON.stringify({ change: "nonzero" }) },
  );
  if (failed.exitCode !== 1 || failed.stderr !== "") {
    throw new Error(
      `failed seed run did not record a normal run failure. stdout: ${failed.stdout} stderr: ${failed.stderr}`,
    );
  }
  const failedRunId = runIdFrom(failed);
  const cancelledRunId = await createCancelledRun(workflowName, project, environment);
  const interruptedRunId = await createInterruptedRun(
    source,
    workflowFile,
    project,
    stateDirectory,
    environment,
  );
  const otherWorkflow = await runCli(
    ["run", otherWorkflowName, "--cwd", project, "--json"],
    environment,
  );
  const otherWorkflowRunId = requireSuccessfulCommand(otherWorkflow, "out-of-scope workflow run");
  const otherWorkingDirectory = await runCli(
    ["run", workflowName, "--cwd", otherProject, "--json"],
    environment,
  );
  const otherWorkingDirectoryRunId = requireSuccessfulCommand(
    otherWorkingDirectory,
    "out-of-scope working-directory run",
  );

  const failedStdout = join(
    stateDirectory,
    "runs",
    failedRunId,
    "nodes",
    "001-change",
    "stdout.log",
  );
  await writeFile(
    failedStdout,
    `TAIL_MUST_NOT_INCLUDE_THIS_PREFIX\n${"x".repeat(70_000)}\nBOUNDED_TAIL_MARKER`,
    { mode: 0o600 },
  );

  return {
    root,
    project,
    otherProject,
    stateDirectory,
    workflowName,
    workflowFile,
    workflowSource: source,
    successfulRunId,
    rerunId,
    decisionPacketRunId,
    decisionPacketRerunId,
    ordinaryJsonRunId,
    proseResultRunId,
    failedRunId,
    cancelledRunId,
    interruptedRunId,
    otherWorkflowRunId,
    otherWorkingDirectoryRunId,
    environment,
    runtimeInvocationCount: async () => lineCount(invocationLog),
    startDelayedRun: async (delayMs = 4_000): Promise<RunningCli> =>
      startBackgroundRun(workflowName, project, {
        ...environment,
        FAKE_CODEX_DELAY_MS: String(delayMs),
      }),
    startStreamingRun: async (streamDelayMs = 3_000): Promise<RunningCli> =>
      startBackgroundRun(workflowName, project, {
        ...environment,
        FAKE_CODEX_BEHAVIORS: JSON.stringify({ analyze: "stream" }),
        FAKE_CODEX_STREAM_DELAY_MS: String(streamDelayMs),
      }),
    startApprovalRun: async (): Promise<RunningCli> => {
      await writeFile(workflowFile, approvalWorkflowSource(workflowName), { mode: 0o600 });
      const run = await startBackgroundRun(workflowName, project, {
        ...environment,
        FAKE_CODEX_RESULT: decisionPacketJson("APPROVAL_PACKET"),
      });
      const deadline = Date.now() + 10_000;
      while (!run.output().includes('"type":"approval.requested"')) {
        if (Date.now() >= deadline) {
          run.cancel();
          throw new Error("Timed out waiting for the E2E approval gate to start waiting.");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return run;
    },
    setWorkflowSource: async (nextSource: string) =>
      writeFile(workflowFile, nextSource, { mode: 0o600 }),
  };
};

const waitForViewerUrl = async (
  child: CapturedChild,
  stdout: () => string,
  stderr: () => string,
): Promise<string> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const match = launchUrlPattern.exec(stdout());
    if (match?.[1] !== undefined) {
      return match[1];
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Kilin UI exited before launch. stdout: ${stdout()} stderr: ${stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Kilin UI. stdout: ${stdout()} stderr: ${stderr()}`);
};

const startViewer = async (scenario: ViewerScenario): Promise<ViewerHarness> => {
  const child = spawn(
    process.execPath,
    [cliFile, "ui", scenario.workflowName, "--cwd", scenario.project, "--no-open"],
    { env: scenario.environment, stdio: ["ignore", "pipe", "pipe"] },
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
  const termination = new Promise<ViewerTermination>((resolveTermination, rejectTermination) => {
    child.once("error", rejectTermination);
    child.once("exit", (exitCode, signal) => resolveTermination({ exitCode, signal }));
  });
  let launchUrl: string;
  try {
    launchUrl = await waitForViewerUrl(
      child,
      () => stdout,
      () => stderr,
    );
  } catch (error: unknown) {
    child.kill("SIGKILL");
    await termination.catch(() => undefined);
    throw error;
  }
  const url = new URL(launchUrl);
  const launchToken = new URLSearchParams(url.hash.slice(1)).get("token");
  if (launchToken === null) {
    child.kill("SIGKILL");
    await termination.catch(() => undefined);
    throw new Error("Kilin UI launch URL did not contain its fragment token.");
  }
  let stopped = false;
  const stop = async (): Promise<ViewerTermination> => {
    if (!stopped) {
      stopped = true;
      child.kill("SIGINT");
    }
    return termination;
  };
  const forceStop = async (): Promise<ViewerTermination> => {
    if (child.exitCode === null && child.signalCode === null) {
      stopped = true;
      child.kill("SIGKILL");
    }
    return termination;
  };
  return {
    origin: url.origin,
    launchUrl,
    launchToken,
    get stdout(): string {
      return stdout;
    },
    stop,
    forceStop,
  };
};

export const requestViewer = async (
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<HttpResponse> => {
  const url = new URL(path, origin);
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", rejectResponse);
        response.once("end", () => {
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", rejectResponse);
    if (options.body !== undefined) {
      request.end(options.body);
    } else {
      request.end();
    }
  });
};

const stopWithDeadline = async (viewer: ViewerHarness): Promise<void> => {
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      viewer.stop().then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Kilin UI did not stop after SIGINT.")),
          5_000,
        );
      }),
    ]);
  } catch (error: unknown) {
    await viewer.forceStop();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
};

export const test = base.extend<TestFixtures>({
  scenario: async ({ browserName }, use, testInfo): Promise<void> => {
    const root = await mkdtemp(
      join(tmpdir(), `kilin-viewer-e2e-${browserName}-${String(testInfo.workerIndex)}-`),
    );
    try {
      const scenario = await createScenario(root);
      await use(scenario);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  viewer: async ({ scenario }, use): Promise<void> => {
    const viewer = await startViewer(scenario);
    try {
      await use(viewer);
    } finally {
      await stopWithDeadline(viewer);
    }
  },
});

export { expect };
