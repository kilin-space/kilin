# V1 Reliable Orchestration

This document defines retry, continuation, choice routing, named workspaces, and bounded parallel
execution for the current V1 contract. Every authored workflow uses `schemaVersion: 1`.

## Retry policy

An agent may declare:

```yaml
retry:
  maxAttempts: 3
  initialBackoffMs: 1000
  maxBackoffMs: 30000
  safeToRepeat: true
```

`maxAttempts` is 1 through 5. `initialBackoffMs` and `maxBackoffMs` are 0 through 300000
milliseconds with exponential growth between attempts. `safeToRepeat: true` is required. An
optional `on` list restricts the retryable failure codes (`NODE_OUTPUT_INVALID`,
`NODE_EXIT_NONZERO`, `NODE_TIMEOUT`); omitting it retries all three. An attempt records its own
status, timestamps, runtime metadata, error, and private capture paths. Kilin retries only the
declared node occurrence. It does not resume a provider session.

Without a declared `retry`, a `read_only` agent retries `NODE_OUTPUT_INVALID` once — two attempts
in total, with no backoff. Read-only re-execution cannot mutate the workspace, so the built-in
second attempt is safe by construction; the retry prompt carries the validation failure so the
runtime can correct the serialization. A declared `retry` replaces this default. `workspace_write`
agents never retry without an explicit `safeToRepeat: true`.

## Join and choice routing

`join` controls how a node becomes ready:

- `all` requires every incoming edge to be active and successful.
- `any` runs after at least one incoming edge succeeds and all possible incoming routes settle.

An agent may declare one `choice` output with 2 through 32 unique lowercase choice IDs. A
conditional edge names one declared choice. Every choice must have an outgoing route. Unselected
routes are skipped; choice values remain private recorded data.

## Named workspaces

A workflow may declare named Git worktree lanes. An agent selects either the source workspace or
one declared lane. Kilin creates detached worktrees beneath its private data root and retains them
for inspection. It never merges, resets, pushes, or deletes them automatically.

Every unordered pair containing a `workspace_write` agent must use distinct isolated lanes.
Approvals and source-workspace writers remain exclusive barriers.

## Parallel readiness

`run` and `rerun` accept `--max-parallel` from 1 through 8. The default is 1. Independent
`read_only` agents may overlap up to the selected bound. Writers and approvals remain exclusive.

On failure, Kilin skips transitive descendants while allowing already-running and independent
branches to settle. The primary node failure is the failed occurrence with the lowest compiled
ordinal. Engine faults remain run-level failures.

## Continuation

`retry <run-id>` creates a continuation from a failed run. `resume <run-id>` also accepts cancelled
or interrupted runs. Both reuse the stored workflow revision, canonical working directory,
parameters, trigger provenance, effective limits, and eligible successful results. They never read
the current package.

Continuation is allowed only when every `workspace_write` occurrence uses a named isolated
workspace. This prevents replay from silently depending on untracked mutations in the source
checkout. Approval decisions are always requested again.

`runs wait` is a one-shot recorded-state query. It returns when a run becomes terminal or needs an
approval; it is not a daemon or event subscription.

## Security invariants

- Workflow content cannot supply raw runtime arguments, environment variables, extra roots, or
  sandbox bypasses.
- Workspace paths are derived from validated declarations and private run identity.
- Recovery never reuses a provider session.
- Retained worktrees are ordinary local data and may contain sensitive changes.
- State and private files remain bounded and user-private.
