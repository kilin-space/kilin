import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { compileWorkflow } from "../domain/compile-workflow.js";
import { startViewerServer } from "../infrastructure/viewer-server.js";
import {
  assertWorkflowScopeAllowsWorkingDirectory,
  resolveWorkflowPackage,
} from "../infrastructure/workflow-package.js";

import { parseUiCommandArguments } from "./arguments.js";
import { renderJson, type ViewerStartedDocument } from "./render.js";

const openViewer = (url: string): void => {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  let failureReported = false;
  const reportFailure = (): void => {
    if (!failureReported) {
      failureReported = true;
      process.stderr.write(
        `The browser could not be opened. Open the printed viewer URL manually.\n`,
      );
    }
  };
  const child = spawn(command, [url], {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
  child.once("spawn", () => {
    child.unref();
  });
  child.once("error", reportFailure);
  child.once("exit", (exitCode, signal) => {
    if (exitCode !== 0 || signal !== null) {
      reportFailure();
    }
  });
};

export const runUiCommand = async (arguments_: readonly string[]): Promise<number> => {
  const parsed = parseUiCommandArguments(arguments_);
  const userWorkflowsDirectory = join(homedir(), ".agents", "workflows");
  const workflowPackage = await resolveWorkflowPackage(parsed.workflowName, {
    workingDirectory: parsed.cwd,
    userWorkflowsDirectory,
  });
  compileWorkflow(workflowPackage.definition);
  const canonicalCwd = await assertWorkflowScopeAllowsWorkingDirectory(workflowPackage, parsed.cwd);
  const server = await startViewerServer({
    definitionFile: workflowPackage.definitionFile,
    identity: workflowPackage.identity,
    canonicalCwd,
    dataDirectory: process.env.KILIN_DATA_DIR ?? join(homedir(), ".kilin"),
  });
  const stop = (): void => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (parsed.json) {
      const document: ViewerStartedDocument = {
        outputVersion: 1,
        type: "viewer.started",
        workflowId: workflowPackage.identity.workflowId,
        workflowScope: workflowPackage.identity.scope.kind,
        ...(workflowPackage.identity.scope.kind === "project"
          ? { projectRoot: workflowPackage.identity.scope.root }
          : {}),
        cwd: canonicalCwd,
        url: server.url,
      };
      renderJson(document);
    } else {
      process.stdout.write(`Viewer: ${server.url}\n`);
    }
    if (!parsed.noOpen) {
      openViewer(server.url);
    }
    await server.waitUntilClosed();
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close();
  }
};
