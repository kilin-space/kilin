# V1 Architecture

## Architecture choice

Kilin V1 is one local TypeScript modular monolith with one CLI entry point, one SQLite database, one execution core, and narrow subprocess and filesystem boundaries. It is not a service or package platform.

The foreground CLI owns every execution and recorded-state transition; workflow packages remain ordinary authored project or user files. `kilin ui` is the sole listener: an attached, authenticated loopback Viewer that queries scoped recorded state, may record a guarded Human Decision for an eligible waiting approval or a cancellation request for a scoped run — a closed set of two mutations — and stops with its CLI process.

```text
author / canonical agent skills
              |
              v
 project/user workflow package
    |                    |
    v                    v
WORKFLOW.md         WORKFLOW.yaml
 discovery               |
                         v
              parse -> validate -> compile
                         |
                         v
                  ExecutionPlan ----------------------+
                                                     v
host cron -> trigger request --------------> run / rerun use case
                                              ├── Codex adapter -> agent process -> bounded files
                                              ├── SQLite metadata
                                              |      |
                                              |      v
                                              |   viewer query + guarded approval decision
                                              |      |
                                              |      v
                                              |   attached 127.0.0.1 browser view
                                              └── RunEvent -> CLI
```

The source tree preserves these boundaries without separately published packages:

```text
src/
├── domain/          workflow, compilation, hashes, and lifecycle rules
├── application/     workflow, run, history, and viewer query use cases
├── infrastructure/  YAML, SQLite, locks, processes, runtime, and HTTP adapter
├── cli/             parsing and human/JSON rendering
└── ui/              local static viewer assets and DTOs
```

A boundary earns an interface when it crosses an external dependency or has a second concrete implementation. V1 has no generic dependency-injection container, runtime registry, event store, scheduler, or transport framework.

## Core model

### WorkflowDefinition

The validated authored contract in [Workflow Contract](workflow.md). It contains no database IDs, filesystem paths, runtime arguments, or execution state.

### WorkflowIdentity

The scope kind, canonical project root when applicable, and workflow ID. Package precedence resolves a source, while this tuple owns revision deduplication, history, rerun, and viewer isolation.

### WorkflowRevision

An immutable normalized definition identified within one `WorkflowIdentity` by a content hash. It is created or reused only when execution is ready to create a run. The stored normalized JSON and scope are sufficient to recompile after the source package changes or disappears.

### ExecutionPlan

The compiler output consumed by the only executor. It contains validated nodes, dependencies, deterministic order, normalized definition, and revision identity, but no mutable run state.

### WorkflowRun and NodeRun

