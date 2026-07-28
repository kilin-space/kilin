import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { checkPackagePublication, formatPublicationStateOutput } from "./check-cli-publication.mjs";

const PACKAGE_NAME = "@kilin-space/cli";
const PACKAGE_VERSION = "0.1.0";
const TARBALL = Buffer.from("verified package artifact");

let temporaryRoot;
let tarballPath;

const registryMetadata = (tarball) => ({
  dist: {
    integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    shasum: createHash("sha1").update(tarball).digest("hex"),
  },
});

const checkPublication = (response) =>
  checkPackagePublication({
    fetchPackageVersion: async () => response,
    packageName: PACKAGE_NAME,
    tarballPath,
    version: PACKAGE_VERSION,
  });

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "kilin-publication-check-"));
  tarballPath = join(temporaryRoot, "kilin-space-cli.tgz");
  await writeFile(tarballPath, TARBALL);
});

afterEach(async () => {
  await rm(temporaryRoot, { force: true, recursive: true });
});

describe("CLI package publication check", () => {
  it("permits publication when the package version is absent", async () => {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await checkPublication(new Response(null, { status: 404 })), {
        packageName: PACKAGE_NAME,
        state: "unpublished",
        version: PACKAGE_VERSION,
      });
    });
  });

  it("skips publication when npm has the same package artifact", async () => {
    const response = Response.json(registryMetadata(TARBALL));

    assert.deepEqual(await checkPublication(response), {
      packageName: PACKAGE_NAME,
      state: "published",
      version: PACKAGE_VERSION,
    });
  });

  it("rejects an existing version with a different package artifact", async () => {
    const response = Response.json(registryMetadata(Buffer.from("different artifact")));

    await assert.rejects(
      checkPublication(response),
      new Error(
        `${PACKAGE_NAME}@${PACKAGE_VERSION} is already published with a different package artifact.`,
      ),
    );
  });

  it("rejects an existing version when only its shasum differs", async () => {
    const metadata = registryMetadata(TARBALL);
    metadata.dist.shasum = "different-shasum";

    await assert.rejects(
      checkPublication(Response.json(metadata)),
      /already published with a different package artifact/u,
    );
  });

  it("rejects an existing version when only its integrity differs", async () => {
    const metadata = registryMetadata(TARBALL);
    metadata.dist.integrity = "sha512-different-integrity";

    await assert.rejects(
      checkPublication(Response.json(metadata)),
      /already published with a different package artifact/u,
    );
  });

  it("rejects incomplete registry digests", async () => {
    await assert.rejects(
      checkPublication(Response.json({ dist: { shasum: "missing-integrity" } })),
      /npm registry returned incomplete package digests/u,
    );
  });

  it("rejects invalid registry JSON", async () => {
    await assert.rejects(
      checkPublication(
        new Response("{", {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
      /npm registry returned invalid JSON/u,
    );
  });

  it("rejects registry failures", async () => {
    await assert.rejects(
      checkPublication(new Response(null, { status: 503 })),
      /npm registry returned 503/u,
    );
  });

  it("bounds a stalled registry request", async () => {
    const fetchPackageVersion = async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });

    await assert.rejects(
      checkPackagePublication({
        fetchPackageVersion,
        packageName: PACKAGE_NAME,
        registryTimeoutMs: 1,
        tarballPath,
        version: PACKAGE_VERSION,
      }),
      /npm registry request failed/u,
    );
  });

  it("formats the exact GitHub output consumed by the workflow", () => {
    assert.equal(formatPublicationStateOutput("published"), "state=published\n");
    assert.equal(formatPublicationStateOutput("unpublished"), "state=unpublished\n");
  });
});
