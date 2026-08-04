import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat, truncate } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";

import type { CompletedProcess, RuntimeInvocation } from "../application/runtime.js";
import { KilinError } from "../domain/errors.js";
import type { AttemptProcessIdentity, NodeOutputPaths } from "../domain/run-state.js";

export interface ProcessRunOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Called once with the identity of the spawned process group leader, before the process can
   * produce output. Recording it lets a later command attribute and reap a survivor of a Kilin
   * process that exited without cleaning up.
   */
  readonly onProcessStarted?: (identity: AttemptProcessIdentity) => void;
}

/** An attempt's recorded process, paired with the time the attempt started. */
export interface RecordedProcess {
  readonly startedAt: string;
  readonly identity: AttemptProcessIdentity;
}

type CompletedProcessWithExitCode = CompletedProcess & {
  readonly exitCode: 0;
  readonly signal: null;
};

export type ProcessRunOutcome =
  | { readonly status: "succeeded"; readonly completed: CompletedProcessWithExitCode }
  | { readonly status: "exited"; readonly completed: CompletedProcess }
  | { readonly status: "timed_out"; readonly completed: CompletedProcess }
  | { readonly status: "output_limit"; readonly completed: CompletedProcess }
  | { readonly status: "cancelled"; readonly completed: CompletedProcess }
  | { readonly status: "capture_failed"; readonly completed: CompletedProcess };

type TerminationStatus = Exclude<ProcessRunOutcome["status"], "succeeded" | "exited">;

interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnFailed: boolean;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startIdentifier: string;
}

const defaultTerminationGraceMs = 1_000;
const resultPollIntervalMs = 10;

const isSafePathSegment = (value: string): boolean =>
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !value.includes("/") &&
  !value.includes("\\") &&
  !value.includes("\0");

const assertSafePathSegment = (name: string, value: string): void => {
  if (!isSafePathSegment(value)) {
    throw new Error(`${name} must be a safe path segment without traversal or separators.`);
  }
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

const createPrivateFile = async (path: string): Promise<void> => {
  const handle = await open(path, "wx", 0o600);
  await handle.close();
};

export const nodeOutputPaths = (
  dataDirectory: string,
  runId: string,
  nodeId: string,
  ordinal: number,
  attempt = 1,
): NodeOutputPaths => {
  assertSafePathSegment("Run ID", runId);
  assertSafePathSegment("Node ID", nodeId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("Node ordinal must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Node attempt must be a positive safe integer.");
  }

  const nodesDirectory = join(dataDirectory, "runs", runId, "nodes");
  const attemptSuffix = attempt === 1 ? "" : `-attempt-${String(attempt).padStart(3, "0")}`;
  const nodeDirectory = join(
    nodesDirectory,
    `${String(ordinal).padStart(3, "0")}-${nodeId}${attemptSuffix}`,
  );
  return {
    stdoutPath: join(nodeDirectory, "stdout.log"),
    stderrPath: join(nodeDirectory, "stderr.log"),
    resultPath: join(nodeDirectory, "result.txt"),
  };
};

export const loopResultPath = (
  dataDirectory: string,
  runId: string,
  executionId: string,
  ordinal: number,
): string => nodeOutputPaths(dataDirectory, runId, executionId, ordinal).resultPath;

const preparePrivateNodeDirectory = async (nodeDirectory: string): Promise<void> => {
  const nodesDirectory = dirname(nodeDirectory);
  const runDirectory = dirname(nodesDirectory);
  const runsDirectory = dirname(runDirectory);
  const dataDirectory = dirname(runsDirectory);
  for (const directory of [dataDirectory, runsDirectory, runDirectory, nodesDirectory]) {
    await ensurePrivateDirectory(directory);
  }
  await mkdir(nodeDirectory, { mode: 0o700 });
  await chmod(nodeDirectory, 0o700);
};

export const prepareLoopResult = async (resultPath: string): Promise<void> => {
  if (basename(resultPath) !== "result.txt") {
    throw new Error("Loop result path must name result.txt.");
  }
  const nodeDirectory = dirname(resultPath);
  try {
    await preparePrivateNodeDirectory(nodeDirectory);
    await createPrivateFile(resultPath);
  } catch {
    throw new KilinError(
      "NODE_CAPTURE_FAILED",
      "Loop result file could not be prepared. Check the Kilin data directory permissions and retry the run.",
    );
  }
};

export const runtimeResultStagingPath = (paths: NodeOutputPaths): string =>
  join(dirname(paths.resultPath), ".runtime-result.tmp");

export const resolvedInputsPath = (paths: NodeOutputPaths): string =>
  join(dirname(paths.resultPath), "resolved-inputs.json");

export const prepareNodeOutput = async (paths: NodeOutputPaths): Promise<void> => {
  const nodeDirectory = dirname(paths.stdoutPath);
  if (
    dirname(paths.stderrPath) !== nodeDirectory ||
    dirname(paths.resultPath) !== nodeDirectory ||
    basename(paths.stdoutPath) !== "stdout.log" ||
    basename(paths.stderrPath) !== "stderr.log" ||
    basename(paths.resultPath) !== "result.txt"
  ) {
    throw new Error("Node output paths must name the three files in one node directory.");
  }

  try {
    await preparePrivateNodeDirectory(nodeDirectory);
    await createPrivateFile(paths.stdoutPath);
    await createPrivateFile(paths.stderrPath);
    await createPrivateFile(paths.resultPath);
    await createPrivateFile(runtimeResultStagingPath(paths));
  } catch {
    throw new KilinError(
      "NODE_CAPTURE_FAILED",
      "Node output files could not be prepared. Check the Kilin data directory permissions and retry the run.",
    );
  }
};

const fileSize = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
};

