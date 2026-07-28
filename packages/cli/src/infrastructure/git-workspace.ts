import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { KilinError } from "../domain/errors.js";

const execFileAsync = promisify(execFile);
const privateDirectoryMode = 0o700;
const gitOutputLimit = 1_048_576;
const gitTimeoutMs = 30_000;
const ownedIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export const isGitObjectId = (value: string): boolean => objectIdPattern.test(value);
const operationMarkers = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

const checkedPathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

interface GitResult {
  readonly stdout: string;
}

const runGit = async (
  workingDirectory: string,
  arguments_: readonly string[],
): Promise<GitResult> => {
  const result = await execFileAsync("git", arguments_, {
    cwd: workingDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    maxBuffer: gitOutputLimit,
    timeout: gitTimeoutMs,
  });
  return { stdout: result.stdout };
};

const qualificationError = (message: string): KilinError =>
  new KilinError(
    "WORKING_DIRECTORY_INVALID",
    `${message} Use a clean Git repository root and try again.`,
  );

const gitOperationError = (message: string): KilinError =>
  new KilinError("INTERNAL_ERROR", `${message} Inspect the repository and try again.`);

const canonicalDirectory = async (directory: string): Promise<string> => {
  try {
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error("Not a directory");
    }
    return canonical;
  } catch {
    throw qualificationError(`Working directory "${directory}" is not an existing directory.`);
  }
};

const gitText = async (
  workingDirectory: string,
  arguments_: readonly string[],
  errorMessage: string,
): Promise<string> => {
  try {
    return (await runGit(workingDirectory, arguments_)).stdout.trim();
  } catch {
    throw qualificationError(errorMessage);
  }
};

const assertOwnedIdentifier = (value: string, subject: string): void => {
  if (!ownedIdentifierPattern.test(value)) {
    throw gitOperationError(
      `${subject} "${value}" is invalid. Use 1 through 128 ASCII letters, digits, dots, underscores, or hyphens, beginning with a letter or digit.`,
    );
  }
};

const assertPrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { mode: privateDirectoryMode });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw gitOperationError(`Kilin worktree storage "${directory}" is not a private directory.`);
  }
  await chmod(directory, privateDirectoryMode);
};

const assertExactCanonicalDirectory = async (
  directory: string,
  expected: string,
  subject: string,
): Promise<void> => {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw gitOperationError(`${subject} "${directory}" is not an owned directory.`);
  }
  const canonical = await realpath(directory);
  if (canonical !== expected) {
    throw gitOperationError(`${subject} "${directory}" resolves outside its owned location.`);
  }
};

const canonicalGitPath = async (
  workingDirectory: string,
  option: "--absolute-git-dir" | "--git-common-dir",
): Promise<string> => {
  const arguments_ =
    option === "--git-common-dir"
      ? ["rev-parse", "--path-format=absolute", option]
      : ["rev-parse", option];
  const path = await gitText(
    workingDirectory,
    arguments_,
    `Git could not resolve ${option === "--git-common-dir" ? "the common repository directory" : "the repository metadata directory"}.`,
  );
  try {
    return await realpath(path);
  } catch {
    throw qualificationError(`Git reported an invalid repository metadata path "${path}".`);
  }
};

export interface GitWorktreeQualification {
  readonly canonicalWorkingDirectory: string;
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly gitCommonDirectory: string;
  readonly baseCommit: string;
}

export interface ProvisionedGitWorktree extends GitWorktreeQualification {
  readonly runId: string;
  readonly workspaceId: string;
  readonly path: string;
}

export interface ProvisionGitWorktreeInput {
  readonly qualification: GitWorktreeQualification;
  readonly dataDirectory: string;
  readonly runId: string;
  readonly workspaceId: string;
}

