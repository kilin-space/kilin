import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { recordApprovalDecision } from "../application/runs.js";
import { ViewerApplication } from "../application/viewer.js";
import { KilinError } from "../domain/errors.js";
import type { RunDetail, RunListRecord } from "../domain/run-state.js";
import { maximumApprovalNoteCharacters } from "../domain/run-state.js";
import type { WorkflowIdentity } from "../domain/workflow-package.js";
import { sameWorkflowIdentity, workflowScopeRoot } from "../domain/workflow-package.js";
import { defaultRuntimeExecutables } from "./runtime-resolver.js";
import {
  decodeStoredNodeAttemptRow as attemptFromRow,
  decodeStoredNodeRunRow as nodeFromRow,
  decodeStoredRevisionRow as revisionFromRow,
  decodeStoredRunWorkspaceRow as workspaceFromRow,
  decodeStoredRunRow as runFromRow,
} from "./state-record-decoder.js";
import { assertCurrentStateSchema } from "./state-schema.js";
import type {
  StoredNodeAttemptRow as NodeAttemptRow,
  StoredNodeRunRow as NodeRow,
  StoredRevisionRow as RevisionRow,
  StoredRunWorkspaceRow as WorkspaceRow,
  StoredRunRow as RunRow,
} from "./state-record-decoder.js";
import { viewerCss, viewerHtml } from "../ui/assets.js";
import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  OutputStream,
  SessionBootstrapResponse,
  ViewerApiErrorResponse,
} from "../ui/contracts.js";

const loopbackHost = "127.0.0.1";
const databaseFileName = "kilin.db";
const maximumRequestBodyBytes = 4_096;
const maximumLineageLength = 1_000;
const defaultPollIntervalMs = 2_000;
const outputVersion = 1 as const;
const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

interface ScopedRunRow extends RunRow {
  readonly scope_kind: string;
  readonly scope_root: string;
  readonly workflow_id: string;
}

export interface StartViewerServerOptions {
  readonly definitionFile: string;
  readonly identity: WorkflowIdentity;
  readonly canonicalCwd: string;
  readonly dataDirectory: string;
  readonly clientJavaScript?: string;
  readonly pollIntervalMs?: number;
}

export interface ViewerServerHandle {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly allow?: string,
  ) {
    super(message);
  }
}

const stateFailure = (): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    "Kilin could not read its local viewer state. Check the data directory and restart the viewer.",
  );

const lineageParentId = (run: RunDetail["run"]): string | undefined => {
  if (run.rerunOfRunId !== undefined && run.recoveryOfRunId !== undefined) {
    throw stateFailure();
  }
  return run.recoveryOfRunId ?? run.rerunOfRunId;
};

class ReadonlyViewerStore {
  readonly #databasePath: string;
  #database: SqliteDatabase | undefined;

  public constructor(dataDirectory: string) {
    this.#databasePath = join(dataDirectory, databaseFileName);
  }

  public listScopedRuns(identity: WorkflowIdentity, canonicalCwd: string): RunListRecord[] {
    const database = this.#openIfAvailable();
    if (database === undefined) {
      return [];
    }
    try {
      const rows = database
        .prepare(
          `
        SELECT workflow_runs.*, workflow_revisions.scope_kind,
               workflow_revisions.scope_root, workflow_revisions.workflow_id
        FROM workflow_runs
        JOIN workflow_revisions ON workflow_revisions.id = workflow_runs.revision_id
        WHERE workflow_revisions.scope_kind = ?
          AND workflow_revisions.scope_root = ?
          AND workflow_revisions.workflow_id = ?
          AND workflow_runs.canonical_cwd = ?
        ORDER BY workflow_runs.started_at DESC, workflow_runs.rowid DESC
        LIMIT 50
      `,
        )
        .all(
          identity.scope.kind,
          workflowScopeRoot(identity.scope),
          identity.workflowId,
          canonicalCwd,
        ) as ScopedRunRow[];
      return rows.map((row) => ({
        ...runFromRow(row),
        scope: identity.scope,
        workflowId: identity.workflowId,
      }));
    } catch (error: unknown) {
      if (error instanceof KilinError) {
        throw error;
      }
      throw stateFailure();
    }
  }

