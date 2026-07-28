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
import { ClaudeCodeRuntimeAdapter } from "../../src/infrastructure/claude-code-runtime.js";
import {
  nodeOutputPaths,
  prepareNodeOutput,
  runProcess,
} from "../../src/infrastructure/process-runner.js";
import { readStrictJsonLines as readCalls } from "../helpers/json-lines.js";
import { inheritedEnvironment } from "../helpers/subprocess.js";

const fakeClaudePath = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const pinnedHelpPath = fileURLToPath(
  new URL(
    "../../docs/references/agent-runtimes/installed-help/claude-code-2.1.215-help.txt",
    import.meta.url,
  ),
);
const temporaryDirectories: string[] = [];

interface ClaudeSettings {
  readonly permissions: {
    readonly deny?: readonly string[];
    readonly disableAutoMode: "disable";
    readonly disableBypassPermissionsMode: "disable";
  };
  readonly sandbox: {
    readonly enabled: true;
    readonly failIfUnavailable: true;
    readonly allowUnsandboxedCommands: false;
    readonly filesystem?: {
      readonly denyWrite: readonly string[];
    };
  };
}

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-claude-runtime-"));
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
  const executable = join(directory, "claude");
  const logPath = join(directory, "calls.jsonl");
  await copyFile(fakeClaudePath, executable);
  await chmod(executable, 0o755);
  return {
    context: {
      canonicalCwd: directory,
      env: {
        ...inheritedEnvironment(),
        FAKE_CLAUDE_HELP_PATH: pinnedHelpPath,
        FAKE_CLAUDE_LOG: logPath,
        FAKE_CLAUDE_SCENARIO: scenario,
      },
    },
    executable,
    logPath,
  };
};

const requirements: RuntimeProbeRequirements = {
  requiredAccessModes: ["read_only", "workspace_write"],
};

