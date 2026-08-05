-- The complete version 1 state baseline, frozen so the version 2 forward migration has a real
-- database to upgrade. Generated from STATE_SCHEMA_SQL at the commit that introduced version 2.
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

INSERT INTO schema_migrations (version, applied_at)
VALUES (1, '2026-07-26T00:00:00.000Z');
