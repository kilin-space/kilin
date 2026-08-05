import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CompletedProcess, RuntimeInvocation } from "../../src/application/runtime.js";
import type { AttemptProcessIdentity } from "../../src/domain/run-state.js";
import {
  cleanupRuntimeResult,
  loopResultPath,
  materializeResolvedInputs,
  materializeRuntimeResult,
  nodeOutputPaths,
  prepareLoopResult,
  prepareNodeOutput,
  publishPrivateFile,
  resolvedInputsPath,
  runProcess,
  runtimeResultStagingPath,
  terminateRecordedProcesses,
} from "../../src/infrastructure/process-runner.js";
import { killProcessIfRunning, processIsRunning } from "../helpers/subprocess.js";

const fakeProcessPath = fileURLToPath(new URL("../fixtures/fake-process.mjs", import.meta.url));
const fakeProcessStartupTimeoutMs = 5_000;
const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-process-runner-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
};

const environment = (recordPath: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  FAKE_PROCESS_RECORD: recordPath,
  FAKE_VISIBLE: "visible value",
});

const invocation = (
  directory: string,
  resultPath: string,
  recordPath: string,
  scenario: string,
  extraArgs: readonly string[] = [],
): RuntimeInvocation => ({
  executable: fakeProcessPath,
  args: ["--scenario", scenario, "--result", resultPath, ...extraArgs],
  cwd: directory,
  env: environment(recordPath),
  stdin: "exact input; $(touch must-not-run)\n",
});

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the fake process condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeAll(async () => {
  await chmod(fakeProcessPath, 0o755);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("node output preparation", () => {
  it("prepares one private loop result without stream files", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const resultPath = loopResultPath(dataDirectory, "run-1", "refinement", 2);

    await prepareLoopResult(resultPath);

    await expect(stat(resultPath)).resolves.toMatchObject({ mode: 0o100600 });
    await expect(readdir(dirname(resultPath))).resolves.toEqual(["result.txt"]);
  });

  it("creates ordinal-separated private output paths and files", async () => {
    const dataDirectory = await createTemporaryDirectory();
    const first = nodeOutputPaths(dataDirectory, "run-1", "Foo", 0);
    const second = nodeOutputPaths(dataDirectory, "run-1", "foo", 1);

    await expect(stat(join(dataDirectory, "runs"))).rejects.toThrow();
    await prepareNodeOutput(first);
    const runDirectories = [
      dataDirectory,
      join(dataDirectory, "runs"),
      join(dataDirectory, "runs", "run-1"),
      join(dataDirectory, "runs", "run-1", "nodes"),
    ];
    await Promise.all(runDirectories.map(async (directory) => chmod(directory, 0o755)));
    await prepareNodeOutput(second);

    expect(first).toEqual({
      stdoutPath: join(dataDirectory, "runs", "run-1", "nodes", "000-Foo", "stdout.log"),
      stderrPath: join(dataDirectory, "runs", "run-1", "nodes", "000-Foo", "stderr.log"),
      resultPath: join(dataDirectory, "runs", "run-1", "nodes", "000-Foo", "result.txt"),
    });
    expect(second.resultPath).toContain(join("nodes", "001-foo", "result.txt"));
    for (const directory of runDirectories) {
      await expect(stat(directory)).resolves.toMatchObject({ mode: 0o40700 });
    }
    await expect(
      stat(join(dataDirectory, "runs", "run-1", "nodes", "000-Foo")),
    ).resolves.toMatchObject({ mode: 0o40700 });
    for (const path of [
      first.stdoutPath,
      first.stderrPath,
      first.resultPath,
      runtimeResultStagingPath(first),
    ]) {
      await expect(stat(path)).resolves.toMatchObject({ mode: 0o100600, size: 0 });
    }
  });

  it.each(["../escape", "nested/node", "nested\\node", "", ".", ".."])(
    "rejects unsafe path segment %j",
    async (segment) => {
      const dataDirectory = await createTemporaryDirectory();
      expect(() => nodeOutputPaths(dataDirectory, "run-1", segment, 0)).toThrow(
        /safe path segment/u,
      );
      expect(() => nodeOutputPaths(dataDirectory, segment, "node", 0)).toThrow(
        /safe path segment/u,
      );
    },
  );
});

describe("private file publication", () => {
  it("durably publishes exact bytes in a private file", async () => {
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, "payload.bin");
    const contents = new Uint8Array([0, 255, 128, 10]);

    await publishPrivateFile(targetPath, contents);

    await expect(readFile(targetPath)).resolves.toEqual(Buffer.from(contents));
    await expect(stat(targetPath)).resolves.toMatchObject({ mode: 0o100600 });
  });

  it("cleans its private temporary file when publication fails", async () => {
    const directory = await createTemporaryDirectory();
    const targetPath = join(directory, "payload.bin");
    await mkdir(targetPath);

    await expect(publishPrivateFile(targetPath, new Uint8Array([1]))).rejects.toThrow();

    expect((await readdir(directory)).filter((entry) => entry.startsWith(".payload.bin-"))).toEqual(
      [],
    );
  });
});

