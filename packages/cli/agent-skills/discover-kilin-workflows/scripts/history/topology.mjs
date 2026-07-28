import { createHash } from "node:crypto";

import { boundedPreview } from "./sanitize.mjs";

export const supportedSessionKinds = new Set(["root", "resume", "child"]);

export const stringField = (record, name) =>
  typeof record[name] === "string" ? record[name] : undefined;

const canonicalValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};

export const fingerprint = (value) => JSON.stringify(canonicalValue(value));

export const fingerprintDigest = (value) =>
  createHash("sha256").update(fingerprint(value)).digest("hex");

export const familyKeyFor = (record) =>
  `${record.provider}\u0000${record.projectPath}\u0000${record.rootSessionId}`;

export const pseudonymousReference = (kind, salt, ...parts) => {
  const digest = createHash("sha256")
    .update(salt)
    .update("\u0000")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `${kind}-${digest}`;
};

export const contentText = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(contentText).filter((item) => item !== undefined && item.length > 0);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  for (const field of ["text", "message", "value", "content"]) {
    const text = contentText(value[field]);
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  return undefined;
};

const isUserEvent = (event) =>
  event.actor === "user" || event.kind === "user" || event.kind === "user_message";

const isAssistantEvent = (event) =>
  event.actor === "assistant" || event.kind === "assistant" || event.kind === "assistant_message";

export const updatePreviews = (family, event, sessionKind, position) => {
  const text = contentText(event.content);
  if (text === undefined) {
    return;
  }
  if (isUserEvent(event)) {
    if (
      sessionKind === "root" &&
      (family.rootRequestPreviewAt === undefined || position < family.rootRequestPreviewAt)
    ) {
      family.rootRequestPreview = boundedPreview(text);
      family.rootRequestPreviewAt = position;
    }
    if (
      family.fallbackRequestPreviewAt === undefined ||
      position < family.fallbackRequestPreviewAt
    ) {
      family.fallbackRequestPreview = boundedPreview(text);
      family.fallbackRequestPreviewAt = position;
    }
  }
  if (
    isAssistantEvent(event) &&
    (family.outcomePreviewAt === undefined || position > family.outcomePreviewAt)
  ) {
    family.outcomePreview = boundedPreview(text);
    family.outcomePreviewAt = position;
  }
};

export const finishPreview = (family) => {
  if (family.rootRequestPreview !== undefined) {
    return {
      requestPreview: family.rootRequestPreview,
      requestPreviewSource: "root",
      outcomePreview: family.outcomePreview,
    };
  }
  return {
    requestPreview: family.fallbackRequestPreview,
    requestPreviewSource:
      family.fallbackRequestPreview === undefined ? "unavailable" : "earliest-admitted",
    outcomePreview: family.outcomePreview,
  };
};

export const sortFamiliesNewestFirst = (left, right) =>
  right.lastObservedAt.localeCompare(left.lastObservedAt) ||
  right.firstObservedAt.localeCompare(left.firstObservedAt) ||
  left.projectRef.localeCompare(right.projectRef) ||
  left.provider.localeCompare(right.provider) ||
  left.familyRef.localeCompare(right.familyRef);

export const sortEvents = (left, right) =>
  left.timestamp.localeCompare(right.timestamp) ||
  left.recordOrdinal - right.recordOrdinal ||
  left.sequence - right.sequence;

export const parentageForSession = (session, sessionReferences) => {
  if (session.kind === "root") {
    return "root";
  }
  if (session.parentSessionId !== undefined && sessionReferences.has(session.parentSessionId)) {
    return "known";
  }
  return "unknown";
};
