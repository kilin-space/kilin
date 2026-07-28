#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  assertArtifactUnchanged,
  createPackageArtifact,
  installAndVerifyPackageArtifact,
} from "./package-artifact.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "kilin-pack-check-"));

try {
  const packDirectory = join(temporaryRoot, "pack");
  await mkdir(packDirectory);
  const artifact = await createPackageArtifact(join(packDirectory, "kilin-space-cli.tgz"));
  const installed = await installAndVerifyPackageArtifact(artifact, temporaryRoot);
  await assertArtifactUnchanged(artifact);
  process.stdout.write(
    `${JSON.stringify({
      filename: artifact.filename,
      sha256: artifact.sha256,
      files: artifact.files.length,
      packageVersion: installed.packageVersion,
      checks: installed.checks,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
