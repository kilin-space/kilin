import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

import { KilinError } from "../domain/errors.js";

const STATE_SCHEMA_VERSION = 2;

/**
 * The `node_attempts` columns introduced by version 2, in declaration order. They are listed
 * separately because the version 1 upgrade adds them one `ALTER TABLE ADD COLUMN` at a time, and
 * SQLite appends an added column after the last column definition and before the table
 * constraints — so replaying this list reproduces the baseline text below exactly. The order is
 * load-bearing: the final column's constraint references the two before it.
 */
const NODE_ATTEMPT_PROCESS_COLUMNS: readonly string[] = [
  "process_pid INTEGER CHECK (process_pid IS NULL OR process_pid > 0)",
  "process_group_id INTEGER CHECK (process_group_id IS NULL OR process_group_id > 0)",
  `process_start_identifier TEXT CHECK (
      (
        process_start_identifier IS NULL
        AND process_pid IS NULL
        AND process_group_id IS NULL
      )
      OR (
        process_start_identifier IS NOT NULL
        AND process_pid IS NOT NULL
        AND process_group_id IS NOT NULL
      )
    )`,
];

const STATE_SCHEMA_SQL = `
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE workflow_revisions (
    id TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'user')),
    scope_root TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    content_hash TEXT NOT NULL,
    normalized_definition TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (
      (scope_kind = 'user' AND scope_root = '')
      OR (scope_kind = 'project' AND length(scope_root) > 0)
    ),
    UNIQUE (scope_kind, scope_root, workflow_id, content_hash)
  );

  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
    rerun_of_run_id TEXT REFERENCES workflow_runs(id),
    recovery_of_run_id TEXT REFERENCES workflow_runs(id),
    recovery_mode TEXT CHECK (
      recovery_mode IS NULL OR recovery_mode IN ('retry', 'resume')
    ),
    canonical_cwd TEXT NOT NULL,
    options_json TEXT NOT NULL,
    parameters_json TEXT CHECK (
      parameters_json IS NULL
      OR (json_valid(parameters_json) AND json_type(parameters_json) = 'object')
    ),
    trigger_source_json TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')
    ),
    started_at TEXT NOT NULL,
    cancel_requested_at TEXT,
    finished_at TEXT,
    failure_code TEXT,
    failure_message TEXT
  );

  CREATE TABLE node_runs (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('agent', 'approval', 'loop')),
    body_node_id TEXT,
    loop_node_id TEXT,
    iteration INTEGER CHECK (iteration IS NULL OR iteration >= 0),
    runtime TEXT CHECK (runtime IS NULL OR runtime IN ('codex', 'claude-code', 'opencode')),
    requested_model TEXT,
    effective_model TEXT,
    runtime_version TEXT,
    status TEXT NOT NULL CHECK (
      status IN (
        'pending', 'running', 'waiting_for_approval', 'succeeded',
        'failed', 'cancelled', 'interrupted', 'skipped'
      )
    ),
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    failure_code TEXT,
    failure_message TEXT,
    stdout_path TEXT,
    stderr_path TEXT,
    result_path TEXT,
    resolved_inputs_path TEXT,
    output_type TEXT CHECK (
      output_type IS NULL
      OR output_type IN ('text', 'json', 'decision_packet', 'artifact')
    ),
    artifact_path TEXT CHECK (
      artifact_path IS NULL OR length(CAST(artifact_path AS BLOB)) BETWEEN 1 AND 1024
    ),
    approval_decision TEXT CHECK (
      approval_decision IS NULL OR approval_decision IN ('approve', 'reject')
    ),
    approval_actor TEXT CHECK (approval_actor IS NULL OR approval_actor IN ('agent', 'human')),
    approval_note TEXT CHECK (approval_note IS NULL OR length(approval_note) <= 1000),
    approval_requested_at TEXT,
    approval_deadline_at TEXT,
    approval_decided_at TEXT,
    current_attempt INTEGER NOT NULL DEFAULT 1 CHECK (current_attempt >= 1),
    reused_from_run_id TEXT REFERENCES workflow_runs(id),
    reused_from_node_id TEXT,
    declared_output_type TEXT CHECK (
      declared_output_type IS NULL OR declared_output_type = 'choice'
    ),
    CHECK (
      (
        body_node_id IS NULL
        AND loop_node_id IS NULL
        AND iteration IS NULL
      )
      OR (
        body_node_id IS NOT NULL
        AND loop_node_id IS NOT NULL
        AND iteration IS NOT NULL
        AND kind IN ('agent', 'approval')
      )
    ),
    CHECK (
      (output_type IS 'artifact' AND artifact_path IS NOT NULL)
      OR (output_type IS NOT 'artifact' AND artifact_path IS NULL)
    ),
    CHECK (
      (
        approval_decision IS NULL
        AND approval_actor IS NULL
        AND approval_note IS NULL
        AND approval_decided_at IS NULL
      )
      OR (
        approval_decision IS NOT NULL
        AND approval_actor IS NOT NULL
        AND approval_decided_at IS NOT NULL
      )
    ),
    CHECK (
      (
        kind = 'agent'
        AND runtime IS NOT NULL
        AND status <> 'waiting_for_approval'
        AND approval_decision IS NULL
        AND approval_actor IS NULL
        AND approval_note IS NULL
        AND approval_requested_at IS NULL
        AND approval_deadline_at IS NULL
        AND approval_decided_at IS NULL
      )
      OR (
        kind = 'approval'
        AND runtime IS NULL
        AND requested_model IS NULL
        AND effective_model IS NULL
        AND runtime_version IS NULL
        AND status <> 'running'
        AND started_at IS NULL
        AND exit_code IS NULL
        AND stdout_path IS NULL
        AND stderr_path IS NULL
        AND result_path IS NULL
        AND resolved_inputs_path IS NULL
        AND output_type IS NULL
        AND artifact_path IS NULL
      )
      OR (
        kind = 'loop'
        AND body_node_id IS NULL
        AND loop_node_id IS NULL
        AND iteration IS NULL
        AND runtime IS NULL
        AND requested_model IS NULL
        AND effective_model IS NULL
        AND runtime_version IS NULL
        AND status <> 'waiting_for_approval'
        AND exit_code IS NULL
        AND stdout_path IS NULL
        AND stderr_path IS NULL
        AND resolved_inputs_path IS NULL
        AND artifact_path IS NULL
        AND approval_decision IS NULL
        AND approval_actor IS NULL
        AND approval_note IS NULL
        AND approval_requested_at IS NULL
        AND approval_deadline_at IS NULL
        AND approval_decided_at IS NULL
        AND current_attempt = 1
        AND reused_from_run_id IS NULL
        AND reused_from_node_id IS NULL
        AND (
          (status = 'succeeded' AND result_path IS NOT NULL AND output_type IS NOT NULL)
          OR (status <> 'succeeded' AND result_path IS NULL)
        )
      )
    ),
    CHECK (
      kind <> 'approval'
      OR (
        (
          status IN ('pending', 'skipped')
          AND approval_requested_at IS NULL
          AND approval_deadline_at IS NULL
          AND approval_decision IS NULL
        )
        OR (
          status = 'waiting_for_approval'
          AND approval_requested_at IS NOT NULL
          AND approval_deadline_at IS NOT NULL
        )
        OR (
          status = 'succeeded'
          AND approval_requested_at IS NOT NULL
          AND approval_deadline_at IS NOT NULL
          AND approval_decision IS 'approve'
        )
        OR (
          status = 'failed'
          AND approval_requested_at IS NOT NULL
          AND approval_deadline_at IS NOT NULL
          AND (approval_decision IS NULL OR approval_decision IS 'reject')
        )
        OR (
          status IN ('cancelled', 'interrupted')
          AND approval_requested_at IS NOT NULL
          AND approval_deadline_at IS NOT NULL
        )
      )
    ),
    PRIMARY KEY (run_id, node_id),
    UNIQUE (run_id, ordinal)
  );

  CREATE TABLE node_attempts (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    status TEXT NOT NULL CHECK (
      status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')
    ),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    exit_code INTEGER,
    failure_code TEXT,
    failure_message TEXT,
    stdout_path TEXT NOT NULL,
    stderr_path TEXT NOT NULL,
    result_path TEXT NOT NULL,
    ${NODE_ATTEMPT_PROCESS_COLUMNS.join(",\n    ")},
    PRIMARY KEY (run_id, node_id, attempt),
    FOREIGN KEY (run_id, node_id)
      REFERENCES node_runs(run_id, node_id) ON DELETE CASCADE
  );

  CREATE TABLE run_workspaces (
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status = 'provisioned'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, workspace_id),
    UNIQUE (path)
  );

  CREATE INDEX workflow_runs_cwd_status_index ON workflow_runs(canonical_cwd, status);
  CREATE INDEX workflow_runs_started_at_index ON workflow_runs(started_at DESC, id DESC);
  CREATE INDEX node_runs_loop_iteration_index
    ON node_runs(run_id, loop_node_id, iteration, ordinal);
`;

