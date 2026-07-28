import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { tryLock, unlock } from "fs-native-extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

import { compileWorkflow } from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type { RunDetail } from "../../src/domain/run-state.js";
import type {
  AgentNode,
  ExecutionPlan,
  WorkflowCompilationInput,
  WorkflowDefinitionV1,
} from "../../src/domain/workflow.js";
import type { WorkflowIdentity } from "../../src/domain/workflow-package.js";
import { initializeStateSchema } from "../../src/infrastructure/state-schema.js";
import {
  claimStateDatabaseFile,
  releaseStateDatabaseFileClaim,
  removeClaimedStateDatabaseFiles,
  StateStore,
  type CreateRunInput,
} from "../../src/infrastructure/state-store.js";

type TestCreateRunInput = Omit<CreateRunInput, "identity"> & {
  readonly identity?: WorkflowIdentity;
};

class TestStateStore extends StateStore {
  public override createRun(input: TestCreateRunInput): RunDetail {
    return super.createRun(this.#withIdentity(input));
  }

  public override createRunAfterStaleReconciliation(input: TestCreateRunInput): RunDetail {
    return super.createRunAfterStaleReconciliation(this.#withIdentity(input));
  }

  #withIdentity(input: TestCreateRunInput): CreateRunInput {
    return {
      ...input,
      identity: input.identity ?? {
        scope: { kind: "user" },
        workflowId: input.plan.definition.workflow.id,
      },
    };
  }
}

const temporaryDirectories: string[] = [];
const stores: StateStore[] = [];
const approvalDecisionChildren: ChildProcessWithoutNullStreams[] = [];

const createDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "kilin-state-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state");
};

const createStore = async (): Promise<{ dataDirectory: string; store: TestStateStore }> => {
  const dataDirectory = await createDirectory();
  const store = new TestStateStore(dataDirectory);
  stores.push(store);
  return { dataDirectory, store };
};

const createLegacyMigrationOneDatabase = async (): Promise<string> => {
  const dataDirectory = await createDirectory();
  await mkdir(dataDirectory);
  const database = new Database(join(dataDirectory, "kilin.db"));
  try {
    database.exec(
      await readFile(new URL("../fixtures/state-legacy-migration-1.sql", import.meta.url), "utf8"),
    );
  } finally {
    database.close();
  }
  return dataDirectory;
};

const node = (id: string, model?: string): AgentNode => ({
  id,
  kind: "agent",
  runtime: "codex",
  access: "read_only",
  prompt: `Run ${id}`,
  ...(model === undefined ? {} : { model }),
});

const plan = (
  workflowId = "state-test",
  nodes = [node("first"), node("second", "gpt-5")],
): ExecutionPlan => {
  const definition: WorkflowDefinitionV1 = {
    schemaVersion: 1,
    workflow: { id: workflowId, name: "State test" },
    nodes,
    edges:
      nodes.length < 2 ? [] : [{ from: nodes[0]?.id ?? "first", to: nodes[1]?.id ?? "second" }],
  };
  return compileWorkflow(definition);
};

const loopPlan = (
  loopNodeId = "feedback",
  bodyNodeId = "review",
  maxIterations = 1,
): ExecutionPlan =>
  compileWorkflow({
    schemaVersion: 1,
    workflow: { id: "loop-state", name: "Loop state" },
    nodes: [
      {
        id: loopNodeId,
        kind: "loop",
        maxIterations,
        body: {
          nodes: [
            { ...node(bodyNodeId), output: { type: "text" } },
            {
              ...node("decision"),
              output: { type: "choice", choices: ["pass", "revise"] },
            },
          ],
          edges: [{ from: bodyNodeId, to: "decision", input: "result" }],
        },
        decision: { node: "decision", passChoice: "pass", reviseChoice: "revise" },
        feedback: { from: bodyNodeId, to: bodyNodeId, input: "feedback" },
        result: { node: bodyNodeId },
      },
    ],
    edges: [],
  });

const staleLoopPlan = (): ExecutionPlan => loopPlan("feedback", "review", 2);

const options = {
  nodeTimeoutMs: 60_000,
  approvalTimeoutMs: 60_000,
  maxOutputBytes: 1_048_576,
  maxParallel: 1,
};
const validStoredTimestamp = "2026-07-21T00:00:00.000Z";

const expectKilinError = (operation: () => unknown, code: string): KilinError => {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code });
    return error as KilinError;
  }
  throw new Error("Expected the state operation to fail");
};

const expectSqliteError = (operation: () => unknown, code: string): void => {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error("Expected SQLite to reject the operation");
};

const mutateStoredRun = (
  dataDirectory: string,
  runId: string,
  setClause: string,
  bypassChecks = false,
): void => {
  const database = new Database(join(dataDirectory, "kilin.db"));
  try {
    if (bypassChecks) {
      database.pragma("ignore_check_constraints = ON");
    }
    database.prepare(`UPDATE workflow_runs SET ${setClause} WHERE id = ?`).run(runId);
  } finally {
    database.close();
  }
};

const mutateStoredNode = (
  dataDirectory: string,
  runId: string,
  setClause: string,
  bypassChecks = false,
): void => {
  const database = new Database(join(dataDirectory, "kilin.db"));
  try {
    if (bypassChecks) {
      database.pragma("ignore_check_constraints = ON");
    }
    database
      .prepare(
        `
      UPDATE node_runs SET ${setClause} WHERE run_id = ? AND node_id = 'first'
    `,
      )
      .run(runId);
  } finally {
    database.close();
  }
};

const replaceWithApprovalNode = (
  dataDirectory: string,
  runId: string,
  status: "pending" | "waiting_for_approval",
  deadlineAt?: string,
): void => {
  const database = new Database(join(dataDirectory, "kilin.db"));
  try {
    database
      .prepare(
        `
      UPDATE node_runs
      SET kind = 'approval', runtime = NULL, requested_model = NULL,
          output_type = NULL, artifact_path = NULL, status = ?,
          approval_requested_at = ?, approval_deadline_at = ?
      WHERE run_id = ? AND node_id = 'first'
    `,
      )
      .run(
        status,
        status === "waiting_for_approval" ? validStoredTimestamp : null,
        deadlineAt ?? null,
        runId,
      );
  } finally {
    database.close();
  }
};

interface StoredCorruptionCase {
  name: string;
  setClause: string;
  bypassChecks?: boolean;
}

const corruptRunCases: StoredCorruptionCase[] = [
  { name: "unknown status", setClause: "status = 'unknown'", bypassChecks: true },
  {
    name: "unknown failure code",
    setClause: `status = 'failed', finished_at = '${validStoredTimestamp}', failure_code = 'UNKNOWN_ERROR', failure_message = 'broken'`,
  },
  { name: "invalid started timestamp", setClause: "started_at = 'not-a-timestamp'" },
  { name: "running with a finish timestamp", setClause: `finished_at = '${validStoredTimestamp}'` },
  { name: "succeeded without a finish timestamp", setClause: "status = 'succeeded'" },
  {
    name: "cancelled with failure information",
    setClause: `status = 'cancelled', finished_at = '${validStoredTimestamp}', failure_code = 'INTERNAL_ERROR', failure_message = 'broken'`,
  },
  {
    name: "failed without failure information",
    setClause: `status = 'failed', finished_at = '${validStoredTimestamp}'`,
  },
  {
    name: "interrupted without a finish timestamp",
    setClause:
      "status = 'interrupted', failure_code = 'RUN_INTERRUPTED', failure_message = 'broken'",
  },
];

const startedNodeFields = `
  started_at = '${validStoredTimestamp}',
  stdout_path = '/state/stdout.log',
  stderr_path = '/state/stderr.log',
  result_path = '/state/result.txt'
`;

const finishedNodeFields = `${startedNodeFields}, finished_at = '${validStoredTimestamp}'`;
const approvalRowFields = `kind = 'approval', runtime = NULL, requested_model = NULL, approval_requested_at = '${validStoredTimestamp}', approval_deadline_at = '2026-07-21T00:02:00.000Z'`;

const corruptNodeCases: StoredCorruptionCase[] = [
  { name: "unknown status", setClause: "status = 'unknown'", bypassChecks: true },
  { name: "pending with a start timestamp", setClause: `started_at = '${validStoredTimestamp}'` },
  { name: "pending with observed runtime metadata", setClause: "effective_model = 'unexpected'" },
  { name: "skipped without a finish timestamp", setClause: "status = 'skipped'" },
  {
    name: "skipped with execution state",
    setClause: `status = 'skipped', started_at = '${validStoredTimestamp}', finished_at = '${validStoredTimestamp}'`,
  },
  {
    name: "running without a start timestamp",
    setClause:
      "status = 'running', stdout_path = '/state/stdout.log', stderr_path = '/state/stderr.log', result_path = '/state/result.txt'",
  },
  {
    name: "running with a finish timestamp",
    setClause: `status = 'running', ${finishedNodeFields}`,
  },
  {
    name: "succeeded with a nonzero exit",
    setClause: `status = 'succeeded', ${finishedNodeFields}, exit_code = 1`,
  },
  {
    name: "failed without failure information",
    setClause: `status = 'failed', ${finishedNodeFields}`,
  },
  {
    name: "interrupted without a finish timestamp",
    setClause: `status = 'interrupted', ${startedNodeFields}, failure_code = 'RUN_INTERRUPTED', failure_message = 'broken'`,
  },
  {
    name: "cancelled with failure information",
    setClause: `status = 'cancelled', ${finishedNodeFields}, failure_code = 'INTERNAL_ERROR', failure_message = 'broken'`,
  },
  { name: "negative ordinal", setClause: "ordinal = -1" },
  { name: "fractional ordinal", setClause: "ordinal = 0.5" },
  { name: "unsafe ordinal", setClause: "ordinal = 9007199254740992" },
  {
    name: "fractional exit code",
    setClause: `status = 'failed', ${finishedNodeFields}, exit_code = 1.5, failure_code = 'NODE_EXIT_NONZERO', failure_message = 'broken'`,
  },
  {
    name: "invalid start timestamp",
    setClause:
      "status = 'running', started_at = 'not-a-timestamp', stdout_path = '/state/stdout.log', stderr_path = '/state/stderr.log', result_path = '/state/result.txt'",
  },
  {
    name: "invalid finish timestamp",
    setClause: "status = 'skipped', finished_at = 'not-a-timestamp'",
  },
];

interface ChildProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

type ApprovalDecisionChildResult =
  | {
      recorded: {
        runId: string;
        nodeId: string;
        decision: "approve" | "reject";
        actor: "agent" | "human";
        decidedAt: string;
      };
    }
  | { error: { code: string; message: string } };

