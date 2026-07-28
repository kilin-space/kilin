#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";

import { claudeHistoryFiles } from "./history/claude.mjs";
import { codexHistoryFiles } from "./history/codex.mjs";
import { scanJsonLines } from "./history/jsonl.mjs";
import { isSensitiveField } from "./history/sanitize.mjs";

const maximumFiles = 100;
const maximumDepth = 5;
const maximumRecords = 10_000;
const maximumShapeValues = 10_000;
const knownSchemaFields = new Set([
  "actor",
  "agentId",
  "content",
  "cwd",
  "entrypoint",
  "git",
  "gitBranch",
  "id",
  "isSidechain",
  "kind",
  "message",
  "name",
  "parentUuid",
  "parent_thread_id",
  "payload",
  "promptId",
  "role",
  "sessionId",
  "session_id",
  "source",
  "summary",
  "text",
  "thread_source",
  "timestamp",
  "type",
  "userType",
  "uuid",
  "value",
  "version",
]);

const fail = (message) => {
  throw new Error(message);
};

const parseOptions = (arguments_) => {
  const allowed = new Set(["--provider", "--root", "--limit"]);
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !allowed.has(name) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      options.has(name)
    ) {
      fail("Provide --provider, --root, and an optional --limit as direct arguments.");
    }
    options.set(name, value);
  }
  if (!options.has("--provider") || !options.has("--root")) {
    fail("Both --provider and --root are required.");
  }
  return options;
};

const valueType = (value) => {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
};

const structuralField = (field) => {
  if (isSensitiveField(field)) {
    return "[sensitive-key]";
  }
  if (knownSchemaFields.has(field)) {
    return field;
  }
  const digest = createHash("sha256").update(field).digest("hex").slice(0, 12);
  return `[dynamic-key-${digest}]`;
};

const recordShape = (value, path, depth, shapes, budget) => {
  if (budget.remainingShapeValues === 0) {
    return false;
  }
  budget.remainingShapeValues -= 1;
  const type = valueType(value);
  const shape = shapes.get(path) ?? new Map();
  shape.set(type, (shape.get(type) ?? 0) + 1);
  shapes.set(path, shape);
  if (depth >= maximumDepth || typeof value !== "object" || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!recordShape(item, `${path}[]`, depth + 1, shapes, budget)) {
        return false;
      }
    }
    return true;
  }
  for (const [field, child] of Object.entries(value)) {
    const safeField = structuralField(field);
    if (
      !recordShape(
        child,
        path.length === 0 ? safeField : `${path}.${safeField}`,
        depth + 1,
        shapes,
        budget,
      )
    ) {
      return false;
    }
  }
  return true;
};

export const inspectHistoryLayout = async (arguments_) => {
  const options = parseOptions(arguments_);
  const provider = options.get("--provider");
  const discoverFiles =
    provider === "codex"
      ? codexHistoryFiles
      : provider === "claude"
        ? claudeHistoryFiles
        : fail("--provider must be codex or claude.");
  const configuredLimit = options.has("--limit") ? Number(options.get("--limit")) : maximumFiles;
  if (
    !Number.isSafeInteger(configuredLimit) ||
    configuredLimit < 1 ||
    configuredLimit > maximumFiles
  ) {
    fail(`--limit must be an integer from 1 through ${String(maximumFiles)}.`);
  }
  const files = await discoverFiles(resolve(options.get("--root")));
  const selected = files.slice(0, configuredLimit);
  const shapes = new Map();
  const budget = { remainingShapeValues: maximumShapeValues };
  let recordCount = 0;
  let truncated = false;
  selectedFiles: for (const file of selected) {
    for await (const { value } of scanJsonLines(file, { label: `${provider} history` })) {
      if (recordCount >= maximumRecords) {
        truncated = true;
        break selectedFiles;
      }
      recordCount += 1;
      if (!recordShape(value, "", 0, shapes, budget)) {
        truncated = true;
        break selectedFiles;
      }
    }
  }
  return {
    provider,
    scannedFiles: selected.length,
    availableFiles: files.length,
    truncatedFiles: files.length - selected.length,
    recordCount,
    truncated,
    shapes: Object.fromEntries(
      [...shapes.entries()]
        .filter(([path]) => path.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, counts]) => [path, Object.fromEntries([...counts].sort())]),
    ),
  };
};

try {
  const result = await inspectHistoryLayout(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "History layout inspection failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