describe("runtime result materialization", () => {
  it("keeps provider staging private and atomically publishes the canonical result", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "result", 0);
    await prepareNodeOutput(paths);
    const stagingPath = runtimeResultStagingPath(paths);
    await writeFile(stagingPath, "  exact final message\n");
    const completed: CompletedProcess = {
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      resultPath: paths.resultPath,
      runtimeResultPath: stagingPath,
      outputBytes: 26,
    };

    await materializeRuntimeResult(completed, "  exact final message\n", 1_024);
    await cleanupRuntimeResult(completed.runtimeResultPath);

    await expect(readFile(paths.resultPath, "utf8")).resolves.toBe("  exact final message\n");
    await expect(stat(paths.resultPath)).resolves.toMatchObject({ mode: 0o100600 });
    await expect(stat(stagingPath)).rejects.toThrow();
  });

  it("rejects a final message that would exceed the combined byte limit", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "limit", 0);
    await prepareNodeOutput(paths);
    const completed: CompletedProcess = {
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      resultPath: paths.resultPath,
      runtimeResultPath: runtimeResultStagingPath(paths),
      outputBytes: 1_020,
    };

    await expect(materializeRuntimeResult(completed, "five!", 1_024)).rejects.toMatchObject({
      code: "NODE_OUTPUT_LIMIT",
    });
    await expect(readFile(paths.resultPath, "utf8")).resolves.toBe("");
  });
});

describe("resolved input materialization", () => {
  it("cleans its private temporary file when atomic publication fails", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "inputs", 0);
    await prepareNodeOutput(paths);
    const inputPath = resolvedInputsPath(paths);
    await mkdir(inputPath);

    await expect(
      materializeResolvedInputs(paths, '{"inputs":{},"version":1}', 1_024),
    ).rejects.toMatchObject({ code: "NODE_INPUT_INVALID" });

    const nodeDirectory = dirname(inputPath);
    expect(
      (await readdir(nodeDirectory)).filter((entry) => entry.startsWith(".resolved-inputs.json-")),
    ).toEqual([]);
    await rm(inputPath, { recursive: true });
    await materializeResolvedInputs(paths, '{"inputs":{},"version":1}', 1_024);
    await expect(readFile(inputPath, "utf8")).resolves.toBe('{"inputs":{},"version":1}');
    await expect(stat(inputPath)).resolves.toMatchObject({ mode: 0o100600 });
  });
});