A workflow run records one revision, canonical working directory, effective execution options, an
optional canonical [run-parameter](workflow.md#run-parameters) snapshot, optional cron trigger
provenance, optional rerun or recovery lineage, status, timestamps, and failure. Both the parameter
snapshot and the trigger provenance are invocation data: they belong to the run, never to the
immutable revision, so one revision serves many invocations. They are also independent of each other
— a version-1 triggered run is parameterless and stores a null parameter snapshot. Its node rows
record deterministic ordinal, runtime/model metadata, lifecycle state, exit code, failure, and output
paths once a process is about to start.

## Application operations

The execution path and guarded approval transition are exposed through transport-neutral operations:

- `runWorkflow(workflowName, cwd, executionOptions, control, environment, parameters)`
- `runTriggeredWorkflow(hostTriggerRequest, control, environment)`
- `rerunWorkflow(runId, control, environment, maxParallel)`
- `recordApprovalDecision(runId, nodeId, decision, actor, note)`

History and validation remain application queries or bounded reconciliation commands:

- initialize and validate a workflow;
- list runs and get one run; and
- project the current workflow, scoped run history, detail, lineage, and bounded output for the viewer.

`control` carries an `AbortSignal` and an in-process `onEvent(RunEvent)` sink. Event delivery cannot
change durable orchestration state. The CLI maps interruption to the signal and renders events. The
Viewer never calls `runWorkflow`, `runTriggeredWorkflow`, `rerunWorkflow`, or a runtime adapter. Its
GET projections use a read-only SQLite connection. Its single approval POST reuses
`recordApprovalDecision`, including the same narrow stale-owner check as the CLI decision commands.

## Run lifecycle and lock order

`runWorkflow` and `runTriggeredWorkflow` follow one ordered lifecycle:

```text
canonical cwd -> resolve package/scope -> read definition once -> parse/validate/compile
        -> validate supplied run parameters against the compiled plan
        -> probe Codex once
        -> open StateStore and verify the V1 state baseline
        -> acquire canonical-cwd lock descriptor
        -> reconcile stale state + create revision/run/pending nodes atomically
        -> execute the ready frontier, bounded by maxParallel
        -> persist terminal node and run state
        -> release that same cwd descriptor
```

In detail:

1. Resolve the supplied working directory to an existing canonical path, find the nearest package root, and resolve the requested name with project-over-user precedence.
2. Read the selected definition bytes once, safely parse them, validate package identity, structure, and graph semantics, normalize, and compile.
3. Validate any supplied [run parameters](workflow.md#run-parameters) against the compiled plan. An unknown name, a missing declared name, an oversized snapshot, or a consumer whose parameter-only envelope already exceeds the run limit fails with `RUN_PARAM_INVALID` here, before any probe, lock, or run row exists.
4. Probe every distinct runtime in the plan. V1 has one distinct runtime, Codex.
5. Open `StateStore`, initializing or verifying the exact V1 baseline under the separate state-schema lock before trying the canonical-cwd lock.
6. Acquire the non-blocking exclusive lock for the canonical cwd.
7. While holding that same cwd descriptor, use one SQLite transaction to reconcile prior active state for the cwd, create or reuse the revision, create the run, and create every pending node row.
8. Admit ready nodes in compiled order up to `maxParallel`, committing each node's `running` state and exact output paths before preparing files or spawning its process, and committing its terminal state when capture closes. Writers and approvals are exclusive barriers, so at the default bound of `1` this is exactly the original one-node-at-a-time sequence.
9. Commit one terminal run state, then release the cwd descriptor and close state.

No agent starts before step 7 commits. Source, path, graph, Git inspection, capability, authentication, state bootstrap, or lock failure creates no run and causes no workflow side effect. A pre-run user cancellation also creates no run or event. Once a run exists, failure and cancellation are durably terminal before the lock is released.

`runTriggeredWorkflow` receives a strict host request and supplies its workflow and cwd to this same
path. The only trigger-specific state is normalized cron provenance on the created run.

`rerun` first loads only the stored normalized JSON, recompiles it, and verifies its schema version,
workflow ID, normalized bytes, and hash. It then uses the recorded canonical cwd and options and
follows the same Git, probe, state, lock, creation, and execution path. It never reads the original
source, reuses output, resumes a provider session, or copies trigger provenance onto the lineage
run.

## Scheduling, failure, and cancellation

The authoritative run, kind-specific execution, attempt, retry-reset, and observation semantics are
defined in [Lifecycle State Contract](lifecycle-state.md).

Scheduling is host-owned. `kilin trigger --request <absolute-file>` accepts one bounded,
versioned cron request and immediately runs it in the foreground. The declared five-field schedule
and runtime-normalized IANA time zone are recorded for audit but never evaluated by Kilin. Kilin has
no clock poller, daemon, schedule table, queue, missed-run policy, crontab manager, or exactly-once
claim. An overlapping host invocation competes for the ordinary canonical-cwd lock and fails with
`WORKSPACE_BUSY` rather than waiting or creating a run.

The compiler determines a topological order. Declaration order breaks ties between ready read-only nodes. An edge requires predecessor success.

One application-owned frontier scheduler admits work from that order. `maxParallel` defaults to `1`,
which reproduces the original strictly sequential behavior exactly; values from 2 through 8 let
independent `read_only` agents overlap. Every `workspace_write` agent and every approval is an
ordinal-stable exclusive barrier: the scheduler admits nothing after a ready exclusive execution
until it settles, and it never admits it while other work is active. Named Git worktrees are
provisioned once per workspace ID, serially, while no agent process is running.

Overlap means overlapping child processes only. The scheduler keeps one event-loop owner and SQLite
is synchronous, so scheduler state is never mutated concurrently.

Run states are:

```text
running -> succeeded
        -> failed
        -> cancelled
        -> interrupted
```

Failure policy follows the bound. At `maxParallel = 1` the first failure skips every pending node and
fails the run. Above `1`, a failure skips only its transitive descendants while independent pending
and active branches still settle truthfully, and the run fails once all reachable independent work
has settled. Every node failure stays durable, and the run's primary failure is the lowest compiled
ordinal rather than whichever process finished first.

That ordering ranks node failures. An engine fault — a scheduling admission fault or an execution
fault rather than a node's own recorded outcome — closes admission, lets every in-flight branch
settle truthfully, and then becomes the run's failure whatever its ordinal. A fault raised while
admitting a node has no node record to carry it, so ranking it below a node failure would drop it
entirely; an environment or invariant break is never masked by a workflow's own failure.

Node states are:

```text
pending -> running -> succeeded
                   -> failed
                   -> cancelled
                   -> interrupted
        -> skipped
```

A zero process exit is successful only after required output and final-result capture are durable. A non-zero exit, timeout, combined-output breach, result or log capture failure, or internal post-creation error fails the active node and run. At `maxParallel = 1` no later node starts and every remaining pending node becomes skipped in plan order; above `1` the bounded failure policy above applies instead.

Kilin starts each runtime in its own process group. Cancellation targets the group, applies bounded TERM/KILL cleanup to descendants, retains captured output, marks active state cancelled, and skips pending work. Cancellation during preflight similarly reaps the probe group but creates no record.

Cancellation has two sources. The attached process maps `SIGINT`, `SIGTERM`, and `SIGHUP` to its
abort signal, so a supervisor or container stop terminates the process group instead of orphaning
it, and a second
local process can record a durable request with [`runs cancel`](cli.md#runs-cancel). After a run
exists, one application-owned monitor polls `workflow_runs.cancel_requested_at` on the existing
250 ms attention cadence and drives a single run-level `AbortController` that combines the caller's
signal with the latch. That combined signal reaches every active process group, approval wait, retry
backoff, and admission decision. The monitor stops in a `finally` path after terminal run
persistence; it is never a daemon and never runs before a run ID exists.

Durable SQLite commit order is the only race arbiter. Admission (`pending -> running` and
`pending -> waiting_for_approval`) and retry rescheduling each require a null latch in the same
transaction, so a request that commits first starts no process, no approval wait, and no further
attempt. A non-cancel terminal transition that has not yet committed is rewritten to `cancelled`
when the latch is already set, which keeps `node_runs` and `node_attempts` consistent without
fabricating failure text. Outcomes that committed before the request keep their truthful state, so
cancellation can win the run while a completed sibling retains its failure evidence.

Stale-run reconciliation honours the latch: an ownerless run with a recorded request reconciles as
`cancelled` rather than `interrupted`, and pending nodes still settle `skipped` in both paths.

## Workspace ownership and crash behavior

`kilin run` requires `--cwd`. Relative values resolve from the invocation directory, symlinks
resolve to a canonical absolute path, and the result must be an existing directory. Nodes use that
source directory unless they select a declared named isolated Git worktree. `workspace_write` may
modify its assigned workspace in place; Kilin never snapshots, cleans, resets, merges, or rolls it
back.

The lock is a non-blocking exclusive advisory lock held on an open descriptor at `~/.kilin/locks/<cwd-sha256>.lock`, keyed by the exact canonical cwd bytes. It coordinates Kilin processes only; editors and unrelated processes can still change the workspace. Supported V1 execution is macOS and Linux. Windows is deferred until equivalent lock semantics exist.

Kilin does not claim exactly-once execution. A crash after spawn may leave workspace changes and active rows. Reconciliation groups active rows by canonical cwd:

- if that cwd lock is busy, the group remains untouched because a live owner may exist;
- if acquisition succeeds, Kilin holds the descriptor while one transaction marks active nodes and runs `interrupted` and pending nodes `skipped`.

`run`, `trigger`, and `rerun` perform that reconciliation and replacement creation without releasing
and reacquiring the descriptor. Reconciling history commands check each distinct active cwd before
querying and ignore only live `WORKSPACE_BUSY` groups. Viewer GET projections are pure reads. The
single approval decision path performs only the existing guarded stale-owner check and decision
write; it adds no generic reconciliation surface.

Rerun repeatability is deliberately narrow: the normalized workflow, dependency plan, authored
node timeouts, persisted run options, revision identity, and canonical cwd are preserved.
Filesystem contents, model output, credentials, network state, runtime versions, and external
configuration may differ.

## Persistence and capture

V1 uses `~/.kilin/kilin.db`. Mutating `StateStore` connections enable foreign keys and WAL
journaling; all state connections use a five-second busy timeout. One transactional V1 baseline is
serialized by a separate state-schema lock. Existing databases must match the complete current
schema. A database at the immediately preceding baseline is brought forward inside that same
exclusive transaction by adding columns only; the current baseline is then asserted, so a shape that
merely claims the older version rolls back untouched. Every other partial, historical, future, or
tampered shape fails closed without mutation. Only a mutating command upgrades a database; the
read-only Viewer connection validates the current baseline and reports the state as unreadable until
one has run. Viewer
projections use a distinct read-only, `query_only` connection and validate the same baseline before
querying. The approval route opens the ordinary guarded state path only long enough to record one
eligible Human Decision. Transactions are short and never remain open while a provider runs.
Private POSIX modes are `0700` for state directories and `0600` for database sidecars, locks, and
output files, subject to stricter host policy.

The six tables are:

| Table                | Required data                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schema_migrations`  | the one applied baseline version and the time it was applied                                                                         |
| `workflow_revisions` | ID, scope kind/root, workflow ID, schema version, hash, normalized definition, created time                                          |
| `workflow_runs`      | revision, lineage, canonical cwd, options, parameter snapshot, trigger provenance, cancellation request, status, timestamps, failure |
| `node_runs`          | run/node identity, ordinal, runtime/model metadata, state, exit/failure, output paths                                                |
| `node_attempts`      | run/node identity, attempt number, state, timestamps, exit/failure, output paths, process identity until the process is observed ending or reaped |
| `run_workspaces`     | run ID, workspace ID, path, base commit, status, created time                                                                        |

`workflow_revisions` is unique by `(scope_kind, scope_root, workflow_id, content_hash)`, and each run has one node row per plan node. Streams remain ordinary files:

```text
~/.kilin/runs/<run-id>/nodes/<zero-padded-ordinal>-<node-id>/stdout.log
~/.kilin/runs/<run-id>/nodes/<zero-padded-ordinal>-<node-id>/stderr.log
~/.kilin/runs/<run-id>/nodes/<zero-padded-ordinal>-<node-id>/result.txt
```

The ordinal prevents case-insensitive node-ID collisions. The parent creates and monitors all
files; each adapter receives only its exact staging result path. V1 has no event table, blob store,
queue, exporter, or retention service.

## Attached viewer boundary

`kilin ui <workflow-name> --cwd <directory> [--no-open] [--json]` resolves and compiles the launch package, fixes its full workflow identity and canonical cwd as the session scope, and binds numeric `127.0.0.1` on port `0`. The operating system chooses the port. `--json` emits one `viewer.started` document before waiting and does not change browser-launch behavior. The server and credentials exist only while the foreground command is attached.

The launch URL contains a 256-bit, one-use token only in `#token=...`. Because fragments are not sent in HTTP requests, local JavaScript exchanges it through same-origin `POST /session` for a process-lifetime `kilin_session` cookie with `HttpOnly; SameSite=Strict; Path=/` and an in-memory CSRF token. `POST /session/resume` can restore the CSRF token from the cookie. The cookie intentionally has no `Secure` claim because the listener is plain HTTP on numeric loopback.

The server enforces an exact loopback peer, exact `Host`, exact `Origin` for POST and any supplied Origin, fixed methods and paths, small request bodies, no-store responses, and local assets. Its CSP starts from `default-src 'none'`, permits only self-hosted script, style, connection, and image sources, and denies fonts, objects, base URLs, forms, frames, inline execution, and unsafe execution. Authenticated API routes require both the cookie and `X-Kilin-CSRF`.

The data routes are current workflow, newest 50 scoped runs, one scoped run with lineage, and one stored node stream selected by run ID, ordinal, and `stdout`, `stderr`, or `result`. Scope is exact workflow identity plus canonical cwd. Output authorization derives the expected path from the stored run/node record, rejects traversal, symlinks, and non-regular files, rechecks identity after `O_NOFOLLOW`, and returns at most the 64 KiB tail. DTOs expose scope kind but not absolute persistence paths or project roots. The run summary carries a derived `waitingForApproval` flag that is presentation-only and grants no decision eligibility; the decision route revalidates the waiting state. The state-changing routes are a closed set of two: one records `approved` or `rejected` for an eligible scoped approval node through `recordApprovalDecision`, and one latches a cancellation request for a scoped run through `requestRunCancellation`.

The client applies the hierarchy and interaction principles described by Linear's [UI refresh](https://linear.app/changelog/2026-03-12-ui-refresh) and [conceptual model](https://linear.app/docs/conceptual-model) without copying assets: dim history navigation, a focused graph, compact inspector, neutral colors, one accent, and clear typography. It uses local semantic DOM/SVG, a textual execution-order equivalent, keyboard focus movement, reduced-motion handling, and polling (two seconds by default, with bounded backoff, a manual refresh, and a reduced fifteen-second cadence while the tab is hidden rather than a stop). There is no mutation route beyond the closed set of two guarded run-scoped mutations — the approval decision and the run cancellation — and no raw path parameter, WebSocket, public API guarantee, daemon mode, generic state reconciliation, or runtime invocation.

## Agent-side authoring boundary

Canonical skill instructions are CLI package assets under `packages/cli/agent-skills`, published verbatim so the source directory and the shipped directory are the same artifact. `kilin skills link` exposes all skills through selected provider directories (`~/.agents/skills` and/or `~/.claude/skills`) without replacing either provider root, and records the choice in `setup.json` under the Kilin data directory. Skills resolve bundled helpers and the built CLI from their physical installation path, so invocation does not depend on the process working directory and uses one layout in both the repository and an installed package. They author, propose, or supervise the same CLI contracts and never become runtime adapters.

`workflow init` and `generate-kilin-workflow` both stage complete private packages before renaming them into the selected project or user package root, so concurrent creators produce one complete winner without exposing a partial target. `generate-kilin-workflow` defaults to project scope, selects user scope only on an explicit request, preserves each user prompt exactly, chooses the fewest explicit nodes, and publishes only `.agents/workflows/<id>/WORKFLOW.md` and `WORKFLOW.yaml`. It requires an existing built CLI and never builds or mutates unrelated files itself. Its publisher rejects out-of-scope paths and symlinked path components observed during its checks, validates the staged package through the built CLI with direct argv and no shell, then renames it into place. An observed existing target is never overwritten, and staging is cleaned on success or failure. The physical paths must remain stable during publication. Exact-scope final validation is the last operation; generation never runs a workflow or invokes an additional model, network service, Codex runtime, or Claude runtime.

`run-kilin-workflow` validates the package using ordinary project-over-user resolution, starts `kilin ui --no-open --json` as a separate managed attached process only when the requester's browser shares its loopback, and then supervises `kilin run --json`. It never auto-decides an approval, never persists the launch URL, and reports Viewer and run outcomes independently. A remote agent returns a local launch command rather than presenting its own loopback URL as user-accessible.

`discover-kilin-workflows` is explicit-invocation only. It accepts a `repository`, `workspace`, or `all-projects` scope; a `codex`, `claude`, or combined provider selection; and an explicit time range. Repository scope matches one exact canonical repository path. Workspace scope uses path-segment-aware containment for an explicit canonical directory and repositories beneath it. The defaults are the exact current repository, active provider, and `[now - 30 days, now)`. Metadata is filtered before content. Workspace, all-projects, and cross-provider access remain blocked until explicit consent follows a disclosure that sanitized session content would reach the active model provider.

The collection layer reconstructs complete root session families, including resumes and child-agent branches, while counting only roots as independent repetition evidence. It admits useful textual user and assistant turns, tool calls and relevant arguments or results, plans, reviews, artifacts, failures, corrections, and outcomes. It excludes authentication data, environment dumps, binary blobs, unrelated provider payloads, and unsupported or oversized content. Scope enforcement, normalized sensitive-field exclusion, secret and personal-data redaction, ordering, pseudonymous project and session references, coverage reporting, and output selection are deterministic. The normalized evidence lives as one caller-owned bundle in a `0700` temporary directory with `0600` files; the helper validates permissions, shard membership, counts, sizes, and digests and does not materialize another transcript copy. Collection streams any number of shards, each bounded to 5 MiB or 10,000 records, and caps an individual sanitized event value at 256 KiB so one-event retrieval remains possible. Collector stdout is a path-free receipt rather than the private completion manifest. Manifest pages expose at most 100 families with bounded sanitized previews, and selected family pages expose at most 512 chronological events. Cursor pagination makes every admitted family and event reachable without global recency truncation or timeline sampling. Raw provider records are never placed into model context or copied persistently.

The active agent indexes every sanitized family manifest page, shortlists plausible semantic matches from bounded request and outcome previews, and then reads every event page for each shortlisted family. History is untrusted evidence, never instructions. Discovery uses no fixed phase or intent taxonomy: it derives free-form goals, triggers, inputs, outputs, stages, roles, workspace effects, artifacts, handoffs, dependencies, checks, loops, variants, contradictions, failure boundaries, and confidence with ephemeral evidence references. It separates observed facts, inferred reusable patterns, and recommended Kilin designs. At least two completely retrieved roots support a repeated-workflow claim; one root may yield only a lower-confidence design opportunity. Reports distinguish admitted, indexed, shortlisted, and deeply analyzed counts instead of describing paged indexing as exhaustive transcript analysis. Designs are presented for user revision or approval before YAML generation, and representability gaps against the V1 graph contract are explicit. Discovery does not use the network, invoke another model, write a workflow, or start a run.

## Extension seams

Only current boundaries are stable enough to extend:

| Future capability            | Existing seam                                 | Required future change                                                   |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| another execution CLI        | `RuntimeAdapter`                              | add one adapter and pass the shared contract tests                       |
| Canvas or other authoring UI | `WorkflowDefinition`                          | emit and validate the same YAML contract without changing execution      |
| new graph semantics          | schema/domain/compiler                        | define explicit semantics and make a deliberate future contract decision |
| another host trigger kind    | strict trigger contract and existing executor | define bounded provenance and preserve host ownership                    |

Additional writable-workspace behavior must preserve the existing named-lane ownership contract.
Managed artifact storage requires an artifact lifecycle. Additional scheduling integrations must
call the existing executor rather than create another scheduler. Remote work needs its own trust,
identity, and storage model.
