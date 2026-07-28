import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  CompletedProcess,
  ResolvedAgentRequest,
  RuntimeExecutionContext,
  RuntimeProbeContext,
  RuntimeProbeRequirements,
} from "../../src/application/runtime.js";
import { KilinError } from "../../src/domain/errors.js";
import { OpenCodeRuntimeAdapter } from "../../src/infrastructure/opencode-runtime.js";
import {
  nodeOutputPaths,
  prepareNodeOutput,
  runProcess,
  runtimeResultStagingPath,
} from "../../src/infrastructure/process-runner.js";
import { readStrictJsonLines as readCalls } from "../helpers/json-lines.js";
import { inheritedEnvironment } from "../helpers/subprocess.js";

const fakeOpenCodePath = fileURLToPath(new URL("../fixtures/fake-opencode.mjs", import.meta.url));
const pinnedHelpPath = fileURLToPath(
  new URL(
    "../../docs/references/agent-runtimes/installed-help/opencode-1.18.4-run-help.txt",
    import.meta.url,
  ),
);
const permissionProfile = '{"edit":"allow","bash":"allow","external_directory":"deny"}';
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-opencode-runtime-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
};

const createProbe = async (
  scenario = "supported",
): Promise<{
  context: RuntimeProbeContext;
  executable: string;
  logPath: string;
}> => {
  const directory = await createTemporaryDirectory();
  const executable = join(directory, "opencode");
  const logPath = join(directory, "calls.jsonl");
  await copyFile(fakeOpenCodePath, executable);
  await chmod(executable, 0o755);
  return {
    context: {
      canonicalCwd: directory,
      env: {
        ...inheritedEnvironment(),
        FAKE_OPENCODE_HELP_PATH: pinnedHelpPath,
        FAKE_OPENCODE_LOG: logPath,
        FAKE_OPENCODE_SCENARIO: scenario,
      },
    },
    executable,
    logPath,
  };
};

const requirements: RuntimeProbeRequirements = {
  requiredAccessModes: ["workspace_write"],
};

const request = (
  canonicalWorkingDirectory: string,
  overrides: Partial<ResolvedAgentRequest> = {},
): ResolvedAgentRequest => ({
  runId: "run-1",
  nodeId: "implement",
  ordinal: 0,
  runtime: "opencode",
  access: "workspace_write",
  prompt: "Implement safely; $(touch must-not-run)\n",
  canonicalWorkingDirectory,
  isGitRepository: true,
  ...overrides,
});

const completedProcess = (stdoutPath: string): CompletedProcess => ({
  exitCode: 0,
  signal: null,
  durationMs: 10,
  stdoutPath,
  stderrPath: join(stdoutPath, "..", "stderr.log"),
  resultPath: join(stdoutPath, "..", "result.txt"),
  runtimeResultPath: join(stdoutPath, "..", ".runtime-result.tmp"),
  outputBytes: 0,
});

