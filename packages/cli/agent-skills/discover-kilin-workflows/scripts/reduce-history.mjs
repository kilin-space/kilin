#!/usr/bin/env node

import process from "node:process";

import { maximumNormalizedRecordBytes, readBundle, scanJsonLines } from "./history/jsonl.mjs";
import {
  createSanitizationCounters,
  isSensitiveField,
  sanitizeEvidenceValue,
} from "./history/sanitize.mjs";
import {
  contentText,
  familyKeyFor,
  fingerprint,
  finishPreview,
  parentageForSession,
  pseudonymousReference,
  sortEvents,
  sortFamiliesNewestFirst,
  stringField,
  supportedSessionKinds,
  updatePreviews,
} from "./history/topology.mjs";

const maximumOutputBytes = 4 * 1_024 * 1_024;
const maximumManifestPageSize = 100;
const maximumFamilyPageSize = 512;
const requiredOptions = new Set(["--bundle"]);
const optionalOptions = new Set(["--output", "--cursor", "--limit", "--family-ref"]);
const structuralFields = new Set([
  "provider",
  "projectPath",
  "timestamp",
  "sessionKind",
  "sessionId",
  "rootSessionId",
  "parentSessionId",
  "recordOrdinal",
  "events",
  "rootUserRequest",
  "assistantResponse",
  "toolNames",
  "toolCalls",
  "toolArguments",
  "toolResults",
  "artifacts",
  "files",
]);

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
      fail("Provide --bundle and a paged manifest or family output request.");
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

const pageLimit = (options, maximum) => {
  const configured = options.get("--limit");
  if (configured === undefined) {
    return maximum;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`--limit must be an integer from 1 through ${String(maximum)}.`);
  }
  return value;
};

const sourceEventsFor = (events) =>
  Array.isArray(events) ? events : events === undefined ? [] : [events];

const transportCategory = (kind) => {
  if (typeof kind !== "string") {
    return undefined;
  }
  const normalized = kind.toLowerCase();
  if (normalized === "user" || normalized === "request" || normalized === "user_message") {
    return "user";
  }
  if (
    normalized === "assistant" ||
    normalized === "response" ||
    normalized === "assistant_message"
  ) {
    return "assistant";
  }
  if (normalized.includes("tool") && normalized.includes("result")) {
    return "tool_results";
  }
  if (normalized.includes("tool")) {
    return "tool_calls";
  }
  if (normalized.includes("artifact") || normalized === "file") {
    return "artifacts";
  }
  return undefined;
};

const representedValue = (event, category) => {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    return undefined;
  }
  if (category === "user" || category === "assistant") {
    return event.text ?? event.content ?? event.message;
  }
  if (category === "tool_calls") {
    return event.call ?? event.toolCall ?? event.name ?? event.toolName ?? event.tool;
  }
  if (category === "tool_results") {
    return event.result ?? event.output;
  }
  return event.artifact ?? event.artifacts ?? event.file ?? event.files ?? event.path;
};

const addRepresented = (represented, category, value) => {
  if (category === undefined || value === undefined) {
    return;
  }
  const values = represented.get(category) ?? new Map();
  const key = fingerprint(value);
  values.set(key, (values.get(key) ?? 0) + 1);
  represented.set(category, values);
};