interface SchemaObjectRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string;
}

interface StateSchemaVersionRow {
  readonly version: number;
}

interface TableColumnRow {
  readonly name: string;
}

const incompatibleStateError = (): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    "The Kilin database is incompatible with this build. Archive or reset the existing data directory before retrying.",
  );

const normalizeSchemaSql = (sql: string): string => sql.replaceAll(/\s+/g, " ").trim();

const readSchemaObjects = (database: SqliteDatabase): SchemaObjectRow[] =>
  database
    .prepare(
      `
        SELECT type, name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND type IN ('index', 'table', 'trigger', 'view')
        ORDER BY type, name
      `,
    )
    .all() as SchemaObjectRow[];

const expectedSchemaObjects = (): ReadonlyMap<string, string> => {
  const database = new Database(":memory:");
  try {
    database.exec(STATE_SCHEMA_SQL);
    return new Map(
      readSchemaObjects(database).map(({ type, name, sql }) => [
        `${type}:${name}`,
        normalizeSchemaSql(sql),
      ]),
    );
  } finally {
    database.close();
  }
};

const EXPECTED_SCHEMA_OBJECTS = expectedSchemaObjects();

const isEmptyStateDatabase = (database: SqliteDatabase): boolean =>
  readSchemaObjects(database).length === 0;

