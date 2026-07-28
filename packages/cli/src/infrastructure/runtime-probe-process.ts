import { spawn } from "node:child_process";

import type { RuntimeProbeContext } from "../application/runtime.js";

export interface RuntimeProbeProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure?: "timeout" | "output_limit" | "cancelled";
}

const probeTimeoutMs = 5_000;
const probeTerminationGraceMs = 250;
const probeOutputLimitBytes = 64 * 1_024;

export const cancelledProbeError = (message: string): DOMException =>
  new DOMException(message, "AbortError");

export const throwIfProbeCancelled = (context: RuntimeProbeContext, message: string): void => {
  if (context.signal?.aborted === true) {
    throw cancelledProbeError(message);
  }
};

export const runRuntimeProbeProcess = (
  executable: string,
  args: readonly string[],
  context: RuntimeProbeContext,
): Promise<RuntimeProbeProcessResult> =>
  new Promise((resolve, reject) => {
    const cancellationRequested = (): boolean => context.signal?.aborted ?? false;
    if (cancellationRequested()) {
      reject(cancelledProbeError("Runtime probe was cancelled before the process started."));
      return;
    }
    const child = spawn(executable, args, {
      cwd: context.canonicalCwd,
      env: context.env,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: RuntimeProbeProcessResult["failure"];
    let settled = false;
    let processClosed = false;
    let closedExitCode: number | null = null;
    let terminationTimeout: NodeJS.Timeout | undefined;
    const clearTimers = (): void => {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
      if (terminationTimeout !== undefined) {
        clearTimeout(terminationTimeout);
      }
    };
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(failure === undefined ? {} : { failure }),
      });
    };
    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const terminate = (reason: NonNullable<RuntimeProbeProcessResult["failure"]>): void => {
      if (failure === undefined) {
        failure = reason;
        signalProcessGroup("SIGTERM");
        terminationTimeout = setTimeout(() => {
          signalProcessGroup("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(processClosed ? closedExitCode : null);
        }, probeTerminationGraceMs);
      }
    };
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > probeOutputLimitBytes) {
        terminate("output_limit");
        return;
      }
      destination.push(chunk);
    };
    const timeout = setTimeout(
      () => terminate("timeout"),
      probeTimeoutMs - probeTerminationGraceMs,
    );
    const abort = (): void => terminate("cancelled");

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", (exitCode) => {
      processClosed = true;
      closedExitCode = exitCode;
      if (failure === undefined) {
        finish(exitCode);
      }
    });
    context.signal?.addEventListener("abort", abort, { once: true });
    if (cancellationRequested()) {
      abort();
    }
  });
