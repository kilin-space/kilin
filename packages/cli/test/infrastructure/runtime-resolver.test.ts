import { describe, expect, it } from "vitest";

import type { ResolvedAgentRequest } from "../../src/application/runtime.js";
import type { RuntimeId } from "../../src/domain/workflow.js";
import { ClaudeCodeRuntimeAdapter } from "../../src/infrastructure/claude-code-runtime.js";
import { CodexRuntimeAdapter } from "../../src/infrastructure/codex-runtime.js";
import { OpenCodeRuntimeAdapter } from "../../src/infrastructure/opencode-runtime.js";
import {
  resolveRuntime,
  type RuntimeExecutables,
} from "../../src/infrastructure/runtime-resolver.js";

const executables: RuntimeExecutables = {
  codex: "/fixed/codex",
  "claude-code": "/fixed/claude",
  opencode: "/fixed/opencode",
};

describe("fixed runtime resolver", () => {
  it.each([
    ["codex", CodexRuntimeAdapter],
    ["claude-code", ClaudeCodeRuntimeAdapter],
    ["opencode", OpenCodeRuntimeAdapter],
  ] as const)("maps %s to its one built-in adapter", (runtimeId, Adapter) => {
    const runtime = resolveRuntime(runtimeId satisfies RuntimeId, executables);
    const request: ResolvedAgentRequest = {
      runId: "run-1",
      nodeId: "node-1",
      ordinal: 0,
      runtime: runtimeId,
      access: runtimeId === "opencode" ? "workspace_write" : "read_only",
      prompt: "Inspect",
      canonicalWorkingDirectory: "/project",
      isGitRepository: true,
    };
    const invocation = runtime.createInvocation(request, {
      runtimeResultPath: "/run/.runtime-result.tmp",
      env: { PATH: "/usr/bin" },
    });

    expect(runtime).toBeInstanceOf(Adapter);
    expect(runtime.runtimeId).toBe(runtimeId);
    expect(invocation.executable).toBe(executables[runtimeId]);
  });
});