interface ApprovalDecisionChild {
  ready: Promise<void>;
  attempting: Promise<void>;
  complete: Promise<ApprovalDecisionChildResult>;
  start: () => void;
}

const bootstrapStateStoreInChildProcess = (dataDirectory: string): Promise<ChildProcessResult> =>
  new Promise((resolve, reject) => {
    const source = `
      import { StateStore } from "./src/infrastructure/state-store.ts";
      const store = new StateStore(process.argv[1]);
      process.stdout.write(JSON.stringify(store.listRuns()));
      store.close();
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source, dataDirectory],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });

const startApprovalDecisionChild = (
  dataDirectory: string,
  runId: string,
  decision: "approve" | "reject",
  actor: "agent" | "human",
): ApprovalDecisionChild => {
  const source = `
    import { KilinError } from "./src/domain/errors.ts";
    import { StateStore } from "./src/infrastructure/state-store.ts";
    const store = new StateStore(process.argv[1]);
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      process.stdout.write("attempting\\n");
      try {
        const recorded = store.recordApprovalDecision(
          process.argv[2],
          "first",
          process.argv[3],
          process.argv[4],
        );
        process.stdout.write(JSON.stringify({ recorded }));
      } catch (error) {
        const failure = error instanceof KilinError
          ? { code: error.code, message: error.message }
          : { code: "UNEXPECTED", message: "Unexpected child error" };
        process.stdout.write(JSON.stringify({ error: failure }));
      } finally {
        store.close();
      }
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      source,
      dataDirectory,
      runId,
      decision,
      actor,
    ],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
  approvalDecisionChildren.push(child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let readyResolved = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let attemptingResolved = false;
  let resolveAttempting: (() => void) | undefined;
  let rejectAttempting: ((error: Error) => void) | undefined;
  const attempting = new Promise<void>((resolve, reject) => {
    resolveAttempting = resolve;
    rejectAttempting = reject;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!readyResolved && stdout.startsWith("ready\n")) {
      readyResolved = true;
      resolveReady?.();
    }
    if (!attemptingResolved && stdout.includes("attempting\n")) {
      attemptingResolved = true;
      resolveAttempting?.();
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const complete = new Promise<ApprovalDecisionChildResult>((resolve, reject) => {
    child.once("error", (error) => {
      rejectReady?.(error);
      rejectAttempting?.(error);
      reject(error);
    });
    child.once("close", (exitCode) => {
      const earlyExit = new Error(
        `Approval decision child exited before signaling with ${String(exitCode)}`,
      );
      if (!readyResolved) {
        rejectReady?.(earlyExit);
      }
      if (!attemptingResolved) {
        rejectAttempting?.(earlyExit);
      }
      if (exitCode !== 0 || stderr !== "") {
        reject(new Error(`Approval decision child failed with ${String(exitCode)}: ${stderr}`));
        return;
      }
      try {
        const resultJson = stdout.trim().split("\n").at(-1);
        if (resultJson === undefined) {
          throw new Error("Approval decision child returned no result");
        }
        resolve(JSON.parse(resultJson) as ApprovalDecisionChildResult);
      } catch (error: unknown) {
        reject(
          error instanceof Error
            ? error
            : new Error("Approval decision child returned invalid JSON"),
        );
      }
    });
  });
  void ready.catch(() => undefined);
  void attempting.catch(() => undefined);
  void complete.catch(() => undefined);
  return {
    ready,
    attempting,
    complete,
    start: () => child.stdin.end("start\n"),
  };
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    approvalDecisionChildren.splice(0).map(async (child) => {
      if (child.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.kill();
      });
    }),
  );
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("StateStore bootstrap", () => {
  it("claims a fresh database file without replacing an existing owner's content", async () => {
    const dataDirectory = await createDirectory();
    await mkdir(dataDirectory);
    const databasePath = join(dataDirectory, "kilin.db");

    const claim = claimStateDatabaseFile(databasePath);
    expect(claim).toBeDefined();
    expect(typeof claim?.dev).toBe("number");
    expect(typeof claim?.ino).toBe("number");
    try {
      await writeFile(databasePath, "externally-owned-state", "utf8");

      expect(claimStateDatabaseFile(databasePath)).toBeUndefined();
      expect(await readFile(databasePath, "utf8")).toBe("externally-owned-state");
    } finally {
      if (claim !== undefined) {
        releaseStateDatabaseFileClaim(claim);
      }
    }
  });

  it("does not clean replacement state or sidecars after a claimed path changes ownership", async () => {
    const dataDirectory = await createDirectory();
    await mkdir(dataDirectory);
    const databasePath = join(dataDirectory, "kilin.db");
    const claim = claimStateDatabaseFile(databasePath);
    if (claim === undefined) {
      throw new Error("Expected the fresh database file claim to succeed");
    }
    try {
      await rm(databasePath);
      await writeFile(databasePath, "replacement-state", "utf8");
      await writeFile(`${databasePath}-wal`, "replacement-wal", "utf8");
      await writeFile(`${databasePath}-shm`, "replacement-shm", "utf8");

      removeClaimedStateDatabaseFiles(databasePath, claim);

      expect(await readFile(databasePath, "utf8")).toBe("replacement-state");
      expect(await readFile(`${databasePath}-wal`, "utf8")).toBe("replacement-wal");
      expect(await readFile(`${databasePath}-shm`, "utf8")).toBe("replacement-shm");
    } finally {
      releaseStateDatabaseFileClaim(claim);
    }
  });

  it("bounds the wait when another process owns the migration lock", async () => {
    const dataDirectory = await createDirectory();
    const locksDirectory = join(dataDirectory, "locks");
    await mkdir(locksDirectory, { recursive: true });
    const lockFileDescriptor = openSync(join(locksDirectory, "migrations.lock"), "a");
    expect(tryLock(lockFileDescriptor)).toBe(true);
    const startedAt = Date.now();

    try {
      expectKilinError(() => new TestStateStore(dataDirectory), "STATE_BUSY");
    } finally {
      unlock(lockFileDescriptor);
      closeSync(lockFileDescriptor);
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
  });

  it("creates the private V1 six-table WAL database with the complete current schema", async () => {
    const { dataDirectory, store } = await createStore();
    const databasePath = join(dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    const tables = database
      .prepare(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `,
      )
      .pluck()
      .all();

    expect(tables).toEqual([
      "node_attempts",
      "node_runs",
      "run_workspaces",
      "schema_migrations",
      "workflow_revisions",
      "workflow_runs",
    ]);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([1]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);
    database.pragma("synchronous = FULL");
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    database.close();

    if (process.platform !== "win32") {
      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dataDirectory, "locks"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(dataDirectory, "locks", "migrations.lock"))).mode & 0o777).toBe(
        0o600,
      );
    }

    expect(store.listRuns()).toEqual([]);
  });

  it("rejects an orphan workflow run through the declared foreign key", async () => {
    const { dataDirectory } = await createStore();
    const database = new Database(join(dataDirectory, "kilin.db"));
    database.pragma("foreign_keys = ON");

    expectSqliteError(
      () =>
        database
          .prepare(
            `
              INSERT INTO workflow_runs (
                id, revision_id, canonical_cwd, options_json, status, started_at
              ) VALUES (
                'orphan-run', 'missing-revision', '/project/orphan',
                '{"nodeTimeoutMs":1000,"maxOutputBytes":1024,"maxParallel":1}',
                'running', '2026-07-21T00:00:00.000Z'
              )
            `,
          )
          .run(),
      "SQLITE_CONSTRAINT_FOREIGNKEY",
    );

    expect(database.prepare("SELECT COUNT(*) FROM workflow_runs").pluck().get()).toBe(0);
    database.close();
  });

  it("serializes bootstrap from two Node processes against one fresh data directory", async () => {
    const dataDirectory = await createDirectory();
    const results = await Promise.all([
      bootstrapStateStoreInChildProcess(dataDirectory),
      bootstrapStateStoreInChildProcess(dataDirectory),
    ]);

    expect(results).toEqual([
      { exitCode: 0, stdout: "[]", stderr: "" },
      { exitCode: 0, stdout: "[]", stderr: "" },
    ]);
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([1]);
    expect(
      database
        .prepare(
          `
            SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          `,
        )
        .pluck()
        .get(),
    ).toBe(6);
    database.close();
  });

  it("rolls back the complete baseline when its ledger write fails", () => {
    const database = new Database(":memory:");
    const prepare = database.prepare.bind(database);
    const prepareSpy = vi.spyOn(database, "prepare").mockImplementation((source: string) => {
      if (source.startsWith("INSERT INTO schema_migrations")) {
        throw new Error("injected baseline failure");
      }
      return prepare(source);
    });

    expect(() => initializeStateSchema(database, validStoredTimestamp, true)).toThrow(
      "injected baseline failure",
    );
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([]);
    prepareSpy.mockRestore();
    initializeStateSchema(database, validStoredTimestamp, true);
    expect(database.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([1]);
    database.close();
  });

  it("rejects an existing database whose complete schema was removed", async () => {
    const dataDirectory = await createDirectory();
    const store = new TestStateStore(dataDirectory);
    store.close();
    const databasePath = join(dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    database.exec(`
      DROP TABLE node_attempts;
      DROP TABLE node_runs;
      DROP TABLE run_workspaces;
      DROP TABLE workflow_runs;
      DROP TABLE workflow_revisions;
      DROP TABLE schema_migrations;
    `);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([]);
    database.close();

    const error = expectKilinError(() => new StateStore(dataDirectory), "INTERNAL_ERROR");
    expect(error.message).toContain("Archive or reset");

    const after = new Database(databasePath, { readonly: true });
    expect(
      after.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([]);
    after.close();
  });

  it("rejects legacy migration-one state without changing its ledger or records", async () => {
    const dataDirectory = await createLegacyMigrationOneDatabase();
    const databasePath = join(dataDirectory, "kilin.db");
    const before = new Database(databasePath, { readonly: true });
    const beforeMigrations = before
      .prepare("SELECT * FROM schema_migrations ORDER BY version")
      .all();
    const beforeRevision = before.prepare("SELECT * FROM workflow_revisions").get();
    const beforeRun = before.prepare("SELECT * FROM workflow_runs").get();
    before.close();

    const error = expectKilinError(() => new StateStore(dataDirectory), "INTERNAL_ERROR");
    expect(error.message).toContain("Archive or reset");

    const after = new Database(databasePath, { readonly: true });
    expect(after.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      beforeMigrations,
    );
    expect(after.prepare("SELECT * FROM workflow_revisions").get()).toEqual(beforeRevision);
    expect(after.prepare("SELECT * FROM workflow_runs").get()).toEqual(beforeRun);
    after.close();
  });

  it("rejects the legacy eleven-entry migration ledger without changing it", async () => {
    const dataDirectory = await createDirectory();
    const store = new TestStateStore(dataDirectory);
    store.close();
    const databasePath = join(dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    const insert = database.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    );
    for (let version = 2; version <= 11; version += 1) {
      insert.run(version, validStoredTimestamp);
    }
    const beforeMigrations = database
      .prepare("SELECT * FROM schema_migrations ORDER BY version")
      .all();
    database.close();

    const error = expectKilinError(() => new StateStore(dataDirectory), "INTERNAL_ERROR");
    expect(error.message).toContain("Archive or reset");

    const after = new Database(databasePath, { readonly: true });
    expect(after.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(
      beforeMigrations,
    );
    after.close();
  });

  it.each([
    ["a missing table", "DROP TABLE run_workspaces"],
    ["a missing index", "DROP INDEX node_runs_loop_iteration_index"],
    [
      "a future ledger entry",
      `INSERT INTO schema_migrations (version, applied_at)
       VALUES (2, '2026-07-26T00:00:00.000Z')`,
    ],
  ])("rejects current state with %s without repairing it", async (_name, mutation) => {
    const dataDirectory = await createDirectory();
    const store = new TestStateStore(dataDirectory);
    store.close();
    const databasePath = join(dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    database.exec(mutation);
    const beforeObjects = database
      .prepare(
        `
          SELECT type, name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name
        `,
      )
      .all();
    database.close();

    const error = expectKilinError(() => new StateStore(dataDirectory), "INTERNAL_ERROR");
    expect(error.message).toContain("Archive or reset");

    const after = new Database(databasePath, { readonly: true });
    expect(
      after
        .prepare(
          `
            SELECT type, name, sql FROM sqlite_master
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY type, name
          `,
        )
        .all(),
    ).toEqual(beforeObjects);
    after.close();
  });

  it("rejects foreign-key corruption without rewriting the orphan row", async () => {
    const dataDirectory = await createDirectory();
    const store = new TestStateStore(dataDirectory);
    store.close();
    const databasePath = join(dataDirectory, "kilin.db");
    const database = new Database(databasePath);
    database.pragma("foreign_keys = OFF");
    database
      .prepare(
        `
          INSERT INTO workflow_runs (
            id, revision_id, canonical_cwd, options_json, status, started_at
          ) VALUES (
            'orphan', 'missing', '/project/orphan',
            '{"nodeTimeoutMs":1000,"maxOutputBytes":1024,"maxParallel":1}',
            'running', '2026-07-26T00:00:00.000Z'
          )
        `,
      )
      .run();
    database.close();

    const error = expectKilinError(() => new StateStore(dataDirectory), "INTERNAL_ERROR");
    expect(error.message).toContain("Archive or reset");

    const after = new Database(databasePath, { readonly: true });
    expect(after.prepare("SELECT id FROM workflow_runs WHERE id = 'orphan'").pluck().get()).toBe(
      "orphan",
    );
    expect(after.pragma("foreign_key_check")).toHaveLength(1);
    after.close();
  });
});

describe("StateStore lifecycle", () => {
  it("round-trips normalized cron provenance while manual runs keep a null source", async () => {
    const { dataDirectory, store } = await createStore();
    const trigger = {
      kind: "cron",
      schedule: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
    } as const;
    const triggered = store.createRun({
      plan: plan("triggered-run"),
      canonicalCwd: "/project/triggered",
      options,
      trigger,
    });
    const manual = store.createRun({
      plan: plan("manual-run"),
      canonicalCwd: "/project/manual",
      options,
    });

    expect(triggered.run.trigger).toEqual(trigger);
    expect(store.getRun(triggered.run.id).run.trigger).toEqual(trigger);
    expect(store.listRuns().find(({ id }) => id === triggered.run.id)?.trigger).toEqual(trigger);
    expect(manual.run.trigger).toBeUndefined();

    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare("SELECT trigger_source_json FROM workflow_runs WHERE id = ?")
        .pluck()
        .get(triggered.run.id),
    ).toBe('{"kind":"cron","schedule":"0 9 * * 1-5","timezone":"America/Los_Angeles"}');
    expect(
      database
        .prepare("SELECT trigger_source_json FROM workflow_runs WHERE id = ?")
        .pluck()
        .get(manual.run.id),
    ).toBeNull();
    database.close();
  });

  it("requests approval with its independent timeout and prevents terminal run transition while waiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:01:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("approval-request", [node("first")]),
      canonicalCwd: "/project/approval-request",
      options: { ...options, nodeTimeoutMs: 1_000, approvalTimeoutMs: 60_000 },
    });
    expectKilinError(() => store.requestApproval(created.run.id, "first"), "INTERNAL_ERROR");
    replaceWithApprovalNode(dataDirectory, created.run.id, "pending");

    expect(store.requestApproval(created.run.id, "first")).toEqual({
      kind: "approval",
      runId: created.run.id,
      nodeId: "first",
      ordinal: 0,
      status: "waiting_for_approval",
      requestedAt: "2026-07-21T00:01:00.000Z",
      deadlineAt: "2026-07-21T00:02:00.000Z",
    });
    expectKilinError(() => store.requestApproval(created.run.id, "first"), "INTERNAL_ERROR");
    expectKilinError(
      () => store.transitionNode(created.run.id, "first", { status: "cancelled" }),
      "INTERNAL_ERROR",
    );
    const completionError = expectKilinError(
      () => store.transitionRun(created.run.id, { status: "cancelled" }),
      "INTERNAL_ERROR",
    );
    expect(completionError.message).toContain("waiting for approval");
    expect(store.getRun(created.run.id).run.status).toBe("running");
  });

  it("consumes an on-time decision before timeout and times out an undecided gate at equality", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const approved = store.createRun({
      plan: plan("approval-consume", [node("first")]),
      canonicalCwd: "/project/approval-consume",
      options,
    });
    replaceWithApprovalNode(dataDirectory, approved.run.id, "pending");
    store.requestApproval(approved.run.id, "first");
    expect(store.pollApproval(approved.run.id, "first").status).toBe("waiting_for_approval");
    vi.setSystemTime(new Date("2026-07-21T00:00:30.000Z"));
    store.recordApprovalDecision(approved.run.id, "first", "approve", "human");
    vi.setSystemTime(new Date("2026-07-21T00:01:30.000Z"));

    expect(store.pollApproval(approved.run.id, "first")).toMatchObject({
      kind: "approval",
      status: "succeeded",
      decision: { decision: "approve", actor: "human" },
    });

    vi.setSystemTime(new Date("2026-07-21T01:00:00.000Z"));
    const timedOut = store.createRun({
      plan: plan("approval-timeout", [node("first")]),
      canonicalCwd: "/project/approval-timeout",
      options,
    });
    replaceWithApprovalNode(dataDirectory, timedOut.run.id, "pending");
    store.requestApproval(timedOut.run.id, "first");
    vi.setSystemTime(new Date("2026-07-21T01:01:00.000Z"));

    expect(store.pollApproval(timedOut.run.id, "first")).toMatchObject({
      kind: "approval",
      status: "failed",
      failure: { code: "APPROVAL_TIMEOUT" },
    });
  });

  it("fails a rejected gate and preserves an unconsumed decision when cancellation wins", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const rejected = store.createRun({
      plan: plan("approval-reject", [node("first")]),
      canonicalCwd: "/project/approval-reject",
      options,
    });
    replaceWithApprovalNode(dataDirectory, rejected.run.id, "pending");
    store.requestApproval(rejected.run.id, "first");
    store.recordApprovalDecision(rejected.run.id, "first", "reject", "agent", "Unsafe change");
    expect(store.pollApproval(rejected.run.id, "first")).toMatchObject({
      status: "failed",
      failure: { code: "APPROVAL_REJECTED" },
      decision: { decision: "reject", note: "Unsafe change" },
    });

    const cancelled = store.createRun({
      plan: plan("approval-cancel", [node("first")]),
      canonicalCwd: "/project/approval-cancel",
      options,
    });
    replaceWithApprovalNode(dataDirectory, cancelled.run.id, "pending");
    store.requestApproval(cancelled.run.id, "first");
    store.recordApprovalDecision(cancelled.run.id, "first", "approve", "human");
    expect(store.cancelApproval(cancelled.run.id, "first")).toMatchObject({
      status: "cancelled",
      decision: { decision: "approve", actor: "human" },
    });
  });

  it("interrupts a stale waiting gate without consuming its decision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const stale = store.createRun({
      plan: plan("stale-approval"),
      canonicalCwd: "/project/stale-approval",
      options,
    });
    replaceWithApprovalNode(dataDirectory, stale.run.id, "pending");
    store.requestApproval(stale.run.id, "first");
    store.recordApprovalDecision(stale.run.id, "first", "approve", "human");

    store.createRunAfterStaleReconciliation({
      plan: plan("stale-approval"),
      canonicalCwd: "/project/stale-approval",
      options,
    });

    expect(store.getRun(stale.run.id)).toMatchObject({
      run: { status: "interrupted", failure: { code: "RUN_INTERRUPTED" } },
      nodes: [
        {
          kind: "approval",
          status: "interrupted",
          failure: { code: "RUN_INTERRUPTED" },
          decision: { decision: "approve", actor: "human" },
        },
        { status: "skipped" },
      ],
    });
  });

  it("records exactly one approval decision before its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:01:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({ plan: plan(), canonicalCwd: "/project/approval", options });
    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2026-07-21T00:02:00.000Z",
    );

    const recorded = store.recordApprovalDecision(
      created.run.id,
      "first",
      "approve",
      "human",
      "Reviewed locally",
    );
    expect(recorded).toEqual({
      runId: created.run.id,
      nodeId: "first",
      decision: "approve",
      actor: "human",
      note: "Reviewed locally",
      decidedAt: "2026-07-21T00:01:00.000Z",
    });

    const secondStore = new StateStore(dataDirectory);
    stores.push(secondStore);
    const error = expectKilinError(
      () => secondStore.recordApprovalDecision(created.run.id, "first", "reject", "agent"),
      "APPROVAL_NOT_WAITING",
    );
    expect(error.message).toContain("already recorded");

    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
      SELECT approval_decision, approval_actor, approval_note, approval_decided_at
      FROM node_runs WHERE run_id = ? AND node_id = 'first'
    `,
        )
        .get(created.run.id),
    ).toEqual({
      approval_decision: "approve",
      approval_actor: "human",
      approval_note: "Reviewed locally",
      approval_decided_at: "2026-07-21T00:01:00.000Z",
    });
    database.close();
  });

  it("rejects a decision timestamp before the durable approval request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:01:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("approval-clock", [node("first")]),
      canonicalCwd: "/project/approval-clock",
      options,
    });
    replaceWithApprovalNode(dataDirectory, created.run.id, "pending");
    store.requestApproval(created.run.id, "first");
    vi.setSystemTime(new Date("2026-07-21T00:00:59.999Z"));

    const error = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "first", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(error.message).toContain("system clock");
    const approval = store.getRun(created.run.id).nodes[0];
    if (approval === undefined) {
      throw new Error("Expected the approval node");
    }
    expect(approval).toMatchObject({ status: "waiting_for_approval" });
    expect("decision" in approval).toBe(false);
  });

  it("rejects non-waiting and expired approval targets with actionable distinctions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:01:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan(),
      canonicalCwd: "/project/approval-errors",
      options,
    });

    const missing = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "missing", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(missing.message).toContain("does not contain");

    const agent = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "first", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(agent.message).toContain("agent node");

    replaceWithApprovalNode(dataDirectory, created.run.id, "pending");
    const pending = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "first", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(pending.message).toContain("pending");

    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2026-07-21T00:01:00.000Z",
    );
    const expired = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "first", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(expired.message).toContain("expired");
    expect(expired.message).toMatch(/rerun/i);
  });

  it("does not record a decision after the run is terminal", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan(),
      canonicalCwd: "/project/terminal-approval",
      options,
    });
    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2999-01-01T00:00:00.000Z",
    );
    mutateStoredRun(
      dataDirectory,
      created.run.id,
      `status = 'interrupted', finished_at = '${validStoredTimestamp}', failure_code = 'RUN_INTERRUPTED', failure_message = 'runner stopped'`,
    );

    const error = expectKilinError(
      () => store.recordApprovalDecision(created.run.id, "first", "approve", "human"),
      "APPROVAL_NOT_WAITING",
    );
    expect(error.message).toContain("interrupted");

    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
      SELECT approval_decision FROM node_runs WHERE run_id = ? AND node_id = 'first'
    `,
        )
        .pluck()
        .get(created.run.id),
    ).toBeNull();
    database.close();
  });

  it("allows exactly one of two concurrent decision processes to win", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan(),
      canonicalCwd: "/project/concurrent-approval",
      options,
    });
    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2999-01-01T00:00:00.000Z",
    );
    const approve = startApprovalDecisionChild(dataDirectory, created.run.id, "approve", "human");
    const reject = startApprovalDecisionChild(dataDirectory, created.run.id, "reject", "agent");
    await Promise.all([approve.ready, reject.ready]);

    approve.start();
    reject.start();
    await Promise.all([approve.attempting, reject.attempting]);
    const outcomes = await Promise.all([approve.complete, reject.complete]);

    expect(outcomes.filter((outcome) => "recorded" in outcome)).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) => "error" in outcome && outcome.error.code === "APPROVAL_NOT_WAITING",
      ),
    ).toHaveLength(1);
    const winner = outcomes.find((outcome) => "recorded" in outcome);
    if (winner === undefined || !("recorded" in winner)) {
      throw new Error("Expected one recorded decision");
    }
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
      SELECT run_id AS runId, node_id AS nodeId,
             approval_decision AS decision, approval_actor AS actor,
             approval_decided_at AS decidedAt
      FROM node_runs WHERE run_id = ? AND node_id = 'first'
    `,
        )
        .get(created.run.id),
    ).toEqual(winner.recorded);
    database.close();
  });

  it("samples the decision time after a blocked writer crosses the deadline", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan(),
      canonicalCwd: "/project/blocked-approval",
      options,
    });
    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2999-01-01T00:00:00.000Z",
    );
    const decision = startApprovalDecisionChild(dataDirectory, created.run.id, "approve", "human");
    await decision.ready;
    const lockHolder = new Database(join(dataDirectory, "kilin.db"));
    const deadlineAt = new Date(Date.now() + 1_500).toISOString();
    lockHolder
      .prepare(
        `
      UPDATE node_runs SET approval_deadline_at = ? WHERE run_id = ? AND node_id = 'first'
    `,
      )
      .run(deadlineAt, created.run.id);
    lockHolder.exec("BEGIN IMMEDIATE");

    decision.start();
    await decision.attempting;
    const waitPastDeadlineMs = Math.max(0, Date.parse(deadlineAt) - Date.now() + 200);
    await new Promise((resolve) => setTimeout(resolve, waitPastDeadlineMs));
    lockHolder.exec("ROLLBACK");
    lockHolder.close();
    const outcome = await decision.complete;

    if (!("error" in outcome)) {
      throw new Error("Expected the blocked decision to expire");
    }
    expect(outcome.error.code).toBe("APPROVAL_NOT_WAITING");
    expect(outcome.error.message).toContain("expired");
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
      SELECT approval_decision FROM node_runs WHERE run_id = ? AND node_id = 'first'
    `,
        )
        .pluck()
        .get(created.run.id),
    ).toBeNull();
    database.close();
  });

  it("projects approval rows without agent execution fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T00:01:00.000Z"));
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("approval-projection", [node("first")]),
      canonicalCwd: "/project/approval-projection",
      options,
    });
    replaceWithApprovalNode(dataDirectory, created.run.id, "pending");

    expect(store.getRun(created.run.id).nodes).toEqual([
      {
        kind: "approval",
        runId: created.run.id,
        nodeId: "first",
        ordinal: 0,
        status: "pending",
      },
    ]);

    replaceWithApprovalNode(
      dataDirectory,
      created.run.id,
      "waiting_for_approval",
      "2026-07-21T00:02:00.000Z",
    );
    store.recordApprovalDecision(created.run.id, "first", "approve", "human");
    expect(store.getRun(created.run.id).nodes).toEqual([
      {
        kind: "approval",
        runId: created.run.id,
        nodeId: "first",
        ordinal: 0,
        status: "waiting_for_approval",
        requestedAt: validStoredTimestamp,
        deadlineAt: "2026-07-21T00:02:00.000Z",
        decision: {
          decision: "approve",
          actor: "human",
          decidedAt: "2026-07-21T00:01:00.000Z",
        },
      },
    ]);

    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare(
        `
      UPDATE node_runs SET status = 'succeeded', finished_at = '2026-07-21T00:03:00.000Z'
      WHERE run_id = ? AND node_id = 'first'
    `,
      )
      .run(created.run.id);
    database.close();
    expect(store.getRun(created.run.id).nodes).toEqual([
      {
        kind: "approval",
        runId: created.run.id,
        nodeId: "first",
        ordinal: 0,
        status: "succeeded",
        requestedAt: validStoredTimestamp,
        deadlineAt: "2026-07-21T00:02:00.000Z",
        finishedAt: "2026-07-21T00:03:00.000Z",
        decision: {
          decision: "approve",
          actor: "human",
          decidedAt: "2026-07-21T00:01:00.000Z",
        },
      },
    ]);
  });

  it.each([
    ["artifact without path", "output_type = 'artifact'"],
    ["path without artifact", "output_type = 'text', artifact_path = 'report.md'"],
    ["overlong artifact path", `output_type = 'artifact', artifact_path = '${"x".repeat(1025)}'`],
    ["agent approval metadata", `approval_requested_at = '${validStoredTimestamp}'`],
    [
      "incomplete approval decision",
      `kind = 'approval', runtime = NULL, requested_model = NULL, status = 'waiting_for_approval', approval_requested_at = '${validStoredTimestamp}', approval_deadline_at = '${validStoredTimestamp}', approval_decision = 'approve', approval_actor = 'human'`,
    ],
    ["approval runtime", "kind = 'approval'"],
    [
      "pending approval request",
      `kind = 'approval', runtime = NULL, requested_model = NULL, approval_requested_at = '${validStoredTimestamp}', approval_deadline_at = '${validStoredTimestamp}'`,
    ],
    [
      "running approval",
      "kind = 'approval', runtime = NULL, requested_model = NULL, status = 'running'",
    ],
    [
      "approval capture path",
      "kind = 'approval', runtime = NULL, requested_model = NULL, stdout_path = '/state/stdout.log'",
    ],
  ] as const)("rejects incompatible current node fields: %s", async (_name, setClause) => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({ plan: plan(), canonicalCwd: "/project/checks", options });
    const database = new Database(join(dataDirectory, "kilin.db"));

    expectSqliteError(
      () =>
        database
          .prepare(
            `
      UPDATE node_runs SET ${setClause} WHERE run_id = ? AND node_id = 'first'
    `,
          )
          .run(created.run.id),
      "SQLITE_CONSTRAINT_CHECK",
    );

    database.close();
  });

  it("persists an artifact declaration as path-only node metadata", async () => {
    const { store } = await createStore();
    const artifactNode: AgentNode = {
      ...node("artifact"),
      access: "workspace_write",
      output: { type: "artifact", path: "outputs/report.md" },
    };

    const created = store.createRun({
      plan: plan("artifact-state", [artifactNode]),
      canonicalCwd: "/project/artifact",
      options,
    });

    expect(created.nodes).toMatchObject([
      {
        nodeId: "artifact",
        outputType: "artifact",
        artifactPath: "outputs/report.md",
      },
    ]);
    expect(Object.keys(created.nodes[0] ?? {}).sort()).toEqual([
      "artifactPath",
      "kind",
      "nodeId",
      "ordinal",
      "outputType",
      "runId",
      "runtime",
      "status",
    ]);
  });

  it("persists a Decision Packet declaration without an artifact path or packet content", async () => {
    const { dataDirectory, store } = await createStore();
    const packetNode: AgentNode = {
      ...node("packet"),
      output: { type: "decision_packet" },
    };

    const created = store.createRun({
      plan: plan("decision-packet-state", [packetNode]),
      canonicalCwd: "/project/decision-packet",
      options,
    });

    expect(created.nodes).toEqual([
      {
        kind: "agent",
        runId: created.run.id,
        nodeId: "packet",
        ordinal: 0,
        runtime: "codex",
        status: "pending",
        outputType: "decision_packet",
      },
    ]);
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
      SELECT output_type, artifact_path FROM node_runs
      WHERE run_id = ? AND node_id = 'packet'
    `,
        )
        .get(created.run.id),
    ).toEqual({
      output_type: "decision_packet",
      artifact_path: null,
    });
    database.close();
  });

  it("projects a choice declaration from its declared output metadata", async () => {
    const { dataDirectory, store } = await createStore();
    const choicePlan = compileWorkflow({
      schemaVersion: 1,
      workflow: { id: "choice-state", name: "Choice state" },
      nodes: [
        {
          ...node("choose"),
          output: { type: "choice", choices: ["left", "right"] },
        },
        node("left"),
        node("right"),
      ],
      edges: [
        { from: "choose", to: "left", when: { choice: "left" } },
        { from: "choose", to: "right", when: { choice: "right" } },
      ],
    });

    const created = store.createRun({
      plan: choicePlan,
      canonicalCwd: "/project/choice",
      options,
    });

    expect(created.nodes[0]).toMatchObject({ nodeId: "choose", outputType: "choice" });
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          "SELECT output_type, declared_output_type FROM node_runs WHERE run_id = ? AND node_id = 'choose'",
        )
        .get(created.run.id),
    ).toEqual({ output_type: "json", declared_output_type: "choice" });
    database.close();
  });

  it("persists expanded loop occurrences and atomically publishes the loop result", async () => {
    const { dataDirectory, store } = await createStore();
    const loopNodeId = "Feedback.Main";
    const bodyNodeId = "Review-1.beta";
    const executionPlan = loopPlan(loopNodeId, bodyNodeId);
    const iteration = executionPlan.loops[0]?.iterations[0];
    if (iteration === undefined) {
      throw new Error("Expected the loop state fixture to compile one iteration");
    }
    const created = store.createRun({
      plan: executionPlan,
      canonicalCwd: "/project/loop",
      options,
    });

    expect(created.nodes).toEqual([
      {
        kind: "loop",
        runId: created.run.id,
        nodeId: loopNodeId,
        ordinal: 0,
        status: "pending",
      },
      {
        kind: "agent",
        runId: created.run.id,
        nodeId: iteration.resultExecutionId,
        bodyNodeId,
        loopNodeId,
        iteration: 0,
        ordinal: 1,
        runtime: "codex",
        status: "pending",
        outputType: "text",
      },
      {
        kind: "agent",
        runId: created.run.id,
        nodeId: iteration.decisionExecutionId,
        bodyNodeId: "decision",
        loopNodeId,
        iteration: 0,
        ordinal: 2,
        runtime: "codex",
        status: "pending",
        outputType: "choice",
      },
    ]);
    const startedLoop = store.startLoop(created.run.id, loopNodeId);
    expect(startedLoop).toMatchObject({
      kind: "loop",
      nodeId: loopNodeId,
      status: "running",
    });
    expect(typeof startedLoop.startedAt).toBe("string");
    const resultPath = "/state/runs/loop/result.txt";
    const finishedLoop = store.finishLoop(created.run.id, loopNodeId, {
      status: "succeeded",
      resultPath,
      outputType: "text",
    });
    expect(finishedLoop).toMatchObject({
      kind: "loop",
      nodeId: loopNodeId,
      status: "succeeded",
      resultPath,
      outputType: "text",
    });
    expect(typeof finishedLoop.finishedAt).toBe("string");
    expect(store.getRun(created.run.id).nodes[0]).toMatchObject({
      status: "succeeded",
      resultPath,
      outputType: "text",
    });

    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    expect(
      database
        .prepare(
          `
            SELECT node_id, body_node_id, loop_node_id, iteration, status,
                   stdout_path, stderr_path, result_path
            FROM node_runs WHERE run_id = ? ORDER BY ordinal
          `,
        )
        .all(created.run.id),
    ).toEqual([
      {
        node_id: loopNodeId,
        body_node_id: null,
        loop_node_id: null,
        iteration: null,
        status: "succeeded",
        stdout_path: null,
        stderr_path: null,
        result_path: resultPath,
      },
      {
        node_id: iteration.resultExecutionId,
        body_node_id: bodyNodeId,
        loop_node_id: loopNodeId,
        iteration: 0,
        status: "pending",
        stdout_path: null,
        stderr_path: null,
        result_path: null,
      },
      {
        node_id: iteration.decisionExecutionId,
        body_node_id: "decision",
        loop_node_id: loopNodeId,
        iteration: 0,
        status: "pending",
        stdout_path: null,
        stderr_path: null,
        result_path: null,
      },
    ]);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM node_attempts WHERE run_id = ? AND node_id = ?")
        .pluck()
        .get(created.run.id, loopNodeId),
    ).toBe(0);
    database.close();
  });

  it("finishes a pending loop as cancelled", async () => {
    const { store } = await createStore();
    const created = store.createRun({
      plan: loopPlan(),
      canonicalCwd: "/project/loop-pending-cancel",
      options,
    });

    const loop = store.finishLoop(created.run.id, "feedback", { status: "cancelled" });

    expect(loop).toMatchObject({ kind: "loop", status: "cancelled" });
    expect(typeof loop.finishedAt).toBe("string");
    expect(loop.startedAt).toBeUndefined();
  });

  it("cancels a loop result when the durable cancellation latch commits first", async () => {
    const { store } = await createStore();
    const created = store.createRun({
      plan: loopPlan(),
      canonicalCwd: "/project/loop-cancel",
      options,
    });
    store.startLoop(created.run.id, "feedback");
    store.requestRunCancellation(created.run.id);

    const loop = store.finishLoop(created.run.id, "feedback", {
      status: "succeeded",
      resultPath: "/state/runs/loop/result.txt",
      outputType: "text",
    });

    expect(loop).toMatchObject({ kind: "loop", status: "cancelled" });
    expect(loop).not.toHaveProperty("resultPath");
    expect(loop).not.toHaveProperty("outputType");
  });

  it.each(["failed", "interrupted"] as const)(
    "lets a committed cancellation latch win over a loop %s outcome",
    async (status) => {
      const { store } = await createStore();
      const created = store.createRun({
        plan: loopPlan(),
        canonicalCwd: `/project/loop-cancel-${status}`,
        options,
      });
      store.startLoop(created.run.id, "feedback");
      store.requestRunCancellation(created.run.id);

      const loop = store.finishLoop(created.run.id, "feedback", {
        status,
        failure: {
          code: status === "failed" ? "LOOP_LIMIT_REACHED" : "RUN_INTERRUPTED",
          message: `Loop would have settled ${status}.`,
        },
      });

      expect(loop).toMatchObject({ kind: "loop", status: "cancelled" });
      expect(loop).not.toHaveProperty("failure");
    },
  );

  it("persists approval nodes as pending rows without agent execution metadata", async () => {
    const { store } = await createStore();
    const definition: WorkflowCompilationInput = {
      schemaVersion: 1,
      workflow: { id: "approval-state", name: "Approval state" },
      nodes: [
        { ...node("prepare"), output: { type: "text" } },
        { id: "approve", kind: "approval", question: "Proceed?" },
        node("apply"),
      ],
      edges: [
        { from: "prepare", to: "approve" },
        { from: "approve", to: "apply" },
      ],
    };

    const created = store.createRun({
      plan: compileWorkflow(definition),
      canonicalCwd: "/project/approval-state",
      options,
    });

    expect(created.nodes).toMatchObject([
      { kind: "agent", nodeId: "prepare", ordinal: 0, runtime: "codex", status: "pending" },
      { kind: "approval", nodeId: "approve", ordinal: 1, status: "pending" },
      { kind: "agent", nodeId: "apply", ordinal: 2, runtime: "codex", status: "pending" },
    ]);
    expect(Object.keys(created.nodes[1] ?? {}).sort()).toEqual([
      "kind",
      "nodeId",
      "ordinal",
      "runId",
      "status",
    ]);
    expect(created.revision.normalizedDefinition).toContain(
      '"id":"approve","join":"all","kind":"approval","question":"Proceed?"',
    );
  });

  it("deduplicates immutable revisions while creating distinct runs and all pending nodes atomically", async () => {
    const { store } = await createStore();
    const executionPlan = plan();

    const first = store.createRun({
      plan: executionPlan,
      canonicalCwd: "/project/one",
      options,
    });
    const second = store.createRun({
      plan: executionPlan,
      canonicalCwd: "/project/two",
      options,
      rerunOfRunId: first.run.id,
    });

    expect(second.run.id).not.toBe(first.run.id);
    expect(second.revision.id).toBe(first.revision.id);
    expect(second.run.rerunOfRunId).toBe(first.run.id);
    expect(second.run.options).toEqual(options);
    expect(
      second.nodes.map(({ nodeId, ordinal, status, requestedModel }) => ({
        nodeId,
        ordinal,
        status,
        requestedModel,
      })),
    ).toEqual([
      { nodeId: "first", ordinal: 0, status: "pending", requestedModel: undefined },
      { nodeId: "second", ordinal: 1, status: "pending", requestedModel: "gpt-5" },
    ]);
    expect(store.listRuns()).toHaveLength(2);
  });

  it("rejects a run that declares both rerun and recovery lineage before persistence", async () => {
    const { store } = await createStore();
    const executionPlan = plan();
    const source = store.createRun({
      plan: executionPlan,
      canonicalCwd: "/project/source",
      options,
    });
    store.transitionNode(source.run.id, "first", { status: "skipped" });
    store.transitionNode(source.run.id, "second", { status: "skipped" });
    store.transitionRun(source.run.id, { status: "succeeded" });
    const runCount = store.listRuns().length;

    expectKilinError(
      () =>
        store.createRun({
          plan: executionPlan,
          canonicalCwd: "/project/invalid-lineage",
          options,
          rerunOfRunId: source.run.id,
          recoveryOfRunId: source.run.id,
          recoveryMode: "retry",
        }),
      "OPTION_INVALID",
    );
    expect(store.listRuns()).toHaveLength(runCount);
  });

  it("keeps revision identity distinct across user and project scopes", async () => {
    const { store } = await createStore();
    const executionPlan = plan("scoped-workflow");
    const userRun = store.createRun({
      plan: executionPlan,
      identity: { scope: { kind: "user" }, workflowId: "scoped-workflow" },
      canonicalCwd: "/project/workspace",
      options,
    });
    const projectRun = store.createRun({
      plan: executionPlan,
      identity: {
        scope: { kind: "project", root: "/project" },
        workflowId: "scoped-workflow",
      },
      canonicalCwd: "/project/workspace",
      options,
    });

    expect(projectRun.revision.id).not.toBe(userRun.revision.id);
    expect(store.listRuns()).toMatchObject([
      { scope: { kind: "project", root: "/project" }, workflowId: "scoped-workflow" },
      { scope: { kind: "user" }, workflowId: "scoped-workflow" },
    ]);
  });

  it("rejects a project identity outside its scope root", async () => {
    const { store } = await createStore();
    const executionPlan = plan("scoped-workflow");

    expectKilinError(
      () =>
        store.createRun({
          plan: executionPlan,
          identity: {
            scope: { kind: "project", root: "/project-a" },
            workflowId: "scoped-workflow",
          },
          canonicalCwd: "/project-b",
          options,
        }),
      "WORKFLOW_SCOPE_INVALID",
    );
    expect(store.listRuns()).toEqual([]);

    expectKilinError(
      () =>
        store.createRun({
          plan: executionPlan,
          identity: {
            scope: { kind: "project", root: "/project" },
            workflowId: "scoped-workflow",
          },
          canonicalCwd: "/projectile",
          options,
        }),
      "WORKFLOW_SCOPE_INVALID",
    );
    expect(store.listRuns()).toEqual([]);
  });

  it("lists each active canonical working directory once in deterministic path order", async () => {
    const { store } = await createStore();
    store.createRun({ plan: plan("first-a"), canonicalCwd: "/project/a", options });
    store.createRun({ plan: plan("second-a"), canonicalCwd: "/project/a", options });
    const finished = store.createRun({
      plan: plan("finished"),
      canonicalCwd: "/project/b",
      options,
    });
    store.skipPendingNodes(finished.run.id);
    store.transitionRun(finished.run.id, {
      status: "failed",
      failure: { code: "INTERNAL_ERROR", message: "The test run finished." },
    });
    store.createRun({ plan: plan("last"), canonicalCwd: "/project/z", options });

    expect(store.listActiveCanonicalWorkingDirectories()).toEqual(["/project/a", "/project/z"]);
  });

  it("rolls back revision, run, and node inserts when the full pending-node set cannot be created", async () => {
    const { store } = await createStore();
    const invalidPlan = plan("atomic-test");
    const secondNode = invalidPlan.nodes[1];
    if (secondNode === undefined) {
      throw new Error("Expected a two-node plan");
    }
    invalidPlan.nodes[1] = { ...secondNode, ordinal: 0 };

    expectKilinError(
      () =>
        store.createRun({
          plan: invalidPlan,
          canonicalCwd: "/project/atomic",
          options,
        }),
      "INTERNAL_ERROR",
    );
    expect(store.listRuns()).toEqual([]);

    const created = store.createRun({
      plan: plan("atomic-test"),
      canonicalCwd: "/project/atomic",
      options,
    });
    expect(created.nodes).toHaveLength(2);
  });

  it("rejects out-of-range execution options before persisting a revision or run", async () => {
    const { store } = await createStore();

    expectKilinError(
      () =>
        store.createRun({
          plan: plan("invalid-options"),
          canonicalCwd: "/project/options",
          options: {
            nodeTimeoutMs: 999,
            approvalTimeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxParallel: 1,
          },
        }),
      "OPTION_INVALID",
    );
    expect(store.listRuns()).toEqual([]);
  });

  it("rejects invalid trigger provenance before persisting a revision or run", async () => {
    const { store } = await createStore();

    expectKilinError(
      () =>
        store.createRun({
          plan: plan("invalid-trigger"),
          canonicalCwd: "/project/invalid-trigger",
          options,
          trigger: {
            kind: "cron",
            schedule: "0 9 * * 1-5",
            timezone: "Mars/Olympus_Mons",
          },
        }),
      "OPTION_INVALID",
    );
    expect(store.listRuns()).toEqual([]);
  });

  it("rejects tampered stored execution options as corrupt state", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-options"),
      canonicalCwd: "/project/tampered-options",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare("UPDATE workflow_runs SET options_json = ? WHERE id = ?")
      .run(JSON.stringify({ nodeTimeoutMs: 1_000.5, maxOutputBytes: 100 }), created.run.id);
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("stored run has invalid execution options");
  });

  it("rejects a current row that lost its execution bound instead of assuming one", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("dropped-bound"),
      canonicalCwd: "/project/dropped-bound",
      options: { ...options, maxParallel: 4 },
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare("UPDATE workflow_runs SET options_json = json_remove(options_json, '$.maxParallel')")
      .run();
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("stored run has invalid execution options");
    expect(() => store.listRuns()).toThrow(KilinError);
  });

  it("rejects a current row that lost its approval timeout instead of assuming one", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("dropped-approval-timeout"),
      canonicalCwd: "/project/dropped-approval-timeout",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare(
        "UPDATE workflow_runs SET options_json = json_remove(options_json, '$.approvalTimeoutMs')",
      )
      .run();
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("stored run has invalid execution options");
    expect(() => store.listRuns()).toThrow(KilinError);
  });

  it("rejects malformed stored trigger provenance as corrupt state", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-trigger"),
      canonicalCwd: "/project/tampered-trigger",
      options,
      trigger: {
        kind: "cron",
        schedule: "0 9 * * 1-5",
        timezone: "America/Los_Angeles",
      },
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare("UPDATE workflow_runs SET trigger_source_json = ? WHERE id = ?")
      .run(
        '{"kind":"cron","schedule":"0 9 * * 1-5","timezone":"Mars/Olympus_Mons"}',
        created.run.id,
      );
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("invalid trigger provenance");
  });

  it("rejects malformed stored workspaces in list and detail reads", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-workspace"),
      canonicalCwd: "/project/tampered-workspace",
      options,
    });
    store.recordRunWorkspace(
      created.run.id,
      "candidate",
      "/state/workspaces/candidate",
      "a".repeat(40),
    );
    const database = new Database(join(dataDirectory, "kilin.db"));
    database.pragma("ignore_check_constraints = ON");
    database
      .prepare("UPDATE run_workspaces SET status = 'ready' WHERE run_id = ?")
      .run(created.run.id);
    database.close();

    const expectReadsToReject = (): void => {
      for (const read of [
        (): unknown => store.listRunWorkspaces(created.run.id),
        (): unknown => store.getRun(created.run.id),
      ]) {
        const error = expectKilinError(read, "INTERNAL_ERROR");
        expect(error.message).toContain("invalid run workspace");
      }
    };
    expectReadsToReject();

    const pathDatabase = new Database(join(dataDirectory, "kilin.db"));
    pathDatabase
      .prepare("UPDATE run_workspaces SET status = 'provisioned', path = ? WHERE run_id = ?")
      .run("/state/workspaces/\u0000candidate", created.run.id);
    pathDatabase.close();
    expectReadsToReject();
  });

  it("rejects a stored row with incomplete failure information", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-failure"),
      canonicalCwd: "/project/tampered-failure",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare(
        `
      UPDATE workflow_runs SET failure_code = 'INTERNAL_ERROR', failure_message = NULL WHERE id = ?
    `,
      )
      .run(created.run.id);
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("incomplete failure information");
  });

  it("rejects a stored node with incomplete output paths", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-paths"),
      canonicalCwd: "/project/tampered-paths",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare(
        `
      UPDATE node_runs SET stdout_path = '/state/stdout.log', stderr_path = NULL, result_path = NULL
      WHERE run_id = ? AND node_id = 'first'
    `,
      )
      .run(created.run.id);
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("incomplete output paths");
  });

  it("rejects an invalid stored revision timestamp", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-revision-timestamp"),
      canonicalCwd: "/project/tampered-revision-timestamp",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare("UPDATE workflow_revisions SET created_at = 'not-a-timestamp' WHERE id = ?")
      .run(created.revision.id);
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("timestamp");
  });

  it("rejects a stored revision outside workflow schema V1", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-revision-schema"),
      canonicalCwd: "/project/tampered-revision-schema",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    expectSqliteError(
      () =>
        database
          .prepare("UPDATE workflow_revisions SET schema_version = 2 WHERE id = ?")
          .run(created.revision.id),
      "SQLITE_CONSTRAINT_CHECK",
    );
    database.pragma("ignore_check_constraints = ON");
    database
      .prepare("UPDATE workflow_revisions SET schema_version = 2 WHERE id = ?")
      .run(created.revision.id);
    database.pragma("ignore_check_constraints = OFF");
    database.close();

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("unsupported workflow schema version");
    expect(error.message).toContain('"2"');
  });

  it("rejects the same invalid stored workflow scope in list and detail reads", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      identity: {
        scope: { kind: "project", root: "/project" },
        workflowId: "tampered-scope",
      },
      plan: plan("tampered-scope"),
      canonicalCwd: "/project/tampered-scope",
      options,
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database
      .prepare("UPDATE workflow_revisions SET scope_root = 'relative-project' WHERE id = ?")
      .run(created.revision.id);
    database.close();

    const reads: (() => unknown)[] = [
      (): unknown => store.listRuns(),
      (): unknown => store.getRun(created.run.id),
    ];
    for (const read of reads) {
      const error = expectKilinError(read, "INTERNAL_ERROR");
      expect(error.message).toContain("invalid workflow scope");
    }
  });

  it.each(corruptRunCases)(
    "rejects stored run corruption: $name",
    async ({ setClause, bypassChecks }) => {
      const { dataDirectory, store } = await createStore();
      const created = store.createRun({
        plan: plan("tampered-run"),
        canonicalCwd: "/project/tampered-run",
        options,
      });
      mutateStoredRun(dataDirectory, created.run.id, setClause, bypassChecks);

      expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    },
  );

  it.each(corruptNodeCases)(
    "rejects stored node corruption: $name",
    async ({ setClause, bypassChecks }) => {
      const { dataDirectory, store } = await createStore();
      const created = store.createRun({
        plan: plan("tampered-node"),
        canonicalCwd: "/project/tampered-node",
        options,
      });
      mutateStoredNode(dataDirectory, created.run.id, setClause, bypassChecks);

      expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    },
  );

  it.each([
    [
      "waiting with a finish timestamp",
      `${approvalRowFields}, status = 'waiting_for_approval', finished_at = '${validStoredTimestamp}'`,
    ],
    [
      "failed without failure information",
      `${approvalRowFields}, status = 'failed', finished_at = '${validStoredTimestamp}'`,
    ],
    [
      "rejected with a non-approval failure",
      `${approvalRowFields}, status = 'failed', finished_at = '${validStoredTimestamp}', approval_decision = 'reject', approval_actor = 'human', approval_decided_at = '2026-07-21T00:01:00.000Z', failure_code = 'NODE_EXIT_NONZERO', failure_message = 'wrong failure'`,
    ],
    [
      "timed out with a non-approval failure",
      `${approvalRowFields}, status = 'failed', finished_at = '${validStoredTimestamp}', failure_code = 'NODE_TIMEOUT', failure_message = 'wrong failure'`,
    ],
    [
      "invalid decision timestamp",
      `${approvalRowFields}, status = 'waiting_for_approval', approval_decision = 'approve', approval_actor = 'human', approval_decided_at = 'invalid'`,
    ],
    [
      "decision at its deadline",
      `${approvalRowFields}, status = 'waiting_for_approval', approval_decision = 'approve', approval_actor = 'human', approval_decided_at = '2026-07-21T00:02:00.000Z'`,
    ],
    [
      "deadline before its request",
      `kind = 'approval', runtime = NULL, requested_model = NULL, status = 'waiting_for_approval', approval_requested_at = '2026-07-21T00:03:00.000Z', approval_deadline_at = '2026-07-21T00:02:00.000Z'`,
    ],
    [
      "decision before its request",
      `kind = 'approval', runtime = NULL, requested_model = NULL, status = 'waiting_for_approval', approval_requested_at = '2026-07-21T00:01:00.000Z', approval_deadline_at = '2026-07-21T00:02:00.000Z', approval_decision = 'approve', approval_actor = 'human', approval_decided_at = '${validStoredTimestamp}'`,
    ],
    [
      "interrupted with a non-interruption failure",
      `${approvalRowFields}, status = 'interrupted', finished_at = '${validStoredTimestamp}', failure_code = 'INTERNAL_ERROR', failure_message = 'wrong failure'`,
    ],
    [
      "non-string approval note",
      `${approvalRowFields}, status = 'waiting_for_approval', approval_decision = 'approve', approval_actor = 'human', approval_note = X'0102', approval_decided_at = '2026-07-21T00:01:00.000Z'`,
    ],
  ] as const)("rejects stored approval corruption: %s", async (_name, setClause) => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("tampered-approval"),
      canonicalCwd: "/approval",
      options,
    });
    mutateStoredNode(dataDirectory, created.run.id, setClause);

    expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
  });

  it("guards node and run transitions while retaining runtime metadata and output paths", async () => {
    const { store } = await createStore();
    const created = store.createRun({ plan: plan(), canonicalCwd: "/project", options });
    const paths = {
      stdoutPath: "/state/stdout.log",
      stderrPath: "/state/stderr.log",
      resultPath: "/state/result.txt",
    };

    expectKilinError(
      () =>
        store.transitionNode(created.run.id, "first", {
          status: "succeeded",
          exitCode: 0,
        }),
      "INTERNAL_ERROR",
    );
    expectKilinError(
      () => store.recordResolvedInputs(created.run.id, "first", "/state/resolved-inputs.json"),
      "INTERNAL_ERROR",
    );

    const running = store.transitionNode(created.run.id, "first", {
      status: "running",
      runtimeVersion: "codex 1.2.3",
      ...paths,
    });
    const runningWithInputs = store.recordResolvedInputs(
      created.run.id,
      "first",
      "/state/resolved-inputs.json",
    );
    expectKilinError(
      () => store.recordResolvedInputs(created.run.id, "first", "/state/replacement.json"),
      "INTERNAL_ERROR",
    );
    const succeeded = store.transitionNode(created.run.id, "first", {
      status: "succeeded",
      exitCode: 0,
      effectiveModel: "gpt-5-effective",
    });
    const secondRunning = store.transitionNode(created.run.id, "second", {
      status: "running",
      ...paths,
    });
    const secondSucceeded = store.transitionNode(created.run.id, "second", {
      status: "succeeded",
      exitCode: 0,
    });
    const finished = store.transitionRun(created.run.id, { status: "succeeded" });

    expect(running).toMatchObject({
      status: "running",
      runtimeVersion: "codex 1.2.3",
      outputPaths: paths,
    });
    expect(runningWithInputs).toMatchObject({
      status: "running",
      resolvedInputsPath: "/state/resolved-inputs.json",
    });
    expect(succeeded).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      runtimeVersion: "codex 1.2.3",
      effectiveModel: "gpt-5-effective",
      outputPaths: paths,
      resolvedInputsPath: "/state/resolved-inputs.json",
    });
    expect(secondRunning).toMatchObject({ status: "running" });
    expect(secondSucceeded).toMatchObject({ status: "succeeded" });
    expect(store.listNodeAttempts(created.run.id)).toMatchObject([
      { nodeId: "first", attempt: 1, status: "succeeded", outputPaths: paths },
      { nodeId: "second", attempt: 1, status: "succeeded", outputPaths: paths },
    ]);
    expect(finished).toMatchObject({ status: "succeeded" });
    expect(finished.finishedAt).toBeDefined();
    expectKilinError(
      () =>
        store.transitionRun(created.run.id, {
          status: "failed",
          failure: {
            code: "INTERNAL_ERROR",
            message: "Already finished",
          },
        }),
      "INTERNAL_ERROR",
    );
  });

  it("records immutable attempts while resetting only the aggregate node for retry", async () => {
    const { store } = await createStore();
    const created = store.createRun({
      plan: plan("attempt-history", [node("first")]),
      canonicalCwd: "/project/attempt-history",
      options,
    });
    const firstPaths = {
      stdoutPath: "/state/first/stdout.log",
      stderrPath: "/state/first/stderr.log",
      resultPath: "/state/first/result.txt",
    };
    const secondPaths = {
      stdoutPath: "/state/second/stdout.log",
      stderrPath: "/state/second/stderr.log",
      resultPath: "/state/second/result.txt",
    };

    store.transitionNode(created.run.id, "first", { status: "running", ...firstPaths });
    store.transitionNode(created.run.id, "first", {
      status: "failed",
      exitCode: 23,
      failure: { code: "NODE_EXIT_NONZERO", message: "retry me" },
    });
    const pending = store.retryNode(created.run.id, "first", 1);
    expect(pending).toMatchObject({ status: "pending", attempt: 2 });

    store.transitionNode(created.run.id, "first", { status: "running", ...secondPaths });
    store.transitionNode(created.run.id, "first", { status: "succeeded", exitCode: 0 });
    store.transitionRun(created.run.id, { status: "succeeded" });

    expect(store.listNodeAttempts(created.run.id, "first")).toMatchObject([
      {
        attempt: 1,
        status: "failed",
        exitCode: 23,
        failure: { code: "NODE_EXIT_NONZERO" },
        outputPaths: firstPaths,
      },
      { attempt: 2, status: "succeeded", exitCode: 0, outputPaths: secondPaths },
    ]);
    expect(store.getRun(created.run.id).attempts).toMatchObject([
      {
        nodeId: "first",
        attempt: 1,
        status: "failed",
        outputPaths: firstPaths,
      },
      {
        nodeId: "first",
        attempt: 2,
        status: "succeeded",
        outputPaths: secondPaths,
      },
    ]);
  });

  it("reconciles only active rows for one cwd before atomically creating its replacement", async () => {
    const { store } = await createStore();
    const stale = store.createRun({ plan: plan("stale"), canonicalCwd: "/project/stale", options });
    store.transitionNode(stale.run.id, "first", {
      status: "running",
      stdoutPath: "/state/stdout.log",
      stderrPath: "/state/stderr.log",
      resultPath: "/state/result.txt",
    });
    store.recordResolvedInputs(stale.run.id, "first", "/state/resolved-inputs.json");
    const unrelated = store.createRun({
      plan: plan("other"),
      canonicalCwd: "/project/other",
      options,
    });

    const replacement = store.createRunAfterStaleReconciliation({
      plan: plan("stale"),
      canonicalCwd: "/project/stale",
      options,
    });
    const reconciled = store.getRun(stale.run.id);

    expect(reconciled.run).toMatchObject({
      status: "interrupted",
      failure: { code: "RUN_INTERRUPTED" },
    });
    expect(reconciled.nodes.map(({ status }) => status)).toEqual(["interrupted", "skipped"]);
    expect(reconciled.nodes[0]?.resolvedInputsPath).toBe("/state/resolved-inputs.json");
    expect(replacement.run.status).toBe("running");
    expect(replacement.nodes.map(({ status }) => status)).toEqual(["pending", "pending"]);
    expect(store.getRun(unrelated.run.id).run.status).toBe("running");
  });

  it.each([
    { name: "interrupted", latched: false, status: "interrupted" as const },
    { name: "cancelled", latched: true, status: "cancelled" as const },
  ])(
    "reconciles a running loop control and active body as $name while skipping future bodies",
    async ({ latched, status }) => {
      const { store } = await createStore();
      const canonicalCwd = `/project/stale-loop-${status}`;
      const executionPlan = staleLoopPlan();
      const activeExecutionId = executionPlan.loops[0]?.iterations[0]?.feedbackTargetExecutionId;
      if (activeExecutionId === undefined) {
        throw new Error("Expected the stale loop fixture to compile an active body occurrence");
      }
      const stale = store.createRun({
        plan: executionPlan,
        canonicalCwd,
        options,
      });
      store.startLoop(stale.run.id, "feedback");
      store.transitionNode(stale.run.id, activeExecutionId, {
        status: "running",
        stdoutPath: "/state/loop-body/stdout.log",
        stderrPath: "/state/loop-body/stderr.log",
        resultPath: "/state/loop-body/result.txt",
      });
      if (latched) {
        store.requestRunCancellation(stale.run.id);
      }

      const [reconciled] = store.reconcileStaleRuns(canonicalCwd);

      expect(reconciled?.run).toMatchObject({
        status,
        ...(latched ? {} : { failure: { code: "RUN_INTERRUPTED" } }),
      });
      expect(reconciled?.nodes).toMatchObject([
        {
          kind: "loop",
          nodeId: "feedback",
          status,
          ...(latched ? {} : { failure: { code: "RUN_INTERRUPTED" } }),
        },
        {
          kind: "agent",
          bodyNodeId: "review",
          iteration: 0,
          status,
          ...(latched ? {} : { failure: { code: "RUN_INTERRUPTED" } }),
        },
        {
          kind: "agent",
          bodyNodeId: "decision",
          iteration: 0,
          status: "skipped",
        },
        {
          kind: "agent",
          bodyNodeId: "review",
          iteration: 1,
          status: "skipped",
        },
        {
          kind: "agent",
          bodyNodeId: "decision",
          iteration: 1,
          status: "skipped",
        },
      ]);
      expect(store.listNodeAttempts(stale.run.id, activeExecutionId)).toMatchObject([
        {
          status,
          ...(latched ? {} : { failure: { code: "RUN_INTERRUPTED" } }),
        },
      ]);
      if (latched) {
        expect(reconciled?.run.failure).toBeUndefined();
        expect(reconciled?.nodes[0]?.failure).toBeUndefined();
        expect(reconciled?.nodes[1]?.failure).toBeUndefined();
      }
    },
  );

  it("fails stale reconciliation when a running agent lost its attempt row", async () => {
    const { dataDirectory, store } = await createStore();
    const stale = store.createRun({
      plan: plan("missing-running-attempt", [node("first")]),
      canonicalCwd: "/project/missing-running-attempt",
      options,
    });
    store.transitionNode(stale.run.id, "first", {
      status: "running",
      stdoutPath: "/state/stdout.log",
      stderrPath: "/state/stderr.log",
      resultPath: "/state/result.txt",
    });
    const database = new Database(join(dataDirectory, "kilin.db"));
    database.prepare("DELETE FROM node_attempts WHERE run_id = ?").run(stale.run.id);
    database.close();

    expectKilinError(
      () =>
        store.createRunAfterStaleReconciliation({
          plan: plan("missing-running-attempt", [node("first")]),
          canonicalCwd: "/project/missing-running-attempt",
          options,
        }),
      "INTERNAL_ERROR",
    );
    expect(store.getRun(stale.run.id).run.status).toBe("running");
    expect(store.listNodeAttempts(stale.run.id, "first")).toEqual([]);
  });

  it("supports bounded newest-run queries and actionable missing-run errors", async () => {
    const { store } = await createStore();
    const failed = store.createRun({ plan: plan("failed"), canonicalCwd: "/failed", options });
    expect(store.skipPendingNodes(failed.run.id).map(({ status }) => status)).toEqual([
      "skipped",
      "skipped",
    ]);
    store.transitionRun(failed.run.id, {
      status: "failed",
      failure: {
        code: "NODE_EXIT_NONZERO",
        message: "The node exited with status 1. Inspect stderr.",
      },
    });
    store.createRun({ plan: plan("running"), canonicalCwd: "/running", options });

    expect(store.listRuns({ status: "failed" })).toMatchObject([
      { id: failed.run.id, workflowId: "failed", status: "failed" },
    ]);
    expect(store.listRuns({ limit: 1 })).toHaveLength(1);
    expectKilinError(() => store.listRuns({ limit: 0 }), "OPTION_INVALID");
    const missingError = expectKilinError(() => store.getRun("missing-run"), "RUN_NOT_FOUND");
    expect(missingError.message).toContain("kilin runs list");
  });

  it("maps a write lock held beyond the busy timeout without dropping state", async () => {
    const { dataDirectory, store } = await createStore();
    const lockHolder = new Database(join(dataDirectory, "kilin.db"));
    lockHolder.pragma("journal_mode = WAL");
    lockHolder.exec("BEGIN IMMEDIATE");

    const startedAt = Date.now();
    let error: KilinError;
    let elapsedMs: number;
    try {
      error = expectKilinError(
        () =>
          store.createRun({
            plan: plan("busy-timeout"),
            canonicalCwd: "/project/busy",
            options,
          }),
        "STATE_BUSY",
      );
      elapsedMs = Date.now() - startedAt;
    } finally {
      lockHolder.exec("ROLLBACK");
      lockHolder.close();
    }

    expect(error.message).toContain("within five seconds");
    expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
    expect(store.listRuns()).toEqual([]);

    const created = store.createRun({
      plan: plan("busy-timeout"),
      canonicalCwd: "/project/busy",
      options,
    });
    expect(store.listRuns()).toMatchObject([{ id: created.run.id, status: "running" }]);
  });
});