describe("process execution", () => {
  it("passes exact argv, cwd, environment, and stdin without a shell and durably captures success", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "success", 0);
    await prepareNodeOutput(paths);
    const recordPath = join(directory, "record.json");
    const processInvocation = invocation(
      directory,
      runtimeResultStagingPath(paths),
      recordPath,
      "success",
      ["$(touch", "must-not-run)"],
    );

    const outcome = await runProcess(processInvocation, paths, {
      timeoutMs: 2_000,
      maxOutputBytes: 10_000,
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.completed).toMatchObject({ exitCode: 0, signal: null, outputBytes: 26 });
    await expect(readFile(paths.stdoutPath, "utf8")).resolves.toBe("stdout exact\n");
    await expect(readFile(paths.stderrPath, "utf8")).resolves.toBe("stderr exact\n");
    await materializeRuntimeResult(
      outcome.completed,
      await readFile(outcome.completed.runtimeResultPath, "utf8"),
      10_000,
    );
    await cleanupRuntimeResult(outcome.completed.runtimeResultPath);
    await expect(readFile(paths.resultPath, "utf8")).resolves.toBe("result exact\n");
    await expect(
      readFile(recordPath, "utf8").then((text) => JSON.parse(text) as unknown),
    ).resolves.toEqual({
      args: processInvocation.args,
      cwd: directory,
      stdin: processInvocation.stdin,
      visibleEnvironment: "visible value",
      absentEnvironmentPresent: false,
    });
    await expect(stat(join(directory, "must-not-run"))).rejects.toThrow();
  });

  it("returns a typed nonzero outcome and preserves partial output", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "nonzero", 0);
    await prepareNodeOutput(paths);
    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "nonzero",
      ),
      paths,
      { timeoutMs: 2_000, maxOutputBytes: 10_000 },
    );

    expect(outcome.status).toBe("exited");
    expect(outcome.completed).toMatchObject({ exitCode: 23, signal: null });
    await expect(readFile(paths.stdoutPath, "utf8")).resolves.toBe("partial stdout\n");
    await expect(readFile(paths.stderrPath, "utf8")).resolves.toBe("partial stderr\n");
    await expect(stat(runtimeResultStagingPath(paths))).rejects.toThrow();
  });

  it("bounds all retained output and terminates an over-limit process", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "bounded", 0);
    await prepareNodeOutput(paths);
    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "output-limit",
      ),
      paths,
      { timeoutMs: 2_000, maxOutputBytes: 1_024, terminationGraceMs: 30 },
    );

    expect(outcome.status).toBe("output_limit");
    expect(outcome.completed.outputBytes).toBeLessThanOrEqual(1_024);
    const sizes = await Promise.all(
      [paths.stdoutPath, paths.stderrPath, paths.resultPath].map(
        async (path) => (await stat(path)).size,
      ),
    );
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(1_024);
    await expect(stat(runtimeResultStagingPath(paths))).rejects.toThrow();
  });

  it("times out a process within a bounded interval", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "timeout", 0);
    await prepareNodeOutput(paths);
    const startedAt = Date.now();
    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "wait",
      ),
      paths,
      { timeoutMs: 40, maxOutputBytes: 10_000, terminationGraceMs: 30 },
    );

    expect(outcome.status).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("times out after a zero-exit leader leaves a descendant holding capture pipes", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "retained-pipes", 0);
    await prepareNodeOutput(paths);
    const pidPath = join(directory, "descendant.pid");
    const timeoutMs = fakeProcessStartupTimeoutMs + 1_000;
    const terminationGraceMs = 30;
    const startedAt = Date.now();
    let descendantPid: number | undefined;

    const running = runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "retained-pipes",
        ["--pid-file", pidPath],
      ),
      paths,
      { timeoutMs, maxOutputBytes: 10_000, terminationGraceMs },
    );
    try {
      await waitFor(
        async () =>
          stat(pidPath).then(
            () => true,
            () => false,
          ),
        fakeProcessStartupTimeoutMs,
      );
      const recordedDescendantPid = Number(await readFile(pidPath, "utf8"));
      descendantPid = recordedDescendantPid;
      const outcome = await running;

      expect(outcome.status).toBe("timed_out");
      expect(Date.now() - startedAt).toBeLessThan(timeoutMs + terminationGraceMs + 500);
      await waitFor(() => !processIsRunning(recordedDescendantPid));
    } finally {
      if (descendantPid !== undefined) {
        killProcessIfRunning(descendantPid);
      }
    }
  });

  it("returns promptly when a zero-exit leader leaves no group or capture pipes", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "prompt-exit", 0);
    await prepareNodeOutput(paths);
    const startedAt = Date.now();

    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "success",
      ),
      paths,
      { timeoutMs: 1_000, maxOutputBytes: 10_000, terminationGraceMs: 30 },
    );

    expect(outcome.status).toBe("succeeded");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("reports the spawned process group leader before the process produces output", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "identity", 0);
    await prepareNodeOutput(paths);
    const reported: AttemptProcessIdentity[] = [];

    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "success",
      ),
      paths,
      {
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 30,
        onProcessStarted: (identity) => reported.push(identity),
      },
    );

    expect(outcome.status).toBe("succeeded");
    expect(reported).toHaveLength(1);
    const identity = reported[0];
    if (identity === undefined) {
      throw new Error("Expected one reported process identity");
    }
    expect(identity.pid).toBeGreaterThan(0);
    // A detached spawn makes the child its own group leader, which is what lets a later command
    // reach the whole tree from this one recorded value.
    expect(identity.processGroupId).toBe(identity.pid);
    expect(identity.startIdentifier.length).toBeGreaterThan(0);
  });

  it("runs to completion when recording the process identity fails", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "identity-failure", 0);
    await prepareNodeOutput(paths);
    let observedPid: number | undefined;

    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "success",
      ),
      paths,
      {
        timeoutMs: 1_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 30,
        onProcessStarted: (identity) => {
          observedPid = identity.pid;
          throw new Error("state write failed");
        },
      },
    );

    // Losing the record costs a later reap, never the run: the group was already spawned and the
    // capture handles were already open when the write failed.
    expect(outcome.status).toBe("succeeded");
    expect(observedPid).toBeGreaterThan(0);
    await expect(readFile(paths.stdoutPath, "utf8")).resolves.toBe("stdout exact\n");
    expect(processIsRunning(observedPid ?? 0)).toBe(false);
  });

  it("settles cancellation after a TERM-resistant descendant outlives its group leader", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "cancel", 0);
    await prepareNodeOutput(paths);
    const pidPath = join(directory, "descendant.pid");
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const running = runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "descendant",
        ["--pid-file", pidPath],
      ),
      paths,
      {
        timeoutMs: fakeProcessStartupTimeoutMs + 1_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 30,
        signal: controller.signal,
      },
    );
    try {
      await waitFor(
        async () =>
          stat(pidPath).then(
            () => true,
            () => false,
          ),
        fakeProcessStartupTimeoutMs,
      );
      const recordedDescendantPid = Number(await readFile(pidPath, "utf8"));
      descendantPid = recordedDescendantPid;

      controller.abort();
      const outcome = await running;

      expect(outcome.status).toBe("cancelled");
      await waitFor(() => !processIsRunning(recordedDescendantPid));
    } finally {
      controller.abort();
      await Promise.allSettled([running]);
      if (descendantPid !== undefined) {
        killProcessIfRunning(descendantPid);
      }
    }
  });

  it("delivers one TERM to each original process-group member on cancellation", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "signal-count", 0);
    await prepareNodeOutput(paths);
    const pidPath = join(directory, "descendant.pid");
    const signalPath = join(directory, "signals.log");
    const controller = new AbortController();
    let descendantPid: number | undefined;
    const running = runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "signal-counting-descendant",
        ["--pid-file", pidPath, "--signal-file", signalPath],
      ),
      paths,
      {
        timeoutMs: fakeProcessStartupTimeoutMs + 1_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 1_000,
        signal: controller.signal,
      },
    );
    try {
      await waitFor(
        async () =>
          stat(pidPath).then(
            () => true,
            () => false,
          ),
        fakeProcessStartupTimeoutMs,
      );
      const recordedDescendantPid = Number(await readFile(pidPath, "utf8"));
      descendantPid = recordedDescendantPid;

      controller.abort();
      const outcome = await running;

      expect(outcome.status).toBe("cancelled");
      await waitFor(() => !processIsRunning(recordedDescendantPid));
      await expect(
        readFile(signalPath, "utf8").then((signals) => signals.trim().split("\n").sort()),
      ).resolves.toEqual(["descendant", "leader"]);
    } finally {
      controller.abort();
      await Promise.allSettled([running]);
      if (descendantPid !== undefined) {
        killProcessIfRunning(descendantPid);
      }
    }
  });

  it("forces delayed cleanup of a detached descendant that outlives its leader", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "detached-descendant", 0);
    await prepareNodeOutput(paths);
    const pidPath = join(directory, "descendant.pid");
    let descendantPid: number | undefined;
    const running = runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "detached-descendant",
        ["--pid-file", pidPath],
      ),
      paths,
      {
        timeoutMs: fakeProcessStartupTimeoutMs + 1_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 30,
      },
    );
    try {
      await waitFor(
        async () =>
          stat(pidPath).then(
            () => true,
            () => false,
          ),
        fakeProcessStartupTimeoutMs,
      );
      const recordedDescendantPid = Number(await readFile(pidPath, "utf8"));
      descendantPid = recordedDescendantPid;

      const outcome = await running;

      expect(outcome.status).toBe("timed_out");
      await waitFor(() => !processIsRunning(recordedDescendantPid));
    } finally {
      if (descendantPid !== undefined) {
        killProcessIfRunning(descendantPid);
      }
    }
  });

  it("returns capture_failed when a precreated capture file is unavailable", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "capture", 0);
    await prepareNodeOutput(paths);
    await unlink(paths.stderrPath);

    const outcome = await runProcess(
      invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "wait",
      ),
      paths,
      { timeoutMs: 2_000, maxOutputBytes: 10_000, terminationGraceMs: 30 },
    );

    expect(outcome.status).toBe("capture_failed");
    expect(outcome.completed.exitCode).toBeNull();
  });

  it("returns capture_failed when the executable cannot be spawned", async () => {
    const directory = await createTemporaryDirectory();
    const paths = nodeOutputPaths(directory, "run", "spawn", 0);
    await prepareNodeOutput(paths);
    const missingInvocation: RuntimeInvocation = {
      ...invocation(
        directory,
        runtimeResultStagingPath(paths),
        join(directory, "record.json"),
        "wait",
      ),
      executable: join(directory, "missing-executable"),
    };

    const outcome = await runProcess(missingInvocation, paths, {
      timeoutMs: 2_000,
      maxOutputBytes: 10_000,
      terminationGraceMs: 30,
    });

    expect(outcome.status).toBe("capture_failed");
    expect(outcome.completed).toMatchObject({ exitCode: null, signal: null });
  });
});