const capturedStreamBytes = async (paths: NodeOutputPaths): Promise<number> => {
  const sizes = await Promise.all([fileSize(paths.stdoutPath), fileSize(paths.stderrPath)]);
  return sizes.reduce((total, size) => total + size, 0);
};

const completedProcess = async (
  exit: Pick<ProcessExit, "exitCode" | "signal">,
  startedAt: number,
  paths: NodeOutputPaths,
): Promise<CompletedProcess> => ({
  exitCode: exit.exitCode,
  signal: exit.signal,
  durationMs: Date.now() - startedAt,
  stdoutPath: paths.stdoutPath,
  stderrPath: paths.stderrPath,
  resultPath: paths.resultPath,
  runtimeResultPath: runtimeResultStagingPath(paths),
  outputBytes: await capturedStreamBytes(paths),
});

const closeHandle = async (handle: FileHandle | undefined): Promise<void> => {
  if (handle !== undefined) {
    await handle.close();
  }
};

const syncAndCloseHandle = async (handle: FileHandle): Promise<void> => {
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const linuxProcessIdentity = (pid: number): Omit<ProcessIdentity, "pid"> | undefined => {
  let processStat: string;
  try {
    processStat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const commandEnd = processStat.lastIndexOf(")");
  if (commandEnd === -1) {
    return undefined;
  }
  const processFields = processStat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const parentPid = Number(processFields[1]);
  const processGroupId = Number(processFields[2]);
  const startIdentifier = processFields[19];
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    startIdentifier === undefined ||
    !/^\d+$/u.test(startIdentifier)
  ) {
    return undefined;
  }
  return { parentPid, processGroupId, startIdentifier };
};

/**
 * `lstart` is rendered through `strftime`, so its weekday, month, and clock reading depend on the
 * locale and time zone of the `ps` process. A recorded identifier is compared against a later
 * snapshot — sometimes from a later CLI invocation — so both sides must render identically.
 */
const processListingEnvironment: Readonly<Record<string, string>> = { LC_ALL: "C", TZ: "UTC" };

const listProcessIdentities = (): readonly ProcessIdentity[] | undefined => {
  const listed = spawnSync(
    "/bin/ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "lstart="],
    {
      encoding: "utf8",
      env: processListingEnvironment,
      maxBuffer: 1024 * 1024,
      timeout: 1_000,
    },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    return undefined;
  }
  const processes: ProcessIdentity[] = [];
  for (const line of listed.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, pidText, parentPidText, processGroupIdText, startedAtText] = match;
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    const processGroupId = Number(processGroupIdText);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(processGroupId) ||
      processGroupId <= 0 ||
      startedAtText === undefined
    ) {
      continue;
    }
    if (process.platform === "linux") {
      const kernelIdentity = linuxProcessIdentity(pid);
      if (kernelIdentity === undefined) {
        continue;
      }
      processes.push({ pid, ...kernelIdentity });
      continue;
    }
    processes.push({
      pid,
      parentPid,
      processGroupId,
      startIdentifier: startedAtText.replace(/\s+/gu, " "),
    });
  }
  return processes;
};

