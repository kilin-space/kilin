#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import {
  assertArtifactUnchanged,
  calculateSha256,
  createPackageArtifact,
  installAndVerifyPackageArtifact,
  packageRoot,
  runCommand,
} from "./package-artifact.mjs";

const usage =
  "Usage: node scripts/qualify-release-artifact.mjs --allow-model-call --tarball <absolute-output.tgz> --evidence <absolute-output.json>";
const RUNTIME_QUALIFICATION_TIMEOUT_MS = 125 * 60_000;
const EVALUATOR_SCRIPTS = [
  "package-artifact.mjs",
  "qualify-release-artifact.mjs",
  "smoke-real-runtimes.mjs",
];

const parseArguments = (arguments_) => {
  let allowModelCall = false;
  let tarball;
  let evidence;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--allow-model-call") {
      allowModelCall = true;
      continue;
    }
    if (argument === "--tarball" || argument === "--evidence") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error(usage);
      }
      if (argument === "--tarball") {
        tarball = value;
      } else {
        evidence = value;
      }
      index += 1;
      continue;
    }
    throw new Error(usage);
  }
  if (!allowModelCall || tarball === undefined || evidence === undefined) {
    throw new Error(usage);
  }
  if (!isAbsolute(tarball) || !isAbsolute(evidence)) {
    throw new Error("Tarball and evidence paths must be absolute.");
  }
  const resolvedTarball = resolve(tarball);
  const resolvedEvidence = resolve(evidence);
  if (resolvedTarball === resolvedEvidence) {
    throw new Error("Tarball and evidence paths must be distinct.");
  }
  return { tarball: resolvedTarball, evidence: resolvedEvidence };
};

const outputIdentity = async (path) => {
  await mkdir(dirname(path), { recursive: true });
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  assert.ok(
    metadata === undefined || !metadata.isSymbolicLink(),
    `Output path cannot be a symbolic link: ${path}`,
  );
  return {
    path:
      metadata === undefined
        ? join(await realpath(dirname(path)), basename(path))
        : await realpath(path),
    ...(metadata === undefined ? {} : { device: metadata.dev, inode: metadata.ino }),
  };
};

const assertDistinctOutputs = async (tarball, evidence) => {
  const [tarballIdentity, evidenceIdentity] = await Promise.all([
    outputIdentity(tarball),
    outputIdentity(evidence),
  ]);
  assert.notEqual(
    tarballIdentity.path,
    evidenceIdentity.path,
    "Tarball and evidence paths must not alias.",
  );
  assert.ok(
    tarballIdentity.device === undefined ||
      evidenceIdentity.device === undefined ||
      tarballIdentity.device !== evidenceIdentity.device ||
      tarballIdentity.inode !== evidenceIdentity.inode,
    "Tarball and evidence paths must not alias.",
  );
  return tarballIdentity;
};

const parseQualificationOutput = (stdout) => {
  const lines = stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, "Runtime qualification must emit one JSON document.");
  const result = JSON.parse(lines[0]);
  assert.equal(result.qualified, true, "Runtime qualification did not pass.");
  return result;
};

const runtimeFailureMessage = (error) => {
  if (typeof error !== "object" || error === null || !("stdout" in error)) {
    return undefined;
  }
  try {
    const result = JSON.parse(String(error.stdout));
    const failure = Array.isArray(result.scenarios)
      ? result.scenarios.find((scenario) => scenario?.qualified === false)
      : undefined;
    const name = ["preflight", "mixed", "timeout", "cancellation"].includes(failure?.name)
      ? failure.name
      : undefined;
    const check =
      typeof failure?.failedCheck === "string" &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(failure.failedCheck)
        ? failure.failedCheck
        : undefined;
    const code =
      typeof failure?.failureCode === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/u.test(failure.failureCode)
        ? failure.failureCode
        : undefined;
    if (name === undefined || check === undefined) {
      return undefined;
    }
    return `Runtime qualification failed: ${name}/${check}${code === undefined ? "" : ` (${code})`}`;
  } catch {
    return undefined;
  }
};

const assertCleanWorktree = async () => {
  const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: packageRoot,
  });
  assert.equal(status.stdout, "", "Release qualification requires a clean worktree.");
};

const evaluatorHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      EVALUATOR_SCRIPTS.map(async (file) => [
        file,
        await calculateSha256(join(packageRoot, "scripts", file)),
      ]),
    ),
  );

