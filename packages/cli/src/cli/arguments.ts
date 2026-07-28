import { isAbsolute } from "node:path";

import {
  type ApprovalActor,
  defaultRunOptions,
  isRunStatus,
  maximumApprovalTimeoutMs,
  maximumApprovalNoteCharacters,
  maximumMaxParallel,
  maximumNodeTimeoutMs,
  maximumOutputBytes,
  minimumApprovalTimeoutMs,
  minimumMaxParallel,
  minimumNodeTimeoutMs,
  minimumOutputBytes,
} from "../domain/run-state.js";
import type { RunParameters } from "../domain/run-parameters.js";
import type { RunOptions, RunStatus } from "../domain/run-state.js";
import { isLowercaseIdentifier } from "../domain/workflow-package.js";

export class OptionError extends Error {
  public readonly code = "OPTION_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "OptionError";
  }
}

export interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export interface RunCommandArguments {
  readonly workflowName: string;
  readonly cwd: string;
  readonly options: RunOptions;
  readonly parameters: RunParameters;
  readonly json: boolean;
}

export interface TriggerCommandArguments {
  readonly requestFile: string;
  readonly json: boolean;
}

export interface ResumeCommandArguments {
  readonly runId: string;
  readonly json: boolean;
}

export interface RerunCommandArguments extends ResumeCommandArguments {
  /** Present only when the caller explicitly overrode concurrency for the new run. */
  readonly maxParallel?: number;
}

export interface RetryCommandArguments extends ResumeCommandArguments {
  readonly nodeId?: string;
}

export interface UiCommandArguments {
  readonly workflowName: string;
  readonly cwd: string;
  readonly noOpen: boolean;
  readonly json: boolean;
}

export interface RunsListCommandArguments {
  readonly action: "list";
  readonly limit: number;
  readonly status?: RunStatus;
  readonly json: boolean;
}

export interface RunsShowCommandArguments {
  readonly action: "show";
  readonly runId: string;
  readonly json: boolean;
}

export interface RunsWaitCommandArguments {
  readonly action: "wait";
  readonly runId: string;
  readonly json: boolean;
}

export interface RunsCancelCommandArguments {
  readonly action: "cancel";
  readonly runId: string;
  readonly json: boolean;
}

export interface RunsDecisionCommandArguments {
  readonly action: "approve" | "reject";
  readonly runId: string;
  readonly nodeId: string;
  readonly actor: ApprovalActor;
  readonly note?: string;
  readonly json: boolean;
}

export type RunsCommandArguments =
  | RunsListCommandArguments
  | RunsShowCommandArguments
  | RunsWaitCommandArguments
  | RunsCancelCommandArguments
  | RunsDecisionCommandArguments;

const valueRequired = (option: string): OptionError =>
  new OptionError(`Flag "${option}" requires a value. Provide one and try again.`);

export const parseOptions = (
  arguments_: readonly string[],
  valueOptions: ReadonlySet<string>,
  booleanOptions: ReadonlySet<string> = new Set(["--json"]),
): ParsedOptions => {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === undefined || (!valueOptions.has(option) && !booleanOptions.has(option))) {
      throw new OptionError(
        option?.startsWith("--") === true
          ? `Unknown option "${option}". Check "kilin --help" for supported commands and flags.`
          : `Unexpected argument "${option ?? ""}". Check "kilin --help" for the exact command syntax.`,
      );
    }
    if (values.has(option) || flags.has(option)) {
      throw new OptionError(
        `Flag "${option}" was provided more than once. Remove the duplicate flag.`,
      );
    }
    if (booleanOptions.has(option)) {
      flags.add(option);
      continue;
    }

    const value = arguments_[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw valueRequired(option);
    }
    values.set(option, value);
    index += 1;
  }

  return { values, flags };
};

interface CollectedParameters {
  readonly parameters: RunParameters;
  readonly remaining: readonly string[];
}

/**
 * Collects the repeatable `--param name=value` flag before the generic option parser runs, so that
 * parser keeps rejecting every other duplicated flag.
 */
export const collectParameterAssignments = (arguments_: readonly string[]): CollectedParameters => {
  const parameters: Record<string, string> = {};
  const remaining: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option !== "--param") {
      if (option !== undefined) {
        remaining.push(option);
      }
      continue;
    }
    const assignment = arguments_[index + 1];
    if (assignment === undefined || assignment === "" || assignment.startsWith("--")) {
      throw valueRequired("--param");
    }
    index += 1;
    const separator = assignment.indexOf("=");
    if (separator < 1) {
      throw new OptionError(`Flag "--param" must receive "name=value". Received "${assignment}".`);
    }
    const name = assignment.slice(0, separator);
    if (!isLowercaseIdentifier(name)) {
      throw new OptionError(
        `Parameter name "${name}" is invalid. Use a lowercase name beginning with a letter and containing at most 64 letters, digits, or underscores.`,
      );
    }
    if (Object.hasOwn(parameters, name)) {
      throw new OptionError(
        `Parameter "${name}" was provided more than once. Remove the duplicate assignment.`,
      );
    }
    parameters[name] = assignment.slice(separator + 1);
  }

  return { parameters, remaining };
};