const recordSchemaVersion = (database: SqliteDatabase, appliedAt: string): void => {
  database.prepare("DELETE FROM schema_migrations").run();
  database
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(STATE_SCHEMA_VERSION, appliedAt);
};

const createStateSchema = (database: SqliteDatabase, appliedAt: string): void => {
  database.exec(STATE_SCHEMA_SQL);
  recordSchemaVersion(database, appliedAt);
};

const storedSchemaVersions = (database: SqliteDatabase): readonly number[] =>
  (
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as StateSchemaVersionRow[]
  ).map(({ version }) => version);

const nodeAttemptColumnNames = (database: SqliteDatabase): readonly string[] =>
  (database.pragma("table_info(node_attempts)") as TableColumnRow[]).map(({ name }) => name);

/**
 * The `node_attempts` columns as version 1 shipped them, matching
 * `test/fixtures/state-version-1.sql`.
 */
const VERSION_1_NODE_ATTEMPT_COLUMNS: readonly string[] = [
  "run_id",
  "node_id",
  "attempt",
  "status",
  "started_at",
  "finished_at",
  "exit_code",
  "failure_code",
  "failure_message",
  "stdout_path",
  "stderr_path",
  "result_path",
];

/**
 * Brings a version 1 database to version 2 by making room to record the process identity of each
 * node attempt.
 *
 * A recorded version of 1 is not enough on its own: pre-release databases exist that claim version
 * 1 without ever having had a `node_attempts` table, and altering one of those would replace the
 * actionable incompatible-state error with a raw SQLite failure. The version 1 column set is
 * therefore checked as well. Everything runs inside the caller's exclusive transaction, so a
 * database that passes both
 * checks yet still fails the baseline assertion afterwards rolls back without mutation.
 */
const migrateStateSchema = (database: SqliteDatabase, appliedAt: string): void => {
  // The shape is checked before the ledger is read, because reading it from a database that has no
  // `schema_migrations` table would raise a raw SQLite error in place of the actionable one.
  const tables = new Set(readSchemaObjects(database).map(({ name }) => name));
  const columns = nodeAttemptColumnNames(database);
  if (
    !tables.has("schema_migrations") ||
    columns.length !== VERSION_1_NODE_ATTEMPT_COLUMNS.length ||
    columns.some((name, index) => name !== VERSION_1_NODE_ATTEMPT_COLUMNS[index])
  ) {
    return;
  }
  const versions = storedSchemaVersions(database);
  if (versions.length !== 1 || versions[0] !== 1) {
    return;
  }
  for (const column of NODE_ATTEMPT_PROCESS_COLUMNS) {
    database.exec(`ALTER TABLE node_attempts ADD COLUMN ${column}`);
  }
  recordSchemaVersion(database, appliedAt);
};

export const assertCurrentStateSchema = (database: SqliteDatabase): void => {
  const rows = readSchemaObjects(database);
  if (rows.length !== EXPECTED_SCHEMA_OBJECTS.size) {
    throw incompatibleStateError();
  }
  for (const { type, name, sql } of rows) {
    if (EXPECTED_SCHEMA_OBJECTS.get(`${type}:${name}`) !== normalizeSchemaSql(sql)) {
      throw incompatibleStateError();
    }
  }

  const versions = storedSchemaVersions(database);
  if (
    versions.length !== 1 ||
    versions[0] !== STATE_SCHEMA_VERSION ||
    (database.pragma("foreign_key_check") as unknown[]).length !== 0
  ) {
    throw incompatibleStateError();
  }
};

export const initializeStateSchema = (
  database: SqliteDatabase,
  appliedAt: string,
  allowCreation: boolean,
): void => {
  database.exec("BEGIN EXCLUSIVE");
  try {
    if (isEmptyStateDatabase(database)) {
      if (!allowCreation) {
        throw incompatibleStateError();
      }
      createStateSchema(database, appliedAt);
    } else {
      migrateStateSchema(database, appliedAt);
    }
    assertCurrentStateSchema(database);
    database.exec("COMMIT");
  } catch (error: unknown) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
};
