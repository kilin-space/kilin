import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type { ExecutionPlan, WorkflowDefinitionV1 } from "../../src/domain/workflow.js";
import type { WorkflowIdentity } from "../../src/domain/workflow-package.js";
import { nodeOutputPaths, prepareNodeOutput } from "../../src/infrastructure/process-runner.js";
import { StateStore } from "../../src/infrastructure/state-store.js";
import { acquireCanonicalWorkspaceLock } from "../../src/infrastructure/workspace-lock.js";
import {
  isViewerLoopbackPeer,
  readViewerClientAsset,
  startViewerServer,
} from "../../src/infrastructure/viewer-server.js";
import type { ViewerServerHandle } from "../../src/infrastructure/viewer-server.js";
import type {
  ScopedRunListResponse,
  SessionBootstrapResponse,
  ViewerApiErrorResponse,
} from "../../src/ui/contracts.js";

interface HttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: OutgoingHttpHeaders;
  readonly body?: string;
  readonly localAddress?: string;
}

interface ServerFixture {
  readonly handle: ViewerServerHandle;
  readonly dataDirectory: string;
  readonly cwd: string;
  readonly targetRunId: string;
  readonly rerunId: string;
  readonly recoveryId: string;
  readonly otherWorkflowRunId: string;
  readonly otherCwdRunId: string;
  readonly resultPath: string;
}

const temporaryDirectories: string[] = [];
const serverHandles: ViewerServerHandle[] = [];

const definition = (workflowId: string): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: workflowId, name: `${workflowId} workflow` },
  nodes: [
    {
      id: "inspect",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      prompt: "Inspect the workspace",
    },
  ],
  edges: [],
});

const approvalDefinition = (): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id: "approval-viewer", name: "Approval viewer workflow" },
  nodes: [
    {
      id: "release-approval",
      kind: "approval",
      question: "Approve preparing the change?",
    },
    {
      id: "prepare",
      kind: "agent",
      runtime: "codex",
      access: "workspace_write",
      output: { type: "artifact", path: ".kilin/artifacts/change-plan.json" },
      prompt: "Prepare the change plan",
    },
    {
      id: "review",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      output: { type: "json" },
      prompt: "Review the prepared plan",
    },
  ],
  edges: [
    { from: "release-approval", to: "prepare" },
    { from: "prepare", to: "review", input: "change_plan" },
  ],
});

const projectIdentity = (plan: ExecutionPlan, root: string): WorkflowIdentity => ({
  scope: { kind: "project", root },
  workflowId: plan.definition.workflow.id,
});