const descendantProcesses = (
  rootPid: number | undefined,
  processes: readonly ProcessIdentity[],
): readonly ProcessIdentity[] => {
  if (rootPid === undefined) {
    return [];
  }
  const childrenByParent = new Map<number, ProcessIdentity[]>();
  for (const processIdentity of processes) {
    const children = childrenByParent.get(processIdentity.parentPid) ?? [];
    children.push(processIdentity);
    childrenByParent.set(processIdentity.parentPid, children);
  }
  const descendants: ProcessIdentity[] = [];
  const pending = [rootPid];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) {
      continue;
    }
    for (const processIdentity of childrenByParent.get(parentPid) ?? []) {
      if (visited.has(processIdentity.pid)) {
        continue;
      }
      visited.add(processIdentity.pid);
      descendants.push(processIdentity);
      pending.push(processIdentity.pid);
    }
  }
  return descendants;
};

const signalProcesses = (processes: Iterable<ProcessIdentity>, signal: NodeJS.Signals): void => {
  for (const processIdentity of processes) {
    try {
      process.kill(processIdentity.pid, signal);
    } catch {
      continue;
    }
  }
};

const matchingProcesses = (
  expectedProcesses: Iterable<ProcessIdentity>,
  currentProcesses: readonly ProcessIdentity[] | undefined,
): readonly ProcessIdentity[] | undefined => {
  const expectedByPid = new Map(
    [...expectedProcesses].map((processIdentity) => [processIdentity.pid, processIdentity]),
  );
  if (currentProcesses === undefined) {
    return undefined;
  }
  return currentProcesses.filter(
    (currentProcess) =>
      expectedByPid.get(currentProcess.pid)?.startIdentifier === currentProcess.startIdentifier,
  );
};

const processIdentity = (pid: number): ProcessIdentity | undefined => {
  if (process.platform === "linux") {
    const kernelIdentity = linuxProcessIdentity(pid);
    return kernelIdentity === undefined ? undefined : { pid, ...kernelIdentity };
  }
  const listed = spawnSync(
    "/bin/ps",
    ["-p", String(pid), "-o", "ppid=", "-o", "pgid=", "-o", "lstart="],
    {
      encoding: "utf8",
      env: processListingEnvironment,
      timeout: 1_000,
    },
  );
  if (listed.error !== undefined || listed.status !== 0) {
    return undefined;
  }
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(listed.stdout.split("\n")[0] ?? "");
  if (match === null) {
    return undefined;
  }
  const [, parentPidText, processGroupIdText, startedAtText] = match;
  const parentPid = Number(parentPidText);
  const processGroupId = Number(processGroupIdText);
  if (
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0 ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0 ||
    startedAtText === undefined
  ) {
    return undefined;
  }
  return {
    pid,
    parentPid,
    processGroupId,
    startIdentifier: startedAtText.replace(/\s+/gu, " "),
  };
};

const hostBootedAt = (): number => Date.now() - uptime() * 1_000;

/**
 * Selects the live processes a recorded identity still owns.
 *
 * The recorded leader is trusted only when it is absent or still carries its recorded start
 * identifier; a live process holding the recorded pid under a different identifier means the pid
 * was recycled, and nothing about the recording can be trusted any more. Otherwise the group the
 * leader created and the tree still parented under it are both claimed, mirroring what an
 * in-process termination retains — a descendant can leave the group by calling `setsid`, and a
 * descendant of a still-live leader can have its own group.
 */
