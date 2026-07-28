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
import { isJsonRecord, parseJsonlEvents, type JsonRecord } from "./jsonl-events.js";
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

const permissionProfile = '{"edit":"allow","bash":"allow","external_directory":"deny"}';
const minimumVersion: StableSemanticVersion = {
  major: 1,
  minor: 18,
  patch: 4,
  text: "1.18.4",
};
const requiredFlags = ["--pure", "--format", "--dir", "--model"] as const;
const probeCancelledMessage = "OpenCode preflight was cancelled before the run started.";

const declarationPattern = (name: string): RegExp =>
  new RegExp(`^ {2}(?:-\\w, | {4})${name}(?=\\s|$)`, "u");

const declarationBlock = (help: string, name: string): string | undefined => {
  const lines = help.split(/\r?\n/u);
  const start = lines.findIndex((line) => declarationPattern(name).test(line));
  if (start === -1) {
    return undefined;
  }
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}(?:-\w, | {4})--\S/u.test(line));
  const end = relativeEnd === -1 ? lines.length : start + relativeEnd + 1;
  return lines.slice(start, end).join("\n");
};

const unsupportedAccess = (): KilinError =>
  new KilinError(
    "RUNTIME_ACCESS_UNSUPPORTED",
    "OpenCode does not support read_only access. Use workspace_write or choose a runtime that supports read_only.",
  );

const completedTextFrom = (event: JsonRecord): string | undefined => {
  if (event.type !== "text" || typeof event.sessionID !== "string" || !isJsonRecord(event.part)) {
    return undefined;
  }
  const part = event.part;
  if (
    part.type !== "text" ||
    part.sessionID !== event.sessionID ||
    typeof part.text !== "string" ||
    !isJsonRecord(part.time) ||
    typeof part.time.end !== "number" ||
    part.time.end <= 0
  ) {
    return undefined;
  }
  return part.text;
};

const captureFailed = (): KilinError =>
  new KilinError(
    "NODE_CAPTURE_FAILED",
    "The OpenCode final result could not be read from captured output. Inspect the node diagnostics and retry the run.",
  );

export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
  public readonly runtimeId = "opencode";
  private readonly executable: string;

  public constructor(executable = "opencode") {
    this.executable = executable;
  }

  public async probe(
    requirements: RuntimeProbeRequirements,
    context: RuntimeProbeContext,
  ): Promise<RuntimeInfo> {
    if (requirements.requiredAccessModes.includes("read_only")) {
      throw unsupportedAccess();
    }
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
        "OpenCode could not be started. Install OpenCode and ensure the opencode executable is available on PATH.",
      );
    }

    if (versionProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }
    if (versionProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "OpenCode version detection timed out. Verify the installation by running opencode --version and retry.",
      );
    }
    if (versionProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "OpenCode version detection produced too much output. Verify the installation and retry.",
      );
    }
    if (versionProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        "OpenCode did not report its version successfully. Verify the installation by running opencode --version.",
      );
    }

    const probedVersion = versionProbe.stdout.trim();
    const version =
      versionProbe.stderr.trim().length === 0
        ? parseStableSemanticVersion(probedVersion)
        : undefined;
    const normalizedVersion = probedVersion.replace(/\+[0-9A-Za-z.-]+$/u, "");
    if (version?.text !== normalizedVersion || !isVersionAtLeast(version, minimumVersion)) {
      throw new KilinError(
        "RUNTIME_UNSUPPORTED",
        `Kilin requires stable OpenCode >=${minimumVersion.text}. Install a supported release and retry.`,
      );
    }

    throwIfProbeCancelled(context, probeCancelledMessage);
    let capabilityProbe: RuntimeProbeProcessResult;
    try {
      capabilityProbe = await runRuntimeProbeProcess(this.executable, ["run", "--help"], context);
    } catch (error: unknown) {
      throwIfProbeCancelled(context, probeCancelledMessage);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "OpenCode run capabilities could not be checked. Verify the installation and retry.",
      );
    }

    if (capabilityProbe.failure === "cancelled") {
      throw cancelledProbeError(probeCancelledMessage);
    }
    if (capabilityProbe.failure === "timeout") {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "OpenCode run capability detection timed out. Verify the installation and retry.",
      );
    }
    if (capabilityProbe.failure === "output_limit") {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "OpenCode run capability detection produced too much output. Verify the installation and retry.",
      );
    }
    if (capabilityProbe.exitCode !== 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        "OpenCode run help was unavailable. Install the supported OpenCode release and retry.",
      );
    }

    const help = `${capabilityProbe.stdout}\n${capabilityProbe.stderr}`;
    const missingCapabilities: string[] = requiredFlags.filter(
      (flag) => declarationBlock(help, flag) === undefined,
    );
    const formatHelp = declarationBlock(help, "--format");
    if (formatHelp !== undefined) {
      const choices = /\[choices:\s*([^\]]*)\]/u.exec(formatHelp)?.[1];
      const supportsJson = choices?.split(",").some((choice) => choice.trim() === '"json"');
      if (supportsJson !== true) {
        missingCapabilities.push("json");
      }
    }
    if (missingCapabilities.length > 0) {
      throw new KilinError(
        "RUNTIME_CAPABILITY_MISSING",
        `OpenCode is missing required run capabilities: ${missingCapabilities.join(", ")}. Install the supported release and retry.`,
      );
    }

    return { runtimeId: this.runtimeId, executable: this.executable, version: version.text };
  }

  public createInvocation(
    request: ResolvedAgentRequest,
    context: RuntimeExecutionContext,
  ): RuntimeInvocation {
    if (request.access !== "workspace_write") {
      throw unsupportedAccess();
    }

    const args = ["run", "--pure", "--format", "json", "--dir", request.canonicalWorkingDirectory];
    if (request.model !== undefined) {
      args.push("--model", request.model);
    }

    return {
      executable: this.executable,
      args,
      cwd: request.canonicalWorkingDirectory,
      env: {
        ...context.env,
        OPENCODE_PERMISSION: permissionProfile,
      },
      stdin: request.prompt,
    };
  }

  public async extractResult(completed: CompletedProcess): Promise<RuntimeResult> {
    try {
      const completedTexts = parseJsonlEvents(
        await readFile(completed.stdoutPath, "utf8"),
        "OpenCode output event was not an object.",
      )
        .map(completedTextFrom)
        .filter((text): text is string => text !== undefined);
      const finalMessage = completedTexts.at(-1);
      if (finalMessage === undefined) {
        throw new Error("OpenCode output did not contain a completed text event.");
      }
      return { finalMessage };
    } catch {
      throw captureFailed();
    }
  }
}