const isRepresented = (value, represented) => {
  if ((represented.get(fingerprint(value)) ?? 0) > 0) {
    return true;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const counts = new Map();
  for (const item of value) {
    const key = fingerprint(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].every(([key, count]) => (represented.get(key) ?? 0) >= count);
};

const eventsForRecord = (record, counters) => {
  const projectPath = record.projectPath;
  const events = [];
  const represented = new Map();
  for (const [sequence, source] of sourceEventsFor(record.events).entries()) {
    const sanitized = sanitizeEvidenceValue(source, projectPath, counters);
    if (sanitized === undefined) {
      continue;
    }
    const actor =
      typeof sanitized === "object" && sanitized !== null
        ? (sanitized.actor ?? sanitized.role)
        : undefined;
    const kind =
      typeof sanitized === "object" && sanitized !== null
        ? (sanitized.kind ?? sanitized.type)
        : undefined;
    if (typeof kind !== "string" || kind.length === 0) {
      counters.unknownEventTypes += 1;
    }
    const category = transportCategory(kind);
    addRepresented(represented, category, representedValue(sanitized, category));
    const content =
      typeof sanitized === "object" && sanitized !== null && "content" in sanitized
        ? sanitized.content
        : sanitized;
    const sanitizedSequence =
      typeof sanitized === "object" && sanitized !== null ? sanitized.sequence : undefined;
    events.push({ actor, kind, content, sequence: sanitizedSequence ?? sequence });
  }
  const flattened = [
    ["user", "user", "user", record.rootUserRequest],
    ["assistant", "assistant", "assistant", record.assistantResponse],
    ["tool_calls", "tool_names", "tool_call", record.toolNames],
    ["tool_calls", "tool_calls", "tool_call", record.toolCalls],
    ["tool_calls", "tool_arguments", "tool_call", record.toolArguments],
    ["tool_results", "tool_results", "tool_result", record.toolResults],
    ["artifacts", "artifacts", "artifact", record.artifacts],
    ["artifacts", "files", "artifact", record.files],
  ];
  for (const [category, sourceField, kind, value] of flattened) {
    if (value === undefined) {
      continue;
    }
    const sanitized = sanitizeEvidenceValue(value, projectPath, counters);
    if (sanitized === undefined) {
      continue;
    }
    if (isRepresented(sanitized, represented.get(category) ?? new Map())) {
      counters.deduplicatedFields += 1;
      continue;
    }
    events.push({
      actor: category === "user" || category === "assistant" ? category : undefined,
      kind,
      content: { sourceField, value: sanitized },
      sequence: events.length,
    });
  }
  for (const [field, value] of Object.entries(record)) {
    if (structuralFields.has(field)) {
      continue;
    }
    if (isSensitiveField(field)) {
      counters.excludedFields += 1;
      continue;
    }
    const sanitized = sanitizeEvidenceValue(value, projectPath, counters);
    if (sanitized !== undefined) {
      events.push({
        kind: "record_field",
        content: { field, value: sanitized },
        sequence: events.length,
      });
    }
  }
  return events;
};

const normalizedRecord = (record) => {
  const provider = stringField(record, "provider");
  const projectPath = stringField(record, "projectPath");
  const timestamp = stringField(record, "timestamp");
  const sessionKind = stringField(record, "sessionKind");
  const sessionId = stringField(record, "sessionId");
  const rootSessionId = stringField(record, "rootSessionId");
  if (
    provider === undefined ||
    projectPath === undefined ||
    timestamp === undefined ||
    !Number.isFinite(Date.parse(timestamp)) ||
    sessionKind === undefined ||
    !supportedSessionKinds.has(sessionKind) ||
    sessionId === undefined ||
    rootSessionId === undefined
  ) {
    fail("History bundle contains a malformed normalized record.");
  }
  return { provider, projectPath, timestamp, sessionKind, sessionId, rootSessionId };
};

async function* recordsIn(bundle) {
  for (const [index, shard] of bundle.shards.entries()) {
    let records = 0;
    for await (const { value } of scanJsonLines(shard, {
      label: "History normalized record",
      maximumLineBytes: maximumNormalizedRecordBytes,
    })) {
      records += 1;
      yield value;
    }
    if (records !== bundle.manifest.shards[index].records) {
      fail("History shard record count does not match its completion manifest.");
    }
  }
}

const createFamily = (identity, bundle, requestedFamilyRef) => {
  const familyRef = pseudonymousReference(
    "family",
    bundle.manifest.salt,
    identity.provider,
    identity.projectPath,
    identity.rootSessionId,
  );
  return {
    familyRef,
    provider: identity.provider,
    projectRef: pseudonymousReference("project", bundle.manifest.salt, identity.projectPath),
    firstObservedAt: identity.timestamp,
    lastObservedAt: identity.timestamp,
    sessionKinds: new Set(),
    sessions:
      requestedFamilyRef === undefined || requestedFamilyRef === familyRef ? new Map() : undefined,
    observedEventCount: 0,
  };
};

const encodeEventCursor = (event) =>
  `event-position:${Buffer.from(
    JSON.stringify([event.timestamp, event.recordOrdinal, event.sequence]),
  ).toString("base64url")}`;

const decodeEventCursor = (cursor) => {
  if (cursor === undefined) {
    return undefined;
  }
  if (!cursor.startsWith("event-position:")) {
    fail("Family cursor is invalid.");
  }
  let position;
  try {
    position = JSON.parse(
      Buffer.from(cursor.slice("event-position:".length), "base64url").toString("utf8"),
    );
  } catch {
    fail("Family cursor is invalid.");
  }
  if (
    !Array.isArray(position) ||
    position.length !== 3 ||
    typeof position[0] !== "string" ||
    !Number.isSafeInteger(position[1]) ||
    !Number.isSafeInteger(position[2])
  ) {
    fail("Family cursor is invalid.");
  }
  return { timestamp: position[0], recordOrdinal: position[1], sequence: position[2] };
};

const retainPageEvent = (page, event) => {
  let low = 0;
  let high = page.events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortEvents(page.events[middle], event) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  page.events.splice(low, 0, event);
  if (page.events.length > page.limit + 1) {
    page.events.pop();
  }
};

const familySummaries = async (bundle, counters, pageRequest) => {
  const families = new Map();
  const page =
    pageRequest === undefined
      ? undefined
      : { ...pageRequest, events: [], precedingEvents: 0, matchedCursor: false };
  let recordOrdinal = 0;
  for await (const record of recordsIn(bundle)) {
    recordOrdinal += 1;
    const identity = normalizedRecord(record);
    const key = familyKeyFor(record);
    let family = families.get(key);
    if (family === undefined) {
      family = createFamily(identity, bundle, page?.familyRef);
      families.set(key, family);
    }
    if (identity.timestamp < family.firstObservedAt) {
      family.firstObservedAt = identity.timestamp;
    }
    if (identity.timestamp > family.lastObservedAt) {
      family.lastObservedAt = identity.timestamp;
    }
    family.sessionKinds.add(identity.sessionKind);
    const parentSessionId = stringField(record, "parentSessionId");
    if (family.sessions !== undefined) {
      const existing = family.sessions.get(identity.sessionId);
      if (existing === undefined) {
        family.sessions.set(identity.sessionId, { kind: identity.sessionKind, parentSessionId });
      } else if (existing.parentSessionId === undefined && parentSessionId !== undefined) {
        existing.parentSessionId = parentSessionId;
      }
    }
    for (const event of eventsForRecord(record, counters)) {
      family.observedEventCount += 1;
      const stableRecordOrdinal = Number.isSafeInteger(record.recordOrdinal)
        ? record.recordOrdinal
        : recordOrdinal;
      const position = `${identity.timestamp}\u0000${String(stableRecordOrdinal).padStart(16, "0")}\u0000${String(event.sequence).padStart(8, "0")}`;
      if (family.sessions !== undefined) {
        updatePreviews(family, event, identity.sessionKind, position);
      }
      if (page?.familyRef === family.familyRef) {
        const positionedEvent = {
          ...event,
          timestamp: identity.timestamp,
          recordOrdinal: stableRecordOrdinal,
          sessionKind: identity.sessionKind,
          sessionId: identity.sessionId,
        };
        if (page.cursor !== undefined) {
          const comparison = sortEvents(positionedEvent, page.cursor);
          if (comparison <= 0) {
            page.precedingEvents += 1;
            if (comparison === 0) {
              page.matchedCursor = true;
            }
            continue;
          }
        }
        retainPageEvent(page, positionedEvent);
      }
    }
  }
  return {
    families: [...families.values()].sort(sortFamiliesNewestFirst),
    page,
  };
};

const publicFamilySummary = (family) => ({
  familyRef: family.familyRef,
  provider: family.provider,
  projectRef: family.projectRef,
  firstObservedAt: family.firstObservedAt,
  lastObservedAt: family.lastObservedAt,
  sessionKinds: [...family.sessionKinds].sort(),
  sessionCount: family.sessions.size,
  observedEventCount: family.observedEventCount,
  ...finishPreview(family),
});

const coverageFor = (bundle, families, counters) => ({
  ...bundle.manifest.coverage,
  familyCount: families.length,
  indexedFamilyCount: families.length,
  observedEvents: families.reduce((total, family) => total + family.observedEventCount, 0),
  missingRootFamilies: families.filter((family) => !family.sessionKinds.has("root")).length,
  deduplicatedFields: counters.deduplicatedFields,
  excludedFields: (bundle.manifest.coverage.excludedFields ?? 0) + counters.excludedFields,
  redactedValues: (bundle.manifest.coverage.redactedValues ?? 0) + counters.redactedValues,
  truncatedValues: (bundle.manifest.coverage.truncatedValues ?? 0) + counters.truncatedValues,
  unknownEventTypes: counters.unknownEventTypes,
});

const pageAfterCursor = (items, cursor, reference, invalidMessage) => {
  if (cursor === undefined) {
    return 0;
  }
  const index = items.findIndex((item) => reference(item) === cursor);
  if (index < 0) {
    fail(invalidMessage);
  }
  return index + 1;
};

const manifestOutput = (families, coverage, options) => {
  if (options.has("--family-ref")) {
    fail("Do not provide --family-ref with manifest output.");
  }
  const limit = pageLimit(options, maximumManifestPageSize);
  const start = pageAfterCursor(
    families,
    options.get("--cursor"),
    (family) => family.familyRef,
    "Manifest cursor does not identify a family in this bundle.",
  );
  const selected = families.slice(start, start + limit);
  const complete = start + selected.length >= families.length;
  return {
    output: "manifest",
    familyManifest: selected.map(publicFamilySummary),
    evidencePackets: [],
    page: {
      returned: selected.length,
      complete,
      nextCursor: complete || selected.length === 0 ? undefined : selected.at(-1).familyRef,
    },
    coverage,
  };
};

const familyOutput = (bundle, families, coverage, options, page) => {
  const familyRef = requireOption(options, "--family-ref");
  const selected = families.find((family) => family.familyRef === familyRef);
  if (selected === undefined) {
    fail("--family-ref does not identify a family in this bundle.");
  }
  if (page.cursor !== undefined && !page.matchedCursor) {
    fail("Family cursor does not identify an event in this family.");
  }
  const sessionKindOrder = new Map([
    ["root", 0],
    ["resume", 1],
    ["child", 2],
  ]);
  const orderedSessions = [...selected.sessions.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      sessionKindOrder.get(left.kind) - sessionKindOrder.get(right.kind) ||
      leftId.localeCompare(rightId),
  );
  const sessionReferences = new Map(
    orderedSessions.map(([sessionId]) => [
      sessionId,
      pseudonymousReference("session", bundle.manifest.salt, selected.familyRef, sessionId),
    ]),
  );
  const selectedEvents = page.events.slice(0, page.limit);
  const publicEvents = selectedEvents.map(
    ({ recordOrdinal, sequence, sessionId, ...event }, index) => ({
      eventRef: `${selected.familyRef}-event-${String(page.precedingEvents + index + 1).padStart(6, "0")}`,
      observedOrdinal: page.precedingEvents + index + 1,
      ...event,
      sessionRef: sessionReferences.get(sessionId),
    }),
  );
  const complete = page.events.length <= page.limit;
  return {
    output: "family",
    family: {
      ...publicFamilySummary(selected),
      sessions: orderedSessions.map(([sessionId, session]) => ({
        sessionRef: sessionReferences.get(sessionId),
        kind: session.kind,
        parentage: parentageForSession(session, sessionReferences),
        parentSessionRef: sessionReferences.get(session.parentSessionId),
      })),
      events: publicEvents,
    },
    page: {
      returned: publicEvents.length,
      complete,
      nextCursor:
        complete || selectedEvents.length === 0
          ? undefined
          : encodeEventCursor(selectedEvents.at(-1)),
    },
    coverage,
  };
};

export const reduceHistory = async (arguments_) => {
  const options = parseOptions(arguments_);
  const bundle = await readBundle(requireOption(options, "--bundle"));
  const output = options.get("--output") ?? "manifest";
  if (output !== "manifest" && output !== "family") {
    fail("--output must be manifest or family.");
  }
  const pageRequest =
    output === "family"
      ? {
          familyRef: requireOption(options, "--family-ref"),
          cursor: decodeEventCursor(options.get("--cursor")),
          limit: pageLimit(options, maximumFamilyPageSize),
        }
      : undefined;
  const counters = {
    ...createSanitizationCounters(),
    deduplicatedFields: 0,
    unknownEventTypes: 0,
  };
  const { families, page } = await familySummaries(bundle, counters, pageRequest);
  const coverage = coverageFor(bundle, families, counters);
  const result =
    output === "manifest"
      ? manifestOutput(families, coverage, options)
      : familyOutput(bundle, families, coverage, options, page);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumOutputBytes) {
    fail("Prepared evidence page exceeds 4 MiB; request a smaller --limit.");
  }
  return result;
};

try {
  const result = await reduceHistory(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "History evidence preparation failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