const runQualification = async (options) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "kilin-release-qualification-"));
  try {
    await assertCleanWorktree();
    const tarballIdentity = await assertDistinctOutputs(options.tarball, options.evidence);
    const worktree = await runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: packageRoot,
    });
    const worktreeRoot = await realpath(worktree.stdout.trim());
    const tarballRelativePath = relative(worktreeRoot, tarballIdentity.path);
    assert.ok(
      tarballRelativePath === ".." ||
        tarballRelativePath.startsWith(`..${sep}`) ||
        isAbsolute(tarballRelativePath),
      "Tarball output must be outside the Git worktree.",
    );
    const [baseline, evaluatorCommit, pnpmVersion, npmVersion, evaluatorScripts] =
      await Promise.all([
        runCommand("git", ["merge-base", "HEAD", "origin/main"], { cwd: packageRoot }),
        runCommand("git", ["rev-parse", "HEAD"], { cwd: packageRoot }),
        runCommand("pnpm", ["--version"], { cwd: packageRoot }),
        runCommand("npm", ["--version"], { cwd: packageRoot }),
        evaluatorHashes(),
      ]);
    const artifact = await createPackageArtifact(options.tarball);
    const installed = await installAndVerifyPackageArtifact(artifact, temporaryRoot);
    let runtime;
    try {
      runtime = await runCommand(
        process.execPath,
        [
          join(packageRoot, "scripts", "smoke-real-runtimes.mjs"),
          "--allow-model-call",
          "--cli",
          installed.cliPath,
        ],
        { cwd: packageRoot, timeout: RUNTIME_QUALIFICATION_TIMEOUT_MS },
      );
    } catch (error) {
      throw new Error(runtimeFailureMessage(error) ?? "Runtime qualification command failed.");
    }
    const runtimeEvidence = parseQualificationOutput(runtime.stdout);
    await assertCleanWorktree();
    await assertArtifactUnchanged(artifact);
    assert.deepEqual(
      await evaluatorHashes(),
      evaluatorScripts,
      "Qualification evaluator changed while it was running.",
    );
    const evidence = {
      qualificationVersion: 1,
      qualified: true,
      createdAt: new Date().toISOString(),
      baselineSha: baseline.stdout.trim(),
      evaluator: {
        commitSha: evaluatorCommit.stdout.trim(),
        scripts: evaluatorScripts,
      },
      platform: {
        os: platform(),
        architecture: arch(),
        release: release(),
      },
      tools: {
        node: process.version,
        pnpm: pnpmVersion.stdout.trim(),
        npm: npmVersion.stdout.trim(),
      },
      artifact: {
        package: installed.packageName,
        filename: artifact.filename,
        sha256: artifact.sha256,
        packageVersion: installed.packageVersion,
        packedFileCount: artifact.files.length,
        installMode: "isolated-global-prefix",
      },
      modelSelection: "provider-default",
      commands: {
        pack: ["pnpm", "pack", "--json", "--out", `<artifact-dir>/${artifact.filename}`],
        install: ["npm", "install", "--global", "--prefix", "<isolated-prefix>", artifact.filename],
        runtime: [
          "node",
          "scripts/smoke-real-runtimes.mjs",
          "--allow-model-call",
          "--cli",
          "<installed-kilin>",
        ],
      },
      deterministicChecks: installed.checks,
      runtime: runtimeEvidence,
      knownLimits: [
        "OpenCode authentication is evidenced by successful execution because its adapter has no separate authentication probe.",
        "Process-group qualification targets POSIX hosts.",
        "macOS declines delayed individual process signals after the original process-group leader exits because its process table lacks a stable start identifier.",
      ],
    };
    const evidenceCandidate = join(
      dirname(options.evidence),
      `.${basename(options.evidence)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(evidenceCandidate, `${JSON.stringify(evidence, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await assertArtifactUnchanged(artifact);
      assert.deepEqual(
        await evaluatorHashes(),
        evaluatorScripts,
        "Qualification evaluator changed while it was running.",
      );
      await rename(evidenceCandidate, options.evidence);
    } finally {
      await rm(evidenceCandidate, { force: true });
    }
    process.stdout.write(
      `${JSON.stringify({
        qualified: true,
        tarball: options.tarball,
        evidence: options.evidence,
        sha256: artifact.sha256,
      })}\n`,
    );
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
};

try {
  await runQualification(parseArguments(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
