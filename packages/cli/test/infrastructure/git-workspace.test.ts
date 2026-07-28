import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  isGitRepository,
  provisionGitWorktree,
  qualifyGitWorktreeSource,
  type ProvisionedGitWorktree,
} from "../../src/infrastructure/git-workspace.js";
import { pathExists } from "../helpers/filesystem.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const createDirectory = async (): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "kilin-git-workspace-")));
  temporaryDirectories.push(directory);
  return directory;
};

const git = async (cwd: string, ...arguments_: string[]): Promise<string> => {
  const result = await execFileAsync("git", arguments_, {
    cwd,
    encoding: "utf8",
  });
  return result.stdout.trim();
};

const createRepository = async (): Promise<{
  readonly baseCommit: string;
  readonly project: string;
  readonly root: string;
}> => {
  const root = await createDirectory();
  const project = join(root, "project");
  await mkdir(project);
  await git(project, "init", "--initial-branch=main");
  await writeFile(join(project, "tracked.txt"), "base\n");
  await git(project, "add", "tracked.txt");
  await git(
    project,
    "-c",
    "user.name=Kilin Test",
    "-c",
    "user.email=kilin@example.invalid",
    "commit",
    "-m",
    "base",
  );
  return {
    baseCommit: await git(project, "rev-parse", "HEAD"),
    project: await realpath(project),
    root,
  };
};