describe("recorded process termination", () => {
  const spawnDetachedSurvivor = async (): Promise<AttemptProcessIdentity> => {
    const paths = nodeOutputPaths(await createTemporaryDirectory(), "run", "survivor", 0);
    await prepareNodeOutput(paths);
    let recorded: AttemptProcessIdentity | undefined;
    const running = runProcess(
      invocation(
        dirname(paths.stdoutPath),
        runtimeResultStagingPath(paths),
        join(dirname(paths.stdoutPath), "record.json"),
        "wait",
      ),
      paths,
      {
        timeoutMs: 30_000,
        maxOutputBytes: 10_000,
        terminationGraceMs: 30,
        onProcessStarted: (identity) => {
          recorded = identity;
        },
      },
    );
    await waitFor(() => recorded !== undefined);
    if (recorded === undefined) {
      throw new Error("Expected a recorded process identity");
    }
    // Abandon the runProcess promise the way a killed Kilin process would: the child stays alive.
    void running.catch(() => undefined);
    return recorded;
  };

  it("terminates a recorded process that is still running", async () => {
    const recorded = await spawnDetachedSurvivor();
    try {
      const examined = await terminateRecordedProcesses(
        [{ startedAt: new Date().toISOString(), process: recorded }],
        30,
      );

      expect(examined).toBe(true);
      await waitFor(() => !processIsRunning(recorded.pid));
    } finally {
      killProcessIfRunning(recorded.pid);
    }
  });

  it("leaves a recorded process alone when the host booted after the attempt started", async () => {
    const recorded = await spawnDetachedSurvivor();
    try {
      // A start time before the current boot cannot describe a live process, so the recorded pid
      // now belongs to somebody else.
      const examined = await terminateRecordedProcesses(
        [{ startedAt: "1999-01-01T00:00:00.000Z", process: recorded }],
        30,
      );

      expect(examined).toBe(true);
      expect(processIsRunning(recorded.pid)).toBe(true);
    } finally {
      killProcessIfRunning(recorded.pid);
    }
  });

  it("leaves a recorded process alone when its start identifier no longer matches", async () => {
    const recorded = await spawnDetachedSurvivor();
    try {
      const examined = await terminateRecordedProcesses(
        [
          {
            startedAt: new Date().toISOString(),
            process: { ...recorded, startIdentifier: "some other process" },
          },
        ],
        30,
      );

      expect(examined).toBe(true);
      expect(processIsRunning(recorded.pid)).toBe(true);
    } finally {
      killProcessIfRunning(recorded.pid);
    }
  });
});
