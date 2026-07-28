import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface CommandFailure {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const isCommandFailure = (error: unknown): error is CommandFailure =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "number" &&
  "stdout" in error &&
  typeof error.stdout === "string" &&
  "stderr" in error &&
  typeof error.stderr === "string";

export const inheritedEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const hasErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }

  if (process.platform !== "linux") {
    if (process.platform === "darwin") {
      try {
        const state = execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
          encoding: "utf8",
        }).trim();
        return !state.startsWith("Z");
      } catch {
        return false;
      }
    }
    return true;
  }

  try {
    const processStat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const state = processStat[processStat.lastIndexOf(") ") + 2];
    return state !== "Z" && state !== "X" && state !== "x";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
};

export const killProcessIfRunning = (pid: number): void => {
  if (!processIsRunning(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!hasErrorCode(error, "ESRCH")) {
      throw error;
    }
  }
};