const recordedSurvivors = (
  record: RecordedProcess,
  currentProcesses: readonly ProcessIdentity[],
): readonly ProcessIdentity[] => {
  const startedAt = Date.parse(record.startedAt);
  if (!Number.isFinite(startedAt) || startedAt < hostBootedAt()) {
    return [];
  }
  const { pid, processGroupId, startIdentifier } = record.identity;
  const leader = currentProcesses.find((candidate) => candidate.pid === pid);
  if (leader !== undefined && leader.startIdentifier !== startIdentifier) {
    return [];
  }
  const claimed = new Map<number, ProcessIdentity>();
  for (const candidate of currentProcesses) {
    if (candidate.processGroupId === processGroupId) {
      claimed.set(candidate.pid, candidate);
    }
  }
  if (leader !== undefined) {
    claimed.set(leader.pid, leader);
    for (const descendant of descendantProcesses(pid, currentProcesses)) {
      claimed.set(descendant.pid, descendant);
    }
  }
  claimed.delete(process.pid);
  return [...claimed.values()];
};

/**
 * Terminates the processes recorded attempts left behind, escalating once for all of them so a run
 * with several recorded attempts waits one grace period rather than one per attempt. Returns the
 * number of processes signalled.
 */
export const terminateRecordedProcesses = async (
  records: readonly RecordedProcess[],
  graceMs = defaultTerminationGraceMs,
): Promise<number> => {
  if (records.length === 0) {
    return 0;
  }
  const currentProcesses = listProcessIdentities();
  if (currentProcesses === undefined) {
    return 0;
  }
  const survivors = new Map<number, ProcessIdentity>();
  for (const record of records) {
    for (const survivor of recordedSurvivors(record, currentProcesses)) {
      survivors.set(survivor.pid, survivor);
    }
  }
  if (survivors.size === 0) {
    return 0;
  }
  signalProcesses(survivors.values(), "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  signalProcesses(matchingProcesses(survivors.values(), listProcessIdentities()) ?? [], "SIGKILL");
  return survivors.size;
};

const signalProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): boolean => {
  if (child.pid === undefined) {
    child.kill(signal);
    return false;
  }
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill(signal);
    }
    return false;
  }
};

const waitForExit = (child: ChildProcess): Promise<ProcessExit> =>
  new Promise((resolveExit) => {
    let settled = false;
    const settle = (exit: ProcessExit): void => {
      if (!settled) {
        settled = true;
        resolveExit(exit);
      }
    };
    child.once("error", () => {
      settle({ exitCode: null, signal: null, spawnFailed: true });
    });
    child.once("exit", (exitCode, signal) => {
      settle({ exitCode, signal, spawnFailed: false });
    });
  });

const outcomeFor = (
  status: ProcessRunOutcome["status"],
  completed: CompletedProcess,
): ProcessRunOutcome => {
  if (status === "succeeded") {
    return {
      status,
      completed: completed as CompletedProcessWithExitCode,
    };
  }
  return { status, completed };
};

export const cleanupRuntimeResult = async (path: string): Promise<void> => {
  try {
    await rm(path, { force: true });
  } catch {
    throw new KilinError(
      "NODE_CAPTURE_FAILED",
      "Kilin could not clean up temporary runtime output. Check the data directory permissions and retry the run.",
    );
  }
};

export const materializeRuntimeResult = async (
  completed: CompletedProcess,
  finalMessage: string,
  maxOutputBytes: number,
): Promise<void> => {
  const finalMessageBytes = Buffer.byteLength(finalMessage, "utf8");
  if (completed.outputBytes + finalMessageBytes > maxOutputBytes) {
    throw new KilinError(
      "NODE_OUTPUT_LIMIT",
      "The runtime result exceeded the combined output limit. Inspect the bounded node logs or choose a larger limit for a new run.",
    );
  }

  await materializePrivateFile(
    completed.resultPath,
    finalMessage,
    new KilinError(
      "NODE_CAPTURE_FAILED",
      "Kilin could not make the runtime result durable. Check the data directory permissions and retry the run.",
    ),
  );
};

