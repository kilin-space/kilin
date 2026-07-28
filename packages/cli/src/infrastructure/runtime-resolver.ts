import type { RuntimeAdapter } from "../application/runtime.js";
import type { RuntimeId } from "../domain/workflow.js";
import { ClaudeCodeRuntimeAdapter } from "./claude-code-runtime.js";
import { CodexRuntimeAdapter } from "./codex-runtime.js";
import { OpenCodeRuntimeAdapter } from "./opencode-runtime.js";

export type RuntimeExecutables = Readonly<Record<RuntimeId, string>>;

export const defaultRuntimeExecutables: RuntimeExecutables = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
};

export const resolveRuntime = (
  runtimeId: RuntimeId,
  executables: RuntimeExecutables = defaultRuntimeExecutables,
): RuntimeAdapter => {
  switch (runtimeId) {
    case "codex":
      return new CodexRuntimeAdapter(executables.codex);
    case "claude-code":
      return new ClaudeCodeRuntimeAdapter(executables["claude-code"]);
    case "opencode":
      return new OpenCodeRuntimeAdapter(executables.opencode);
  }
};