const provision = async (
  project: string,
  root: string,
  runId = "run-1",
  workspaceId = "candidate",
): Promise<ProvisionedGitWorktree> => {
  const qualification = await qualifyGitWorktreeSource(project);
  return provisionGitWorktree({
    qualification,
    dataDirectory: join(root, "state"),
    runId,
    workspaceId,
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("Git workspace detection", () => {
  it("recognizes a repository root and its nested directories", async () => {
    const { project } = await createRepository();
    const nested = join(project, "packages", "app");
    await mkdir(nested, { recursive: true });

    await expect(isGitRepository(project)).resolves.toBe(true);
    await expect(isGitRepository(nested)).resolves.toBe(true);
  });

  it("recognizes a linked worktree through its .git file", async () => {
    const { project, root } = await createRepository();
    const worktree = join(root, "linked-worktree");
    await git(project, "worktree", "add", "--detach", worktree);

    await expect(isGitRepository(worktree)).resolves.toBe(true);
  });

  it.each(["directory", "file"] as const)("rejects an invalid .git %s marker", async (marker) => {
    const root = await createDirectory();
    const project = join(root, "project");
    await mkdir(project);
    if (marker === "directory") {
      await mkdir(join(project, ".git"));
    } else {
      await writeFile(join(project, ".git"), "gitdir: /nonexistent/worktrees/project\n");
    }

    await expect(isGitRepository(project)).resolves.toBe(false);
  });

  it("returns false when neither the directory nor an ancestor has a Git marker", async () => {
    const root = await createDirectory();
    const project = join(root, "project");
    await mkdir(project);

    await expect(isGitRepository(project)).resolves.toBe(false);
  });
});

describe("Git worktree qualification", () => {
  it("records a clean repository root and its fixed HEAD commit", async () => {
    const { baseCommit, project } = await createRepository();

    await expect(qualifyGitWorktreeSource(project)).resolves.toMatchObject({
      canonicalWorkingDirectory: project,
      repositoryRoot: project,
      baseCommit,
    });
  });

  it("rejects a directory below the repository root", async () => {
    const { project } = await createRepository();
    const nested = join(project, "nested");
    await mkdir(nested);

    await expect(qualifyGitWorktreeSource(nested)).rejects.toMatchObject({
      code: "WORKING_DIRECTORY_INVALID",
    });
  });

  it("rejects an unborn repository without HEAD", async () => {
    const root = await createDirectory();
    const project = join(root, "project");
    await mkdir(project);
    await git(project, "init", "--initial-branch=main");

    await expect(qualifyGitWorktreeSource(project)).rejects.toMatchObject({
      code: "WORKING_DIRECTORY_INVALID",
    });
  });

  it.each(["tracked", "staged", "untracked"] as const)(
    "rejects a repository with %s changes",
    async (change) => {
      const { project } = await createRepository();
      if (change === "tracked") {
        await writeFile(join(project, "tracked.txt"), "changed\n");
      } else {
        await writeFile(join(project, "new.txt"), "new\n");
        if (change === "staged") {
          await git(project, "add", "new.txt");
        }
      }

      await expect(qualifyGitWorktreeSource(project)).rejects.toMatchObject({
        code: "WORKING_DIRECTORY_INVALID",
      });
    },
  );

  it("rejects a repository with an unfinished Git operation", async () => {
    const { baseCommit, project } = await createRepository();
    await writeFile(join(project, ".git", "MERGE_HEAD"), `${baseCommit}\n`);

    await expect(qualifyGitWorktreeSource(project)).rejects.toMatchObject({
      code: "WORKING_DIRECTORY_INVALID",
    });
  });
});

describe("Git worktree lifecycle", () => {
  it("provisions a detached worktree at the qualified commit under private Kilin storage", async () => {
    const { baseCommit, project, root } = await createRepository();

    const worktree = await provision(project, root);

    expect(worktree.baseCommit).toBe(baseCommit);
    expect(worktree.path).toBe(join(root, "state", "workspaces", "run-1", "candidate"));
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    await expect(readFile(join(worktree.path, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    expect((await stat(join(root, "state", "workspaces"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "state", "workspaces", "run-1"))).mode & 0o777).toBe(0o700);
    await expect(readFile(join(project, "tracked.txt"), "utf8")).resolves.toBe("base\n");
  });

  it("fails closed when source HEAD changes after qualification", async () => {
    const { project, root } = await createRepository();
    const qualification = await qualifyGitWorktreeSource(project);
    await writeFile(join(project, "second.txt"), "second\n");
    await git(project, "add", "second.txt");
    await git(
      project,
      "-c",
      "user.name=Kilin Test",
      "-c",
      "user.email=kilin@example.invalid",
      "commit",
      "-m",
      "second",
    );

    await expect(
      provisionGitWorktree({
        qualification,
        dataDirectory: join(root, "state"),
        runId: "run-1",
        workspaceId: "candidate",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(pathExists(join(root, "state", "workspaces", "run-1", "candidate"))).resolves.toBe(
      false,
    );
  });

  it("rejects traversal identifiers before creating storage", async () => {
    const { project, root } = await createRepository();
    const qualification = await qualifyGitWorktreeSource(project);

    await expect(
      provisionGitWorktree({
        qualification,
        dataDirectory: join(root, "state"),
        runId: "../outside",
        workspaceId: "candidate",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(pathExists(join(root, "state", "outside"))).resolves.toBe(false);
  });

  it("removes a partial worktree registration when checkout fails", async () => {
    const { project, root } = await createRepository();
    await writeFile(join(project, ".gitattributes"), "tracked.txt filter=kilin-failing-filter\n");
    await git(project, "add", ".gitattributes");
    await git(
      project,
      "-c",
      "user.name=Kilin Test",
      "-c",
      "user.email=kilin@example.invalid",
      "commit",
      "-m",
      "require filter",
    );
    await git(project, "config", "filter.kilin-failing-filter.required", "true");
    await git(project, "config", "filter.kilin-failing-filter.clean", "cat");
    await git(project, "config", "filter.kilin-failing-filter.smudge", "false");
    const qualification = await qualifyGitWorktreeSource(project);
    const worktreePath = join(root, "state", "workspaces", "run-1", "candidate");

    await expect(
      provisionGitWorktree({
        qualification,
        dataDirectory: join(root, "state"),
        runId: "run-1",
        workspaceId: "candidate",
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    await expect(pathExists(worktreePath)).resolves.toBe(false);
    expect(await git(project, "worktree", "list", "--porcelain")).not.toContain(worktreePath);
  });
});
