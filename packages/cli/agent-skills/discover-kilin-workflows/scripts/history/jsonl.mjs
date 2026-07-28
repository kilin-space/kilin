import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const maximumShardBytes = 5 * 1_024 * 1_024;
export const maximumShardRecords = 10_000;
export const maximumSourceLineBytes = maximumShardBytes;
export const maximumNormalizedRecordBytes = 512 * 1_024;

const fail = (message) => {
  throw new Error(message);
};

const isWithin = (parent, child) => {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !pathFromParent.startsWith(sep))
  );
};

export const requirePrivateDirectory = async (directory, label, { empty = false } = {}) => {
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail(`${label} must be a directory, not a symbolic link: ${directory}`);
  }
  if ((status.mode & 0o077) !== 0) {
    fail(`${label} must use private permissions. Set its mode to 0700 and retry.`);
  }
  if (empty && (await readdir(directory)).length > 0) {
    fail(`${label} must be empty before collection.`);
  }
  return realpath(directory);
};

export const requirePrivateRegularFile = async (file, label, bundleRoot) => {
  const resolved = resolve(file);
  if (bundleRoot !== undefined && !isWithin(bundleRoot, resolved)) {
    fail(`${label} escapes the private history bundle.`);
  }
  const status = await lstat(resolved);
  if (status.isSymbolicLink() || !status.isFile()) {
    fail(`${label} must be a regular file: ${resolved}`);
  }
  if ((status.mode & 0o077) !== 0) {
    fail(`${label} must use private permissions. Set its mode to 0600 and retry.`);
  }
  const physical = await realpath(resolved);
  if (bundleRoot !== undefined && !isWithin(bundleRoot, physical)) {
    fail(`${label} resolves outside the private history bundle.`);
  }
  return physical;
};

const parseJsonLine = (line, lineNumber, label) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    fail(`${label} contains malformed JSON at line ${String(lineNumber)}.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} line ${String(lineNumber)} must be an object.`);
  }
  return value;
};

// Split strictly on \n: readline also breaks on U+2028/U+2029, which are
// legal inside JSON strings and appear in real session content.
export async function* scanJsonLines(
  file,
  { label = "JSON Lines input", maximumLineBytes = maximumSourceLineBytes, onOversizedLine } = {},
) {
  const input = createReadStream(file, { encoding: "utf8" });
  let lineNumber = 0;
  let buffered = "";
  let bufferedBytes = 0;
  let oversized = false;
  const finishLine = () => {
    lineNumber += 1;
    if (oversized) {
      if (onOversizedLine === undefined) {
        fail(
          `${label} line ${String(lineNumber)} exceeds the ${String(maximumLineBytes)} byte limit.`,
        );
      }
      onOversizedLine?.(lineNumber);
    }
    const line = buffered;
    buffered = "";
    bufferedBytes = 0;
    oversized = false;
    return line;
  };
  try {
    for await (const chunk of input) {
      let start = 0;
      let newline = chunk.indexOf("\n", start);
      while (newline >= 0) {
        const segment = chunk.slice(start, newline);
        if (!oversized) {
          const segmentBytes = Buffer.byteLength(segment, "utf8");
          if (bufferedBytes + segmentBytes > maximumLineBytes) {
            buffered = "";
            bufferedBytes = 0;
            oversized = true;
          } else {
            buffered += segment;
            bufferedBytes += segmentBytes;
          }
        }
        const line = finishLine();
        if (line.trim().length > 0) {
          yield { value: parseJsonLine(line, lineNumber, label), lineNumber };
        }
        start = newline + 1;
        newline = chunk.indexOf("\n", start);
      }
      const remainder = chunk.slice(start);
      if (!oversized) {
        const remainderBytes = Buffer.byteLength(remainder, "utf8");
        if (bufferedBytes + remainderBytes > maximumLineBytes) {
          buffered = "";
          bufferedBytes = 0;
          oversized = true;
        } else {
          buffered += remainder;
          bufferedBytes += remainderBytes;
        }
      }
    }
    if (oversized || buffered.trim().length > 0) {
      const line = finishLine();
      if (line.trim().length > 0) {
        yield { value: parseJsonLine(line, lineNumber, label), lineNumber };
      }
    }
  } finally {
    input.destroy();
  }
}

