# Kilin V1 Product Scope

## Product statement

Kilin is a CLI-first workflow runtime that enables agents to discover, create, validate, and run reusable workflows. It provides visual inspection and operational visibility into workflow structure, execution, history, and outputs.

V1 delivers that position through strict project- and user-scoped workflow packages, fixed Codex,
Claude Code, and OpenCode adapters, deterministic orchestration, durable history, and exact
stored-revision rerun without depending on current package contents. Kilin is a workflow runtime,
not an embedded authoring model; agents or people may author packages directly, while the shipped
agent skills help discover and create workflows against the same contract.

## Target user

The first user operates agents through a CLI and wants to turn repeated procedures into reusable
workflows. They are comfortable reviewing workflow metadata and YAML, choosing an explicit working
directory, and keeping execution attached to a foreground command.

## Primary journey

```text
human or canonical authoring skill
               |
               v
 project/user workflow package
               |
               v
     validate -> run -> inspect
                           |  \
                           |   -> attached viewer + guarded approval
                           v
                  rerun stored revision
```

The complete V1 journey is:

1. Create or edit `.agents/workflows/<name>/WORKFLOW.md` and `WORKFLOW.yaml`, directly or with `generate-kilin-workflow`.
2. Optionally invoke `discover-kilin-workflows` to analyze scoped session families, review evidence-backed workflow designs, and explicitly approve one before any file is written.
3. Run `kilin workflow validate <name> --cwd /absolute/project --json` and fix actionable errors before a provider starts; pass `--scope` only when inspecting one scope directly.
4. Run the workflow against an explicit project directory and observe deterministic lifecycle events.
5. Inspect persisted metadata and output paths with `runs list` and `runs show`.
6. Optionally launch `kilin ui <workflow-name> --cwd <directory> [--no-open] [--json]` for an attached, authenticated view of the DAG, history, lineage, states, failures, and bounded output. It is read-only except for two guarded run-scoped mutations, the waiting-approval decision and the run cancellation. When the user's browser shares the agent's loopback, the run skill starts and manages this separate process, reports its URL directly to the requester, and reports Viewer and run outcomes independently.
7. Use `kilin rerun <run-id>` to create a new run from the prior run's immutable workflow revision,
   canonical cwd, authored node timeouts, and persisted run options.

## V1 capabilities

- Strict project/user packages with bounded discovery metadata, safe YAML parsing, closed structural schema, semantic DAG validation, precedence, and scope-aware identity.
- Agent, approval, and contained-loop nodes with dependency, typed-binding, and closed-choice edges.
- Fixed Codex, Claude Code, and OpenCode adapters; OpenCode supports only `workspace_write`.
- `read_only` and `workspace_write` access modes in the source workspace or named isolated Git
  worktree lanes.
- Deterministic sequential-by-default execution, bounded parallel reads, bounded retry,
  continuation recovery, process-group cancellation, and stale-state interruption.
- Declared run parameters, host-owned trigger requests, typed outputs, and Decision Packet V1.
- Automatic immutable workflow revisions, exact-revision rerun, and lineage.
- Run and node metadata in local SQLite; bounded private stdout, stderr, and final-result files.
- Human CLI output, stable JSON documents, and JSON Lines lifecycle events.
- Canonical `.agents` workflow-generation and explicit history-discovery skills with minimal `.claude` shims.
- An attached numeric-loopback viewer with one-use fragment bootstrap, cookie and CSRF authentication, exact Host/Origin checks, local assets, CSP, polling, exact workflow/cwd scope, authorized 64 KiB output tails, and a closed set of two guarded run-scoped mutation routes, the approval decision and the run cancellation.

## Non-goals

The following are outside V1:

- an embedded LLM or prompt generator;
- an editable Canvas or browser mutation surface beyond the closed set of two guarded run-scoped mutations, the approval decision and the run cancellation;
- a daemon, public HTTP API, WebSocket, remote listener, or background service;
- a transcript database, cache, registry, watcher, or persistent history ingestion system;
- implicit skill discovery across user history, or all-project/cross-provider history access without explicit consent and egress disclosure;
- managed artifact transport or implicit stdout data flow;
- generic human-input nodes beyond the approval primitive;
- built-in schedules, queues, webhooks, or exactly-once claims;
- unordered writers in one workspace, automatic worktree merge, or remote workspace provisioning;
- nested or unbounded loops, arbitrary cycles, or parallel iterations;
- teams, remote workers, cloud storage, hosted execution, plugin loading, exporter buses, or node registries; and
- Windows execution before equivalent workspace-lock semantics are available.

The attached `ui` listener and bounded agent-side discovery procedure are explicit exceptions to broader browser-UI and transcript-system deferrals. The Viewer may only record a scoped waiting-approval decision or request cancellation of a scoped run; otherwise neither surface mutates recorded state or invokes a runtime.

## Release criteria

V1 is complete only when all of the following hold:

1. A user can initialize, author, and validate a workflow without starting Codex or opening the database.
2. Unsafe YAML, unknown fields, invalid paths, unsupported runtimes, failed authentication/capability preflight, and invalid DAGs fail before an agent process or run row exists.
3. A valid three-node dependency chain executes exactly once per node in deterministic order.
4. A failed node preserves bounded output, starts no later node, and marks all pending nodes skipped; interruption reaps descendants and persists terminal state once a run exists.
5. Two unchanged runs have distinct run IDs and share one immutable revision.
6. Editing or deleting the current package definition cannot change `rerun`; rerun uses the stored normalized definition, revision, canonical cwd, options, and lineage without restoring workspace contents.
7. Workflow text cannot inject shell/runtime arguments, environment, cwd, sandbox bypass, or extra writable roots.
8. Human, JSON-document, and JSON Lines paths expose only their documented contracts and never mix prompts or provider events into public output.
9. Generation publishes exactly one complete validated target with no overwrite or model/run invocation, including under publisher contention, and rejects out-of-root targets or symlinked path components observed during its path checks.
10. Discovery is explicit, defaults to `[now - 30 days, now)` for the exact current project and active provider, reconstructs resumes and child agents under their root, sanitizes rich textual evidence before model analysis, reports incomplete coverage, separates observations from inference and design, and writes nothing before approval.
11. The Viewer binds only numeric `127.0.0.1` on an OS-selected port, authenticates through its one-use fragment bootstrap plus cookie/CSRF, enforces exact request boundaries and restrictive CSP, exposes exactly two guarded run-scoped mutations — the waiting-approval decision and the run cancellation — and no runtime or generic reconciliation route, and stops with the CLI.
12. Viewer history is newest 50 for the exact full workflow identity and canonical cwd; output reads derive only from authorized stored node records, reject path/symlink substitution, and return at most the 64 KiB tail.
13. Keyboard/focus behavior, reduced motion, semantic graph equivalence, and 1440x900 and 390x844 layouts pass automated browser coverage without horizontal page overflow.
14. The single canonical [release gate](../../../../RELEASING.md#release-gate) exits
    zero with pnpm `11.4.0` and `minimumReleaseAge: 1440` declared.

## Qualification status

Automated release tests use fake runtimes and temporary state. Exact release-artifact and
authenticated Codex, Claude Code, and OpenCode status is recorded only in the
[qualification index](../qualification/README.md); capability probes and deterministic tests are
not presented as model-execution evidence.

## Scale target

Kilin is a local orchestrator, not a distributed scheduler. Graph validation, planning, metadata,
and log storage scale with the finite workflow graph. Independent read-only agents may overlap up
to the configured bound; writers and approvals remain exclusive within a workspace.

## Extension direction

Extensions require a concrete need and should reuse current contracts:

1. Another runtime must pass the same adapter and process-safety contract without changing graph execution.
2. An editable Canvas must emit the existing `WorkflowDefinition`; it must not turn the viewer into a mutation service.
3. Managed artifacts require explicit lifecycle semantics rather than treating stdout as data.
4. New writable-workspace behavior must preserve explicit ownership and retained-evidence rules.
5. Governance, scheduling, or remote execution require their own trust and persistence designs.

The extension seams are defined in [Architecture](architecture.md#extension-seams). V1 contains no
speculative framework for them.
