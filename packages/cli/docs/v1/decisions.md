# V1 Decision Record

This record captures the current V1 decisions. A deferred item is not an invitation to build a
placeholder. The release gate is owned by [RELEASING.md](../../../../RELEASING.md#release-gate).

## Resolved decisions

### D-001 — The product is a foreground CLI

**Decision:** V1 runs as one foreground local CLI process. Execution and recorded-state mutations are direct CLI use cases; workflow source remains an ordinary authored project- or user-scoped package whose executable graph is `WORKFLOW.yaml`. Its only listener is the `kilin ui` exception in D-013: an attached, authenticated numeric-loopback viewer that terminates with the command and whose only mutation is the single approval-decision route sanctioned there.

**Reason:** Author, validate, run, inspect, and rerun do not need a service lifecycle. The bounded viewer makes graph and run inspection clearer without becoming a second execution surface.

**Consequence:** V1 has no daemon, public API, WebSocket, background worker, or remotely reachable listener.

### D-002 — YAML is the canonical authored format

**Decision:** Workflows are project-local YAML validated by a strict versioned JSON Schema plus semantic validation.

**Reason:** Humans and coding agents can both create and review it. A Canvas can later emit the same contract.

**Consequence:** Unknown fields, unsafe YAML features, and implicit interpolation are rejected.

**Status:** Superseded in source discovery and identity by D-015. `WORKFLOW.yaml` remains the canonical executable graph format.

### D-003 — Runs create automatic immutable revisions

**Decision:** There is no draft/publish lifecycle. `run` reads the file once, validates and normalizes it, then creates or reuses an immutable revision before any agent starts.

**Reason:** A separate publishing subsystem solves a collaborative editing problem V1 does not have.

**Consequence:** `rerun` loads stored normalized JSON, not the current source file.

### D-004 — Execution runtimes are fixed adapters

**Decision:** V1 ships Codex, Claude Code, and OpenCode behind one `RuntimeAdapter` boundary.

**Reason:** Each adapter can own provider-specific preflight, access mapping, invocation, and result
extraction without changing graph execution.

**Consequence:** There is no dynamic plugin discovery. Every adapter must pass the same boundary
tests. OpenCode fails closed for `read_only`.

### D-005 — The graph model is finite and explicit

**Decision:** V1 supports agent and approval nodes plus one contained finite loop. Edges express
dependencies, typed bindings, or closed-choice routes. Run parameters are an explicit second input
source.

**Reason:** These primitives cover the current workflows while preserving compile-time bounds and
deterministic scheduling.

**Consequence:** There are no arbitrary cycles, dynamic nodes, implicit stdout flow, or generic
router and human-input nodes.

### D-006 — The working directory is explicit and mutated in place

**Decision:** New runs require `--cwd`. Nodes use its canonical real path or a declared named
detached Git worktree lane. Kilin does not snapshot, clean, reset, merge, or roll back workspaces.

**Reason:** Workspace provisioning is a separate product. Requiring an explicit existing directory makes ownership and side effects visible.

**Consequence:** Rerun repeats the definition against current files, not an old filesystem state.
Retained worktrees require deliberate manual cleanup.

### D-007 — V1 execution is deterministic and sequential

**Decision:** Dependencies determine readiness; declaration order breaks ties; concurrency is one inside a run by default. Unordered node pairs are allowed only when both are read-only.

**Reason:** This gives stable orchestration behavior while avoiding unsafe shared-workspace writers.

**Consequence:** Every writer and approval remains an exclusive barrier at any bound. Writable
branches may be unordered only when their declared isolated workspaces are distinct.

### D-008 — A canonical workspace has one active Kilin run

**Decision:** `run` and `rerun` open `StateStore` and complete V1 baseline initialization or
validation under its separate state-schema lock before acquiring an exclusive lock keyed by
canonical cwd. They then retain the same cwd descriptor through stale reconciliation, replacement
creation, execution, and terminal persistence. If another Kilin process holds it, the command
fails without creating a run.

**Reason:** Per-run concurrency one does not prevent two CLI processes from mutating the same project at once.

**Consequence:** Runs in different working directories may proceed independently. V1 does not special-case concurrent read-only workflows.

### D-009 — Retry and continuation stay bounded and explicit

**Decision:** Any node failure stops new nodes and skips pending work at the default bound of one. Above it, a failure skips only its transitive descendants while independent branches settle, and the run's primary failure is the lowest compiled ordinal among node failures. An engine fault becomes the run's failure whatever its ordinal, because a fault raised while admitting a node has no node record to carry it. Cancellation stops the process group. A stale active run becomes interrupted on later reconciliation, or cancelled when a cancellation request was already recorded.

**Reason:** Retrying agent side effects without explicit bounds or workspace ownership can make
damage worse.

**Consequence:** Per-node attempts are bounded. `retry` and `resume` create continuation runs only
when every writer uses an isolated workspace. Partial changes and logs remain for inspection.

### D-010 — SQLite stores metadata; files store streams

**Decision:** SQLite stores the current V1 metadata model, including revisions, runs, occurrences,
attempts, and workspaces. Stdout, stderr, resolved inputs, and final results remain ordinary bounded
files.

**Reason:** SQLite is well suited to local lifecycle queries but not unbounded process streams.

**Consequence:** V1 needs no event store, blob abstraction, queue, exporter, or ORM.

### D-011 — Runtime arguments are owned by Kilin

**Decision:** The workflow schema has no raw args, environment, command, working-directory, or sandbox override.

**Reason:** Authored flags could bypass access rules, break capture, or redirect execution.

**Consequence:** A new safe user control requires a named, validated Kilin option with defined precedence.

### D-012 — Repeatability is defined narrowly and honestly

**Decision:** Rerun preserves normalized workflow semantics, execution options, and working-directory identity.

**Reason:** Model output, project contents, credentials, network state, CLI version, and external configuration can change.

**Consequence:** V1 never describes rerun as deterministic replay or exactly-once execution. Rerun,
retry, and resume also reproduce the source run's stored parameter snapshot exactly and accept no
parameter override, so a repeated run cannot silently change its inputs.

### D-013 — The viewer is an attached CLI inspection surface with one sanctioned decision route

**Decision:** V1 adds `kilin ui <workflow-name> --cwd <directory> [--no-open] [--json]` as a foreground command that binds an OS-selected port on numeric `127.0.0.1`, remains attached to the CLI process, and exposes authenticated inspection routes plus exactly one mutation route: `POST /api/runs/:run-id/nodes/:node-id/decision`, which records a human approval decision for a waiting gate in the viewer's scope. `--json` emits one `viewer.started` document without changing browser-launch semantics. A 256-bit single-use launch token is exchanged from the URL fragment for a process-lifetime `HttpOnly; SameSite=Strict` cookie. Authenticated requests also require an in-memory CSRF token.

**Reason:** A local visual view makes workflow order, run lineage, states, and bounded output easier to inspect, and an approval gate is best decided where its upstream evidence is rendered. The decision route reuses the same guarded store transition as `kilin runs approve` and `kilin runs reject` — recorded with actor `human` and consumed by the blocked run's store poll — so the viewer still executes, schedules, and edits nothing. Numeric loopback binding, exact host and origin checks, a restrictive content security policy, local assets, bounded record-authorized file reads, and process-lifetime credentials limit the server to its intended local session.

**Consequence:** The viewer enforces exact loopback peer, Host, and Origin boundaries, a restrictive CSP, local assets, exact workflow-plus-canonical-cwd scoping, newest-50 history, and an authorized 64 KiB output tail. The decision route accepts `{decision: "approved" | "rejected", note?}` with a bounded note, is guarded exactly like every authenticated route (session cookie plus CSRF token on top of the request boundary), applies only to a scoped run's waiting, undecided, unexpired approval node, and records through the same application transition the CLI uses — including stale-run reconciliation when no attached run holds the workspace, in which case the decision is refused with `APPROVAL_NOT_WAITING`. There is no other mutation route and no daemon mode, WebSocket, public API, raw filesystem path parameter, or runtime adapter. It polls read-only projections otherwise, stops when the CLI stops, and never invokes Codex.

### D-014 — Agent skills remain outside the execution runtime

**Decision:** V1 ships `generate-kilin-workflow`, `discover-kilin-workflows`, and `run-kilin-workflow` as CLI package assets under `packages/cli/agent-skills`, published verbatim rather than copied into `dist`. A cross-platform, no-overwrite linker exposes each skill through the user's `~/.agents/skills` and `~/.claude/skills` directories while keeping the versioned package as the source of truth. They author, propose, or supervise the same strict CLI contract and do not add an embedded model, runtime adapter, transcript store, watcher, or daemon to Kilin.

**Reason:** Reusable agent-side authoring guidance improves the CLI-first journey without duplicating validation or execution. Repository ownership keeps the skills reviewable and packageable, while provider links allow invocation from unrelated working directories. Discovery is explicitly invoked, defaults to the trailing 30 days of active-provider history for the exact repository, reconstructs complete root session families, sanitizes admitted textual evidence in a private temporary directory, and lets the active agent infer workflow structure without a fixed phase taxonomy.

**Consequence:** Generation defaults to project scope, uses user scope only when explicitly requested, never overwrites or starts a run, and finishes with exact-scope validation. Discovery treats history as hostile evidence, reports coverage limits, and writes nothing before user approval. Execution supervision starts the separate attached Viewer only when its loopback is user-accessible, never auto-decides approvals, and reports run and Viewer outcomes independently. Windows installations use junctions because symbolic-link creation may require Developer Mode or elevation; every installed link targets the installed CLI package, so removing or relocating that package breaks them. The CLI exposes `kilin skills link` and `kilin skills status`, and the first interactive command can offer a provider multiselect once per data directory; the chosen providers are recorded in `setup.json` under `KILIN_DATA_DIR` or `~/.kilin`, while all packaged skills link together for each selected provider.

### D-015 — Workflow packages have project and user scope

**Decision:** Kilin resolves exact workflow packages from `<project>/.agents/workflows/<name>/` and `~/.agents/workflows/<name>/`. Each package contains discovery metadata in `WORKFLOW.md` and executable YAML in `WORKFLOW.yaml`. The nearest eligible ancestor containing `.agents/workflows` is the project root, independent of Git; the owner of the configured user root is a hard boundary and is never reinterpreted as project scope. Project packages shadow same-named user packages, including fail-closed invalid shadowing. Durable identity is `(scope kind, canonical scope root, workflow id)`.

**Reason:** Agent clients need a progressively disclosed, repository-native discovery contract, while reusable personal workflows need a portable global scope. Lookup precedence alone cannot safely distinguish run history or revisions for same-named workflows in different scopes.

**Consequence:** The manifest owns `name` and `description`; executable YAML does not repeat description. Package resolution, revision uniqueness, rerun, events, CLI documents, and viewer isolation are scope-aware. Project execution is limited to its root and descendants, while a user package remains portable from descendants of the user's home. Initializers and authoring publishers stage complete packages before no-overwrite publication. Native agent-client integration is deferred, but the filesystem contract is complete. Databases without scope-aware revision identity are rejected rather than migrated or guessed.

## Delivery evidence

The canonical [release gate](../../../../RELEASING.md#release-gate) owns deterministic
verification. Exact artifact and opt-in authenticated runtime results are recorded separately in
the [qualification index](../qualification/README.md).

## Deferred, non-blocking decisions

These questions are intentionally unanswered until a concrete next feature is selected:

- Does a Canvas edit YAML directly or use a separate authoring service?
- What artifact lifecycle justifies managed storage?
- Which trigger and trust model is required beyond strict host-owned request files?
- What identity and storage model is required for remote workers?

No V1 file, table, interface, or background process should exist solely to anticipate these answers.

## Complexity test

Before adding a new V1 abstraction or contract, it must satisfy at least one of these conditions:

1. It protects a first-run correctness or safety property.
2. It is exercised by the current vertical slice through a public behavior.
3. It isolates an external boundary already used in V1.
4. It removes more complexity than it introduces.

Otherwise, record the future capability here and defer implementation. Extensibility comes from stable definitions, compilation, application use cases, and a narrow subprocess boundary—not from implementing every future feature early.