export const isGitRepository = async (canonicalWorkingDirectory: string): Promise<boolean> => {
  try {
    const { stdout } = await runGit(canonicalWorkingDirectory, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
};

const inspectGitWorktreeSource = async (
  workingDirectory: string,
  requireCleanSource: boolean,
): Promise<GitWorktreeQualification> => {
  const canonicalWorkingDirectory = await canonicalDirectory(workingDirectory);
  const insideWorkTree = await gitText(
    canonicalWorkingDirectory,
    ["rev-parse", "--is-inside-work-tree"],
    `Working directory "${canonicalWorkingDirectory}" is not a Git worktree.`,
  );
  if (insideWorkTree !== "true") {
    throw qualificationError(
      `Working directory "${canonicalWorkingDirectory}" is not a Git worktree.`,
    );
  }

  const reportedRoot = await gitText(
    canonicalWorkingDirectory,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    `Git could not resolve the repository root for "${canonicalWorkingDirectory}".`,
  );
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(reportedRoot);
  } catch {
    throw qualificationError(`Git reported an invalid repository root "${reportedRoot}".`);
  }
  if (canonicalWorkingDirectory !== repositoryRoot) {
    throw qualificationError(
      `Working directory "${canonicalWorkingDirectory}" is not the repository root "${repositoryRoot}".`,
    );
  }

  const bare = await gitText(
    repositoryRoot,
    ["rev-parse", "--is-bare-repository"],
    `Git could not inspect repository "${repositoryRoot}".`,
  );
  if (bare !== "false") {
    throw qualificationError(`Repository "${repositoryRoot}" is bare.`);
  }

  const gitDirectory = await canonicalGitPath(repositoryRoot, "--absolute-git-dir");
  const gitCommonDirectory = await canonicalGitPath(repositoryRoot, "--git-common-dir");
  try {
    for (const marker of operationMarkers) {
      if (await checkedPathExists(join(gitDirectory, marker))) {
        throw qualificationError(
          `Repository "${repositoryRoot}" has an unfinished Git operation (${marker}).`,
        );
      }
    }
  } catch (error: unknown) {
    if (error instanceof KilinError) {
      throw error;
    }
    throw qualificationError(
      `Kilin could not verify whether repository "${repositoryRoot}" has an unfinished Git operation.`,
    );
  }

  const baseCommit = await gitText(
    repositoryRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    `Repository "${repositoryRoot}" does not have a valid HEAD commit.`,
  );
  if (!isGitObjectId(baseCommit)) {
    throw qualificationError(
      `Git returned an invalid HEAD commit for repository "${repositoryRoot}".`,
    );
  }

  if (requireCleanSource) {
    let status: string;
    try {
      status = (
        await runGit(repositoryRoot, [
          "-c",
          "core.fsmonitor=false",
          "status",
          "--porcelain=v2",
          "--untracked-files=all",
          "-z",
        ])
      ).stdout;
    } catch {
      throw qualificationError(`Git could not inspect repository status for "${repositoryRoot}".`);
    }
    if (status.length !== 0) {
      throw qualificationError(
        `Repository "${repositoryRoot}" has staged, tracked, or untracked changes.`,
      );
    }
  }

  return {
    canonicalWorkingDirectory,
    repositoryRoot,
    gitDirectory,
    gitCommonDirectory,
    baseCommit,
  };
};

export const qualifyGitWorktreeSource = async (
  workingDirectory: string,
): Promise<GitWorktreeQualification> => inspectGitWorktreeSource(workingDirectory, true);

const prepareOwnedWorktreePath = async (
  dataDirectory: string,
  runId: string,
  workspaceId: string,
): Promise<{ hooksDirectory: string; path: string }> => {
  assertOwnedIdentifier(runId, "Run ID");
  assertOwnedIdentifier(workspaceId, "Workspace ID");
  if (!isAbsolute(dataDirectory)) {
    throw gitOperationError(`Kilin data directory "${dataDirectory}" is not absolute.`);
  }

  await mkdir(dataDirectory, { mode: privateDirectoryMode, recursive: true });
  const canonicalDataDirectory = await realpath(dataDirectory);
  const workspacesDirectory = join(canonicalDataDirectory, "workspaces");
  if (!(await checkedPathExists(workspacesDirectory))) {
    await assertPrivateDirectory(workspacesDirectory);
  } else {
    await assertExactCanonicalDirectory(
      workspacesDirectory,
      workspacesDirectory,
      "Kilin worktree storage",
    );
    await chmod(workspacesDirectory, privateDirectoryMode);
  }

  const hooksDirectory = join(workspacesDirectory, ".hooks");
  if (!(await checkedPathExists(hooksDirectory))) {
    await assertPrivateDirectory(hooksDirectory);
  } else {
    await assertExactCanonicalDirectory(
      hooksDirectory,
      hooksDirectory,
      "Kilin worktree hook storage",
    );
    await chmod(hooksDirectory, privateDirectoryMode);
  }

  const runDirectory = join(workspacesDirectory, runId);
  if (!(await checkedPathExists(runDirectory))) {
    await assertPrivateDirectory(runDirectory);
  } else {
    await assertExactCanonicalDirectory(runDirectory, runDirectory, "Kilin run worktree storage");
    await chmod(runDirectory, privateDirectoryMode);
  }

  const path = join(runDirectory, workspaceId);
  if (resolve(path) !== path || !path.startsWith(`${runDirectory}${sep}`)) {
    throw gitOperationError(`Worktree path "${path}" is outside its owned run directory.`);
  }
  if (await checkedPathExists(path)) {
    throw gitOperationError(`Kilin worktree path "${path}" already exists.`);
  }

  return {
    hooksDirectory,
    path,
  };
};

const verifyQualificationIsCurrent = async (
  qualification: GitWorktreeQualification,
): Promise<GitWorktreeQualification> => {
  if (!isGitObjectId(qualification.baseCommit)) {
    throw gitOperationError(`Git base commit "${qualification.baseCommit}" is invalid.`);
  }
  const current = await inspectGitWorktreeSource(qualification.canonicalWorkingDirectory, false);
  if (
    current.repositoryRoot !== qualification.repositoryRoot ||
    current.gitDirectory !== qualification.gitDirectory ||
    current.gitCommonDirectory !== qualification.gitCommonDirectory
  ) {
    throw gitOperationError(
      `Repository identity changed after worktree qualification for "${qualification.canonicalWorkingDirectory}".`,
    );
  }
  if (current.baseCommit !== qualification.baseCommit) {
    throw gitOperationError(
      `Repository HEAD changed from "${qualification.baseCommit}" to "${current.baseCommit}" after worktree qualification.`,
    );
  }
  return current;
};

const verifyProvisionedWorktree = async (worktree: ProvisionedGitWorktree): Promise<void> => {
  await assertExactCanonicalDirectory(worktree.path, worktree.path, "Kilin worktree");
  const root = await gitText(
    worktree.path,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    `Git could not inspect Kilin worktree "${worktree.path}".`,
  );
  if ((await realpath(root)) !== worktree.path) {
    throw gitOperationError(`Kilin worktree "${worktree.path}" has an unexpected repository root.`);
  }
  const commonDirectory = await canonicalGitPath(worktree.path, "--git-common-dir");
  if (commonDirectory !== worktree.gitCommonDirectory) {
    throw gitOperationError(
      `Kilin worktree "${worktree.path}" belongs to a different Git repository.`,
    );
  }
  const head = await gitText(
    worktree.path,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    `Git could not inspect HEAD for Kilin worktree "${worktree.path}".`,
  );
  if (head !== worktree.baseCommit) {
    throw gitOperationError(
      `Kilin worktree "${worktree.path}" moved from base commit "${worktree.baseCommit}".`,
    );
  }
};

const rollbackProvisionedWorktree = async (
  repositoryRoot: string,
  worktreePath: string,
): Promise<void> => {
  try {
    await runGit(repositoryRoot, ["worktree", "remove", "--force", "--", worktreePath]);
  } catch {
    // A partial worktree registration may not be removable through the ordinary command.
  }
  try {
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort so the original provisioning failure remains actionable.
  }
  try {
    await runGit(repositoryRoot, ["worktree", "prune"]);
  } catch {
    // Cleanup is best effort so the original provisioning failure remains actionable.
  }
};

export const provisionGitWorktree = async (
  input: ProvisionGitWorktreeInput,
): Promise<ProvisionedGitWorktree> => {
  const qualification = await verifyQualificationIsCurrent(input.qualification);
  const owned = await prepareOwnedWorktreePath(input.dataDirectory, input.runId, input.workspaceId);
  try {
    await runGit(qualification.repositoryRoot, [
      "-c",
      `core.hooksPath=${owned.hooksDirectory}`,
      "worktree",
      "add",
      "--detach",
      "--",
      owned.path,
      qualification.baseCommit,
    ]);
  } catch {
    await rollbackProvisionedWorktree(qualification.repositoryRoot, owned.path);
    throw gitOperationError(
      `Git could not provision Kilin worktree "${owned.path}" at commit "${qualification.baseCommit}".`,
    );
  }

  const provisioned: ProvisionedGitWorktree = {
    ...qualification,
    runId: input.runId,
    workspaceId: input.workspaceId,
    path: owned.path,
  };
  try {
    await verifyProvisionedWorktree(provisioned);
  } catch (error: unknown) {
    await rollbackProvisionedWorktree(qualification.repositoryRoot, owned.path);
    throw error;
  }
  return provisioned;
};