const request = (
  canonicalWorkingDirectory: string,
  overrides: Partial<ResolvedAgentRequest> = {},
): ResolvedAgentRequest => ({
  runId: "run-1",
  nodeId: "inspect",
  ordinal: 0,
  runtime: "claude-code",
  access: "read_only",
  prompt: "Inspect safely; $(touch must-not-run)\n",
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

const settingsFrom = (args: readonly string[]): ClaudeSettings => {
  const settingsIndex = args.indexOf("--settings");
  const settings = args[settingsIndex + 1];
  if (settingsIndex === -1 || settings === undefined) {
    throw new Error("Claude invocation did not include inline settings.");
  }
  return JSON.parse(settings) as ClaudeSettings;
};

beforeAll(async () => {
  await chmod(fakeClaudePath, 0o755);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("Claude Code runtime preflight", () => {
  it("probes the floor version, emitted capabilities, and authentication in order", async () => {
    const { context, executable, logPath } = await createProbe("pinned-help");
    const runtime = new ClaudeCodeRuntimeAdapter(executable);

    await expect(runtime.probe(requirements, context)).resolves.toEqual({
      runtimeId: "claude-code",
      executable,
      version: "2.1.215",
    });
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["auth", "status"],
    ]);
  });

  it("rejects a missing executable with an actionable runtime error", async () => {
    const { context } = await createProbe();
    const runtime = new ClaudeCodeRuntimeAdapter(join(context.canonicalCwd, "missing-claude"));

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect((error as Error).message).toMatch(/install Claude Code|PATH/u);
  });

  it.each([
    ["version-2.1.216", "2.1.216"],
    ["version-build", "2.1.215"],
  ])("accepts stable %s when required probes still pass", async (scenario, version) => {
    const { context, executable, logPath } = await createProbe(scenario);
    const runtime = new ClaudeCodeRuntimeAdapter(executable);

    await expect(runtime.probe(requirements, context)).resolves.toMatchObject({ version });
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["auth", "status"],
    ]);
  });

  it.each([
    ["version-2.1.214", "2.1.214"],
    ["version-prerelease", "2.1.215-beta.1"],
    ["version-leading-zero", "02.01.215"],
    ["version-invalid", "invalid output"],
  ])("rejects %s before later probes", async (scenario, providerOutput) => {
    const { context, executable, logPath } = await createProbe(scenario);
    const runtime = new ClaudeCodeRuntimeAdapter(executable);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_UNSUPPORTED" });
    expect((error as Error).message).toContain("stable Claude Code >=2.1.215");
    expect((error as Error).message).not.toContain(providerOutput);
    await expect(readCalls(logPath)).resolves.toEqual([["--version"]]);
  });

  it.each([
    ["help-failure", "unavailable"],
    ["help-output-limit", "too much output"],
    ["missing-short-p", "-p"],
    ["missing-safe-mode", "--safe-mode"],
    ["missing-auth-command", "auth"],
    ["missing-verbose", "--verbose"],
  ])("maps %s to a redacted capability error", async (scenario, message) => {
    const { context, executable, logPath } = await createProbe(scenario);
    const runtime = new ClaudeCodeRuntimeAdapter(executable);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain("CAPABILITY_SECRET_FROM_PROVIDER");
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["--help"]]);
  });

  it.each([
    ["read_only", "missing-dontAsk", "dontAsk"],
    ["workspace_write", "missing-acceptEdits", "acceptEdits"],
  ] as const)("requires the %s permission mode", async (access, scenario, capability) => {
    const { context, executable, logPath } = await createProbe(scenario);
    const runtime = new ClaudeCodeRuntimeAdapter(executable);

    const error = await runtime
      .probe({ requiredAccessModes: [access] }, context)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain(capability);
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["--help"]]);
  });

  it.each([
    ["read_only", "missing-acceptEdits"],
    ["workspace_write", "missing-dontAsk"],
  ] as const)("does not require an unused %s permission mode", async (access, scenario) => {
    const { context, executable, logPath } = await createProbe(scenario);

    await expect(
      new ClaudeCodeRuntimeAdapter(executable).probe({ requiredAccessModes: [access] }, context),
    ).resolves.toMatchObject({ runtimeId: "claude-code", version: "2.1.215" });
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["auth", "status"],
    ]);
  });

  it.each(["auth-required", "auth-output-limit"])(
    "maps %s to a redacted authentication error",
    async (scenario) => {
      const { context, executable, logPath } = await createProbe(scenario);
      const runtime = new ClaudeCodeRuntimeAdapter(executable);

      const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(KilinError);
      expect(error).toMatchObject({ code: "RUNTIME_AUTH_REQUIRED" });
      expect((error as Error).message).toContain("claude auth");
      expect((error as Error).message).not.toContain("AUTH_SECRET_FROM_PROVIDER");
      await expect(readCalls(logPath)).resolves.toEqual([
        ["--version"],
        ["--help"],
        ["auth", "status"],
      ]);
    },
    7_000,
  );

  it("maps cancellation during a running probe to AbortError", async () => {
    const { context, executable } = await createProbe("version-timeout");
    const controller = new AbortController();
    const probe = new ClaudeCodeRuntimeAdapter(executable).probe(requirements, {
      ...context,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not start the fake executable when already cancelled", async () => {
    const { context, executable, logPath } = await createProbe();
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ClaudeCodeRuntimeAdapter(executable).probe(requirements, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Claude Code runtime invocation", () => {
  it.each([
    ["read_only", "dontAsk", ["Edit", "Write", "NotebookEdit"]],
    ["workspace_write", "acceptEdits", undefined],
  ] as const)("maps %s access to a fail-closed sandbox profile", (access, permissionMode, deny) => {
    const runtime = new ClaudeCodeRuntimeAdapter(fakeClaudePath);
    const environment = { PATH: "/usr/bin", SENTINEL: "inherited" };
    const context: RuntimeExecutionContext = {
      runtimeResultPath: "/private/run/.runtime-result.tmp",
      env: environment,
    };
    const invocation = runtime.createInvocation(
      request("/canonical/project", { access, model: "claude-sonnet" }),
      context,
    );
    const settings = settingsFrom(invocation.args);

    expect(runtime.runtimeId).toBe("claude-code");
    expect(invocation).toMatchObject({
      executable: fakeClaudePath,
      cwd: "/canonical/project",
      env: environment,
      stdin: "Inspect safely; $(touch must-not-run)\n",
    });
    expect(invocation.args.slice(0, 11)).toEqual([
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      permissionMode,
      "--settings",
      expect.any(String),
    ]);
    expect(invocation.args.slice(11)).toEqual(["--safe-mode", "--model", "claude-sonnet"]);
    expect(settings.permissions).toEqual({
      ...(deny === undefined ? {} : { deny }),
      disableAutoMode: "disable",
      disableBypassPermissionsMode: "disable",
    });
    expect(settings.sandbox).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      ...(access === "read_only" ? { filesystem: { denyWrite: ["/canonical/project"] } } : {}),
    });
  });

  it("omits the model and keeps shell syntax exclusively on stdin", () => {
    const runtime = new ClaudeCodeRuntimeAdapter();
    const invocation = runtime.createInvocation(request("/canonical/project"), {
      runtimeResultPath: "/private/run/.runtime-result.tmp",
      env: { PATH: "/usr/bin" },
    });

    expect(invocation.executable).toBe("claude");
    expect(invocation.args).not.toContain("--model");
    expect(invocation.args.join(" ")).not.toContain("touch must-not-run");
    expect(invocation.stdin).toBe("Inspect safely; $(touch must-not-run)\n");
  });

  it("runs through the shared process runner with exact cwd and stdin", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run-1", "claude", 0);
    await prepareNodeOutput(paths);
    const recordPath = join(directory, "invocation.json");
    const runtime = new ClaudeCodeRuntimeAdapter(fakeClaudePath);
    const invocation = runtime.createInvocation(
      request(directory, { model: "claude; $(touch model-must-not-run)" }),
      {
        runtimeResultPath: join(directory, "ignored-runtime-result.tmp"),
        env: {
          ...inheritedEnvironment(),
          FAKE_CLAUDE_RECORD: recordPath,
        },
      },
    );

    const outcome = await runProcess(invocation, paths, {
      timeoutMs: 2_000,
      maxOutputBytes: 10_000,
    });

    expect(outcome.status).toBe("succeeded");
    await expect(runtime.extractResult(outcome.completed)).resolves.toEqual({
      finalMessage: "result:Inspect safely; $(touch must-not-run)\n",
    });
    await expect(
      readFile(recordPath, "utf8").then((value) => JSON.parse(value) as unknown),
    ).resolves.toEqual({
      args: invocation.args,
      cwd: directory,
      prompt: invocation.stdin,
    });
    await expect(stat(join(directory, "must-not-run"))).rejects.toThrow();
    await expect(stat(join(directory, "model-must-not-run"))).rejects.toThrow();
  });
});