export const filesBelow = async (root, predicate = () => true) => {
  const physicalRoot = await realpath(root);
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && predicate(path)) {
        files.push(path);
      }
    }
  };
  await visit(physicalRoot);
  return files;
};

export class ShardWriter {
  constructor(directory) {
    this.directory = directory;
    this.shards = [];
    this.handle = undefined;
    this.current = undefined;
  }

  async write(record) {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maximumNormalizedRecordBytes) {
      fail("One sanitized history record exceeds the normalized record limit.");
    }
    if (
      this.current !== undefined &&
      (this.current.records >= maximumShardRecords ||
        (this.current.bytes > 0 && this.current.bytes + bytes > maximumShardBytes))
    ) {
      await this.closeCurrent();
    }
    if (this.handle === undefined) {
      await this.openNext();
    }
    await this.handle.write(line);
    this.digest.update(line);
    this.current.records += 1;
    this.current.bytes += bytes;
  }

  async openNext() {
    const file = `records-${String(this.shards.length + 1).padStart(6, "0")}.jsonl`;
    const path = join(this.directory, file);
    this.handle = await open(path, "wx", 0o600);
    this.current = { file, records: 0, bytes: 0 };
    this.digest = createHash("sha256");
  }

  async closeCurrent() {
    if (this.handle === undefined) {
      return;
    }
    await this.handle.sync();
    await this.handle.close();
    this.shards.push({ ...this.current, sha256: this.digest.digest("hex") });
    this.handle = undefined;
    this.current = undefined;
    this.digest = undefined;
  }

  async finish() {
    await this.closeCurrent();
    return this.shards;
  }

  async abort() {
    if (this.handle !== undefined) {
      await this.handle.close().catch(() => undefined);
      this.handle = undefined;
    }
    const candidates = await readdir(this.directory).catch(() => []);
    await Promise.all(
      candidates
        .filter((file) => /^records-\d{6}\.jsonl$/u.test(file) || file === "bundle.json")
        .map((file) => rm(join(this.directory, file), { force: true })),
    );
  }
}

export const writePrivateJson = async (file, value) => {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const sha256File = async (file) => {
  const digest = createHash("sha256");
  const input = createReadStream(file);
  for await (const chunk of input) {
    digest.update(chunk);
  }
  return digest.digest("hex");
};

export const readBundle = async (directory) => {
  const root = await requirePrivateDirectory(resolve(directory), "History bundle");
  const manifestFile = await requirePrivateRegularFile(
    join(root, "bundle.json"),
    "History bundle manifest",
    root,
  );
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.formatVersion !== 1 ||
    manifest.complete !== true ||
    typeof manifest.salt !== "string" ||
    !/^[a-f0-9]{64}$/u.test(manifest.salt) ||
    !Array.isArray(manifest.shards)
  ) {
    fail("History bundle is incomplete or uses an unsupported format.");
  }
  const shards = [];
  const shardNames = new Set();
  for (const shard of manifest.shards) {
    if (
      typeof shard !== "object" ||
      shard === null ||
      Array.isArray(shard) ||
      typeof shard.file !== "string" ||
      basename(shard.file) !== shard.file ||
      !/^records-\d{6}\.jsonl$/u.test(shard.file) ||
      typeof shard.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(shard.sha256)
    ) {
      fail("History bundle contains an invalid shard entry.");
    }
    if (shardNames.has(shard.file)) {
      fail("History bundle lists the same shard more than once.");
    }
    shardNames.add(shard.file);
    const file = await requirePrivateRegularFile(join(root, shard.file), "History shard", root);
    const status = await lstat(file);
    if (
      !Number.isSafeInteger(shard.records) ||
      shard.records < 0 ||
      !Number.isSafeInteger(shard.bytes) ||
      shard.bytes < 0 ||
      status.size !== shard.bytes ||
      (await sha256File(file)) !== shard.sha256 ||
      shard.records > maximumShardRecords ||
      status.size > maximumShardBytes
    ) {
      fail(`History shard does not match its completion manifest: ${shard.file}`);
    }
    shards.push(file);
  }
  const unexpected = (await readdir(root)).filter(
    (file) => file !== "bundle.json" && !shardNames.has(file),
  );
  if (unexpected.length > 0) {
    fail("History bundle contains files not named by its completion manifest.");
  }
  return { root, manifest, shards };
};
