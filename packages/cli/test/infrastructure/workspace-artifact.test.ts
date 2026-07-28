import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isWorkspaceArtifactValid } from "../../src/infrastructure/workspace-artifact.js";

describe("workspace artifact validation", () => {
  let fixtureDirectory: string;
  let canonicalWorkingDirectory: string;
  let outsideDirectory: string;

  beforeEach(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "kilin-workspace-artifact-"));
    const workingDirectory = join(fixtureDirectory, "workspace");
    outsideDirectory = join(fixtureDirectory, "workspace-outside");
    await mkdir(workingDirectory);
    await mkdir(outsideDirectory);
    canonicalWorkingDirectory = await realpath(workingDirectory);
  });

  afterEach(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  it("accepts regular files and contained ancestor symlinks", async () => {
    const sourcePath = join(canonicalWorkingDirectory, "source.md");
    await writeFile(sourcePath, "artifact", "utf8");
    await mkdir(join(canonicalWorkingDirectory, "stored"));
    await writeFile(join(canonicalWorkingDirectory, "stored", "report.md"), "report", "utf8");
    await symlink("stored", join(canonicalWorkingDirectory, "contained-link"), "dir");

    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "source.md")).resolves.toBe(
      true,
    );
    await expect(
      isWorkspaceArtifactValid(canonicalWorkingDirectory, "contained-link/report.md"),
    ).resolves.toBe(true);
  });

  it("rejects hard links, including links to files inside the workspace", async () => {
    const sourcePath = join(canonicalWorkingDirectory, "source.md");
    await writeFile(sourcePath, "artifact", "utf8");
    await link(sourcePath, join(canonicalWorkingDirectory, "hard-link.md"));
    await writeFile(join(outsideDirectory, "outside.md"), "outside", "utf8");
    await link(join(outsideDirectory, "outside.md"), join(canonicalWorkingDirectory, "alias.md"));

    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "source.md")).resolves.toBe(
      false,
    );
    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "hard-link.md")).resolves.toBe(
      false,
    );
    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "alias.md")).resolves.toBe(
      false,
    );
  });

  it("accepts a replaced regular file when the live path still passes validation", async () => {
    const artifactPath = join(canonicalWorkingDirectory, "report.md");
    await writeFile(artifactPath, "first", "utf8");

    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "report.md")).resolves.toBe(
      true,
    );

    await unlink(artifactPath);
    await writeFile(artifactPath, "replacement", "utf8");

    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, "report.md")).resolves.toBe(
      true,
    );
  });

  it("does not require a regular artifact file to be readable", async () => {
    const artifactPath = join(canonicalWorkingDirectory, "unreadable.md");
    await writeFile(artifactPath, "artifact", "utf8");
    await chmod(artifactPath, 0o000);

    await expect(
      isWorkspaceArtifactValid(canonicalWorkingDirectory, "unreadable.md"),
    ).resolves.toBe(true);

    await chmod(artifactPath, 0o600);
  });

  it.each([
    ["a missing path", "missing.md"],
    ["a directory", "directory"],
    ["a final symbolic link", "final-link.md"],
  ] as const)("rejects %s", async (_name, artifactPath) => {
    await mkdir(join(canonicalWorkingDirectory, "directory"));
    await writeFile(join(canonicalWorkingDirectory, "target.md"), "target", "utf8");
    await symlink("target.md", join(canonicalWorkingDirectory, "final-link.md"));

    await expect(isWorkspaceArtifactValid(canonicalWorkingDirectory, artifactPath)).resolves.toBe(
      false,
    );
  });

  it("rejects lexical traversal and an ancestor symlink that escapes the workspace", async () => {
    await writeFile(join(outsideDirectory, "report.md"), "outside", "utf8");
    await symlink(outsideDirectory, join(canonicalWorkingDirectory, "escape"), "dir");

    await expect(
      isWorkspaceArtifactValid(canonicalWorkingDirectory, "../workspace-outside/report.md"),
    ).resolves.toBe(false);
    await expect(
      isWorkspaceArtifactValid(canonicalWorkingDirectory, "escape/report.md"),
    ).resolves.toBe(false);
  });
});