const requestViewer = (
  handle: ViewerServerHandle,
  options: RequestOptions = {},
): Promise<HttpResponse> => {
  const target = new URL(handle.origin);
  const body = options.body;
  const headers: OutgoingHttpHeaders = {
    Host: target.host,
    Connection: "close",
    ...options.headers,
  };
  if (body !== undefined) {
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers,
        ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: unknown) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
        });
        response.once("end", () => {
          resolveResponse({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", rejectResponse);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
};

const sessionToken = (handle: ViewerServerHandle): string => {
  const token = new URLSearchParams(new URL(handle.url).hash.slice(1)).get("token");
  if (token === null) {
    throw new Error("Viewer URL did not contain a launch token");
  }
  return token;
};

const exchangeSession = async (
  handle: ViewerServerHandle,
): Promise<{ readonly cookie: string; readonly csrfToken: string; readonly setCookie: string }> => {
  const response = await requestViewer(handle, {
    method: "POST",
    path: "/session",
    headers: {
      Origin: handle.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: sessionToken(handle) }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers["set-cookie"]?.[0];
  expect(setCookie).toBeDefined();
  if (setCookie === undefined) {
    throw new Error("Viewer session response did not set a cookie");
  }
  const bootstrap = JSON.parse(response.body) as SessionBootstrapResponse;
  return {
    cookie: setCookie.split(";", 1)[0] ?? "",
    csrfToken: bootstrap.csrfToken,
    setCookie,
  };
};

const authenticatedHeaders = (session: {
  readonly cookie: string;
  readonly csrfToken: string;
}): OutgoingHttpHeaders => ({
  Cookie: session.cookie,
  "X-Kilin-CSRF": session.csrfToken,
});

const createServerFixture = async (): Promise<ServerFixture> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-viewer-server-"));
  temporaryDirectories.push(root);
  const dataDirectory = join(root, "state");
  const cwd = join(root, "project", "workspace");
  const otherCwd = join(root, "project", "other-workspace");
  const workflowFile = join(root, "workflow.yaml");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(otherCwd, { recursive: true })]);
  const plan = compileWorkflow(definition("target-workflow"));
  const otherPlan = compileWorkflow(definition("other-workflow"));
  const identity = projectIdentity(plan, join(root, "project"));
  const otherIdentity = projectIdentity(otherPlan, join(root, "project"));
  await writeFile(workflowFile, JSON.stringify(plan.definition), "utf8");

  const store = new StateStore(dataDirectory);
  const options = {
    nodeTimeoutMs: 60_000,
    approvalTimeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    maxParallel: 1,
  };
  const target = store.createRun({ plan, identity, canonicalCwd: cwd, options });
  const targetNode = target.nodes[0];
  if (targetNode === undefined) {
    throw new Error("Test workflow did not create its node record");
  }
  const paths = nodeOutputPaths(
    dataDirectory,
    target.run.id,
    targetNode.nodeId,
    targetNode.ordinal,
  );
  await prepareNodeOutput(paths);
  await writeFile(paths.resultPath, `${"x".repeat(70_000)}server-tail`, "utf8");
  store.transitionNode(target.run.id, targetNode.nodeId, { status: "running", ...paths });
  store.recordRunWorkspace(
    target.run.id,
    "changes",
    join(dataDirectory, "worktrees", "changes"),
    "0123456789abcdef0123456789abcdef01234567",
  );
  const rerun = store.createRun({
    plan,
    identity,
    canonicalCwd: cwd,
    options,
    rerunOfRunId: target.run.id,
  });
  store.transitionNode(rerun.run.id, "inspect", { status: "skipped" });
  store.transitionRun(rerun.run.id, {
    status: "failed",
    failure: { code: "NODE_EXIT_NONZERO", message: "Fixture failure" },
  });
  const recovery = store.createRun({
    plan,
    identity,
    canonicalCwd: cwd,
    options,
    recoveryOfRunId: rerun.run.id,
    recoveryMode: "retry",
  });
  const otherWorkflow = store.createRun({
    plan: otherPlan,
    identity: otherIdentity,
    canonicalCwd: cwd,
    options,
  });
  const otherDirectory = store.createRun({
    plan,
    identity,
    canonicalCwd: otherCwd,
    options,
  });
  store.close();

  const handle = await startViewerServer({
    definitionFile: workflowFile,
    identity,
    canonicalCwd: cwd,
    dataDirectory,
    clientJavaScript: "document.documentElement.dataset.viewer = 'ready';",
    pollIntervalMs: 1_000,
  });
  serverHandles.push(handle);
  return {
    handle,
    dataDirectory,
    cwd,
    targetRunId: target.run.id,
    rerunId: rerun.run.id,
    recoveryId: recovery.run.id,
    otherWorkflowRunId: otherWorkflow.run.id,
    otherCwdRunId: otherDirectory.run.id,
    resultPath: paths.resultPath,
  };
};

interface ApprovalFixture {
  readonly handle: ViewerServerHandle;
  readonly dataDirectory: string;
  readonly cwd: string;
  readonly runId: string;
  readonly outOfScopeRunId: string;
  readonly requestedAt: string | undefined;
  readonly deadlineAt: string | undefined;
}

const createApprovalFixture = async (): Promise<ApprovalFixture> => {
  const root = await mkdtemp(join(tmpdir(), "kilin-viewer-approval-"));
  temporaryDirectories.push(root);
  const dataDirectory = join(root, "state");
  const cwd = join(root, "workspace");
  const otherCwd = join(root, "other-workspace");
  const workflowFile = join(root, "workflow.yaml");
  await Promise.all([mkdir(cwd), mkdir(otherCwd)]);
  const plan = compileWorkflow(approvalDefinition());
  const identity = projectIdentity(plan, root);
  await writeFile(workflowFile, JSON.stringify(plan.definition), "utf8");
  const store = new StateStore(dataDirectory);
  const options = {
    nodeTimeoutMs: 60_000,
    approvalTimeoutMs: 60_000,
    maxOutputBytes: 1_048_576,
    maxParallel: 1,
  };
  const created = store.createRun({ plan, identity, canonicalCwd: cwd, options });
  const requested = store.requestApproval(created.run.id, "release-approval");
  const outOfScope = store.createRun({ plan, identity, canonicalCwd: otherCwd, options });
  store.close();
  const clientJavaScript = await readFile(join(process.cwd(), "dist/ui/client.js"), "utf8");
  const handle = await startViewerServer({
    definitionFile: workflowFile,
    identity,
    canonicalCwd: cwd,
    dataDirectory,
    clientJavaScript,
  });
  serverHandles.push(handle);
  return {
    handle,
    dataDirectory,
    cwd,
    runId: created.run.id,
    outOfScopeRunId: outOfScope.run.id,
    requestedAt: requested.requestedAt,
    deadlineAt: requested.deadlineAt,
  };
};

const storedApprovalDecision = (dataDirectory: string, runId: string): unknown => {
  const database = new Database(join(dataDirectory, "kilin.db"), {
    readonly: true,
    fileMustExist: true,
  });
  const row: unknown = database
    .prepare(
      `
    SELECT approval_decision, approval_actor, approval_note
    FROM node_runs WHERE run_id = ? AND node_id = 'release-approval'
  `,
    )
    .get(runId);
  database.close();
  return row;
};

const storedLifecycle = (dataDirectory: string): readonly unknown[] => {
  const database = new Database(join(dataDirectory, "kilin.db"), {
    readonly: true,
    fileMustExist: true,
  });
  const rows = database
    .prepare(
      `
    SELECT id, status, started_at, finished_at, failure_code, failure_message
    FROM workflow_runs ORDER BY id
  `,
    )
    .all();
  database.close();
  return rows;
};

afterEach(async () => {
  await Promise.all(serverHandles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("viewer client asset", () => {
  const packageRootFixture = async (): Promise<string> => {
    const packageRoot = await mkdtemp(join(tmpdir(), "kilin-viewer-asset-"));
    temporaryDirectories.push(packageRoot);
    return packageRoot;
  };

  const moduleUrl = (packageRoot: string, modulePath: string): string =>
    pathToFileURL(join(packageRoot, modulePath)).href;

  it("reads the built asset from both the source and the build entry point", async () => {
    const packageRoot = await packageRootFixture();
    await mkdir(join(packageRoot, "dist/ui"), { recursive: true });
    await writeFile(join(packageRoot, "dist/ui/client.js"), "export const viewer = 1;\n", "utf8");

    await expect(
      readViewerClientAsset(moduleUrl(packageRoot, "src/infrastructure/viewer-server.ts")),
    ).resolves.toBe("export const viewer = 1;\n");
    await expect(
      readViewerClientAsset(moduleUrl(packageRoot, "dist/infrastructure/viewer-server.js")),
    ).resolves.toBe("export const viewer = 1;\n");
  });

  it("names the build command and the expected path when the asset is missing", async () => {
    const packageRoot = await packageRootFixture();

    const failure = await readViewerClientAsset(
      moduleUrl(packageRoot, "src/infrastructure/viewer-server.ts"),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(KilinError);
    const error = failure as KilinError;
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toContain("pnpm --filter @kilin-space/cli build");
    expect(error.path).toBe(join(packageRoot, "dist/ui/client.js"));
  });

  it("reports an unreadable asset as its own failure instead of a missing build", async () => {
    const packageRoot = await packageRootFixture();
    await mkdir(join(packageRoot, "dist/ui/client.js"), { recursive: true });

    const failure = await readViewerClientAsset(
      moduleUrl(packageRoot, "src/infrastructure/viewer-server.ts"),
    ).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(KilinError);
    expect((failure as NodeJS.ErrnoException).code).toBe("EISDIR");
  });
});

describe("viewer server request boundary and sessions", () => {
  it("serves only fixed local assets and enforces Host, Origin, remote address, and methods", async () => {
    const { handle } = await createServerFixture();
    expect(new URL(handle.origin)).toMatchObject({ protocol: "http:", hostname: "127.0.0.1" });

    const root = await requestViewer(handle);
    expect(root.status).toBe(200);
    expect(root.body).toContain("Kilin workflow viewer");
    expect(root.body).not.toContain(sessionToken(handle));
    expect(root.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(root.headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(root.headers["content-security-policy"]).not.toContain("unsafe-eval");
    expect((await requestViewer(handle, { path: "/assets/viewer.css" })).status).toBe(200);
    expect((await requestViewer(handle, { path: "/assets/client.js" })).status).toBe(200);
    expect((await requestViewer(handle, { path: "/src/ui/client.ts" })).status).toBe(404);

    const wrongMethod = await requestViewer(handle, {
      method: "POST",
      path: "/",
      headers: { Origin: handle.origin },
    });
    expect(wrongMethod).toMatchObject({ status: 405 });
    expect(wrongMethod.headers.allow).toBe("GET");
    expect((await requestViewer(handle, { path: "/api/runs" })).status).toBe(401);
    expect((await requestViewer(handle, { path: "/api/runs?limit=1" })).status).toBe(404);
    expect((await requestViewer(handle, { method: "OPTIONS", path: "/api/runs" })).status).toBe(
      405,
    );

    const invalidHost = await requestViewer(handle, {
      headers: { Host: "localhost:1" },
    });
    expect(invalidHost.status).toBe(403);
    const invalidOrigin = await requestViewer(handle, {
      headers: { Origin: "http://localhost:9999" },
    });
    expect(invalidOrigin.status).toBe(403);
    expect(isViewerLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isViewerLoopbackPeer("127.0.0.2")).toBe(false);
    expect(isViewerLoopbackPeer("::1")).toBe(false);
    expect(isViewerLoopbackPeer(undefined)).toBe(false);
  });

  it("exchanges the fragment token once and requires its cookie and CSRF token afterward", async () => {
    const { handle } = await createServerFixture();
    const token = sessionToken(handle);
    const missingOrigin = await requestViewer(handle, {
      method: "POST",
      path: "/session",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(missingOrigin.status).toBe(403);
    const invalidToken = await requestViewer(handle, {
      method: "POST",
      path: "/session",
      headers: { Origin: handle.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: `${token}invalid` }),
    });
    expect(invalidToken.status).toBe(401);

    const session = await exchangeSession(handle);
    expect(session.setCookie).toContain("HttpOnly");
    expect(session.setCookie).toContain("SameSite=Strict");
    expect(session.setCookie).not.toMatch(/;\s*Secure(?:;|$)/iu);
    const cookieHeader = await requestViewer(handle, {
      method: "POST",
      path: "/session/resume",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(cookieHeader.status).toBe(200);
    const exchangeAgain = await requestViewer(handle, {
      method: "POST",
      path: "/session",
      headers: { Origin: handle.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(exchangeAgain.status).toBe(401);

    const unauthenticatedResume = await requestViewer(handle, {
      method: "POST",
      path: "/session/resume",
      headers: { Origin: handle.origin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthenticatedResume.status).toBe(401);
    expect(
      (
        await requestViewer(handle, {
          path: "/api/workflow",
          headers: { Cookie: session.cookie },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await requestViewer(handle, {
          path: "/api/workflow",
          headers: authenticatedHeaders(session),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await requestViewer(handle, {
          path: "/api/workflow",
          headers: { ...authenticatedHeaders(session), Origin: "http://localhost:9999" },
        })
      ).status,
    ).toBe(403);

    const setCookie = (
      await requestViewer(handle, {
        method: "POST",
        path: "/session/resume",
        headers: {
          Origin: handle.origin,
          Cookie: session.cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).headers["set-cookie"];
    expect(setCookie).toBeUndefined();
    expect(session.cookie).toMatch(/^kilin_session_[A-Za-z0-9_-]+=/u);
  });

  it("keeps concurrent viewer sessions isolated under distinct host-scoped cookie names", async () => {
    const first = await createServerFixture();
    const second = await createServerFixture();
    const firstSession = await exchangeSession(first.handle);
    const secondSession = await exchangeSession(second.handle);
    const combinedCookies = `${firstSession.cookie}; ${secondSession.cookie}`;

    expect(firstSession.cookie.split("=", 1)[0]).not.toBe(secondSession.cookie.split("=", 1)[0]);
    expect(
      (
        await requestViewer(first.handle, {
          path: "/api/runs",
          headers: { Cookie: combinedCookies, "X-Kilin-CSRF": firstSession.csrfToken },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await requestViewer(second.handle, {
          path: "/api/runs",
          headers: { Cookie: combinedCookies, "X-Kilin-CSRF": secondSession.csrfToken },
        })
      ).status,
    ).toBe(200);
  });
});

describe("viewer server read-only records and output", () => {
  it("returns empty history when state is absent without creating a data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kilin-viewer-empty-state-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, "missing-state");
    const cwd = join(root, "workspace");
    const workflowFile = join(root, "workflow.yaml");
    await mkdir(cwd);
    const plan = compileWorkflow(definition("target-workflow"));
    const identity = projectIdentity(plan, cwd);
    await writeFile(workflowFile, JSON.stringify(plan.definition), "utf8");
    const handle = await startViewerServer({
      definitionFile: workflowFile,
      identity,
      canonicalCwd: cwd,
      dataDirectory,
      clientJavaScript: "",
    });
    serverHandles.push(handle);
    const session = await exchangeSession(handle);

    const response = await requestViewer(handle, {
      path: "/api/runs",
      headers: authenticatedHeaders(session),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ workflowId: "target-workflow", runs: [] });
    expect(existsSync(dataDirectory)).toBe(false);
  });

  it("fails closed when a stored revision claims a non-V1 workflow schema", async () => {
    const fixture = await createServerFixture();
    const databasePath = join(fixture.dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    database.pragma("ignore_check_constraints = ON");
    database.prepare("UPDATE workflow_revisions SET schema_version = 2").run();
    database.pragma("ignore_check_constraints = OFF");
    database.close();
    const beforeMtime = (await stat(databasePath)).mtimeMs;
    const session = await exchangeSession(fixture.handle);

    const detail = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.targetRunId}`,
      headers: authenticatedHeaders(session),
    });

    expect(detail.status).toBe(500);
    expect(JSON.parse(detail.body)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect((await stat(databasePath)).mtimeMs).toBe(beforeMtime);
  });

  it("isolates workflow and cwd records, preserves lifecycle state, and authorizes bounded outputs", async () => {
    const fixture = await createServerFixture();
    const session = await exchangeSession(fixture.handle);
    const headers = authenticatedHeaders(session);
    const before = storedLifecycle(fixture.dataDirectory);
    const databaseMtime = (await stat(join(fixture.dataDirectory, "kilin.db"))).mtimeMs;

    const runsResponse = await requestViewer(fixture.handle, { path: "/api/runs", headers });
    expect(runsResponse.status).toBe(200);
    const runList = JSON.parse(runsResponse.body) as { runs: { runId: string }[] };
    expect(runList.runs.map(({ runId }) => runId).sort()).toEqual(
      [fixture.targetRunId, fixture.rerunId, fixture.recoveryId].sort(),
    );
    expect(runsResponse.body).not.toContain(fixture.cwd);
    expect(runsResponse.body).not.toContain(fixture.dataDirectory);
    expect(
      (
        await requestViewer(fixture.handle, {
          path: `/api/runs/${fixture.otherWorkflowRunId}`,
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await requestViewer(fixture.handle, {
          path: `/api/runs/${fixture.otherCwdRunId}`,
          headers,
        })
      ).status,
    ).toBe(404);

    const detailResponse = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.rerunId}`,
      headers,
    });
    expect(detailResponse.status).toBe(200);
    expect(JSON.parse(detailResponse.body)).toMatchObject({
      run: { runId: fixture.rerunId },
      lineage: {
        selectedRunIndex: 1,
        runs: [{ runId: fixture.targetRunId }, { runId: fixture.rerunId }],
      },
    });
    expect(detailResponse.body).not.toContain(fixture.dataDirectory);

    const recoveryResponse = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.recoveryId}`,
      headers,
    });
    expect(recoveryResponse.status).toBe(200);
    expect(JSON.parse(recoveryResponse.body)).toMatchObject({
      run: {
        runId: fixture.recoveryId,
        recoveryOfRunId: fixture.rerunId,
        recoveryMode: "retry",
      },
      lineage: {
        selectedRunIndex: 2,
        runs: [
          { runId: fixture.targetRunId },
          { runId: fixture.rerunId, rerunOfRunId: fixture.targetRunId },
          {
            runId: fixture.recoveryId,
            recoveryOfRunId: fixture.rerunId,
            recoveryMode: "retry",
          },
        ],
      },
    });

    const targetDetailResponse = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.targetRunId}`,
      headers,
    });
    expect(targetDetailResponse.status).toBe(200);
    expect(JSON.parse(targetDetailResponse.body)).toMatchObject({
      attempts: [{ executionId: "inspect", attempt: 1, status: "running" }],
      workspaces: [
        {
          workspaceId: "changes",
          baseCommit: "0123456789abcdef0123456789abcdef01234567",
          status: "provisioned",
        },
      ],
    });
    expect(targetDetailResponse.body).not.toContain(join("worktrees", "changes"));
    expect(targetDetailResponse.body).not.toContain(fixture.resultPath);

    const outputResponse = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.targetRunId}/nodes/0/output/result`,
      headers,
    });
    expect(outputResponse.status).toBe(200);
    expect(JSON.parse(outputResponse.body)).toMatchObject({
      runId: fixture.targetRunId,
      ordinal: 0,
      stream: "result",
      totalBytes: 70_011,
      returnedBytes: 65_536,
      truncated: true,
    });
    expect(outputResponse.body).toContain("server-tail");
    expect(
      (
        await requestViewer(fixture.handle, {
          path: `/api/runs/${fixture.targetRunId}/nodes/0/output/../../secret`,
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await requestViewer(fixture.handle, {
          method: "POST",
          path: `/api/runs/${fixture.targetRunId}/nodes/0/output/result`,
          headers: { ...headers, Origin: fixture.handle.origin },
        })
      ).status,
    ).toBe(405);

    const externalSecret = join(dirname(fixture.dataDirectory), "external-secret.txt");
    await writeFile(externalSecret, "outside", "utf8");
    await unlink(fixture.resultPath);
    await symlink(externalSecret, fixture.resultPath);
    expect(
      (
        await requestViewer(fixture.handle, {
          path: `/api/runs/${fixture.targetRunId}/nodes/0/output/result`,
          headers,
        })
      ).status,
    ).toBe(404);

    expect(storedLifecycle(fixture.dataDirectory)).toEqual(before);
    expect((await stat(join(fixture.dataDirectory, "kilin.db"))).mtimeMs).toBe(databaseMtime);
  });

  it("derives the waiting-for-approval flag from stored approval state without scope leakage", async () => {
    const root = await mkdtemp(join(tmpdir(), "kilin-viewer-waiting-"));
    temporaryDirectories.push(root);
    const dataDirectory = join(root, "state");
    const cwd = join(root, "workspace");
    const otherCwd = join(root, "other-workspace");
    const workflowFile = join(root, "workflow.yaml");
    await Promise.all([mkdir(cwd), mkdir(otherCwd)]);
    const plan = compileWorkflow(approvalDefinition());
    const otherApprovalPlan = compileWorkflow({
      ...approvalDefinition(),
      workflow: { id: "other-approval-viewer", name: "Other approval workflow" },
    });
    const identity = projectIdentity(plan, root);
    await writeFile(workflowFile, JSON.stringify(plan.definition), "utf8");
    const options = {
      nodeTimeoutMs: 60_000,
      approvalTimeoutMs: 60_000,
      maxOutputBytes: 1_048_576,
      maxParallel: 1,
    };
    const store = new StateStore(dataDirectory);
    const waitingUndecided = store.createRun({ plan, identity, canonicalCwd: cwd, options });
    store.requestApproval(waitingUndecided.run.id, "release-approval");
    const decidedWaiting = store.createRun({ plan, identity, canonicalCwd: cwd, options });
    store.requestApproval(decidedWaiting.run.id, "release-approval");
    store.recordApprovalDecision(decidedWaiting.run.id, "release-approval", "approve", "human");
    const plainRunning = store.createRun({ plan, identity, canonicalCwd: cwd, options });
    const terminal = store.createRun({ plan, identity, canonicalCwd: cwd, options });
    store.skipPendingNodes(terminal.run.id);
    store.transitionRun(terminal.run.id, { status: "succeeded" });
    const otherCwdWaiting = store.createRun({ plan, identity, canonicalCwd: otherCwd, options });
    store.requestApproval(otherCwdWaiting.run.id, "release-approval");
    const otherWorkflowWaiting = store.createRun({
      plan: otherApprovalPlan,
      identity: projectIdentity(otherApprovalPlan, root),
      canonicalCwd: otherCwd,
      options,
    });
    store.requestApproval(otherWorkflowWaiting.run.id, "release-approval");
    store.close();

    const handle = await startViewerServer({
      definitionFile: workflowFile,
      identity,
      canonicalCwd: cwd,
      dataDirectory,
      clientJavaScript: "",
    });
    serverHandles.push(handle);
    const session = await exchangeSession(handle);
    const response = await requestViewer(handle, {
      path: "/api/runs",
      headers: authenticatedHeaders(session),
    });

    expect(response.status).toBe(200);
    const list = JSON.parse(response.body) as ScopedRunListResponse;
    const runsById = new Map(list.runs.map((run) => [run.runId, run]));
    expect(runsById.get(waitingUndecided.run.id)).toMatchObject({ waitingForApproval: true });
    for (const runId of [decidedWaiting.run.id, plainRunning.run.id, terminal.run.id]) {
      expect(runsById.get(runId)).toBeDefined();
      expect(runsById.get(runId)).not.toHaveProperty("waitingForApproval");
    }
    expect(runsById.has(otherCwdWaiting.run.id)).toBe(false);
    expect(runsById.has(otherWorkflowWaiting.run.id)).toBe(false);
  });

  it("records a scoped human decision through the guarded route while the attached run holds its workspace", async () => {
    const fixture = await createApprovalFixture();
    const lock = await acquireCanonicalWorkspaceLock(fixture.cwd, fixture.dataDirectory);
    try {
      const session = await exchangeSession(fixture.handle);
      const headers = authenticatedHeaders(session);
      const decisionPath = `/api/runs/${fixture.runId}/nodes/release-approval/decision`;
      const postHeaders = {
        ...headers,
        Origin: fixture.handle.origin,
        "Content-Type": "application/json",
      };
      const approvedBody = JSON.stringify({ decision: "approved", note: "Ship it" });

      const waiting = await requestViewer(fixture.handle, {
        path: `/api/runs/${fixture.runId}`,
        headers,
      });
      expect(waiting.status).toBe(200);
      expect(JSON.parse(waiting.body)).toMatchObject({
        nodes: [
          {
            nodeId: "release-approval",
            status: "waiting_for_approval",
            question: "Approve preparing the change?",
            requestedAt: fixture.requestedAt,
            deadlineAt: fixture.deadlineAt,
          },
          { nodeId: "prepare", outputType: "artifact" },
          { nodeId: "review", outputType: "json" },
        ],
      });
      expect(JSON.parse(waiting.body)).not.toMatchObject({
        nodes: [{ decision: {} }, {}, {}],
      });

      const methodResponse = await requestViewer(fixture.handle, {
        method: "GET",
        path: decisionPath,
        headers,
      });
      expect(methodResponse.status).toBe(405);
      expect(methodResponse.headers.allow).toBe("POST");
      expect(
        (
          await requestViewer(fixture.handle, {
            method: "POST",
            path: decisionPath,
            headers: { Origin: fixture.handle.origin, "Content-Type": "application/json" },
            body: approvedBody,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await requestViewer(fixture.handle, {
            method: "POST",
            path: decisionPath,
            headers: {
              Cookie: session.cookie,
              Origin: fixture.handle.origin,
              "Content-Type": "application/json",
            },
            body: approvedBody,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await requestViewer(fixture.handle, {
            method: "POST",
            path: decisionPath,
            headers: { ...postHeaders, Origin: "http://localhost:9999" },
            body: approvedBody,
          })
        ).status,
      ).toBe(403);
      for (const invalidBody of [
        "{}",
        JSON.stringify({ decision: "approve" }),
        JSON.stringify({ decision: "approved", actor: "agent" }),
        JSON.stringify({ decision: "approved", note: "n".repeat(1_001) }),
      ]) {
        expect(
          (
            await requestViewer(fixture.handle, {
              method: "POST",
              path: decisionPath,
              headers: postHeaders,
              body: invalidBody,
            })
          ).status,
        ).toBe(400);
      }
      expect(
        (
          await requestViewer(fixture.handle, {
            method: "POST",
            path: `/api/runs/${fixture.outOfScopeRunId}/nodes/release-approval/decision`,
            headers: postHeaders,
            body: approvedBody,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await requestViewer(fixture.handle, {
            method: "POST",
            path: "/api/runs/missing-run/nodes/release-approval/decision",
            headers: postHeaders,
            body: approvedBody,
          })
        ).status,
      ).toBe(404);
      const agentNodeResponse = await requestViewer(fixture.handle, {
        method: "POST",
        path: `/api/runs/${fixture.runId}/nodes/prepare/decision`,
        headers: postHeaders,
        body: approvedBody,
      });
      expect(agentNodeResponse.status).toBe(409);
      expect((JSON.parse(agentNodeResponse.body) as ViewerApiErrorResponse).error.code).toBe(
        "APPROVAL_NOT_WAITING",
      );
      expect(storedApprovalDecision(fixture.dataDirectory, fixture.runId)).toMatchObject({
        approval_decision: null,
        approval_actor: null,
        approval_note: null,
      });

      const recordedResponse = await requestViewer(fixture.handle, {
        method: "POST",
        path: decisionPath,
        headers: postHeaders,
        body: approvedBody,
      });
      expect(recordedResponse.status).toBe(200);
      expect(JSON.parse(recordedResponse.body)).toMatchObject({
        outputVersion: 1,
        runId: fixture.runId,
        nodeId: "release-approval",
        decision: { decision: "approve", actor: "human", note: "Ship it" },
      });
      expect(storedApprovalDecision(fixture.dataDirectory, fixture.runId)).toMatchObject({
        approval_decision: "approve",
        approval_actor: "human",
        approval_note: "Ship it",
      });
      const decided = await requestViewer(fixture.handle, {
        path: `/api/runs/${fixture.runId}`,
        headers,
      });
      expect(JSON.parse(decided.body)).toMatchObject({
        nodes: [
          {
            nodeId: "release-approval",
            status: "waiting_for_approval",
            decision: { decision: "approve", actor: "human", note: "Ship it" },
          },
          { nodeId: "prepare" },
          { nodeId: "review" },
        ],
      });
      const duplicate = await requestViewer(fixture.handle, {
        method: "POST",
        path: decisionPath,
        headers: postHeaders,
        body: approvedBody,
      });
      expect(duplicate.status).toBe(409);
      expect((JSON.parse(duplicate.body) as ViewerApiErrorResponse).error.code).toBe(
        "APPROVAL_NOT_WAITING",
      );
    } finally {
      await lock.release();
    }
  });

  it("records a rejection while attached and fails closed once the stale run reconciles", async () => {
    const fixture = await createApprovalFixture();
    const session = await exchangeSession(fixture.handle);
    const postHeaders = {
      ...authenticatedHeaders(session),
      Origin: fixture.handle.origin,
      "Content-Type": "application/json",
    };
    const decisionPath = `/api/runs/${fixture.runId}/nodes/release-approval/decision`;
    const lock = await acquireCanonicalWorkspaceLock(fixture.cwd, fixture.dataDirectory);
    try {
      const rejected = await requestViewer(fixture.handle, {
        method: "POST",
        path: decisionPath,
        headers: postHeaders,
        body: JSON.stringify({ decision: "rejected", note: "Not yet" }),
      });
      expect(rejected.status).toBe(200);
      expect(JSON.parse(rejected.body)).toMatchObject({
        decision: { decision: "reject", actor: "human", note: "Not yet" },
      });
      expect(storedApprovalDecision(fixture.dataDirectory, fixture.runId)).toMatchObject({
        approval_decision: "reject",
        approval_actor: "human",
        approval_note: "Not yet",
      });
    } finally {
      await lock.release();
    }

    const stale = await requestViewer(fixture.handle, {
      method: "POST",
      path: decisionPath,
      headers: postHeaders,
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(stale.status).toBe(409);
    expect((JSON.parse(stale.body) as ViewerApiErrorResponse).error.code).toBe(
      "APPROVAL_NOT_WAITING",
    );
    const detail = await requestViewer(fixture.handle, {
      path: `/api/runs/${fixture.runId}`,
      headers: authenticatedHeaders(session),
    });
    expect(JSON.parse(detail.body)).toMatchObject({ run: { status: "interrupted" } });
  });
});
