# System Design Guide

## Product Vision

Kilin is a local, CLI-first workflow runtime for turning repeated agent procedures into strict, reusable workflows. Workflows are normally authored or updated by an outer AI agent, stored as project- or user-scoped packages, validated before execution, and observed through machine-readable events and durable run history.

Kilin is not an embedded model, distributed scheduler, hosted service, or plugin platform. The current design favors deterministic local execution and explicit contracts over dynamic routing, background workers, or speculative extension points.

## Design Philosophy

- **Local and CLI-owned.** One foreground process owns execution and lifecycle transitions. SQLite stores metadata; bounded private files store captured streams.
- **Deterministic over dynamic.** A strict outer DAG, with at most one finite contained loop,
  compiles to one stable expanded plan. Execution defaults to sequential fail-fast, may overlap
  independent `read_only` nodes up to a caller-selected bound, and reruns use immutable stored
  revisions.
- **Agent-oriented.** Commands expose stable JSON documents or JSON Lines. Errors identify actionable workflow paths. Human-oriented viewing is separate from controller-oriented events.
- **Smallest useful graph.** Use the fewest nodes and edges that express real stages and prerequisites. Do not add generic planner, reviewer, coordinator, or verifier nodes automatically.
- **General primitives over special cases.** Prefer agent nodes, approval gates, typed outputs, and named bindings. A single narrow workflow does not justify a new node kind, scheduler service, registry, or framework.
- **Fail closed.** Invalid definitions, unresolved inputs, unsafe paths, unsupported runtime access, or missing declared outputs stop dependent execution rather than being weakened or defaulted.
- **Honest guarantees.** Workspace locking is cooperative, artifacts may remain live and mutable, and deterministic orchestration does not make model output reproducible.
- **Explicit evolution.** Add a capability only when a concrete need cannot be represented safely with existing contracts.

## System Overview

```text
human instruction
       |
       v
outer AI agent (controller)
       |
       +-- discover -----> WORKFLOW.md metadata
       |
       +-- create/update --> .agents/workflows/<id>/WORKFLOW.yaml
       |                              |
       |                              v
       |                     parse -> validate -> compile
       |                         |
       +-- run/monitor ----------v
                         foreground executor
                          |      |       |
                          v      v       v
                    runtime   SQLite   JSONL events
                    adapter   history      |
                       |         |         v
                       v         +---- outer agent
                 agent process   |
                       |          v
                       +--> bounded files
                                  |
                                  v
                        attached local viewer
                   (inspection + one approval route)
```

The outer agent controls the workflow but is not one of its nodes. Runtime adapters execute resolved requests; they do not choose successors, update workflow state, or query the graph. The domain layer defines compilation rules; application use cases invoke the domain compiler and own scheduling, lifecycle transitions, approvals, and reruns.

## Execution Topology and Bounded Feedback

The authored outer graph is acyclic. A V1 workflow may contain one `loop` node whose
body is also an acyclic graph. Compilation expands the configured one-through-five iteration bound
before persistence:

```text
outer DAG
   |
   +-- loop control (application-owned aggregate)
   |      |
   |      +-- iteration 0 body DAG
   |      +-- iteration 1 body DAG
   |      `-- ... finite configured bound
   |
   `-- outer dependents wait for loop success
```

Each body occurrence has a deterministic opaque execution identity plus explicit authored body
node, loop, and zero-based iteration provenance. Clients must use that metadata and must not parse
the opaque identity. Only one iteration is eligible at a time, although independent `read_only`
nodes within that iteration may share the ordinary bounded frontier.

The loop control is not a runtime process. The application layer owns its
`pending -> running -> succeeded|failed|cancelled|interrupted|skipped` lifecycle, validates the
`pass` or `revise` decision, fences the single declared feedback value for the next iteration,
projects the passing result, and prevents outer dependents from observing an early iteration. It
does not consume a parallel slot or emit agent/approval `node.started` and `node.finished` events.

SQLite is authoritative for run, loop-control, scoped execution, attempt, cancellation, and
failure state. Bounded private files are authoritative for captured streams and result content.
JSON Lines events are an observational controller surface, not a state log to replay. Derived
iteration views come from the immutable stored definition, compiled scope metadata, SQLite rows,
and authorized bounded files; parameter, feedback, and result content does not enter public
lifecycle events.

One Kilin body occurrence still means one runtime process invocation. A provider may perform
opaque internal planning or iteration inside that invocation, but Kilin neither observes nor
controls it. The bounded loop primitive controls only the finite repeated process occurrences that
Kilin compiles and records.