export const publishPrivateFile = async (
  targetPath: string,
  contents: string | Uint8Array,
): Promise<void> => {
  const targetDirectory = dirname(targetPath);
  const temporaryPath = join(targetDirectory, `.${basename(targetPath)}-${randomUUID()}.tmp`);
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(contents, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, targetPath);
    const directoryHandle = await open(targetDirectory, "r");
    await syncAndCloseHandle(directoryHandle);
  } catch (error) {
    await Promise.allSettled([closeHandle(temporaryHandle), rm(temporaryPath, { force: true })]);
    throw error;
  }
};

const materializePrivateFile = async (
  targetPath: string,
  contents: string | Uint8Array,
  failure: KilinError,
): Promise<void> => {
  try {
    await publishPrivateFile(targetPath, contents);
  } catch {
    throw failure;
  }
};

export const materializeResolvedInputs = async (
  paths: NodeOutputPaths,
  serializedInputs: string,
  maxOutputBytes: number,
): Promise<void> => {
  if (Buffer.byteLength(serializedInputs, "utf8") > maxOutputBytes) {
    throw new KilinError(
      "NODE_INPUT_INVALID",
      "The resolved input envelope exceeded the run output-byte limit. Reduce the bound values or choose a larger limit for a new run.",
    );
  }
  await materializePrivateFile(
    resolvedInputsPath(paths),
    serializedInputs,
    new KilinError(
      "NODE_INPUT_INVALID",
      "Kilin could not make the resolved inputs durable. Check the data directory permissions and retry the run.",
    ),
  );
};

const outcomeWithCleanup = async (
  status: Exclude<ProcessRunOutcome["status"], "succeeded">,
  completed: CompletedProcess,
): Promise<ProcessRunOutcome> => {
  try {
    await cleanupRuntimeResult(completed.runtimeResultPath);
    return outcomeFor(status, completed);
  } catch {
    return outcomeFor("capture_failed", completed);
  }
};

