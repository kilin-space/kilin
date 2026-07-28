import { readFile } from "node:fs/promises";

import type {
  CompletedProcess,
  ResolvedAgentRequest,
  RuntimeAdapter,
  RuntimeExecutionContext,
  RuntimeInfo,
  RuntimeInvocation,
  RuntimeProbeContext,
  RuntimeProbeRequirements,
  RuntimeResult,
} from "../application/runtime.js";
import { KilinError } from "../domain/errors.js";
import type { NodeAccess } from "../domain/workflow.js";
import { parseJsonlEvents, type JsonRecord } from "./jsonl-events.js";
import {
  runRuntimeProbeProcess,
  cancelledProbeError,
  throwIfProbeCancelled,
} from "./runtime-probe-process.js";
import type { RuntimeProbeProcessResult } from "./runtime-probe-process.js";
import {
  isVersionAtLeast,
  parseStableSemanticVersion,
  type StableSemanticVersion,
} from "./stable-semantic-version.js";

interface ClaudePermissionsSettings {
  readonly deny?: readonly string[];
  readonly disableAutoMode: "disable";
  readonly disableBypassPermissionsMode: "disable";
}

interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly allowUnsandboxedCommands: false;
  readonly filesystem?: {
    readonly denyWrite: readonly string[];
  };
}

interface ClaudeSettings {
  readonly permissions: ClaudePermissionsSettings;
  readonly sandbox: ClaudeSandboxSettings;
}

const minimumVersion: StableSemanticVersion = {
  major: 2,
  minor: 1,
  patch: 215,
  text: "2.1.215",
};
const requiredLongFlags = [
  "--input-format",
  "--output-format",
  "--verbose",
  "--no-session-persistence",
  "--permission-mode",
  "--settings",
  "--safe-mode",
  "--model",
] as const;
const probeCancelledMessage = "Claude Code preflight was cancelled before the run started.";

const declarationPattern = (name: string): RegExp =>
  new RegExp(`^ {2}${name}(?=[\\s,=<\\[]|$)`, "u");

const declarationBlock = (help: string, name: string): string | undefined => {
  const lines = help.split(/\r?\n/u);
  const start = lines.findIndex((line) => declarationPattern(name).test(line));
  if (start === -1) {
    return undefined;
  }
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^ {2}\S/u.test(line));
  const end = relativeEnd === -1 ? lines.length : start + relativeEnd + 1;
  return lines.slice(start, end).join("\n");
};

const hasDeclaration = (help: string, name: string): boolean =>
  declarationBlock(help, name) !== undefined;

const permissionModeFor = (access: NodeAccess): "dontAsk" | "acceptEdits" =>
  access === "read_only" ? "dontAsk" : "acceptEdits";

const settingsFor = (request: ResolvedAgentRequest): ClaudeSettings => ({
  permissions: {
    ...(request.access === "read_only" ? { deny: ["Edit", "Write", "NotebookEdit"] } : {}),
    disableAutoMode: "disable",
    disableBypassPermissionsMode: "disable",
  },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    ...(request.access === "read_only"
      ? {
          filesystem: {
            denyWrite: [request.canonicalWorkingDirectory],
          },
        }
      : {}),
  },
});

const isSuccessfulResult = (event: JsonRecord): event is JsonRecord & { result: string } =>
  event.type === "result" &&
  event.subtype === "success" &&
  event.is_error === false &&
  typeof event.result === "string";

const captureFailed = (): KilinError =>
  new KilinError(
    "NODE_CAPTURE_FAILED",
    "The Claude Code final result could not be read from captured output. Inspect the node diagnostics and retry the run.",
  );

export class ClaudeCodeRuntimeAdapter implements RuntimeAdapter {
  public readonly runtimeId = "claude-code";
  private readonly executable: string;

  public constructor(executable = "claude") {
    this.executable = executable;
  }

