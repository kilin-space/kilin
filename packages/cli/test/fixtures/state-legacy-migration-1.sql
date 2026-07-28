CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE workflow_revisions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  normalized_definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, content_hash)
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES workflow_revisions(id),
  rerun_of_run_id TEXT REFERENCES workflow_runs(id),
  canonical_cwd TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failure_code TEXT,
  failure_message TEXT
);

CREATE TABLE node_runs (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  requested_model TEXT,
  effective_model TEXT,
  runtime_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'skipped')),
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  failure_code TEXT,
  failure_message TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  result_path TEXT,
  PRIMARY KEY (run_id, node_id),
  UNIQUE (run_id, ordinal)
);

CREATE INDEX workflow_runs_cwd_status_index ON workflow_runs(canonical_cwd, status);
CREATE INDEX workflow_runs_started_at_index ON workflow_runs(started_at DESC, id DESC);

INSERT INTO schema_migrations (version, applied_at)
VALUES (1, '2026-07-20T00:00:00.000Z');

INSERT INTO workflow_revisions (
  id, workflow_id, schema_version, content_hash, normalized_definition, created_at
) VALUES (
  'legacy-revision',
  'legacy-workflow',
  1,
  '0000000000000000000000000000000000000000000000000000000000000000',
  '{"edges":[],"nodes":[{"access":"read_only","id":"legacy-node","kind":"agent","prompt":"legacy","runtime":"codex"}],"schemaVersion":1,"workflow":{"id":"legacy-workflow","name":"Legacy workflow"}}',
  '2026-07-20T00:01:00.000Z'
);

INSERT INTO workflow_runs (
  id, revision_id, rerun_of_run_id, canonical_cwd, options_json, status,
  started_at, finished_at, failure_code, failure_message
) VALUES (
  'legacy-run',
  'legacy-revision',
  NULL,
  '/legacy/project',
  '{"nodeTimeoutMs":60000,"maxOutputBytes":1048576}',
  'succeeded',
  '2026-07-20T00:02:00.000Z',
  '2026-07-20T00:03:00.000Z',
  NULL,
  NULL
);

INSERT INTO node_runs (
  run_id, node_id, ordinal, runtime, requested_model, effective_model, runtime_version,
  status, started_at, finished_at, exit_code, failure_code, failure_message,
  stdout_path, stderr_path, result_path
) VALUES (
  'legacy-run',
  'legacy-node',
  0,
  'codex',
  'gpt-5',
  'gpt-5-effective',
  'codex 0.144.6',
  'succeeded',
  '2026-07-20T00:02:00.000Z',
  '2026-07-20T00:03:00.000Z',
  0,
  NULL,
  NULL,
  '/legacy/state/stdout.log',
  '/legacy/state/stderr.log',
  '/legacy/state/result.txt'
);