describe("StateStore cancellation latch", () => {
  const outputPaths = {
    stdoutPath: "/state/runs/r/nodes/000-first/stdout.log",
    stderrPath: "/state/runs/r/nodes/000-first/stderr.log",
    resultPath: "/state/runs/r/nodes/000-first/result.txt",
  };

  const latchedRun = async (
    workflowId: string,
  ): Promise<{ dataDirectory: string; store: TestStateStore; runId: string }> => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan(workflowId, [node("first")]),
      canonicalCwd: `/project/${workflowId}`,
      options,
    });
    return { dataDirectory, store, runId: created.run.id };
  };

  it("records one monotonic request and rejects a terminal target", async () => {
    const { store, runId } = await latchedRun("latch-request");

    const first = store.requestRunCancellation(runId);
    expect(first.runId).toBe(runId);
    expect(store.readCancellationRequest(runId)).toBe(first.cancelRequestedAt);
    expect(store.requestRunCancellation(runId)).toEqual(first);
    expect(store.getRun(runId).run.cancelRequestedAt).toBe(first.cancelRequestedAt);

    store.skipPendingNodes(runId);
    store.transitionRun(runId, { status: "cancelled" });
    const error = expectKilinError(
      () => store.requestRunCancellation(runId),
      "RUN_NOT_CANCELLABLE",
    );
    expect(error.message).toContain("cancelled");
  });

  it("refuses to admit a pending node once the request has committed", async () => {
    const { dataDirectory, store, runId } = await latchedRun("latch-admission");
    store.requestRunCancellation(runId);

    const unchanged = store.transitionNode(runId, "first", {
      status: "running",
      ...outputPaths,
    });

    expect(unchanged.status).toBe("pending");
    expect(unchanged.outputPaths).toBeUndefined();
    expect(store.listNodeAttempts(runId, "first")).toEqual([]);
    const database = new Database(join(dataDirectory, "kilin.db"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT status, started_at FROM node_runs WHERE run_id = ? AND node_id = 'first'",
          )
          .get(runId),
      ).toEqual({ status: "pending", started_at: null });
    } finally {
      database.close();
    }
  });

  it("refuses to start an approval wait once the request has committed", async () => {
    const { dataDirectory, store, runId } = await latchedRun("latch-approval-start");
    replaceWithApprovalNode(dataDirectory, runId, "pending");
    store.requestRunCancellation(runId);

    const unchanged = store.requestApproval(runId, "first");

    expect(unchanged.status).toBe("pending");
    expect(unchanged.requestedAt).toBeUndefined();
    expect(unchanged.deadlineAt).toBeUndefined();
  });

  it("settles a waiting approval cancelled instead of consuming a decision or its deadline", async () => {
    const { dataDirectory, store, runId } = await latchedRun("latch-approval-poll");
    replaceWithApprovalNode(dataDirectory, runId, "pending");
    const waiting = store.requestApproval(runId, "first");
    expect(waiting.status).toBe("waiting_for_approval");
    store.recordApprovalDecision(runId, "first", "approve", "human");
    store.requestRunCancellation(runId);

    const polled = store.pollApproval(runId, "first");

    expect(polled.status).toBe("cancelled");
    expect(polled.failure).toBeUndefined();
    // The committed decision stays recorded as evidence; it is simply never consumed.
    expect(polled.decision).toMatchObject({ decision: "approve", actor: "human" });
  });

  it("rewrites a still-active non-cancel node outcome to cancelled", async () => {
    const { store, runId } = await latchedRun("latch-node-outcome");
    store.transitionNode(runId, "first", { status: "running", ...outputPaths });
    store.requestRunCancellation(runId);

    const settled = store.transitionNode(runId, "first", { status: "succeeded", exitCode: 0 });

    expect(settled.status).toBe("cancelled");
    expect(settled.failure).toBeUndefined();
    expect(store.listNodeAttempts(runId, "first")).toMatchObject([
      { attempt: 1, status: "cancelled" },
    ]);
  });

  it("rewrites a non-cancel terminal run outcome to cancelled and clears its failure", async () => {
    const { store, runId } = await latchedRun("latch-run-outcome");
    store.transitionNode(runId, "first", { status: "running", ...outputPaths });
    store.transitionNode(runId, "first", { status: "succeeded", exitCode: 0 });
    store.requestRunCancellation(runId);

    const settled = store.transitionRun(runId, { status: "succeeded" });

    expect(settled.status).toBe("cancelled");
    expect(settled.failure).toBeUndefined();
  });

  it("loses the retry rescheduling compare-and-set to a committed request", async () => {
    const { store, runId } = await latchedRun("latch-retry");
    store.transitionNode(runId, "first", { status: "running", ...outputPaths });
    store.transitionNode(runId, "first", {
      status: "failed",
      exitCode: 23,
      failure: { code: "NODE_EXIT_NONZERO", message: "retry me" },
    });
    store.requestRunCancellation(runId);

    const unchanged = store.retryNode(runId, "first", 1);

    expect(unchanged.status).toBe("failed");
    expect(unchanged.attempt).toBeUndefined();
    expect(unchanged.failure?.code).toBe("NODE_EXIT_NONZERO");
    expect(store.listNodeAttempts(runId, "first")).toMatchObject([
      { attempt: 1, status: "failed", failure: { code: "NODE_EXIT_NONZERO" } },
    ]);
  });

  it("rejects a retry whose expected attempt no longer matches", async () => {
    const { store, runId } = await latchedRun("latch-retry-attempt");
    store.transitionNode(runId, "first", { status: "running", ...outputPaths });
    store.transitionNode(runId, "first", {
      status: "failed",
      exitCode: 23,
      failure: { code: "NODE_EXIT_NONZERO", message: "retry me" },
    });

    expectKilinError(() => store.retryNode(runId, "first", 7), "INTERNAL_ERROR");
    expect(store.getRun(runId).nodes[0]?.status).toBe("failed");
  });

  it("reconciles a latched ownerless run as cancelled rather than interrupted", async () => {
    const { store, runId } = await latchedRun("latch-reconcile");
    store.transitionNode(runId, "first", { status: "running", ...outputPaths });
    store.requestRunCancellation(runId);

    const [reconciled] = store.reconcileStaleRuns("/project/latch-reconcile");

    expect(reconciled?.run.status).toBe("cancelled");
    expect(reconciled?.run.failure).toBeUndefined();
    expect(reconciled?.nodes[0]?.status).toBe("cancelled");
    expect(reconciled?.nodes[0]?.failure).toBeUndefined();
    expect(store.listNodeAttempts(runId, "first")).toMatchObject([
      { attempt: 1, status: "cancelled" },
    ]);
  });

  it("rejects a stored parameter snapshot that is not a flat string map", async () => {
    const { dataDirectory, store } = await createStore();
    const created = store.createRun({
      plan: plan("latch-parameters", [node("first")]),
      canonicalCwd: "/project/latch-parameters",
      options,
      parameters: { task: "ok" },
    });
    expect(store.getRun(created.run.id).run.parameters).toEqual({ task: "ok" });

    const database = new Database(join(dataDirectory, "kilin.db"));
    try {
      database
        .prepare("UPDATE workflow_runs SET parameters_json = ? WHERE id = ?")
        .run('{"task":123}', created.run.id);
    } finally {
      database.close();
    }

    const error = expectKilinError(() => store.getRun(created.run.id), "INTERNAL_ERROR");
    expect(error.message).toContain("parameter snapshot");
  });
});