The primitive remains deliberately narrow: no arbitrary graph cycles, nested loops, dynamic
nodes, parallel iterations, accumulators, loop-level retry, same-run recovery at a historical
iteration, `loop_iterations` table, or provider-session resume. Artifact feedback and artifact
loop results are also deferred because they lack the bounded immutable transfer and authorization
contract required by the first version.

Before the bounded-loop design work represented by issue #8 can be considered complete, discovery
must link sanitized evidence from at least two completely retrieved distinct root-session families
for the selected repeated feedback pattern and report collection, indexing, retrieval, redaction,
exclusion, unknown-event, truncation, and skipped-session coverage gaps. A desired pattern or a
single rich session is not sufficient evidence of repetition.

## Module Boundaries

- `src/domain/` defines workflow, compilation, revision, and lifecycle rules.
- `src/application/` owns workflow and run use cases, runtime contracts, events, and viewer projections.
- `src/infrastructure/` implements YAML, SQLite, locks, subprocesses, runtime adapters, files, and loopback HTTP.
- `src/cli/` and `src/ui/` present application behavior to agents and humans.

A new interface must isolate an external dependency or serve multiple concrete implementations. Keep domain, infrastructure, and presentation concerns separate.

## Agent Workflow Lifecycle

### Create

1. Translate the requested operation into the fewest explicit stages.
2. Default agent nodes to `read_only`; grant `workspace_write` only when mutation is required.
3. Declare an output only when another node must consume it or the workflow contract requires it.
4. Add an edge only for a real prerequisite; add a named binding only for actual data transfer.
5. Use approval nodes for genuine decisions, not general human input. Approval questions are persisted and publicly emitted, so they must contain no secrets.
6. Default to project scope; use user scope only when explicitly requested. Write only `.agents/workflows/<id>/WORKFLOW.md` and `.agents/workflows/<id>/WORKFLOW.yaml` beneath the selected scope root, never overwrite an existing package during generation, and finish with:

```bash
kilin workflow validate <id> --scope <project|user> --cwd /absolute/project --json
```

Generation and validation must not execute the workflow.

### Update

Edit the package deliberately, then validate it before running. `WORKFLOW.md` owns discovery metadata; `WORKFLOW.yaml` owns execution and does not repeat the description. Use `kilin run` to execute the updated definition; the run creates or reuses an immutable scope-aware revision. `kilin rerun <run-id>` intentionally uses the selected run's stored definition, scope, canonical working directory, and limits—not the current package. Do not add compatibility handling or abstractions unless an established contract requires them.

### Run and Monitor

Agents should prefer machine-readable output. The Viewer and run are separate attached processes:
start the Viewer as a managed process, retain its handle, and wait for `viewer.started` before
starting the run in another process.

```bash
# Managed process A
kilin ui <id> --cwd /absolute/project --no-open --json
```

```bash
# Process B
kilin run <id> --cwd /absolute/project --json
kilin runs show <run-id> --json
kilin runs list --limit 50 --json
```

`run` and `rerun` stream JSON Lines lifecycle events. Retain the `runId`, react to the closed event union, and use `runs show` as the durable state view. Inspect recorded result paths rather than expecting provider output in public events.

An approval leaves the foreground run attached and the workspace lock held. A controller may decide from a second local process:

```bash
kilin runs approve <run-id> <node-id> --actor agent --json
kilin runs reject <run-id> <node-id> --actor agent --json
```

The attached viewer is primarily an inspection surface, with a closed set of two authenticated and CSRF-protected run-scoped mutation routes: the approval decision and the run cancellation. Operational success means the graph completed; it is not evidence of user satisfaction or workflow quality.

## Avoiding Over-Engineering

Represent a specialized procedure in workflow YAML before changing the runtime. Promote a new system primitive only when current contracts cannot express a recurring need safely and the change has clear ownership, lifecycle, failure, security, and test semantics.

Do not introduce queues, daemons, worker registries, dynamic plugins, generic suspend/resume,
managed artifact stores, or additional workspace modes pre-emptively. V1 already provides
declared named Git worktree lanes; extend that contract only when requirements demand
different ownership, remote execution, automatic merge, or durable artifact ownership.

## Security and Trust Boundaries

Workflow content and upstream agent output are untrusted data. Kilin owns runtime arguments, working directory, environment policy, access mapping, output limits, and state transitions. Runtime sandboxing is defense in depth, not a hermetic boundary against the local operating-system user or ambient provider configuration.

The viewer binds numeric loopback, scopes data by workflow and canonical working directory, bounds output reads, and exposes no general execution API. Preserve those constraints when extending observation or approval behavior.
