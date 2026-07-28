import { stat } from "node:fs/promises";
import { extname } from "node:path";

import { filesBelow, scanJsonLines } from "./jsonl.mjs";
import { contentText, fingerprintDigest } from "./topology.mjs";

const objectValue = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

export const codexMetadata = async (file) => {
  for await (const { value } of scanJsonLines(file, {
    label: "Codex history",
    onOversizedLine: () => undefined,
  })) {
    if (value.type !== "session_meta") {
      continue;
    }
    const payload = objectValue(value.payload);
    if (payload === undefined) {
      return undefined;
    }
    const sessionId = payload.id ?? payload.session_id;
    const projectPath = payload.cwd;
    const parentSessionId = payload.parent_thread_id;
    if (typeof sessionId !== "string" || typeof projectPath !== "string") {
      return undefined;
    }
    const source = `${String(payload.source ?? "")} ${String(payload.thread_source ?? "")}`;
    const sessionKind =
      typeof parentSessionId === "string" ? "child" : /resume/iu.test(source) ? "resume" : "root";
    return {
      provider: "codex",
      projectPath,
      sessionId,
      parentSessionId: typeof parentSessionId === "string" ? parentSessionId : undefined,
      rootSessionId: typeof parentSessionId === "string" ? parentSessionId : sessionId,
      sessionKind,
      timestamp: typeof value.timestamp === "string" ? value.timestamp : payload.timestamp,
    };
  }
  return undefined;
};

const responseItemCandidates = (payload) => {
  if (payload.type === "message") {
    const text = contentText(payload.content);
    return text === undefined
      ? []
      : [{ actor: payload.role, kind: payload.role, content: { text } }];
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    return [
      {
        actor: "assistant",
        kind: "tool_call",
        content: { name: payload.name, arguments: payload.arguments ?? payload.input },
      },
    ];
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return [{ actor: "tool", kind: "tool_result", content: { result: payload.output } }];
  }
  return [];
};

const eventMessageCandidates = (payload) => {
  if (payload.type === "user_message") {
    return [{ actor: "user", kind: "user", content: { text: payload.message } }];
  }
  if (payload.type === "agent_message") {
    return [{ actor: "assistant", kind: "assistant", content: { text: payload.message } }];
  }
  if (payload.type === "task_complete" || payload.type === "turn_aborted") {
    return [{ actor: "system", kind: payload.type, content: payload }];
  }
  return [];
};

const messageKey = (actor, text) =>
  typeof actor === "string" && typeof text === "string"
    ? fingerprintDigest({ actor, text })
    : undefined;

export const codexResponseMessageCounts = async (file, since, now) => {
  const counts = new Map();
  for await (const { value } of scanJsonLines(file, {
    label: "Codex history",
    onOversizedLine: () => undefined,
  })) {
    const payload = objectValue(value.payload);
    if (value.type !== "response_item" || payload?.type !== "message") {
      continue;
    }
    const timestamp =
      typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp < since || timestamp >= now) {
      continue;
    }
    const key = messageKey(payload.role, contentText(payload.content));
    if (key !== undefined) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
};

export const codexEventMessageKey = (record) => {
  const payload = objectValue(record.payload);
  if (record.type !== "event_msg" || payload === undefined) {
    return undefined;
  }
  if (payload.type === "user_message") {
    return messageKey("user", payload.message);
  }
  if (payload.type === "agent_message") {
    return messageKey("assistant", payload.message);
  }
  return undefined;
};

export const extractCodexCandidates = (record) => {
  const payload = objectValue(record.payload);
  if (payload === undefined) {
    return [];
  }
  if (record.type === "response_item") {
    return responseItemCandidates(payload);
  }
  if (record.type === "event_msg") {
    return eventMessageCandidates(payload);
  }
  return [];
};

export const isCodexStructuralRecord = (record) => record.type === "session_meta";

export const codexHistoryFiles = async (root) =>
  filesBelow(root, (file) => extname(file) === ".jsonl");

export const codexFileTimestamp = async (file) => (await stat(file)).mtime.toISOString();
