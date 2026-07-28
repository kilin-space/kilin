#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const calculateDigests = (tarball) => ({
  integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
  shasum: createHash("sha1").update(tarball).digest("hex"),
});

export const formatPublicationStateOutput = (state) => `state=${state}\n`;

const readRegistryDigests = async (response, registryUrl) => {
  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new Error(`npm registry returned invalid JSON for ${registryUrl}.`, { cause: error });
  }

  if (
    !isRecord(metadata) ||
    !isRecord(metadata.dist) ||
    typeof metadata.dist.shasum !== "string" ||
    typeof metadata.dist.integrity !== "string"
  ) {
    throw new Error(`npm registry returned incomplete package digests for ${registryUrl}.`);
  }

  return {
    integrity: metadata.dist.integrity,
    shasum: metadata.dist.shasum,
  };
};

export const checkPackagePublication = async ({
  fetchPackageVersion = fetch,
  packageName,
  tarballPath,
  version,
}) => {
  const encodedPackageName = encodeURIComponent(packageName);
  const registryUrl = `https://registry.npmjs.org/${encodedPackageName}/${version}`;
  const response = await fetchPackageVersion(registryUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (response.status === 404) {
    return { packageName, state: "unpublished", version };
  }
  if (response.status !== 200) {
    throw new Error(`npm registry returned ${String(response.status)} for ${registryUrl}.`);
  }

  const [registryDigests, tarball] = await Promise.all([
    readRegistryDigests(response, registryUrl),
    readFile(tarballPath),
  ]);
  const localDigests = calculateDigests(tarball);

  if (
    registryDigests.shasum !== localDigests.shasum ||
    registryDigests.integrity !== localDigests.integrity
  ) {
    throw new Error(
      `${packageName}@${version} is already published with a different package artifact.`,
    );
  }

  return { packageName, state: "published", version };
};

const run = async () => {
  const tarballArgument = process.argv[2];
  if (tarballArgument === undefined) {
    throw new Error("Usage: node scripts/check-cli-publication.mjs <package-tarball>");
  }

  const packageManifest = JSON.parse(
    await readFile(join(workspaceRoot, "packages", "cli", "package.json"), "utf8"),
  );
  if (
    !isRecord(packageManifest) ||
    typeof packageManifest.name !== "string" ||
    typeof packageManifest.version !== "string"
  ) {
    throw new Error("packages/cli/package.json must contain string name and version fields.");
  }

  const result = await checkPackagePublication({
    packageName: packageManifest.name,
    tarballPath: resolve(tarballArgument),
    version: packageManifest.version,
  });

  if (result.state === "published") {
    process.stderr.write(
      `${result.packageName}@${result.version} is already published with the same package artifact; publication will be skipped.\n`,
    );
  } else {
    process.stderr.write(
      `${result.packageName}@${result.version} is not present in the npm registry.\n`,
    );
  }
  process.stdout.write(formatPublicationStateOutput(result.state));
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
