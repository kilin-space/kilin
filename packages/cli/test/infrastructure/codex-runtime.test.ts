import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { CodexRuntimeAdapter } from "../../src/infrastructure/codex-runtime.js";
import { readStrictJsonLines as readCalls } from "../helpers/json-lines.js";
import { inheritedEnvironment, processIsRunning } from "../helpers/subprocess.js";

const fakeCodexPath = fileURLToPath(new URL("../fixtures/fake-codex.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

const createProbe = async (
  scenario = "supported",
): Promise<{ context: RuntimeProbeContext; directory: string; logPath: string }> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-codex-runtime-"));
  temporaryDirectories.push(directory);
  const logPath = join(directory, "calls.jsonl");
  return {
    context: {
      canonicalCwd: directory,
      env: {
        ...inheritedEnvironment(),
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_SCENARIO: scenario,
        FAKE_CODEX_DESCENDANT_PID: join(directory, "descendant.pid"),
        FAKE_CODEX_SIGNAL_MARKER: join(directory, "signal.txt"),
      },
    },
    directory,
    logPath,
  };
};

const waitForProcessExit = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 500;
  while (processIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsRunning(pid);
};

const requirements: RuntimeProbeRequirements = {
  requiredAccessModes: ["read_only", "workspace_write"],
};

const request = (overrides: Partial<ResolvedAgentRequest> = {}): ResolvedAgentRequest => ({
  runId: "run-1",
  nodeId: "inspect",
  ordinal: 0,
  runtime: "codex",
  access: "read_only",
  prompt: "Inspect safely; $(touch must-not-run)",
  canonicalWorkingDirectory: "/canonical/project",
  isGitRepository: true,
  ...overrides,
});

beforeAll(async () => {
  await chmod(fakeCodexPath, 0o755);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("Codex runtime preflight", () => {
  it("probes version, exact execution capabilities, and authentication in order", async () => {
    const { context, logPath } = await createProbe();
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    await expect(runtime.probe(requirements, context)).resolves.toEqual({
      runtimeId: "codex",
      executable: fakeCodexPath,
      version: "0.144.6",
    });
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
      ["login", "status"],
    ]);
  });

  it("accepts a newer stable version when required probes still pass", async () => {
    const { context, logPath } = await createProbe("newer-version");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    await expect(runtime.probe(requirements, context)).resolves.toMatchObject({
      version: "0.145.0",
    });
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
      ["login", "status"],
    ]);
  });

  it("rejects a missing executable with an actionable runtime error", async () => {
    const { context, directory } = await createProbe();
    const runtime = new CodexRuntimeAdapter(join(directory, "missing-codex"));

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_NOT_FOUND" });
    expect((error as Error).message).toMatch(/install Codex|PATH/u);
  });

  it.each(["unsupported-version", "prerelease-version"])(
    "rejects %s outside the stable minimum policy before later probes",
    async (scenario) => {
      const { context, logPath } = await createProbe(scenario);
      const runtime = new CodexRuntimeAdapter(fakeCodexPath);

      const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(KilinError);
      expect(error).toMatchObject({ code: "RUNTIME_UNSUPPORTED" });
      expect((error as Error).message).toContain("stable Codex >=0.144.0");
      await expect(readCalls(logPath)).resolves.toEqual([["--version"]]);
    },
  );

  it("terminates a probe that does not finish without exposing provider output", async () => {
    const { context, logPath } = await createProbe("version-timeout");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_UNSUPPORTED" });
    expect((error as Error).message).toContain("timed out");
    await expect(readCalls(logPath)).resolves.toEqual([["--version"]]);
  }, 7_000);

  it("terminates the probe process group when a descendant retains its output streams", async () => {
    const { context, directory } = await createProbe("version-descendant-timeout");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);
    const startedAt = Date.now();

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_UNSUPPORTED" });
    expect(Date.now() - startedAt).toBeLessThan(6_500);
    await expect(readFile(join(directory, "signal.txt"), "utf8")).resolves.toBe("SIGTERM");
    const descendantPid = Number(await readFile(join(directory, "descendant.pid"), "utf8"));
    await expect(waitForProcessExit(descendantPid)).resolves.toBe(true);
  }, 8_000);

  it("terminates a probe that exceeds the output limit without exposing output", async () => {
    const { context, logPath } = await createProbe("capability-output-limit");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain("too much output");
    expect((error as Error).message).not.toContain("OUTPUT_SECRET_FROM_PROVIDER");
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it.each([
    ["--ask-for-approval", "missing-ask-for-approval"],
    ["--config", "missing-config"],
  ] as const)("rejects Codex without the global %s capability", async (flag, scenario) => {
    const { context, logPath } = await createProbe(scenario);
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain(flag);
    await expect(readCalls(logPath)).resolves.toEqual([["--version"], ["--help"]]);
  });

  it("rejects a missing required flag without exposing provider output", async () => {
    const { context, logPath } = await createProbe("missing-capability");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain("--ephemeral");
    expect((error as Error).message).not.toContain("CAPABILITY_SECRET_FROM_PROVIDER");
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it.each([
    ["missing-ignore-user-config", "--ignore-user-config"],
    ["missing-ignore-rules", "--ignore-rules"],
  ] as const)("rejects Codex without the %s isolation capability", async (scenario, flag) => {
    const { context, logPath } = await createProbe(scenario);
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain(flag);
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("rejects help that advertises --cd but not the emitted -C flag", async () => {
    const { context, logPath } = await createProbe("long-cwd-only");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_CAPABILITY_MISSING" });
    expect((error as Error).message).toContain("-C");
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
    ]);
  });

  it("maps failed login status without exposing authentication output", async () => {
    const { context, logPath } = await createProbe("auth-required");
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);

    const error = await runtime.probe(requirements, context).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "RUNTIME_AUTH_REQUIRED" });
    expect((error as Error).message).toContain("codex login");
    expect((error as Error).message).not.toContain("AUTH_SECRET_FROM_PROVIDER");
    await expect(readCalls(logPath)).resolves.toEqual([
      ["--version"],
      ["--help"],
      ["exec", "--help"],
      ["login", "status"],
    ]);
  });
});

