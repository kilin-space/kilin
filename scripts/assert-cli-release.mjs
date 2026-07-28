#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(
  await readFile(join(workspaceRoot, "packages", "cli", "package.json"), "utf8"),
);
const releaseTag = process.env.RELEASE_TAG;

if (typeof releaseTag !== "string" || releaseTag.length === 0) {
  throw new Error("RELEASE_TAG is required.");
}
if (!/^\d+\.\d+\.\d+$/u.test(packageManifest.version)) {
  throw new Error(`CLI version must be a stable semantic version: ${packageManifest.version}`);
}

const expectedTag = `cli-v${packageManifest.version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match ${expectedTag}.`);
}

const documentationRoot = join(workspaceRoot, "apps", "docs", "content", "docs");
const pinPattern =
  /@kilin-space\/cli@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![0-9A-Za-z.-])/gu;
const stalePins = [];
let pinCount = 0;
for (const entry of await readdir(documentationRoot, { recursive: true })) {
  if (!entry.endsWith(".mdx") && !entry.endsWith(".md")) {
    continue;
  }
  const source = await readFile(join(documentationRoot, entry), "utf8");
  for (const pin of source.matchAll(pinPattern)) {
    pinCount += 1;
    if (pin[1] !== packageManifest.version) {
      stalePins.push(`${entry} pins ${pin[1]}`);
    }
  }
}
if (pinCount === 0) {
  throw new Error(
    `Documentation contains no @kilin-space/cli version pin, so the release cannot be verified.`,
  );
}
if (stalePins.length > 0) {
  throw new Error(
    `Documentation must pin @kilin-space/cli@${packageManifest.version}:\n${stalePins.join("\n")}`,
  );
}

process.stdout.write(
  `Release tag ${releaseTag} matches @kilin-space/cli ${packageManifest.version}, and the documentation pins it.\n`,
);
