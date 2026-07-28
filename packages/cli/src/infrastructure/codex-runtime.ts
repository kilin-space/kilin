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

const minimumVersion: StableSemanticVersion = {
  major: 0,
  minor: 144,
  patch: 0,
  text: "0.144.0",
};
const requiredGlobalLongFlags = ["--ask-for-approval", "--config"] as const;
const requiredExecLongFlags = [
  "--json",
  "--ignore-rules",
  "--ignore-user-config",
  "--output-last-message",
  "--model",
  "--skip-git-repo-check",
  "--ephemeral",
] as const;
const probeCancelledMessage = "Codex preflight was cancelled before the run started.";

const optionPattern = (option: string): RegExp =>
  new RegExp(`(^|[\\s,])${option}(?=[\\s,=<\\[]|$)`, "mu");

const hasOption = (help: string, option: string): boolean => optionPattern(option).test(help);

const readCapabilityHelp = async (
  executable: string,
  surface: "global" | "exec",
  context: RuntimeProbeContext,
): Promise<string> => {
  throwIfProbeCancelled(context, probeCancelledMessage);
  let capabilityProbe: RuntimeProbeProcessResult;
  try {
    capabilityProbe = await runRuntimeProbeProcess(
      executable,
      surface === "global" ? ["--help"] : ["exec", "--help"],
      context,
    );
  } catch (error: unknown) {
    throwIfProbeCancelled(context, probeCancelledMessage);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new KilinError(
      "RUNTIME_CAPABILITY_MISSING",
      `Codex ${surface} capabilities could not be checked. Verify the Codex installation and retry.`,
    );
  }

  if (capabilityProbe.failure === "cancelled") {
    throw cancelledProbeError(probeCancelledMessage);
  }
  if (capabilityProbe.failure === "timeout") {
    throw new KilinError(
      "RUNTIME_CAPABILITY_MISSING",
      `Codex ${surface} capability detection timed out. Verify the Codex installation and retry.`,
    );
  }
  if (capabilityProbe.failure === "output_limit") {
    throw new KilinError(
      "RUNTIME_CAPABILITY_MISSING",
      `Codex ${surface} capability detection produced too much output. Verify the Codex installation and retry.`,
    );
  }
  if (capabilityProbe.exitCode !== 0) {
    throw new KilinError(
      "RUNTIME_CAPABILITY_MISSING",
      `Codex ${surface} help was unavailable. Install a supported Codex release and retry.`,
    );
  }

  return `${capabilityProbe.stdout}\n${capabilityProbe.stderr}`;
};

const permissionProfileFor = (access: NodeAccess): ":read-only" | ":workspace" =>
  access === "read_only" ? ":read-only" : ":workspace";

const untrustedProjectOverrideFor = (canonicalWorkingDirectory: string): string =>
  `projects.${JSON.stringify(canonicalWorkingDirectory)}.trust_level="untrusted"`;

export class CodexRuntimeAdapter implements RuntimeAdapter {
  public readonly runtimeId = "codex";
  private readonly executable: string;

  public constructor(executable = "codex") {
    this.executable = executable;
  }

  public async probe(
    _requirements: RuntimeProbeRequirements,
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
        "Codex could not be started. Install Codex and ensure the codex executable is available on PATH.",
      );
    }

    if (versionProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }

    if (versionProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Codex version detection timed out. Verify the installation by running codex --version and retry.",
      );
    }
    if (versionProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Codex version detection produced too much output. Verify the installation and retry.",
      );
    }
    if (versionProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "Codex did not report its version successfully. Verify the installation and run codex --version.",
      );
    }

    const version = parseStableSemanticVersion(`${versionProbe.stdout}\n${versionProbe.stderr}`);
    if (version === undefined || !isVersionAtLeast(version, minimumVersion)) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        `Kilin requires stable Codex >=${minimumVersion.text}. Install a supported Codex release and retry.`,
      );
    }

    const globalHelp = await readCapabilityHelp(this.executable, "global", context);
    const missingGlobalFlags: string[] = requiredGlobalLongFlags.filter(
      (flag) => !hasOption(globalHelp, flag),
    );
    if (missingGlobalFlags.length > 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        `Codex is missing required execution capabilities: ${missingGlobalFlags.join(", ")}. Install a supported Codex release and retry.`,
      );
    }

    const execHelp = await readCapabilityHelp(this.executable, "exec", context);
    const missingExecFlags: string[] = requiredExecLongFlags.filter(
      (flag) => !hasOption(execHelp, flag),
    );
    if (!hasOption(execHelp, "-C")) {
      missingExecFlags.push("-C");
    }
    if (missingExecFlags.length > 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        `Codex is missing required execution capabilities: ${missingExecFlags.join(", ")}. Install a supported Codex release and retry.`,
      );
    }

    let authenticationProbe: RuntimeProbeProcessResult;
    throwIfProbeCancelled(context, probeCancelledMessage);
    try {
      authenticationProbe = await runRuntimeProbeProcess(
        this.executable,
        ["login", "status"],
        context,
      );
    } catch (error: unknown) {
      throwIfProbeCancelled(context, probeCancelledMessage);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Codex authentication could not be checked. Run codex login and retry.",
      );
    }

    if (authenticationProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }

    if (authenticationProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Codex authentication status timed out. Run codex login status, then retry.",
      );
    }
    if (authenticationProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Codex authentication status produced too much output. Run codex login status, then retry.",
      );
    }
    if (authenticationProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_AUTH_REQUIRED",
        "Codex is not authenticated. Run codex login and retry.",
      );
    }

    return { runtimeId: this.runtimeId, executable: this.executable, version: version.text };
  }

  public createInvocation(
    request: ResolvedAgentRequest,
    context: RuntimeExecutionContext,
  ): RuntimeInvocation {
    const args = [
      "--ask-for-approval",
      "never",
      "--config",
      `default_permissions="${permissionProfileFor(request.access)}"`,
      "--config",
      untrustedProjectOverrideFor(request.canonicalWorkingDirectory),
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "-C",
      request.canonicalWorkingDirectory,
      "--output-last-message",
      context.runtimeResultPath,
    ];

    if (request.model !== undefined) {
      args.push("--model", request.model);
    }
    if (!request.isGitRepository) {
      args.push("--skip-git-repo-check");
    }
    args.push("--ephemeral", "-");

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
      const finalMessage = await readFile(completed.runtimeResultPath, "utf8");
      return { finalMessage };
    } catch {
      throw new KilinError(
        "NODE_CAPTURE_FAILED",
        "The Codex final result could not be read from captured output. Inspect the node diagnostics and retry the run.",
      );
    }
  }
}