  public async probe(
    requirements: RuntimeProbeRequirements,
    context: RuntimeProbeContext,
  ): Promise<RuntimeInfo> {
    throwIfProbeCancelled(context, probeCancelledMessage);
    let versionProbe: RuntimeProbeProcessResult;
    try {
      versionProbe = await runRuntimeProbeProcess(this.executable, ["--version"], context);
    } catch (error: unknown) {
      throwIfProbeCancelled(context, probeCancelledMessage);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new KilinError(
        "RUNTIME_NOT_FOUND",
        "Claude Code could not be started. Install Claude Code and ensure the claude executable is available on PATH.",
      );
    }

    if (versionProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }
    if (versionProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Claude Code version detection timed out. Verify the installation by running claude --version and retry.",
      );
    }
    if (versionProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Claude Code version detection produced too much output. Verify the installation and retry.",
      );
    }
    if (versionProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Claude Code did not report its version successfully. Verify the installation by running claude --version.",
      );
    }

    const version = parseStableSemanticVersion(`${versionProbe.stdout}\n${versionProbe.stderr}`);
    if (version === undefined || !isVersionAtLeast(version, minimumVersion)) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        `Kilin requires stable Claude Code >=${minimumVersion.text}. Install a supported release and retry.`,
      );
    }

    throwIfProbeCancelled(context, probeCancelledMessage);
    let capabilityProbe: RuntimeProbeProcessResult;
    try {
      capabilityProbe = await runRuntimeProbeProcess(this.executable, ["--help"], context);
    } catch (error: unknown) {
      throwIfProbeCancelled(context, probeCancelledMessage);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "Claude Code capabilities could not be checked. Verify the installation and retry.",
      );
    }

    if (capabilityProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }
    if (capabilityProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "Claude Code capability detection timed out. Verify the installation and retry.",
      );
    }
    if (capabilityProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "Claude Code capability detection produced too much output. Verify the installation and retry.",
      );
    }
    if (capabilityProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "Claude Code help was unavailable. Install the supported Claude Code release and retry.",
      );
    }

    const help = `${capabilityProbe.stdout}\n${capabilityProbe.stderr}`;
    const missingCapabilities: string[] = requiredLongFlags.filter(
      (flag) => !hasDeclaration(help, flag),
    );
    if (!hasDeclaration(help, "-p")) {
      missingCapabilities.push("-p");
    }
    if (!hasDeclaration(help, "auth")) {
      missingCapabilities.push("auth");
    }
    const permissionModeHelp = declarationBlock(help, "--permission-mode");
    if (
      permissionModeHelp !== undefined &&
      requirements.requiredAccessModes.includes("read_only") &&
      !permissionModeHelp.includes('"dontAsk"')
    ) {
      missingCapabilities.push("dontAsk");
    }
    if (
      permissionModeHelp !== undefined &&
      requirements.requiredAccessModes.includes("workspace_write") &&
      !permissionModeHelp.includes('"acceptEdits"')
    ) {
      missingCapabilities.push("acceptEdits");
    }
    if (missingCapabilities.length > 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        `Claude Code is missing required capabilities: ${missingCapabilities.join(", ")}. Install the supported release and retry.`,
      );
    }

    throwIfProbeCancelled(context, probeCancelledMessage);
    let authenticationProbe: RuntimeProbeProcessResult;
    try {
      authenticationProbe = await runRuntimeProbeProcess(
        this.executable,
        ["auth", "status"],
        context,
      );
    } catch (error: unknown) {
      throwIfProbeCancelled(context, probeCancelledMessage);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Claude Code authentication could not be checked. Run claude auth status, authenticate if needed, and retry.",
      );
    }

    if (authenticationProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }
    if (authenticationProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Claude Code authentication status timed out. Run claude auth status, then retry.",
      );
    }
    if (authenticationProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Claude Code authentication status produced too much output. Run claude auth status, then retry.",
      );
    }
    if (authenticationProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Claude Code is not authenticated. Run claude auth status, authenticate if needed, and retry.",
      );
    }

    return { runtimeId: this.runtimeId, executable: this.executable, version: version.text };
  }

  public createInvocation(
    request: ResolvedAgentRequest,
    context: RuntimeExecutionContext,
  ): RuntimeInvocation {
    const args = [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      permissionModeFor(request.access),
      "--settings",
      JSON.stringify(settingsFor(request)),
      "--safe-mode",
    ];
    if (request.model !== undefined) {
      args.push("--model", request.model);
    }

    return {
      executable: this.executable,
      args,
      cwd: request.canonicalWorkingDirectory,
      env: context.env,
      stdin: request.prompt,
    };
  }

  public async extractResult(completed: CompletedProcess): Promise<RuntimeResult> {
    try {
      const events = parseJsonlEvents(
        await readFile(completed.stdoutPath, "utf8"),
        "Claude output event was not an object.",
      );
      const resultEvents = events.filter((event) => event.type === "result");
      const resultEvent = resultEvents[0];
      if (
        resultEvents.length !== 1 ||
        resultEvent === undefined ||
        !isSuccessfulResult(resultEvent)
      ) {
        throw new Error("Claude output did not contain one successful result event.");
      }
      return { finalMessage: resultEvent.result };
    } catch {
      throw captureFailed();
    }
  }
}
