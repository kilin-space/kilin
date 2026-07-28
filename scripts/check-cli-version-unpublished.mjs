#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageManifest = JSON.parse(
  await readFile(join(workspaceRoot, "packages", "cli", "package.json"), "utf8"),
);
const encodedPackageName = encodeURIComponent(packageManifest.name);
const registryUrl = `https://registry.npmjs.org/${encodedPackageName}/${packageManifest.version}`;
const response = await fetch(registryUrl, {
  headers: {
    accept: "application/json",
  },
});

if (response.status === 200) {
  throw new Error(`${packageManifest.name}@${packageManifest.version} is already published.`);
}
if (response.status !== 404) {
  throw new Error(`npm registry returned ${String(response.status)} for ${registryUrl}.`);
}

process.stdout.write(
  `${packageManifest.name}@${packageManifest.version} is not present in the npm registry.\n`,
);