describe("Claude Code runtime results", () => {
  it.each([
    ["exact whitespace", "  exact final message\n"],
    ["whitespace-only result", " \n\t "],
    ["empty result", ""],
  ])("extracts one successful %s", async (_name, result) => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    await writeFile(
      stdoutPath,
      `${JSON.stringify({ type: "system", subtype: "init" })}\n\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result })}\n\n`,
    );

    await expect(
      new ClaudeCodeRuntimeAdapter(fakeClaudePath).extractResult(completedProcess(stdoutPath)),
    ).resolves.toEqual({ finalMessage: result });
  });

  it.each([
    ["malformed output", "{not-json}\nPROVIDER_SECRET"],
    ["missing result", `${JSON.stringify({ type: "assistant", message: {} })}\n`],
    [
      "duplicate result",
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "first" })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "second" })}\n`,
    ],
    [
      "non-success result",
      `${JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "PROVIDER_SECRET" })}\n`,
    ],
    [
      "non-string result",
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: 42 })}\n`,
    ],
  ])("maps %s to a generic capture failure", async (_name, stdout) => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "stdout.log");
    await writeFile(stdoutPath, stdout);

    const error = await new ClaudeCodeRuntimeAdapter(fakeClaudePath)
      .extractResult(completedProcess(stdoutPath))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "NODE_CAPTURE_FAILED" });
    expect((error as Error).message).not.toContain("PROVIDER_SECRET");
  });

  it("maps unreadable stdout to a generic capture failure", async () => {
    const directory = await createTemporaryDirectory();
    const stdoutPath = join(directory, "missing", "stdout.log");

    await expect(
      new ClaudeCodeRuntimeAdapter(fakeClaudePath).extractResult(completedProcess(stdoutPath)),
    ).rejects.toMatchObject({ code: "NODE_CAPTURE_FAILED" });
  });
});
