import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceLock } from "../../src/infrastructure/workspace-lock.js";
import {
  acquireCanonicalWorkspaceLock,
  acquireWorkspaceLock,
  resolveWorkingDirectory,
} from "../../src/infrastructure/workspace-lock.js";

const temporaryDirectories: string[] = [];
const heldLocks: WorkspaceLock[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-workspace-lock-"));
  temporaryDirectories.push(directory);
  return directory;
};

const runCanonicalLockAttempt = async (
  workingDirectory: string,
  dataDirectory: string,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> => {
  const moduleUrl = pathToFileURL(resolve("src/infrastructure/workspace-lock.ts")).href;
  const script = `
    import { acquireCanonicalWorkspaceLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lock = await acquireCanonicalWorkspaceLock(
        ${JSON.stringify(workingDirectory)},
        ${JSON.stringify(dataDirectory)},
      );
      await lock.release();
      process.stdout.write("ACQUIRED");
    } catch (error) {
      process.stdout.write(error?.code ?? "UNKNOWN_ERROR");
    }
  `;
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end();

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

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { exitCode, stderr, stdout };
};

afterEach(async () => {
  await Promise.all(heldLocks.splice(0).map(async (lock) => lock.release()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("working directory resolution", () => {
  it("returns the canonical absolute path for a symlinked directory", async () => {
    const root = await createTemporaryDirectory();
    const directory = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    await mkdir(directory);
    await symlink(directory, alias, "dir");

    await expect(resolveWorkingDirectory(alias)).resolves.toBe(await realpath(directory));
  });

  it.each(["missing path", "regular file"])(
    "maps a %s to WORKING_DIRECTORY_INVALID",
    async (fixture) => {
      const root = await createTemporaryDirectory();
      const path = join(root, fixture === "regular file" ? "file" : "missing");
      if (fixture === "regular file") {
        await writeFile(path, "not a directory");
      }

      await expect(resolveWorkingDirectory(path)).rejects.toMatchObject({
        code: "WORKING_DIRECTORY_INVALID",
      });
    },
  );
});

describe("workspace locking", () => {
  it("creates private lock storage keyed by the canonical cwd", async () => {
    const root = await createTemporaryDirectory();
    const workingDirectory = join(root, "workspace");
    const dataDirectory = join(root, "state");
    await mkdir(workingDirectory);

    const lock = await acquireWorkspaceLock(workingDirectory, dataDirectory);
    heldLocks.push(lock);

    const canonicalWorkingDirectory = await realpath(workingDirectory);
    const expectedHash = createHash("sha256")
      .update(canonicalWorkingDirectory, "utf8")
      .digest("hex");
    expect(lock).toMatchObject({
      canonicalWorkingDirectory,
      lockFile: join(dataDirectory, "locks", `${expectedHash}.lock`),
    });
    await expect(stat(join(dataDirectory, "locks"))).resolves.toMatchObject({ mode: 0o40700 });
    await expect(stat(lock.lockFile)).resolves.toMatchObject({ mode: 0o100600 });
  });

  it("uses the exact same lock identity for resolved and canonical acquisition", async () => {
    const root = await createTemporaryDirectory();
    const workingDirectory = join(root, "workspace");
    const workingDirectoryAlias = join(root, "workspace-alias");
    const dataDirectory = join(root, "state");
    await mkdir(workingDirectory);
    await symlink(workingDirectory, workingDirectoryAlias, "dir");
    const canonicalWorkingDirectory = await realpath(workingDirectory);

    const resolvedLock = await acquireWorkspaceLock(workingDirectoryAlias, dataDirectory);
    const resolvedLockFile = resolvedLock.lockFile;
    await resolvedLock.release();

    const canonicalLock = await acquireCanonicalWorkspaceLock(
      canonicalWorkingDirectory,
      dataDirectory,
    );
    heldLocks.push(canonicalLock);

    expect(canonicalLock.canonicalWorkingDirectory).toBe(canonicalWorkingDirectory);
    expect(canonicalLock.lockFile).toBe(resolvedLockFile);
  });

  it("acquires the canonical cwd lock after the directory is deleted", async () => {
    const root = await createTemporaryDirectory();
    const workingDirectory = join(root, "workspace");
    const dataDirectory = join(root, "state");
    await mkdir(workingDirectory);
    const canonicalWorkingDirectory = await realpath(workingDirectory);
    await rm(workingDirectory, { recursive: true });

    const lock = await acquireCanonicalWorkspaceLock(canonicalWorkingDirectory, dataDirectory);
    heldLocks.push(lock);

    expect(lock.canonicalWorkingDirectory).toBe(canonicalWorkingDirectory);
  });

  it.each(["", "relative/workspace"])(
    "rejects invalid canonical cwd input %j",
    async (canonicalWorkingDirectory) => {
      const root = await createTemporaryDirectory();

      await expect(
        acquireCanonicalWorkspaceLock(canonicalWorkingDirectory, join(root, "state")),
      ).rejects.toMatchObject({ code: "WORKING_DIRECTORY_INVALID" });
    },
  );

  it("rejects cross-process canonical lock contention until release", async () => {
    const root = await createTemporaryDirectory();
    const workingDirectory = join(root, "workspace");
    const dataDirectory = join(root, "state");
    await mkdir(workingDirectory);
    const canonicalWorkingDirectory = await realpath(workingDirectory);

    const lock = await acquireCanonicalWorkspaceLock(canonicalWorkingDirectory, dataDirectory);
    heldLocks.push(lock);

    await expect(
      runCanonicalLockAttempt(canonicalWorkingDirectory, dataDirectory),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "WORKSPACE_BUSY" });

    await lock.release();
    await lock.release();
    heldLocks.splice(heldLocks.indexOf(lock), 1);

    await expect(
      runCanonicalLockAttempt(canonicalWorkingDirectory, dataDirectory),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "ACQUIRED" });
  });

  it("locks distinct canonical working directories independently", async () => {
    const root = await createTemporaryDirectory();
    const firstDirectory = join(root, "first");
    const secondDirectory = join(root, "second");
    const dataDirectory = join(root, "state");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);

    const firstLock = await acquireWorkspaceLock(firstDirectory, dataDirectory);
    const secondLock = await acquireWorkspaceLock(secondDirectory, dataDirectory);
    heldLocks.push(firstLock, secondLock);

    expect(firstLock.lockFile).not.toBe(secondLock.lockFile);
  });
});
