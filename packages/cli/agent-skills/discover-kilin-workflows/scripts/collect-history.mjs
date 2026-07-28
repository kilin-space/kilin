#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  codexFileTimestamp,
  codexHistoryFiles,
  codexMetadata,
  codexEventMessageKey,
  codexResponseMessageCounts,
  extractCodexCandidates,
  isCodexStructuralRecord,
} from "./history/codex.mjs";
import {
  claudeFileTimestamp,
  claudeHistoryFiles,
  claudeMetadata,
  extractClaudeCandidates,
} from "./history/claude.mjs";
import {
  requirePrivateDirectory,
  scanJsonLines,
  ShardWriter,
  writePrivateJson,
} from "./history/jsonl.mjs";
import {
  canonicalProject,
  defaultProviderRoots,
  isWithinScope,
  parseProviders,
  parseScope,
  requireExpandedScopeConsent,
  supportedProviders,
} from "./history/projects.mjs";
import { createSanitizationCounters, sanitizeEvidenceValue } from "./history/sanitize.mjs";

const dayMilliseconds = 24 * 60 * 60 * 1_000;
const requiredOptions = new Set([
  "--scope",
  "--active-provider",
  "--providers",
  "--now",
  "--bundle",
]);
const optionalOptions = new Set([
  "--scope-root",
  "--scope-consent",
  "--since",
  "--codex-root",
  "--claude-root",
]);

const providerAdapters = {
  codex: {
    files: codexHistoryFiles,
    metadata: codexMetadata,
    candidates: extractCodexCandidates,
    structural: isCodexStructuralRecord,
    fileTimestamp: codexFileTimestamp,
  },
  claude: {
    files: claudeHistoryFiles,
    metadata: claudeMetadata,
    candidates: extractClaudeCandidates,
    structural: () => false,
    fileTimestamp: claudeFileTimestamp,
  },
};

const fail = (message) => {
  throw new Error(message);
};

const parseOptions = (arguments_) => {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      (!requiredOptions.has(name) && !optionalOptions.has(name)) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail("Provide collection scope, providers, UTC range, and --bundle as direct arguments.");
    }
    if (options.has(name)) {
      fail(`Option ${name} was provided more than once.`);
    }
    options.set(name, value);
  }
  for (const name of requiredOptions) {
    if (!options.has(name)) {
      fail(`Missing required option ${name}.`);
    }
  }
  return options;
};

const requireOption = (options, name) => {
  const value = options.get(name);
  if (value === undefined) {
    fail(`Missing required option ${name}.`);
  }
  return value;
};

const parseBoundary = async (options) => {
  const activeProvider = requireOption(options, "--active-provider");
  if (!supportedProviders.has(activeProvider)) {
    fail("--active-provider must be codex or claude.");
  }
  const providers = parseProviders(requireOption(options, "--providers"));
  const scope = await parseScope(requireOption(options, "--scope"), options.get("--scope-root"));
  requireExpandedScopeConsent(
    options.get("--scope-consent"),
    activeProvider,
    providers,
    scope.kind,
  );
  const now = Date.parse(requireOption(options, "--now"));
  const since = options.has("--since")
    ? Date.parse(options.get("--since"))
    : now - 30 * dayMilliseconds;
  if (!Number.isFinite(now) || !Number.isFinite(since) || since >= now) {
    fail("Provide exact UTC timestamps with --since earlier than --now.");
  }
  return { activeProvider, providers, scope, since, now };
};

const resolveRootSessionIds = (metadata) => {
  const sessions = new Map(
    metadata.map((entry) => [
      `${entry.provider}\u0000${entry.projectPath}\u0000${entry.sessionId}`,
      entry,
    ]),
  );
  const resolveRoot = (entry) => {
    const seen = new Set([entry.sessionId]);
    let current = entry;
    while (typeof current.parentSessionId === "string" && !seen.has(current.parentSessionId)) {
      seen.add(current.parentSessionId);
      const parent = sessions.get(
        `${entry.provider}\u0000${entry.projectPath}\u0000${current.parentSessionId}`,
      );
      if (parent === undefined) {
        return current.rootSessionId;
      }
      current = parent;
    }
    return current.sessionKind === "root" ? current.sessionId : current.rootSessionId;
  };
  return metadata.map((entry) => ({ ...entry, rootSessionId: resolveRoot(entry) }));
};

const collectMetadata = async (boundary, roots, coverage, interrupted) => {
  const admitted = [];
  for (const provider of boundary.providers) {
    const root = roots[provider];
    await access(root).catch(() =>
      fail(`Documented ${provider} history root is unavailable: ${root}`),
    );
    const adapter = providerAdapters[provider];
    for (const file of await adapter.files(root)) {
      if (interrupted()) {
        fail("History collection was interrupted.");
      }
      coverage.scannedFiles += 1;
      const metadata = await adapter.metadata(file);
      if (metadata === undefined) {
        coverage.excludedFiles.malformed += 1;
        continue;
      }
      const projectPath = await canonicalProject(metadata.projectPath);
      if (projectPath === undefined || !isWithinScope(projectPath, boundary.scope)) {
        coverage.excludedFiles.project += 1;
        continue;
      }
      const firstObserved = Date.parse(metadata.timestamp);
      const lastModified = Date.parse(await adapter.fileTimestamp(file));
      if (
        !Number.isFinite(lastModified) ||
        lastModified < boundary.since ||
        (Number.isFinite(firstObserved) && firstObserved >= boundary.now)
      ) {
        coverage.excludedFiles.time += 1;
        continue;
      }
      admitted.push({ ...metadata, projectPath, file });
    }
  }
  return resolveRootSessionIds(admitted);
};