  public getRun(runId: string): RunDetail | undefined {
    const database = this.#openIfAvailable();
    if (database === undefined) {
      return undefined;
    }
    try {
      const runRow = database.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as
        RunRow | undefined;
      if (runRow === undefined) {
        return undefined;
      }
      const revisionRow = database
        .prepare("SELECT * FROM workflow_revisions WHERE id = ?")
        .get(runRow.revision_id) as RevisionRow | undefined;
      if (revisionRow === undefined) {
        throw stateFailure();
      }
      const nodeRows = database
        .prepare(
          `
        SELECT * FROM node_runs WHERE run_id = ? ORDER BY ordinal
      `,
        )
        .all(runId) as NodeRow[];
      const attemptRows = database
        .prepare(
          `
            SELECT * FROM node_attempts WHERE run_id = ? ORDER BY node_id, attempt
          `,
        )
        .all(runId) as NodeAttemptRow[];
      const workspaceRows = database
        .prepare(
          `
            SELECT * FROM run_workspaces WHERE run_id = ? ORDER BY workspace_id
          `,
        )
        .all(runId) as WorkspaceRow[];
      return {
        run: runFromRow(runRow),
        revision: revisionFromRow(revisionRow),
        nodes: nodeRows.map(nodeFromRow),
        attempts: attemptRows.map(attemptFromRow),
        workspaces: workspaceRows.map((row) => workspaceFromRow(row, runId)),
      };
    } catch (error: unknown) {
      if (error instanceof KilinError) {
        throw error;
      }
      throw stateFailure();
    }
  }

  public lineage(detail: RunDetail): RunDetail[] {
    const reversed = [detail];
    const seen = new Set<string>([detail.run.id]);
    let parentId = lineageParentId(detail.run);
    while (parentId !== undefined) {
      if (seen.has(parentId) || reversed.length >= maximumLineageLength) {
        throw stateFailure();
      }
      const parent = this.getRun(parentId);
      if (parent === undefined) {
        throw stateFailure();
      }
      reversed.push(parent);
      seen.add(parentId);
      parentId = lineageParentId(parent.run);
    }
    return reversed.reverse();
  }

  public close(): void {
    if (this.#database?.open === true) {
      this.#database.close();
    }
    this.#database = undefined;
  }

  #openIfAvailable(): SqliteDatabase | undefined {
    if (this.#database?.open === true) {
      assertCurrentStateSchema(this.#database);
      return this.#database;
    }
    if (!existsSync(this.#databasePath)) {
      return undefined;
    }
    let database: SqliteDatabase | undefined;
    try {
      database = new Database(this.#databasePath, { readonly: true, fileMustExist: true });
      database.pragma("busy_timeout = 5000");
      database.pragma("query_only = ON");
      assertCurrentStateSchema(database);
      this.#database = database;
      return database;
    } catch {
      if (database?.open === true) {
        database.close();
      }
      throw stateFailure();
    }
  }
}

const secret = (): string => randomBytes(32).toString("base64url");

const secretDigest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

const secretsEqual = (provided: string | undefined, expectedDigest: Buffer): boolean => {
  if (provided === undefined) {
    return false;
  }
  return timingSafeEqual(secretDigest(provided), expectedDigest);
};

const commonHeaders = (): Readonly<Record<string, string>> => ({
  "Cache-Control": "no-store",
  "Content-Security-Policy": contentSecurityPolicy,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

const send = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...commonHeaders(),
    ...headers,
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Content-Type": contentType,
  });
  response.end(body);
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value), headers);
};

const sendError = (response: ServerResponse, error: HttpError): void => {
  const body: ViewerApiErrorResponse = {
    outputVersion,
    error: { code: error.code, message: error.message },
  };
  const headers = error.allow === undefined ? {} : { Allow: error.allow };
  sendJson(response, error.status, body, headers);
};

const methodNotAllowed = (allow: string): HttpError =>
  new HttpError(
    405,
    "METHOD_NOT_ALLOWED",
    `This viewer route accepts ${allow} only. Use the supported method and try again.`,
    allow,
  );

const notFound = (): HttpError =>
  new HttpError(404, "NOT_FOUND", "The requested viewer resource does not exist.");

