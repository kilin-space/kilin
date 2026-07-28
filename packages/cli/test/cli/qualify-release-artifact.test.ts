import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { inheritedEnvironment, isCommandFailure } from "../helpers/subprocess.js";

const execFileAsync = promisify(execFile);
const qualifierFile = fileURLToPath(
  new URL("../../scripts/qualify-release-artifact.mjs", import.meta.url),
);
const worktreeRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const temporaryDirectories: string[] = [];

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runQualifier = async (
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<CommandResult> => {
  try {
    const result = await execFileAsync(process.execPath, [qualifierFile, ...arguments_], {
      encoding: "utf8",
      env: environment,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (isCommandFailure(error)) {
      return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
};

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-qualifier-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("release artifact qualifier", () => {
  it.each([
    ["an in-worktree tarball", false],
    ["an external parent symlink that resolves into the worktree", true],
  ] as const)("rejects %s before packaging can start", async (_case, useWorktreeAlias) => {
    const directory = await createTemporaryDirectory();
    const executableDirectory = join(directory, "bin");
    const pnpmLog = join(directory, "pnpm.log");
    await mkdir(executableDirectory);
    await writeFile(
      join(executableDirectory, "git"),
      `#!/bin/sh
if [ "$1" = "status" ]; then
  exit 0
fi
if [ "$1" = "merge-base" ]; then
  printf '%s\\n' '0000000000000000000000000000000000000000'
  exit 0
fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then
  printf '%s\\n' "$KILIN_TEST_WORKTREE"
  exit 0
fi
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' '0000000000000000000000000000000000000000'
  exit 0
fi
exit 97
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(executableDirectory, "pnpm"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$KILIN_TEST_PNPM_LOG"
if [ "$1" = "--version" ]; then
  printf '%s\\n' '11.4.0'
  exit 0
fi
exit 97
`,
      { mode: 0o700 },
    );
    const tarballParent = useWorktreeAlias ? join(directory, "worktree-alias") : worktreeRoot;
    if (useWorktreeAlias) {
      await symlink(worktreeRoot, tarballParent, "dir");
    }
    const tarball = join(tarballParent, `.kilin-qualification-${randomUUID()}.tgz`);
    const result = await runQualifier(
      ["--allow-model-call", "--tarball", tarball, "--evidence", join(directory, "evidence.json")],
      {
        ...inheritedEnvironment(),
        PATH: `${executableDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        KILIN_TEST_PNPM_LOG: pnpmLog,
        KILIN_TEST_WORKTREE: worktreeRoot,
      },
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Tarball output must be outside the Git worktree.\n",
    });
    await expect(readFile(pnpmLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