beforeAll(async () => {
  await chmod(fakeOpenCodePath, 0o755);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("OpenCode runtime preflight", () => {
  it("probes the floor version and pinned run capabilities without authentication", async () => {
    const { context, executable, logPath } = await createProbe("pinned-help");

    await expect(
      new OpenCodeRuntimeAdapter(executable).probe(requirements, context),
    ).resolves.toEqual({
      runtimeId: "opencode",
      executable,
      version: "1.18.4",
    });
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["run", "--help"]]);
  });

  it("rejects read-only requirements before starting the executable", async () => {
    const { context, executable, logPath } = await createProbe();

    const error = await new OpenCodeRuntimeAdapter(executable)
      .probe({ requiredAccessModes: ["read_only", "workspace_write"] }, context)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "RUNTIME_ACCESS_UNSUPPORTED" });
    expect((error as Error).message).toMatch(/OpenCode.*read_only.*workspace_write/u);
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a missing executable with an actionable runtime error", async () => {
    const { context } = await createProbe();
    const executable = join(context.canonicalCwd, "missing-opencode");

    const error = await new OpenCodeRuntimeAdapter(executable)
      .probe(requirements, context)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect((error as Error).message).toMatch(/install OpenCode|PATH/u);
  });

  it.each([
    ["version-1.18.5", "1.18.5"],
    ["version-build", "1.18.4"],
  ])("accepts stable %s before checking capabilities", async (scenario, version) => {
    const { context, executable, logPath } = await createProbe(scenario);

    await expect(
      new OpenCodeRuntimeAdapter(executable).probe(requirements, context),
    ).resolves.toMatchObject({ version });
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["run", "--help"]]);
  });

  it.each([
    ["version-1.18.3", "1.18.3"],
    ["version-prerelease", "1.18.4-beta.1"],
    ["version-incidental", "warning: compatibility data 1.18.4"],
    ["version-ambiguous", "1.18.4\n1.18.5"],
    ["version-invalid", "invalid output"],
  ])("rejects %s before checking capabilities", async (scenario, providerOutput) => {
    const { context, executable, logPath } = await createProbe(scenario);

    const error = await new OpenCodeRuntimeAdapter(executable)
      .probe(requirements, context)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "RUNTIME_UNSUPPORTED" });
    expect((error as Error).message).toContain("stable OpenCode >=1.18.4");
    expect((error as Error).message).not.toContain(providerOutput);
    await expect(readCalls(logPath)).resolves.toEqual([["--version"]]);
  });

  it.each([
    ["help-failure", "unavailable"],
    ["help-output-limit", "too much output"],
    ["missing-pure", "--pure"],
    ["missing-format", "--format"],
    ["missing-json", "json"],
    ["missing-dir", "--dir"],
    ["missing-model", "--model"],
  ])("maps %s to a redacted capability error", async (scenario, capability) => {
    const { context, executable, logPath } = await createProbe(scenario);

    const error = await new OpenCodeRuntimeAdapter(executable)
      .probe(requirements, context)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain(capability);
    expect((error as Error).message).not.toContain("CAPABILITY_SECRET_FROM_PROVIDER");
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["run", "--help"]]);
  });

  it("maps cancellation during a running probe to AbortError", async () => {
    const { context, executable } = await createProbe("version-timeout");
    const controller = new AbortController();
    const probe = new OpenCodeRuntimeAdapter(executable).probe(requirements, {
      ...context,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start the executable when already cancelled", async () => {
    const { context, executable, logPath } = await createProbe();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new OpenCodeRuntimeAdapter(executable).probe(requirements, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("OpenCode runtime invocation", () => {
  it("owns the exact workspace-write command, environment, cwd, and stdin", () => {
    const runtime = new OpenCodeRuntimeAdapter(fakeOpenCodePath);
    const environment = {
      PATH: "/usr/bin",
      SENTINEL: "inherited",
      OPENCODE_PERMISSION: '{"*":"allow"}',
    };
    const context: RuntimeExecutionContext = {
      runtimeResultPath: "/private/run/.runtime-result.tmp",
      env: environment,
    };

    const invocation = runtime.createInvocation(
      request("/canonical/project", { model: "provider/model" }),
      context,
    );

    expect(runtime.runtimeId).toBe("opencode");
    expect(invocation).toEqual({
      executable: fakeOpenCodePath,
      args: [
        "run",
        "--pure",
        "--format",
        "json",
        "--dir",
        "/canonical/project",
        "--model",
        "provider/model",
      ],
      cwd: "/canonical/project",
      env: {
        PATH: "/usr/bin",
        SENTINEL: "inherited",
        OPENCODE_PERMISSION: permissionProfile,
      },
      stdin: "Implement safely; $(touch must-not-run)\n",
    });
    expect(environment.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
  });

  it("omits the model without adding lifecycle or automatic-approval flags", () => {
    const invocation = new OpenCodeRuntimeAdapter().createInvocation(
      request("/canonical/project"),
      {
        runtimeResultPath: "/private/run/.runtime-result.tmp",
        env: { PATH: "/usr/bin" },
      },
    );

    expect(invocation.executable).toBe("opencode");
    expect(invocation.args).toEqual([
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      "/canonical/project",
    ]);
    expect(invocation.args).not.toContain("--auto");
  });

  it("rejects read-only access instead of weakening it", () => {
    let error: unknown;
    try {
      new OpenCodeRuntimeAdapter().createInvocation(
        request("/canonical/project", { access: "read_only" }),
        {
          runtimeResultPath: "/private/run/.runtime-result.tmp",
          env: { PATH: "/usr/bin" },
        },
      );
    } catch (reason: unknown) {
      error = reason;
    }

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_ACCESS_UNSUPPORTED" });
    expect((error as Error).message).toMatch(/OpenCode.*read_only.*workspace_write/u);
  });

  it("runs shell-free with exact stdin, model argv, cwd, and permission policy", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run-1", "opencode", 0);
    await prepareNodeOutput(paths);
    const recordPath = join(directory, "invocation.json");
    const runtime = new OpenCodeRuntimeAdapter(fakeOpenCodePath);
    const invocation = runtime.createInvocation(
      request(directory, { model: "provider/model; $(touch model-must-not-run)" }),
      {
        runtimeResultPath: runtimeResultStagingPath(paths),
        env: {
          ...inheritedEnvironment(),
          FAKE_OPENCODE_RECORD: recordPath,
          OPENCODE_PERMISSION: '{"*":"allow"}',
          SENTINEL: "preserved",
        },
      },
    );

    const outcome = await runProcess(invocation, paths, {
      timeoutMs: 2_000,
      maxOutputBytes: 10_000,
    });

    expect(outcome.status).toBe("succeeded");
    await expect(runtime.extractResult(outcome.completed)).resolves.toEqual({
      finalMessage: "result:Implement safely; $(touch must-not-run)\n",
    });
    await expect(
      readFile(recordPath, "utf8").then((value) => JSON.parse(value) as unknown),
    ).resolves.toEqual({
      args: invocation.args,
      cwd: directory,
      permission: permissionProfile,
      prompt: invocation.stdin,
      sentinel: "preserved",
    });
    await expect(stat(join(directory, "must-not-run"))).rejects.toThrow();
    await expect(stat(join(directory, "model-must-not-run"))).rejects.toThrow();
  });
});

describe("OpenCode runtime results", () => {
  it.each([
    ["exact whitespace", "  exact final message\n"],
    ["whitespace-only text", " \n\t "],
    ["empty text", ""],
  ])("returns the last completed %s", async (_name, finalMessage) => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    const events = [
      {
        type: "text",
        sessionID: "session-1",
        part: { type: "text", sessionID: "other", text: "wrong", time: { end: 1 } },
      },
      {
        type: "text",
        sessionID: "session-1",
        part: { type: "text", sessionID: "session-1", text: "partial", time: { start: 1 } },
      },
      {
        type: "text",
        sessionID: "session-1",
        part: { type: "text", sessionID: "session-1", text: "earlier", time: { end: 2 } },
      },
      {
        type: "reasoning",
        sessionID: "session-1",
        part: { type: "reasoning", sessionID: "session-1", text: "hidden", time: { end: 3 } },
      },
      {
        type: "text",
        sessionID: "session-1",
        part: { type: "text", sessionID: "session-1", text: finalMessage, time: { end: 4 } },
      },
    ];
    await writeFile(stdoutPath, `\n${events.map((event) => JSON.stringify(event)).join("\n")}\n\n`);

    await expect(
      new OpenCodeRuntimeAdapter(fakeOpenCodePath).extractResult(completedProcess(stdoutPath)),
    ).resolves.toEqual({ finalMessage });
  });

  it.each([
    ["malformed output", "{not-json}\nPROVIDER_SECRET"],
    ["primitive event", "42\n"],
    ["missing text", `${JSON.stringify({ type: "step_finish", sessionID: "session-1" })}\n`],
    [
      "mismatched session",
      `${JSON.stringify({ type: "text", sessionID: "session-1", part: { type: "text", sessionID: "session-2", text: "PROVIDER_SECRET", time: { end: 1 } } })}\n`,
    ],
    [
      "incomplete text",
      `${JSON.stringify({ type: "text", sessionID: "session-1", part: { type: "text", sessionID: "session-1", text: "PROVIDER_SECRET", time: { start: 1 } } })}\n`,
    ],
    [
      "zero completion time",
      `${JSON.stringify({ type: "text", sessionID: "session-1", part: { type: "text", sessionID: "session-1", text: "PROVIDER_SECRET", time: { end: 0 } } })}\n`,
    ],
    [
      "non-string text",
      `${JSON.stringify({ type: "text", sessionID: "session-1", part: { type: "text", sessionID: "session-1", text: 42, time: { end: 1 } } })}\n`,
    ],
  ])("maps %s to a generic capture failure", async (_name, output) => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    await writeFile(stdoutPath, output);

    const error = await new OpenCodeRuntimeAdapter(fakeOpenCodePath)
      .extractResult(completedProcess(stdoutPath))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "NODE_CAPTURE_FAILED" });
    expect((error as Error).message).not.toContain("PROVIDER_SECRET");
  });

  it("maps unreadable stdout to a generic capture failure", async () => {
    const directory = await createTemporaryDirectory();

    await expect(
      new OpenCodeRuntimeAdapter(fakeOpenCodePath).extractResult(
        completedProcess(join(directory, "missing-stdout.log")),
      ),
    ).rejects.toMatchObject({ code: "NODE_CAPTURE_FAILED" });
  });

  it("does not treat diagnostic stderr as machine output", async () => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    const event = {
      type: "text",
      sessionID: "session-1",
      part: { type: "text", sessionID: "session-1", text: "diagnostic", time: { end: 1 } },
    };
    await writeFile(stdoutPath, `${JSON.stringify({ type: "step_finish" })}\n`);
    await writeFile(stderrPath, `${JSON.stringify(event)}\n`);

    await expect(
      new OpenCodeRuntimeAdapter(fakeOpenCodePath).extractResult({
        ...completedProcess(stdoutPath),
        stderrPath,
      }),
    ).rejects.toMatchObject({ code: "NODE_CAPTURE_FAILED" });
  });
});
