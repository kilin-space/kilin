import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

import type { RunControl, RunEvent } from "../application/run-events.js";
import {
  getRun,
  listRuns,
  recordApprovalDecision,
  requestRunCancellation,
  resumeWorkflow,
  rerunWorkflow,
  retryWorkflow,
  runTriggeredWorkflow,
  runWorkflow,
  waitForRunAttention,
} from "../application/runs.js";
import { compileStoredWorkflowRevision } from "../application/workflows.js";
import type { RunDetail } from "../domain/run-state.js";
import {
  maximumHostTriggerRequestBytes,
  parseHostTriggerRequestBytes,
} from "../domain/workflow-trigger.js";
import type { HostTriggerRequest } from "../domain/workflow-trigger.js";

import {
  OptionError,
  parseRerunCommandArguments,
  parseResumeCommandArguments,
  parseRetryCommandArguments,
  parseRunCommandArguments,
  parseRunsCommandArguments,
  parseTriggerCommandArguments,
} from "./arguments.js";
import {
  createApprovalDecisionDocument,
  createRunCancellationDocument,
  createRunDetailDocument,
  createRunListDocument,
  renderError,
  renderJson,
  renderApprovalDecision,
  renderRunCancellation,
  renderRunDetail,
  renderRunEvent,
  renderRunList,
} from "./render.js";

const exitCodeForRunStatus = (status: RunDetail["run"]["status"]): number => {
  switch (status) {
    case "succeeded":
      return 0;
    case "cancelled":
      return 130;
    case "failed":
    case "interrupted":
    case "running":
      return 1;
  }
};

const readHostTriggerRequest = async (requestFile: string): Promise<HostTriggerRequest> => {
  let handle: FileHandle;
  try {
    handle = await open(
      requestFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw new OptionError(
      `Could not read trigger request "${requestFile}". Check that it exists and is a readable regular file, then try again.`,
    );
  }

  let bytes: Uint8Array;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new OptionError(`Trigger request "${requestFile}" must be a regular file.`);
    }
    if (typeof process.geteuid === "function") {
      // Ownership and mode bits only carry meaning on POSIX hosts; Windows synthesizes both.
      if (metadata.uid !== process.geteuid()) {
        throw new OptionError(
          `Trigger request "${requestFile}" must be owned by the invoking user.`,
        );
      }
      if ((metadata.mode & 0o022) !== 0) {
        throw new OptionError(
          `Trigger request "${requestFile}" must not be group- or world-writable.`,
        );
      }
    }
    if (metadata.size > maximumHostTriggerRequestBytes) {
      throw new OptionError(
        `Trigger request "${requestFile}" exceeds the ${String(maximumHostTriggerRequestBytes)} byte limit.`,
      );
    }

    const buffer = new Uint8Array(maximumHostTriggerRequestBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    bytes = buffer.subarray(0, offset);
  } catch (error: unknown) {
    if (error instanceof OptionError) {
      throw error;
    }
    throw new OptionError(
      `Could not read trigger request "${requestFile}". Check that it exists and is a readable regular file, then try again.`,
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  return parseHostTriggerRequestBytes(bytes, requestFile);
};

const runAttached = async (
  json: boolean,
  operation: (control: RunControl) => Promise<RunDetail>,
): Promise<number> => {
  const controller = new AbortController();
  const state = { errorRendered: false, runStarted: false };
  const onEvent = (event: RunEvent): void => {
    if (event.type === "run.started") {
      state.runStarted = true;
    }
    if (event.type === "error") {
      state.errorRendered = true;
    }
    renderRunEvent(event, json);
  };
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  try {
    const detail = await operation({ signal: controller.signal, onEvent });
    return exitCodeForRunStatus(detail.run.status);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return 130;
    }
    if (!state.errorRendered) {
      renderError(error, json);
    }
    return state.runStarted ? 1 : 2;
  } finally {
    process.off("SIGINT", cancel);
  }
};

export const runRunCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseRunCommandArguments(arguments_);
  return runAttached(parsed.json, (control) =>
    runWorkflow(
      parsed.workflowName,
      parsed.cwd,
      parsed.options,
      control,
      undefined,
      parsed.parameters,
    ),
  );
};

export const runTriggerCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseTriggerCommandArguments(arguments_);
  const request = await readHostTriggerRequest(parsed.requestFile);
  return runAttached(parsed.json, (control) => runTriggeredWorkflow(request, control));
};

export const runRerunCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseRerunCommandArguments(arguments_);
  return runAttached(parsed.json, (control) =>
    rerunWorkflow(parsed.runId, control, undefined, parsed.maxParallel),
  );
};

export const runRetryCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseRetryCommandArguments(arguments_);
  return runAttached(parsed.json, (control) => retryWorkflow(parsed.runId, parsed.nodeId, control));
};

export const runResumeCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseResumeCommandArguments(arguments_);
  return runAttached(parsed.json, (control) => resumeWorkflow(parsed.runId, control));
};

const runWaitCommand = async (runId: string, json: boolean): Promise<number> => {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  try {
    const attention = await waitForRunAttention(runId, controller.signal);
    renderRunEvent(attention, json);
    return attention.type === "run.finished" ? exitCodeForRunStatus(attention.status) : 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return 130;
    }
    throw error;
  } finally {
    process.off("SIGINT", cancel);
  }
};

export const runRunsCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseRunsCommandArguments(arguments_);
  if (parsed.action === "list") {
    const document = createRunListDocument(
      await listRuns({
        limit: parsed.limit,
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
      }),
    );
    if (parsed.json) {
      renderJson(document);
    } else {
      renderRunList(document);
    }
    return 0;
  }

  if (parsed.action === "wait") {
    return runWaitCommand(parsed.runId, parsed.json);
  }

  if (parsed.action === "cancel") {
    const requested = await requestRunCancellation(parsed.runId);
    renderRunCancellation(createRunCancellationDocument(requested), parsed.json);
    return 0;
  }

  if (parsed.action === "approve" || parsed.action === "reject") {
    const recorded = await recordApprovalDecision(
      parsed.runId,
      parsed.nodeId,
      parsed.action,
      parsed.actor,
      parsed.note,
    );
    renderApprovalDecision(createApprovalDecisionDocument(recorded), parsed.json);
    return 0;
  }

  const detail = await getRun(parsed.runId);
  const plan = compileStoredWorkflowRevision(detail.revision);
  const document = createRunDetailDocument(detail, plan);
  if (parsed.json) {
    renderJson(document);
  } else {
    renderRunDetail(detail, document);
  }
  return 0;
};