const parseCookie = (request: IncomingMessage, name: string): string | undefined => {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    throw new HttpError(
      415,
      "CONTENT_TYPE_UNSUPPORTED",
      "This viewer route accepts an application/json request body.",
    );
  }
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maximumRequestBodyBytes
  ) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "The viewer request body is too large.");
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  await new Promise<void>((resolveBody, rejectBody) => {
    request.on("data", (chunk: unknown) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buffer.length;
      if (totalBytes <= maximumRequestBodyBytes) {
        chunks.push(buffer);
      }
    });
    request.once("end", resolveBody);
    request.once("error", rejectBody);
    request.resume();
  });
  if (totalBytes > maximumRequestBodyBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "The viewer request body is too large.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "REQUEST_INVALID", "The viewer request body is not valid JSON.");
  }
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireEmptyBody = (value: unknown): void => {
  if (!isPlainRecord(value) || Object.keys(value).length !== 0) {
    throw new HttpError(
      400,
      "REQUEST_INVALID",
      "The session resume request must contain an empty object.",
    );
  }
};

const approvalDecisionFromBody = (value: unknown): ApprovalDecisionRequest => {
  const requestInvalid = (): HttpError =>
    new HttpError(
      400,
      "REQUEST_INVALID",
      `The decision request must contain decision "approved" or "rejected" and may add a note of at most ${String(maximumApprovalNoteCharacters)} characters.`,
    );
  if (
    !isPlainRecord(value) ||
    !Object.keys(value).every((key) => key === "decision" || key === "note")
  ) {
    throw requestInvalid();
  }
  if (value.decision !== "approved" && value.decision !== "rejected") {
    throw requestInvalid();
  }
  if ("note" in value) {
    if (
      typeof value.note !== "string" ||
      Array.from(value.note).length > maximumApprovalNoteCharacters
    ) {
      throw requestInvalid();
    }
    return { decision: value.decision, note: value.note };
  }
  return { decision: value.decision };
};

const sessionTokenFromBody = (value: unknown): string => {
  if (!isPlainRecord(value) || Object.keys(value).length !== 1 || typeof value.token !== "string") {
    throw new HttpError(
      400,
      "REQUEST_INVALID",
      "The session request must contain only the launch token.",
    );
  }
  return value.token;
};

const requestPath = (request: IncomingMessage, origin: string): URL => {
  if (request.url === undefined) {
    throw new HttpError(400, "REQUEST_INVALID", "The viewer request URL is missing.");
  }
  try {
    return new URL(request.url, origin);
  } catch {
    throw new HttpError(400, "REQUEST_INVALID", "The viewer request URL is invalid.");
  }
};

const decodePathSegment = (segment: string): string => {
  try {
    const decoded = decodeURIComponent(segment);
    if (encodeURIComponent(decoded) !== segment) {
      throw notFound();
    }
    return decoded;
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw notFound();
  }
};

/**
 * Reads the built viewer client asset. `moduleUrl` must be a module in
 * `src/infrastructure/` or `dist/infrastructure/`; both resolve to `dist/ui/client.js`
 * under the package root, so the viewer serves identical bytes from source and from build.
 */
export const readViewerClientAsset = async (moduleUrl: string): Promise<string> => {
  const assetUrl = new URL("../../dist/ui/client.js", moduleUrl);
  try {
    return await readFile(assetUrl, "utf8");
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    throw new KilinError(
      "INTERNAL_ERROR",
      'The viewer client asset is missing. Build the CLI with "pnpm --filter @kilin-space/cli build" and start the viewer again.',
      fileURLToPath(assetUrl),
    );
  }
};

export const isViewerLoopbackPeer = (remoteAddress: string | undefined): boolean =>
  remoteAddress === loopbackHost;