const collectContent = async (metadata, boundary, writer, coverage, counters, interrupted) => {
  let recordOrdinal = 0;
  for (const session of metadata) {
    const adapter = providerAdapters[session.provider];
    const responseMessageCounts =
      session.provider === "codex"
        ? await codexResponseMessageCounts(session.file, boundary.since, boundary.now)
        : new Map();
    let includedForSession = 0;
    for await (const { value } of scanJsonLines(session.file, {
      label: `${session.provider} history`,
      onOversizedLine: () => {
        coverage.scannedSourceRecords += 1;
        coverage.excludedSourceRecords.oversized += 1;
      },
    })) {
      if (interrupted()) {
        fail("History collection was interrupted.");
      }
      coverage.scannedSourceRecords += 1;
      const timestamp =
        typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      if (!Number.isFinite(timestamp) || timestamp < boundary.since || timestamp >= boundary.now) {
        coverage.excludedSourceRecords.time += 1;
        continue;
      }
      const eventMessageKey =
        session.provider === "codex" ? codexEventMessageKey(value) : undefined;
      if (eventMessageKey !== undefined && (responseMessageCounts.get(eventMessageKey) ?? 0) > 0) {
        responseMessageCounts.set(eventMessageKey, responseMessageCounts.get(eventMessageKey) - 1);
        coverage.deduplicatedSourceRecords += 1;
        continue;
      }
      const candidates = adapter.candidates(value);
      if (candidates.length === 0) {
        if (!adapter.structural(value)) {
          coverage.unknownSourceRecords += 1;
        }
        continue;
      }
      for (const [sequence, candidate] of candidates.entries()) {
        const sanitized = sanitizeEvidenceValue(candidate.content, session.projectPath, counters);
        if (sanitized === undefined) {
          coverage.excludedSourceRecords.empty += 1;
          continue;
        }
        recordOrdinal += 1;
        includedForSession += 1;
        await writer.write({
          provider: session.provider,
          projectPath: session.projectPath,
          timestamp: new Date(timestamp).toISOString(),
          sessionKind: session.sessionKind,
          sessionId: session.sessionId,
          rootSessionId: session.rootSessionId,
          parentSessionId: session.parentSessionId,
          recordOrdinal,
          events: [
            {
              actor: candidate.actor,
              kind: candidate.kind,
              sequence,
              content: sanitized,
            },
          ],
        });
      }
    }
    if (includedForSession > 0) {
      coverage.includedSessions[session.sessionKind] += 1;
      coverage.includedFiles += 1;
    } else {
      coverage.excludedFiles.noAdmittedContent += 1;
    }
  }
  coverage.includedRecords = recordOrdinal;
};

export const collectHistory = async (arguments_) => {
  const options = parseOptions(arguments_);
  const boundary = await parseBoundary(options);
  const bundle = await requirePrivateDirectory(
    resolve(requireOption(options, "--bundle")),
    "History bundle",
    { empty: true },
  );
  const defaults = defaultProviderRoots();
  const roots = {
    codex: resolve(options.get("--codex-root") ?? defaults.codex),
    claude: resolve(options.get("--claude-root") ?? defaults.claude),
  };
  const coverage = {
    scannedFiles: 0,
    includedFiles: 0,
    excludedFiles: { project: 0, time: 0, malformed: 0, noAdmittedContent: 0 },
    scannedSourceRecords: 0,
    includedRecords: 0,
    excludedSourceRecords: { time: 0, empty: 0, oversized: 0 },
    unknownSourceRecords: 0,
    deduplicatedSourceRecords: 0,
    includedSessions: { root: 0, resume: 0, child: 0 },
  };
  const counters = createSanitizationCounters();
  const writer = new ShardWriter(bundle);
  let interrupted = false;
  const markInterrupted = () => {
    interrupted = true;
  };
  process.once("SIGINT", markInterrupted);
  process.once("SIGTERM", markInterrupted);
  try {
    const metadata = await collectMetadata(boundary, roots, coverage, () => interrupted);
    await collectContent(metadata, boundary, writer, coverage, counters, () => interrupted);
    const shards = await writer.finish();
    const manifest = {
      formatVersion: 1,
      complete: true,
      salt: randomBytes(32).toString("hex"),
      query: {
        scope: boundary.scope,
        activeProvider: boundary.activeProvider,
        providers: boundary.providers,
        since: new Date(boundary.since).toISOString(),
        now: new Date(boundary.now).toISOString(),
      },
      coverage: { ...coverage, ...counters },
      shards,
    };
    await writePrivateJson(join(bundle, "bundle.json"), manifest);
    return manifest;
  } catch (error) {
    await writer.abort();
    throw error;
  } finally {
    process.off("SIGINT", markInterrupted);
    process.off("SIGTERM", markInterrupted);
  }
};

const safeReceipt = (manifest) => ({
  complete: manifest.complete,
  shardCount: manifest.shards.length,
  includedFiles: manifest.coverage.includedFiles,
  includedRecords: manifest.coverage.includedRecords,
  excludedFiles: manifest.coverage.excludedFiles,
  excludedSourceRecords: manifest.coverage.excludedSourceRecords,
});

try {
  const result = await collectHistory(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(safeReceipt(result))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "History collection failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
