import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { isCommandFailure } from "../helpers/subprocess.js";
import { writeTestWorkflowPackage } from "../helpers/workflow-package.js";

const execFileAsync = promisify(execFile);
const cliFile = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const temporaryDirectories: string[] = [];
const viewerProcesses: ChildProcessWithoutNullStreams[] = [];

interface ViewerStartedDocument {
  outputVersion: 1;
  type: "viewer.started";
  workflowId: string;
  workflowScope: "project" | "user";
  projectRoot?: string;
  cwd: string;
  url: string;
}

const workflowSource = (id: string): string => `schemaVersion: 1
workflow: { id: ${id}, name: Viewer workflow }
nodes:
  - { id: main, kind: agent, runtime: codex, access: read_only, prompt: Inspect. }
edges: []
`;

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-ui-cli-"));
  temporaryDirectories.push(directory);
  return realpath(directory);
};

const waitForFirstLine = async (child: ChildProcessWithoutNullStreams): Promise<string> =>
  new Promise((resolveLine, rejectLine) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectLine(new Error(`Viewer did not start. stderr: ${stderr}`));
    }, 5_000);
    const finish = (callback: () => void): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        finish(() => resolveLine(stdout.slice(0, newline)));
      }
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error: Error): void => {
      finish(() => rejectLine(error));
    };
    const onExit = (code: number | null): void => {
      finish(() =>
        rejectLine(new Error(`Viewer exited before startup with code ${String(code)}: ${stderr}`)),
      );
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });

const startViewer = async (
  workflowId: string,
  cwd: string,
  homeDirectory: string,
  dataDirectory: string,
): Promise<{ process: ChildProcessWithoutNullStreams; document: ViewerStartedDocument }> => {
  const child = spawn(
    process.execPath,
    [cliFile, "ui", workflowId, "--cwd", cwd, "--no-open", "--json"],
    {
      env: {
        ...process.env,
        HOME: homeDirectory,
        KILIN_DATA_DIR: dataDirectory,
        KILIN_SKIP_SETUP_PROMPT: "true",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  viewerProcesses.push(child);
  const document = JSON.parse(await waitForFirstLine(child)) as ViewerStartedDocument;
  return { process: child, document };
};

afterEach(async () => {
  await Promise.all(
    viewerProcesses.splice(0).map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          child.once("exit", () => resolveExit());
          child.kill("SIGTERM");
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("ui CLI", () => {
  it("emits a project-scoped viewer.started document and stays attached", async () => {
    const root = await createTemporaryDirectory();
    const homeDirectory = join(root, "home");
    const project = join(homeDirectory, "project");
    const dataDirectory = join(root, "state");
    await mkdir(project, { recursive: true });
    await writeTestWorkflowPackage(
      join(project, ".agents", "workflows"),
      "project-viewer",
      "Project viewer",
      workflowSource("project-viewer"),
    );

    const viewer = await startViewer("project-viewer", project, homeDirectory, dataDirectory);

    expect(viewer.document).toEqual({
      outputVersion: 1,
      type: "viewer.started",
      workflowId: "project-viewer",
      workflowScope: "project",
      projectRoot: project,
      cwd: project,
      url: viewer.document.url,
    });
    expect(viewer.document.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[^\s]+$/u);
    expect(viewer.process.exitCode).toBeNull();
  });

  it("omits projectRoot for a user-scoped viewer", async () => {
    const root = await createTemporaryDirectory();
    const homeDirectory = join(root, "home");
    const project = join(homeDirectory, "project");
    const dataDirectory = join(root, "state");
    await mkdir(project, { recursive: true });
    await writeTestWorkflowPackage(
      join(homeDirectory, ".agents", "workflows"),
      "user-viewer",
      "User viewer",
      workflowSource("user-viewer"),
    );

    const viewer = await startViewer("user-viewer", project, homeDirectory, dataDirectory);

    expect(viewer.document).toMatchObject({
      outputVersion: 1,
      type: "viewer.started",
      workflowId: "user-viewer",
      workflowScope: "user",
      cwd: project,
    });
    expect(viewer.document).not.toHaveProperty("projectRoot");
    expect(viewer.process.exitCode).toBeNull();
  });

  it("renders startup errors as JSON", async () => {
    const root = await createTemporaryDirectory();
    try {
      await execFileAsync(
        process.execPath,
        [cliFile, "ui", "missing", "--cwd", root, "--no-open", "--json"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: root,
            KILIN_DATA_DIR: join(root, "state"),
            KILIN_SKIP_SETUP_PROMPT: "true",
          },
        },
      );
      throw new Error("Expected the viewer command to fail");
    } catch (error: unknown) {
      if (!isCommandFailure(error)) {
        throw error;
      }
      expect(error.stderr).toBe("");
      expect(JSON.parse(error.stdout)).toMatchObject({
        outputVersion: 1,
        type: "error",
        code: "WORKFLOW_NOT_FOUND",
      });
    }
  });
});
