import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { tryLock, unlock } from "fs-native-extensions";

import { KilinError } from "../domain/errors.js";

const directoryMode = 0o700;
const fileMode = 0o600;

export interface WorkspaceLock {
  readonly canonicalWorkingDirectory: string;
  readonly lockFile: string;
  release(): Promise<void>;
}

export const resolveWorkingDirectory = async (workingDirectory: string): Promise<string> => {
  try {
    const canonicalWorkingDirectory = await realpath(workingDirectory);
    const workingDirectoryStat = await stat(canonicalWorkingDirectory);
    if (!workingDirectoryStat.isDirectory()) {
      throw new Error("The resolved path is not a directory");
    }
    return canonicalWorkingDirectory;
  } catch {
    throw new KilinError(
      "WORKING_DIRECTORY_INVALID",
      `Working directory "${workingDirectory}" does not resolve to an existing directory. Check the path and try again.`,
    );
  }
};

const createWorkspaceLock = (
  canonicalWorkingDirectory: string,
  lockFile: string,
  fileHandle: FileHandle,
): WorkspaceLock => {
  let released = false;
  return {
    canonicalWorkingDirectory,
    lockFile,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      try {
        unlock(fileHandle.fd);
      } finally {
        await fileHandle.close();
      }
    },
  };
};

export const acquireCanonicalWorkspaceLock = async (
  canonicalWorkingDirectory: string,
  dataDirectory = join(homedir(), ".kilin"),
): Promise<WorkspaceLock> => {
  if (canonicalWorkingDirectory.length === 0 || !isAbsolute(canonicalWorkingDirectory)) {
    throw new KilinError(
      "WORKING_DIRECTORY_INVALID",
      "Canonical working directory must be a non-empty absolute path. Resolve the working directory and try again.",
    );
  }
  const lockDirectory = join(dataDirectory, "locks");
  const cwdHash = createHash("sha256").update(canonicalWorkingDirectory, "utf8").digest("hex");
  const lockFile = join(lockDirectory, `${cwdHash}.lock`);

  let fileHandle: FileHandle;
  try {
    await mkdir(lockDirectory, { mode: directoryMode, recursive: true });
    await chmod(lockDirectory, directoryMode);
    fileHandle = await open(lockFile, "a+", fileMode);
    try {
      await fileHandle.chmod(fileMode);
    } catch (error: unknown) {
      await fileHandle.close();
      throw error;
    }
  } catch {
    throw new KilinError(
      "INTERNAL_ERROR",
      `Could not prepare workspace lock storage at "${lockDirectory}". Check that the directory is writable and try again.`,
    );
  }

  let acquired: boolean;
  try {
    acquired = tryLock(fileHandle.fd);
  } catch {
    await fileHandle.close();
    throw new KilinError(
      "INTERNAL_ERROR",
      `Could not acquire the workspace lock for "${canonicalWorkingDirectory}". Check the local filesystem and try again.`,
    );
  }
  if (!acquired) {
    await fileHandle.close();
    throw new KilinError(
      "WORKSPACE_BUSY",
      `Working directory "${canonicalWorkingDirectory}" is already in use by another Kilin process. Wait for that run to finish and try again.`,
    );
  }

  return createWorkspaceLock(canonicalWorkingDirectory, lockFile, fileHandle);
};

export const acquireWorkspaceLock = async (
  workingDirectory: string,
  dataDirectory = join(homedir(), ".kilin"),
): Promise<WorkspaceLock> => {
  const canonicalWorkingDirectory = await resolveWorkingDirectory(workingDirectory);
  return acquireCanonicalWorkspaceLock(canonicalWorkingDirectory, dataDirectory);
};