export const runProcess = async (
  invocation: RuntimeInvocation,
  paths: NodeOutputPaths,
  options: ProcessRunOptions,
): Promise<ProcessRunOutcome> => {
  const startedAt = Date.now();
  const cancellationRequested = (): boolean => options.signal?.aborted ?? false;
  let stdoutHandle: FileHandle | undefined;
  let stderrHandle: FileHandle | undefined;
  try {
    stdoutHandle = await open(paths.stdoutPath, "r+");
    stderrHandle = await open(paths.stderrPath, "r+");
    await stat(paths.resultPath);
    await stat(runtimeResultStagingPath(paths));
  } catch {
    await Promise.allSettled([closeHandle(stdoutHandle), closeHandle(stderrHandle)]);
    return outcomeWithCleanup(
      "capture_failed",
      await completedProcess({ exitCode: null, signal: null }, startedAt, paths),
    );
  }

  if (cancellationRequested()) {
    await Promise.allSettled([syncAndCloseHandle(stdoutHandle), syncAndCloseHandle(stderrHandle)]);
    return outcomeWithCleanup(
      "cancelled",
      await completedProcess({ exitCode: null, signal: null }, startedAt, paths),
    );
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    await Promise.allSettled([syncAndCloseHandle(stdoutHandle), syncAndCloseHandle(stderrHandle)]);
    return outcomeWithCleanup(
      "capture_failed",
      await completedProcess({ exitCode: null, signal: null }, startedAt, paths),
    );
  }

  const exitPromise = waitForExit(child);
  // Read the leader's identity while it is certain to exist rather than waiting for a termination
  // snapshot, which can arrive after the leader has already gone.
  let leaderIdentity = child.pid === undefined ? undefined : processIdentity(child.pid);
  if (leaderIdentity !== undefined) {
    options.onProcessStarted?.({
      pid: leaderIdentity.pid,
      processGroupId: leaderIdentity.processGroupId,
      startIdentifier: leaderIdentity.startIdentifier,
    });
  }

  let terminationStatus: TerminationStatus | undefined;
  let terminationPromise: Promise<void> | undefined;
  let escalationTimer: NodeJS.Timeout | undefined;
  let resolveTermination: (() => void) | undefined;
  let processGroupConfirmedAbsent = false;
  let processGroupSnapshotCaptured = false;
  const ownedProcesses = new Map<number, ProcessIdentity>();
  const retainProcesses = (processes: Iterable<ProcessIdentity>): void => {
    for (const processIdentity of processes) {
      ownedProcesses.set(processIdentity.pid, processIdentity);
    }
  };
  const retainOriginalProcessGroup = (
    currentProcesses: readonly ProcessIdentity[],
  ): readonly ProcessIdentity[] => {
    if (child.pid === undefined) {
      return [];
    }
    const groupMembers = currentProcesses.filter(
      (processIdentity) => processIdentity.processGroupId === child.pid,
    );
    retainProcesses(groupMembers);
    return groupMembers;
  };
  const signalOriginalProcessGroup = (
    signal: NodeJS.Signals,
    currentProcesses: readonly ProcessIdentity[] | undefined,
  ): boolean => {
    const childIsActive = child.exitCode === null && child.signalCode === null;
    if (leaderIdentity === undefined && childIsActive) {
      leaderIdentity = currentProcesses?.find(
        (processIdentity) => processIdentity.pid === child.pid,
      );
    }
    const leaderMatches =
      leaderIdentity !== undefined &&
      matchingProcesses([leaderIdentity], currentProcesses)?.length === 1;
    const processSnapshotUnavailable = currentProcesses === undefined && childIsActive;
    if (leaderMatches || processSnapshotUnavailable) {
      return signalProcessGroup(child, signal);
    }
    return false;
  };
  const signalOwnedProcessTree = (
    signal: NodeJS.Signals,
    currentProcesses: readonly ProcessIdentity[] | undefined,
  ): void => {
    const originalProcessGroupSignaled = signalOriginalProcessGroup(signal, currentProcesses);
    const currentOwnedProcesses =
      matchingProcesses(ownedProcesses.values(), currentProcesses) ?? [];
    signalProcesses(
      originalProcessGroupSignaled
        ? currentOwnedProcesses.filter(
            (processIdentity) => processIdentity.processGroupId !== child.pid,
          )
        : currentOwnedProcesses,
      signal,
    );
  };
  let tearDownCapture = (): void => undefined;
  const finishTermination = (escalate: boolean): void => {
    if (resolveTermination === undefined) {
      return;
    }
    if (escalationTimer !== undefined) {
      clearTimeout(escalationTimer);
      escalationTimer = undefined;
    }
    if (escalate) {
      const currentProcesses = listProcessIdentities();
      if (currentProcesses !== undefined) {
        retainOriginalProcessGroup(currentProcesses);
      }
      if (!processGroupConfirmedAbsent) {
        signalOwnedProcessTree("SIGKILL", currentProcesses);
      } else {
        signalProcesses(
          matchingProcesses(ownedProcesses.values(), currentProcesses) ?? [],
          "SIGKILL",
        );
      }
      tearDownCapture();
    }
    resolveTermination();
    resolveTermination = undefined;
  };
  const terminate = (status: TerminationStatus): void => {
    if (terminationStatus !== undefined) {
      return;
    }
    terminationStatus = status;
    const currentProcesses = listProcessIdentities();
    if (currentProcesses !== undefined) {
      retainProcesses(descendantProcesses(child.pid, currentProcesses));
      retainOriginalProcessGroup(currentProcesses);
    }
    signalOwnedProcessTree("SIGTERM", currentProcesses);
    terminationPromise = new Promise((resolve) => {
      resolveTermination = resolve;
      escalationTimer = setTimeout(
        () => finishTermination(true),
        options.terminationGraceMs ?? defaultTerminationGraceMs,
      );
    });
  };

  let streamBytes = 0;
  let resultBytes = 0;
  const createCaptureTransform = (): Transform =>
    new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        const remaining = Math.max(0, options.maxOutputBytes - streamBytes - resultBytes);
        const retainedBytes = Math.min(chunk.byteLength, remaining);
        streamBytes += retainedBytes;
        if (retainedBytes > 0) {
          this.push(chunk.subarray(0, retainedBytes));
        }
        if (retainedBytes < chunk.byteLength) {
          terminate("output_limit");
        }
        callback();
      },
    });

  const stdoutStream = createWriteStream(paths.stdoutPath, {
    fd: stdoutHandle.fd,
    autoClose: false,
    start: 0,
  });
  const stderrStream = createWriteStream(paths.stderrPath, {
    fd: stderrHandle.fd,
    autoClose: false,
    start: 0,
  });
  tearDownCapture = (): void => {
    child.stdout.destroy();
    child.stderr.destroy();
    stdoutStream.destroy();
    stderrStream.destroy();
  };
  const markCaptureFailure = (): void => terminate("capture_failed");
  const stdoutCapture = pipeline(child.stdout, createCaptureTransform(), stdoutStream).catch(
    markCaptureFailure,
  );
  const stderrCapture = pipeline(child.stderr, createCaptureTransform(), stderrStream).catch(
    markCaptureFailure,
  );

  const inspectResult = async (): Promise<void> => {
    try {
      const size = (await stat(runtimeResultStagingPath(paths))).size;
      const allowedResultBytes = Math.max(0, options.maxOutputBytes - streamBytes);
      if (size > allowedResultBytes) {
        await truncate(runtimeResultStagingPath(paths), allowedResultBytes);
        resultBytes = allowedResultBytes;
        terminate("output_limit");
      } else {
        resultBytes = size;
      }
    } catch {
      terminate("capture_failed");
    }
  };
  await inspectResult();
  let resultInspection = Promise.resolve();
  const resultMonitor = setInterval(() => {
    resultInspection = resultInspection.then(inspectResult);
  }, resultPollIntervalMs);

  const timeout = setTimeout(() => terminate("timed_out"), options.timeoutMs);
  const abort = (): void => terminate("cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (cancellationRequested()) {
    abort();
  }
  child.stdin.once("error", markCaptureFailure);
  child.stdin.end(invocation.stdin);

  const exit = await exitPromise;
  const exitedProcessGroup = listProcessIdentities();
  if (exitedProcessGroup !== undefined && child.pid !== undefined) {
    processGroupSnapshotCaptured = true;
    const retainedGroupMembers = retainOriginalProcessGroup(exitedProcessGroup);
    processGroupConfirmedAbsent = retainedGroupMembers.length === 0;
  }
  await Promise.all([stdoutCapture, stderrCapture]);
  clearInterval(resultMonitor);
  await resultInspection;
  await inspectResult();
  options.signal?.removeEventListener("abort", abort);

  try {
    await Promise.all([syncAndCloseHandle(stdoutHandle), syncAndCloseHandle(stderrHandle)]);
    const resultHandle = await open(runtimeResultStagingPath(paths), "r+");
    await syncAndCloseHandle(resultHandle);
  } catch {
    terminationStatus ??= "capture_failed";
  }

  clearTimeout(timeout);
  if (terminationPromise !== undefined) {
    const matchingOwnedProcesses = matchingProcesses(
      ownedProcesses.values(),
      listProcessIdentities(),
    );
    if (processGroupSnapshotCaptured && matchingOwnedProcesses?.length === 0) {
      processGroupConfirmedAbsent = true;
      finishTermination(false);
    }
    await terminationPromise;
  }

  const completed = await completedProcess(exit, startedAt, paths);
  if (exit.spawnFailed) {
    return outcomeWithCleanup("capture_failed", completed);
  }
  if (terminationStatus !== undefined) {
    return outcomeWithCleanup(terminationStatus, completed);
  }
  if (exit.exitCode === 0 && exit.signal === null) {
    return outcomeFor("succeeded", completed);
  }
  return outcomeWithCleanup("exited", completed);
};
