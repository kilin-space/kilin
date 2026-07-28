import { stat } from "node:fs/promises";
import { extname } from "node:path";

import { filesBelow, scanJsonLines } from "./jsonl.mjs";
import { contentText } from "./topology.mjs";

const objectValue = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

export const claudeMetadata = async (file) => {
  for await (const { value } of scanJsonLines(file, {
    label: "Claude history",
    onOversizedLine: () => undefined,
  })) {
    const sessionId = value.sessionId;
    const projectPath = value.cwd;
    if (typeof sessionId !== "string" || typeof projectPath !== "string") {
      continue;
    }
    const childId = typeof value.agentId === "string" ? value.agentId : undefined;
    const isChild = value.isSidechain === true || childId !== undefined;
    const recordSessionId = childId ?? sessionId;
    return {
      provider: "claude",
      projectPath,
      sessionId: recordSessionId,
      parentSessionId: isChild ? sessionId : undefined,
      rootSessionId: sessionId,
      sessionKind: isChild ? "child" : "root",
      timestamp: value.timestamp,
    };
  }
  return undefined;
};

const contentCandidates = (role, content) => {
  if (typeof content === "string") {
    return [{ actor: role, kind: role, content: { text: content } }];
  }
  if (!Array.isArray(content)) {
    const text = contentText(content);
    return text === undefined ? [] : [{ actor: role, kind: role, content: { text } }];
  }
  const candidates = [];
  for (const item of content) {
    if (typeof item === "string") {
      candidates.push({ actor: role, kind: role, content: { text: item } });
      continue;
    }
    const object = objectValue(item);
    if (object === undefined) {
      continue;
    }
    if (object.type === "text") {
      candidates.push({ actor: role, kind: role, content: { text: object.text } });
    } else if (object.type === "tool_use") {
      candidates.push({
        actor: "assistant",
        kind: "tool_call",
        content: { name: object.name, arguments: object.input },
      });
    } else if (object.type === "tool_result") {
      candidates.push({
        actor: "tool",
        kind: "tool_result",
        content: { result: object.content },
      });
    }
  }
  return candidates;
};

export const extractClaudeCandidates = (record) => {
  const message = objectValue(record.message);
  if (message !== undefined) {
    const role = typeof message.role === "string" ? message.role : record.type;
    return contentCandidates(role, message.content);
  }
  if (record.type === "summary" && typeof record.summary === "string") {
    return [{ actor: "assistant", kind: "summary", content: { text: record.summary } }];
  }
  return [];
};

export const claudeHistoryFiles = async (root) =>
  filesBelow(root, (file) => extname(file) === ".jsonl");

export const claudeFileTimestamp = async (file) => (await stat(file)).mtime.toISOString();