export const requireOption = (options: ParsedOptions, name: string): string => {
  const value = options.values.get(name);
  if (value === undefined) {
    throw new OptionError(`Missing required flag "${name}". Provide it and try again.`);
  }
  return value;
};

export const requirePositional = (value: string | undefined, description: string): string => {
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new OptionError(`${description} is required. Provide it and try again.`);
  }
  return value;
};

const parseDuration = (
  value: string,
  option: "--node-timeout" | "--approval-timeout",
  minimumMs: number,
  maximumMs: number,
): number => {
  const match = /^([1-9][0-9]*)([smh])$/u.exec(value);
  const amountText = match?.[1];
  const unit = match?.[2];
  if (amountText === undefined || unit === undefined) {
    throw new OptionError(
      `Flag "${option}" must be a positive integer followed by s, m, or h, from 1s through 24h.`,
    );
  }
  const amount = Number(amountText);
  let multiplier = 3_600_000;
  if (unit === "s") {
    multiplier = 1_000;
  } else if (unit === "m") {
    multiplier = 60_000;
  }
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < minimumMs || milliseconds > maximumMs) {
    throw new OptionError(`Flag "${option}" must resolve to a duration from 1s through 24h.`);
  }
  return milliseconds;
};

const parseIntegerInRange = (
  value: string,
  option: string,
  minimum: number,
  maximum: number,
): number => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new OptionError(
      `Flag "${option}" must be an integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new OptionError(
      `Flag "${option}" must be an integer from ${String(minimum)} through ${String(maximum)}.`,
    );
  }
  return parsed;
};

export const wantsJsonOutput = (arguments_: readonly string[]): boolean =>
  arguments_.includes("--json");

export const parseRunCommandArguments = (arguments_: readonly string[]): RunCommandArguments => {
  const workflowName = requirePositional(arguments_[0], "A workflow name");
  const collected = collectParameterAssignments(arguments_.slice(1));
  const parsed = parseOptions(
    collected.remaining,
    new Set([
      "--cwd",
      "--node-timeout",
      "--approval-timeout",
      "--max-output-bytes",
      "--max-parallel",
    ]),
  );
  const timeoutValue = parsed.values.get("--node-timeout");
  const approvalTimeoutValue = parsed.values.get("--approval-timeout");
  const outputValue = parsed.values.get("--max-output-bytes");
  const parallelValue = parsed.values.get("--max-parallel");

  return {
    workflowName,
    cwd: requireOption(parsed, "--cwd"),
    parameters: collected.parameters,
    options: {
      nodeTimeoutMs:
        timeoutValue === undefined
          ? defaultRunOptions.nodeTimeoutMs
          : parseDuration(
              timeoutValue,
              "--node-timeout",
              minimumNodeTimeoutMs,
              maximumNodeTimeoutMs,
            ),
      approvalTimeoutMs:
        approvalTimeoutValue === undefined
          ? defaultRunOptions.approvalTimeoutMs
          : parseDuration(
              approvalTimeoutValue,
              "--approval-timeout",
              minimumApprovalTimeoutMs,
              maximumApprovalTimeoutMs,
            ),
      maxOutputBytes:
        outputValue === undefined
          ? defaultRunOptions.maxOutputBytes
          : parseIntegerInRange(
              outputValue,
              "--max-output-bytes",
              minimumOutputBytes,
              maximumOutputBytes,
            ),
      maxParallel:
        parallelValue === undefined
          ? defaultRunOptions.maxParallel
          : parseIntegerInRange(
              parallelValue,
              "--max-parallel",
              minimumMaxParallel,
              maximumMaxParallel,
            ),
    },
    json: parsed.flags.has("--json"),
  };
};

/**
 * The version-1 trigger request is closed and parameterless: the generic parser rejects `--param`
 * as an unknown option, and the request parser rejects a root `parameters` field.
 */
export const parseTriggerCommandArguments = (
  arguments_: readonly string[],
): TriggerCommandArguments => {
  const parsed = parseOptions(arguments_, new Set(["--request"]));
  const requestFile = requireOption(parsed, "--request");
  if (!isAbsolute(requestFile)) {
    throw new OptionError(
      `Flag "--request" must name an absolute file path. Received "${requestFile}".`,
    );
  }
  return { requestFile, json: parsed.flags.has("--json") };
};

/** Only `rerun` may override concurrency; `retry` and `resume` reproduce the stored value. */
export const parseRerunCommandArguments = (
  arguments_: readonly string[],
): RerunCommandArguments => {
  const runId = requirePositional(arguments_[0], "A run ID");
  const parsed = parseOptions(arguments_.slice(1), new Set(["--max-parallel"]));
  const parallelValue = parsed.values.get("--max-parallel");
  return {
    runId,
    ...(parallelValue === undefined
      ? {}
      : {
          maxParallel: parseIntegerInRange(
            parallelValue,
            "--max-parallel",
            minimumMaxParallel,
            maximumMaxParallel,
          ),
        }),
    json: parsed.flags.has("--json"),
  };
};

export const parseResumeCommandArguments = (
  arguments_: readonly string[],
): ResumeCommandArguments => {
  const runId = requirePositional(arguments_[0], "A run ID");
  const parsed = parseOptions(arguments_.slice(1), new Set());
  return { runId, json: parsed.flags.has("--json") };
};

export const parseRetryCommandArguments = (
  arguments_: readonly string[],
): RetryCommandArguments => {
  const runId = requirePositional(arguments_[0], "A run ID");
  const parsed = parseOptions(arguments_.slice(1), new Set(["--node"]));
  const nodeId = parsed.values.get("--node");
  return {
    runId,
    ...(nodeId === undefined ? {} : { nodeId }),
    json: parsed.flags.has("--json"),
  };
};

export const parseUiCommandArguments = (arguments_: readonly string[]): UiCommandArguments => {
  const workflowName = requirePositional(arguments_[0], "A workflow name");
  const parsed = parseOptions(
    arguments_.slice(1),
    new Set(["--cwd"]),
    new Set(["--json", "--no-open"]),
  );
  return {
    workflowName,
    cwd: requireOption(parsed, "--cwd"),
    noOpen: parsed.flags.has("--no-open"),
    json: parsed.flags.has("--json"),
  };
};

export const parseRunsCommandArguments = (arguments_: readonly string[]): RunsCommandArguments => {
  const action = arguments_[0];
  if (action === "list") {
    const parsed = parseOptions(arguments_.slice(1), new Set(["--limit", "--status"]));
    const limitValue = parsed.values.get("--limit");
    const statusValue = parsed.values.get("--status");
    if (statusValue !== undefined && !isRunStatus(statusValue)) {
      throw new OptionError(
        `Flag "--status" must be one of: running, succeeded, failed, cancelled, interrupted. Received "${statusValue}".`,
      );
    }
    return {
      action,
      limit: limitValue === undefined ? 50 : parseIntegerInRange(limitValue, "--limit", 1, 1_000),
      ...(statusValue === undefined ? {} : { status: statusValue }),
      json: parsed.flags.has("--json"),
    };
  }

  if (action === "show" || action === "wait" || action === "cancel") {
    const runId = requirePositional(arguments_[1], "A run ID");
    const parsed = parseOptions(arguments_.slice(2), new Set());
    return { action, runId, json: parsed.flags.has("--json") };
  }

  if (action === "approve" || action === "reject") {
    const runId = requirePositional(arguments_[1], "A run ID");
    const nodeId = requirePositional(arguments_[2], "A node ID");
    const parsed = parseOptions(arguments_.slice(3), new Set(["--actor", "--note"]));
    const actor = requireOption(parsed, "--actor");
    if (actor !== "agent" && actor !== "human") {
      throw new OptionError(`Flag "--actor" must be agent or human. Received "${actor}".`);
    }
    const note = parsed.values.get("--note");
    if (note !== undefined && Array.from(note).length > maximumApprovalNoteCharacters) {
      throw new OptionError(
        `Flag "--note" must contain at most ${String(maximumApprovalNoteCharacters)} characters. Shorten the note and try again.`,
      );
    }
    return {
      action,
      runId,
      nodeId,
      actor,
      ...(note === undefined ? {} : { note }),
      json: parsed.flags.has("--json"),
    };
  }

  if (action === undefined || action.startsWith("--")) {
    throw new OptionError(
      'A runs action is required. Use "list", "show", "wait", "cancel", "approve", or "reject".',
    );
  }
  throw new OptionError(
    `Unknown runs command "${action}". Use "list", "show", "wait", "cancel", "approve", or "reject".`,
  );
};