describe("Codex runtime invocation", () => {
  it.each(["read_only", "workspace_write"] as const)(
    "maps %s access and owns the complete argv",
    (access) => {
      const runtime = new CodexRuntimeAdapter(fakeCodexPath);
      const environment = { PATH: "/usr/bin", SENTINEL: "inherited" };
      const context: RuntimeExecutionContext = {
        runtimeResultPath: "/private/run/nodes/001-inspect/.runtime-result.tmp",
        env: environment,
      };

      expect(
        runtime.createInvocation(
          request({ access, model: "gpt-5.4", isGitRepository: false }),
          context,
        ),
      ).toEqual({
        executable: fakeCodexPath,
        args: [
          "--ask-for-approval",
          "never",
          "--config",
          `default_permissions="${access === "read_only" ? ":read-only" : ":workspace"}"`,
          "--config",
          'projects."/canonical/project".trust_level="untrusted"',
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--json",
          "-C",
          "/canonical/project",
          "--output-last-message",
          context.runtimeResultPath,
          "--model",
          "gpt-5.4",
          "--skip-git-repo-check",
          "--ephemeral",
          "-",
        ],
        cwd: "/canonical/project",
        env: environment,
        stdin: "Inspect safely; $(touch must-not-run)",
      });
    },
  );

  it("omits optional flags for a Git workspace and a node without a model", () => {
    const runtime = new CodexRuntimeAdapter(fakeCodexPath);
    const invocation = runtime.createInvocation(request(), {
      runtimeResultPath: "/private/run/.runtime-result.tmp",
      env: { PATH: "/usr/bin" },
    });

    expect(invocation.args).toEqual([
      "--ask-for-approval",
      "never",
      "--config",
      'default_permissions=":read-only"',
      "--config",
      'projects."/canonical/project".trust_level="untrusted"',
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-C",
      "/canonical/project",
      "--output-last-message",
      "/private/run/.runtime-result.tmp",
      "--ephemeral",
      "-",
    ]);
  });
});

describe("Codex runtime results", () => {
  it("reads the exact final message from the runner-owned result path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kilin-codex-result-"));
    temporaryDirectories.push(directory);
    const completed: CompletedProcess = {
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutPath: join(directory, "stdout.log"),
      stderrPath: join(directory, "stderr.log"),
      resultPath: join(directory, "result.txt"),
      runtimeResultPath: join(directory, ".runtime-result.tmp"),
      outputBytes: 22,
    };
    await writeFile(completed.runtimeResultPath, "  exact final message\n");

    await expect(new CodexRuntimeAdapter(fakeCodexPath).extractResult(completed)).resolves.toEqual({
      finalMessage: "  exact final message\n",
    });
  });

  it("maps an unreadable result to an actionable capture error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kilin-codex-result-"));
    temporaryDirectories.push(directory);
    const missingResult = join(directory, "missing", "result.txt");

    const error = await new CodexRuntimeAdapter(fakeCodexPath)
      .extractResult({
        exitCode: 0,
        signal: null,
        durationMs: 10,
        stdoutPath: join(directory, "stdout.log"),
        stderrPath: join(directory, "stderr.log"),
        resultPath: join(directory, "result.txt"),
        runtimeResultPath: missingResult,
        outputBytes: 0,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code: "NODE_CAPTURE_FAILED" });
    expect((error as Error).message).toMatch(/final result|captured output/u);
  });
});