export const startViewerServer = async (
  options: StartViewerServerOptions,
): Promise<ViewerServerHandle> => {
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1_000 || pollIntervalMs > 30_000) {
    throw new KilinError(
      "OPTION_INVALID",
      "Viewer polling must be an integer from 1000 through 30000 milliseconds.",
    );
  }
  const clientJavaScript =
    options.clientJavaScript ?? (await readViewerClientAsset(import.meta.url));
  const application = new ViewerApplication(options);
  const store = new ReadonlyViewerStore(options.dataDirectory);
  const launchToken = secret();
  const launchTokenDigest = secretDigest(launchToken);
  const sessionSecret = secret();
  const sessionSecretDigest = secretDigest(sessionSecret);
  const sessionCookieName = `kilin_session_${secret().slice(0, 24)}`;
  const csrfToken = secret();
  const csrfTokenDigest = secretDigest(csrfToken);
  let launchTokenConsumed = false;
  let sessionIssued = false;
  let origin = "";
  let expectedHost = "";

  const requireRequestBoundary = (request: IncomingMessage): void => {
    if (!isViewerLoopbackPeer(request.socket.remoteAddress)) {
      throw new HttpError(403, "REQUEST_FORBIDDEN", "The viewer accepts local requests only.");
    }
    if (request.headers.host !== expectedHost) {
      throw new HttpError(403, "REQUEST_FORBIDDEN", "The viewer request host is not allowed.");
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      throw new HttpError(403, "REQUEST_FORBIDDEN", "The viewer request origin is not allowed.");
    }
    if (request.method === "POST" && requestOrigin !== origin) {
      throw new HttpError(
        403,
        "REQUEST_FORBIDDEN",
        "The viewer POST origin is missing or invalid.",
      );
    }
  };

  const hasSessionCookie = (request: IncomingMessage): boolean =>
    sessionIssued && secretsEqual(parseCookie(request, sessionCookieName), sessionSecretDigest);

  const requireApiSession = (request: IncomingMessage): void => {
    if (!hasSessionCookie(request)) {
      throw new HttpError(
        401,
        "SESSION_REQUIRED",
        "Open the viewer from its current Kilin launch URL.",
      );
    }
    const header = request.headers["x-kilin-csrf"];
    const provided = typeof header === "string" ? header : undefined;
    if (!secretsEqual(provided, csrfTokenDigest)) {
      throw new HttpError(403, "CSRF_REQUIRED", "Refresh the viewer session and try again.");
    }
  };

  const sessionBootstrap = (): SessionBootstrapResponse => ({
    outputVersion,
    csrfToken,
    pollIntervalMs,
  });

  const scopedDetail = (runId: string): RunDetail => {
    const detail = store.getRun(runId);
    if (
      detail === undefined ||
      !sameWorkflowIdentity(
        { scope: detail.revision.scope, workflowId: detail.revision.workflowId },
        application.scope.identity,
      ) ||
      detail.run.canonicalCwd !== application.scope.canonicalCwd
    ) {
      throw new HttpError(
        404,
        "RUN_NOT_FOUND",
        "The selected run is not available in this viewer.",
      );
    }
    return detail;
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    requireRequestBoundary(request);
    const url = requestPath(request, origin);
    if (url.search.length !== 0) {
      throw notFound();
    }
    const path = url.pathname;

    if (path === "/") {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      send(response, 200, "text/html; charset=utf-8", viewerHtml);
      return;
    }
    if (path === "/assets/viewer.css") {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      send(response, 200, "text/css; charset=utf-8", viewerCss);
      return;
    }
    if (path === "/assets/client.js") {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      send(response, 200, "text/javascript; charset=utf-8", clientJavaScript);
      return;
    }
    if (path === "/session") {
      if (request.method !== "POST") {
        throw methodNotAllowed("POST");
      }
      const providedToken = sessionTokenFromBody(await readJsonBody(request));
      if (launchTokenConsumed || !secretsEqual(providedToken, launchTokenDigest)) {
        throw new HttpError(
          401,
          "SESSION_TOKEN_INVALID",
          "The viewer launch token is invalid or already used.",
        );
      }
      launchTokenConsumed = true;
      sessionIssued = true;
      sendJson(response, 200, sessionBootstrap(), {
        "Set-Cookie": `${sessionCookieName}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
      });
      return;
    }
    if (path === "/session/resume") {
      if (request.method !== "POST") {
        throw methodNotAllowed("POST");
      }
      requireEmptyBody(await readJsonBody(request));
      if (!hasSessionCookie(request)) {
        throw new HttpError(
          401,
          "SESSION_REQUIRED",
          "Open the viewer from its current Kilin launch URL.",
        );
      }
      sendJson(response, 200, sessionBootstrap());
      return;
    }
    if (path === "/api/workflow") {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      requireApiSession(request);
      sendJson(response, 200, await application.currentWorkflow());
      return;
    }
    if (path === "/api/runs") {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      requireApiSession(request);
      const records = store.listScopedRuns(
        application.scope.identity,
        application.scope.canonicalCwd,
      );
      sendJson(response, 200, application.runList(records));
      return;
    }

    const outputMatch =
      /^\/api\/runs\/([^/]+)\/nodes\/(0|[1-9]\d*)\/output\/(stdout|stderr|result)$/u.exec(path);
    if (outputMatch !== null) {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      requireApiSession(request);
      const runSegment = outputMatch[1];
      const ordinalSegment = outputMatch[2];
      const stream = outputMatch[3];
      if (runSegment === undefined || ordinalSegment === undefined || stream === undefined) {
        throw notFound();
      }
      const runId = decodePathSegment(runSegment);
      const ordinal = Number(ordinalSegment);
      if (!Number.isSafeInteger(ordinal)) {
        throw notFound();
      }
      sendJson(
        response,
        200,
        await application.output(scopedDetail(runId), ordinal, stream as OutputStream),
      );
      return;
    }

    const decisionMatch = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)\/decision$/u.exec(path);
    if (decisionMatch !== null) {
      if (request.method !== "POST") {
        throw methodNotAllowed("POST");
      }
      requireApiSession(request);
      const runSegment = decisionMatch[1];
      const nodeSegment = decisionMatch[2];
      if (runSegment === undefined || nodeSegment === undefined) {
        throw notFound();
      }
      const runId = decodePathSegment(runSegment);
      const nodeId = decodePathSegment(nodeSegment);
      const decisionRequest = approvalDecisionFromBody(await readJsonBody(request));
      scopedDetail(runId);
      const recorded = await recordApprovalDecision(
        runId,
        nodeId,
        decisionRequest.decision === "approved" ? "approve" : "reject",
        "human",
        decisionRequest.note,
        {
          dataDirectory: options.dataDirectory,
          userWorkflowsDirectory: join(homedir(), ".agents", "workflows"),
          runtimeExecutables: defaultRuntimeExecutables,
          environment: {},
        },
      );
      const decisionResponse: ApprovalDecisionResponse = {
        outputVersion,
        runId: recorded.runId,
        nodeId: recorded.nodeId,
        decision: {
          decision: recorded.decision,
          actor: recorded.actor,
          decidedAt: recorded.decidedAt,
          ...(recorded.note === undefined ? {} : { note: recorded.note }),
        },
      };
      sendJson(response, 200, decisionResponse);
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(path);
    if (runMatch !== null) {
      if (request.method !== "GET") {
        throw methodNotAllowed("GET");
      }
      requireApiSession(request);
      const runSegment = runMatch[1];
      if (runSegment === undefined) {
        throw notFound();
      }
      const detail = scopedDetail(decodePathSegment(runSegment));
      sendJson(response, 200, await application.runDetail(detail, store.lineage(detail)));
      return;
    }
    throw notFound();
  };

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(response, error);
        return;
      }
      if (error instanceof KilinError) {
        const status =
          error.code === "RUN_NOT_FOUND" ? 404 : error.code === "APPROVAL_NOT_WAITING" ? 409 : 500;
        sendError(response, new HttpError(status, error.code, error.message));
        return;
      }
      sendError(
        response,
        new HttpError(
          500,
          "INTERNAL_ERROR",
          "The viewer could not complete the request. Restart Kilin UI and try again.",
        ),
      );
    });
  });
  server.maxHeadersCount = 32;
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;

  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        rejectListening(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolveListening();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: loopbackHost, port: 0, exclusive: true });
    });
  } catch {
    store.close();
    throw new KilinError(
      "INTERNAL_ERROR",
      "Kilin could not start its local viewer. Check local networking permissions and try again.",
    );
  }

  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== loopbackHost) {
    server.close();
    store.close();
    throw new KilinError(
      "INTERNAL_ERROR",
      "Kilin could not confirm its numeric loopback viewer address. Close the viewer and try again.",
    );
  }
  expectedHost = `${loopbackHost}:${String(address.port)}`;
  origin = `http://${expectedHost}`;

  let storeClosed = false;
  const closeStore = (): void => {
    if (!storeClosed) {
      storeClosed = true;
      store.close();
    }
  };
  const closed = new Promise<void>((resolveClosed) => {
    server.once("close", () => {
      closeStore();
      resolveClosed();
    });
  });
  let closeRequested = false;
  const close = async (): Promise<void> => {
    if (!closeRequested) {
      closeRequested = true;
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        });
        server.closeIdleConnections();
      });
    }
    await closed;
  };

  return {
    origin,
    url: `${origin}/#token=${encodeURIComponent(launchToken)}`,
    close,
    waitUntilClosed: async () => closed,
  };
};
