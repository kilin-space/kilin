# CLI Contract

Kilin V1 is a foreground CLI. Execution and recorded-state mutation, including history
reconciliation, are CLI-only. An external scheduler may invoke `trigger`, but each invocation is
still one foreground CLI process; Kilin does not become a daemon or scheduler. Workflow packages
remain ordinary project or user files that a human, `workflow init`, or an authoring skill may
create. The sole listener is the attached, authenticated `ui` command; beyond recording human
approval decisions through its single guarded route, it mutates nothing, is not a daemon or public
API, and stops with the command.

## Commands

```text
kilin workflow init <name> --scope <project|user> --name <display-name>
  --description <description> [--project-root <directory>] [--json]
kilin workflow list [--cwd <directory>] [--json]
kilin workflow validate <name> [--scope <project|user>] [--cwd <directory>] [--json]

kilin run <name> --cwd <directory>
  [--param <name=value>]...
  [--node-timeout <duration>]
  [--approval-timeout <duration>]
  [--max-output-bytes <bytes>]
  [--max-parallel <count>]
  [--json]

kilin trigger --request <absolute-file> [--json]

kilin rerun <run-id> [--max-parallel <count>] [--json]
kilin retry <run-id> [--node <node-id>] [--json]
kilin resume <run-id> [--json]

kilin runs list [--limit <count>] [--status <status>] [--json]
kilin runs show <run-id> [--json]
kilin runs wait <run-id> [--json]
kilin runs cancel <run-id> [--json]
kilin runs approve <run-id> <execution-id> --actor <agent|human> [--note <text>] [--json]
kilin runs reject <run-id> <execution-id> --actor <agent|human> [--note <text>] [--json]

kilin ui <name> --cwd <directory> [--no-open] [--json]
```

Global `-h`, `--help`, and `--version` are exact-only invocations. Commands reject unknown flags, duplicate non-repeatable flags, missing values, and extra positionals.

## `workflow init`

Creates a minimal valid package with discovery metadata, one `read_only` Codex agent node, and an empty edge array. Parent directories may be created, but an existing package is never overwritten.

`--scope`, display `--name`, and `--description` are required so initialization is deterministic and non-interactive. Project scope requires an explicit `--project-root`; user scope writes to `~/.agents/workflows` and rejects that flag. The command prints both created files and the next validation command, or one JSON document with `--json`.

Initialization does not create a database revision and does not start Codex.

## `workflow list`

Discovers manifests from the nearest project root and `~/.agents/workflows`, applies project-over-user shadowing, and reports the selected name, description, scope, and package location. Invalid packages are returned as bounded diagnostics. Listing does not parse every executable YAML definition.

## `workflow validate`

Resolves the named package for `--cwd`, then safely parses, structurally validates, semantically validates, normalizes, and compiles its definition. Without `--scope`, resolution keeps normal project-over-user precedence. `--scope project` selects only the nearest project package; `--scope user` selects only `~/.agents/workflows` and neither explicit selection falls back. Success reports the selected scope, workflow ID, content hash, node count, edge count, and deterministic execution order.

Validation has no persistent side effects and does not probe authentication. It does verify that every named runtime is supported by the installed Kilin build.

Failure identifies the YAML path when available and tells the user how to correct the definition.

## `run`

Requires a workflow name and explicit working directory. It resolves the project/user package with [package precedence](workflow-packages.md#lookup-and-shadowing), performs the lifecycle in [Architecture](architecture.md#run-lifecycle-and-lock-order), then remains attached until the run reaches a terminal state.

`--node-timeout` supplies the process-timeout fallback for agent nodes that do not declare
`timeoutMs`. `--approval-timeout` independently bounds each approval wait.
`--max-output-bytes` controls bounded capture and resolved-input limits. These run options are
validated before persistence and stored with the run.

Both timeout flags accept a positive integer followed by `s`, `m`, or `h`, from `1s` through
`24h`, and default to 30 minutes. An authored agent `timeoutMs` uses integer milliseconds in the
same range and replaces the node-timeout fallback for every attempt of that node. Output limits are
integer bytes from `1024` through `104857600`.

`--param name=value` supplies one [declared run parameter](workflow.md#run-parameters). It is the
only repeatable flag; every other flag still rejects duplicates. The name and value split at the
first `=`, so later `=` characters are value content, and `name=` supplies an empty string rather
than a missing value. A malformed assignment, an invalid name, or a repeated name fails with
`OPTION_INVALID`. A missing, undeclared, or oversized value fails with `RUN_PARAM_INVALID` at
`parameters.<name>` after compilation but before runtime probing, lock acquisition, run creation,
or any agent process.

`--param` is not secret-safe: command arguments can enter shell history and local process listings.
Secret input requires a separate design that does not pass values through argv.

`--param` belongs to `run` only. The closed version-1 [host trigger](host-triggers.md#run-parameters-are-outside-the-version-1-contract)
rejects both the flag and a root `parameters` request field, and a triggered workflow that declares
required parameters fails with `RUN_PARAM_INVALID` before any run or provenance is recorded.

`--max-parallel` is an integer from 1 through 8 and defaults to 1. It bounds how many independent
`read_only` agents may overlap. Every `workspace_write` agent and every approval stays an exclusive
barrier at any bound, so only read-only work ever overlaps. At the default bound execution is exactly
the original strict sequence, including its global fail-fast behavior; above it a failure skips only
its transitive descendants while independent branches settle, and the run's primary failure is the
lowest compiled ordinal among node failures rather than whichever process finished first.

A successful run prints its run ID, workflow revision ID, node outcomes, duration, result paths, and a usable rerun command. A failed or cancelled run still prints the run ID and inspection command when a run record exists.

## `trigger`

Reads one strict, versioned request file and starts the requested workflow through the same
foreground execution path as `run`. The request path must be absolute. The UTF-8 JSON file is
limited to 65,536 bytes and contains only a workflow ID, an absolute working directory, and a
normalized cron source:

```json
{
  "triggerVersion": 1,
  "workflow": "change-review",
  "cwd": "/absolute/path/to/project",
  "source": {
    "kind": "cron",
    "schedule": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  }
}
```

The schedule is a standard numeric five-field cron expression and the time zone is an
`Area/Location` IANA ID recognized and normalized by the installed runtime, or `UTC`. Numeric
offsets and single-label identifiers such as `PST` or `Japan` are rejected; name the zone directly.
Both values are host-declared provenance; Kilin does not evaluate when the request is due. The
request must be a regular non-symlink file; on supported POSIX hosts it must be owned by the
invoking user and not group- or world-writable. The run uses default execution limits and records
the normalized source for `runs list` and `runs show`. Malformed requests fail before persistence
or provider execution. See
[Host-owned cron triggers](host-triggers.md) for host configuration and non-goals.

## `rerun`

Creates a fresh run from the exact stored workflow revision, canonical working directory, and effective execution options of the referenced run. The new row records `rerunOfRunId`.

It does not resolve or read the current workflow package, reset the workspace, reuse old node results, resume a provider session, or retry only failed nodes. `rerun --max-parallel` is the one permitted execution-option override, because concurrency is an execution choice rather than recorded evidence; omitting it reproduces the source run's bound. `retry` and `resume` accept no override at all. `rerun`, `retry`, and `resume` reproduce the stored parameter snapshot exactly and accept no `--param` override.

If the stored working directory no longer exists or runtime preflight fails, Kilin starts no agent process and creates no new run.

## `retry` and `resume`

V1 recovery creates a new continuation run from the exact stored revision, cwd, and limits.
`retry` starts at the failed/skipped frontier, or at the node selected by `--node`; `resume`
reconciles an ownerless running source to `interrupted` before continuing. Eligible successful
read-only checkpoints are copied into the new run, while approvals are always requested again.

Recovery inherits the working-directory process cleanup every execution path performs: on taking
the canonical-cwd lock, any process an earlier owner of that directory recorded and never observed
ending is terminated, and those identities are then forgotten so a later command cannot signal a
recycled PID. This is keyed to the recorded process, not to a status, because reconciliation may
already have rewritten the run. A host that rebooted after the attempt started, or a PID that a
different process now holds, is left alone, and identities are kept rather than forgotten when the
host's processes cannot be listed at all.

The source run remains terminal and immutable. Recovery records `recoveryOfRunId` and
`recoveryMode`. Workflows containing a source-workspace writer must use whole-workflow `rerun`;
isolated worktree lanes are rerun from a fresh base worktree.

## `runs wait`

Blocks silently until the selected run has an undecided approval or reaches a terminal state, then returns the existing `approval.requested` or `run.finished` event shape. A loop-body approval keeps the same scoped execution, body-node, loop, and iteration identity as the live event stream. This is a one-shot outer-controller attention boundary, not a daemon or network callback. `SIGINT` stops only the waiter and does not cancel the workflow.

## `runs cancel`

Records one durable monotonic cancellation request for a live run from a second local process, so
cancellation no longer requires the attached terminal. Repeating the request while the run is still
running returns the original timestamp. A terminal run returns non-zero `RUN_NOT_CANCELLABLE`.

`runs show` reports the recorded request as `cancelRequestedAt` while the owner is still draining, so
a pending cancellation is observable and a draining run is distinguishable from an ordinary one. The
field is omitted when no request exists.

The command output acknowledges only that the request was recorded. It never claims the run has
already stopped: the attached owner observes the request on its 250 ms attention cadence and then
applies the existing process-group termination grace, so cancellation latency is

```text
poll interval + process-group termination grace
```

Durable commit order decides every race. A request that commits before run finalization wins the run
outcome; a finalization that commits first leaves the request rejected. A node outcome that committed
before the request keeps its truthful `succeeded` or `failed` state, while still-active work settles
`cancelled`, and work that had not been admitted settles `skipped`. Cancellation therefore has
run-outcome precedence over failure but never deletes recorded failure evidence. During retry backoff
the failed attempt stays failed and no later attempt is scheduled.

The canonical-cwd lock is a best-effort owner probe, not the race arbiter. A busy lock is evidence of
a live attached owner. An acquirable lock means no owner exists, so the stale run is reconciled
through the existing path and reported as not cancellable; reconciliation is never reported as a
successful cancellation. Cancelling a live run still adds no PID file, lease, daemon, or direct
inter-process signal: the owner observes a durable request rather than being signalled. Signalling
a recorded process happens only where Kilin already holds the working-directory lock and is about
to declare that directory's earlier runs dead, so there is no owner left to ask.

## `runs list`

Lists runs newest first with run ID, full workflow scope identity, revision ID, status, canonical
working directory, start time, duration, optional trigger provenance, and optional lineage source
ID.

`--limit` defaults to 50 and accepts 1 through 1000. `--status` accepts one documented run status. V1 has no query language or pagination protocol.

## `runs show`

Shows one run and its full workflow scope identity plus ordered node runs, including statuses,
timestamps, exit codes, actionable failures, runtime metadata, immutable attempt history,
workspace records, and stdout/stderr/result paths.

An executing agent node additionally reports `pid`, the operating-system process of its current
attempt, and `durationMs`, the time elapsed as of that document rather than a final duration. A
terminal node reports no `pid`, and its `durationMs` is the recorded total. `pid` is also absent
when no process identity was recorded, and it is reported as recorded rather than probed for
liveness.

For a V1 loop, the top-level entry is the loop control with its bound and result
projection. Body executions are grouped by iteration and carry an opaque `executionId`, authored
body `nodeId`, `loopNodeId`, and zero-based `iteration`. Top-level node IDs and the surrounding
run-detail shape remain unchanged. A body approval must be addressed by its scoped execution ID
because its authored node ID repeats across iterations.

The command never embeds entire log files by default. Paths are present for nodes that started; an
unstarted pending or skipped node has no log files. Parameter, feedback, decision-choice, and
result values are never embedded in `runs show`; only authorized evidence paths and value-free
provenance are reported.

## `runs approve` and `runs reject`

Each command records one decision intent for a live, waiting, undecided, unexpired approval node.
For a top-level approval, its execution ID is its existing node ID. For a loop-body approval, use
the scoped execution ID reported by `runs show`, JSON Lines, or the Viewer.
`--actor` is a required local audit label, not authentication or authorization: `agent` records a
decision an agent made itself, while `human` records a Human Decision, including one an agent
records on a human's behalf. `--note` is optional and contains at most 1,000 characters. The
command reuses the same guarded application transition as the Viewer decision route and never
launches, resumes, or schedules a runtime.

The foreground `run` process consumes an approved decision and continues. It consumes a rejected
decision by failing the gate and run with `APPROVAL_REJECTED`. Recording a rejection is still a
successful decision command; the attached run has the separate failed outcome.

## `ui`

Resolves, validates, and compiles the named launch package, canonicalizes the explicit working directory, and starts an attached viewer on numeric `127.0.0.1` with an operating-system-selected port. It fixes the session scope to the full workflow identity and canonical cwd, remains attached, and stops on CLI shutdown. It never opens an execution runtime; its only mutation is the approval-decision route below, which records a human decision through the same guarded transition as `kilin runs approve` and `kilin runs reject`.

The command prints a launch URL. Without `--no-open`, it also asks the operating system to open that URL in the default browser; `--no-open` leaves browser navigation to the user. With `--json`, it emits one `ViewerStarted` document and then remains attached. JSON output does not implicitly suppress browser launch. The fragment-bearing URL is a one-use launch credential for that attached process and must not be published or reused as an API endpoint.

The URL contains a 256-bit one-use token only in `#token=...`. Local client code sends it through exact-origin `POST /session`, which issues a process-lifetime `kilin_session` cookie with `HttpOnly; SameSite=Strict; Path=/` and an in-memory CSRF token. `POST /session/resume` accepts an empty object and requires that cookie. Authenticated routes require both the cookie and `X-Kilin-CSRF`.

Unauthenticated GET is limited to `/`, `/assets/viewer.css`, and `/assets/client.js`. Authenticated routes are exactly:

```text
GET /api/workflow
GET /api/runs
GET /api/runs/:run-id
GET /api/runs/:run-id/nodes/:ordinal/output/:stream
POST /api/runs/:run-id/nodes/:node-id/decision
```

`:stream` is `stdout`, `stderr`, or `result`. History is newest-first, limited to 50, and scoped by exact workflow identity plus canonical cwd. The current definition is revalidated during polling. Output lookup accepts no filesystem path, authorizes the exact stored run/node path, rejects traversal, symlinks, and non-regular files, and returns at most the 64 KiB tail. Viewer DTOs expose scope kind but omit absolute persistence paths and project roots.

The decision route is the single sanctioned mutation. It accepts `{"decision": "approved" | "rejected", "note"?}` with a note of at most 1000 characters, is scoped like run detail, and records the decision with actor `human` through the same application transition as `kilin runs approve` and `kilin runs reject` — including stale-run reconciliation when no attached run holds the workspace. Any target that is not a waiting, undecided, unexpired approval node of a running scoped run is refused with `APPROVAL_NOT_WAITING`. The blocked `kilin run` consumes the recorded decision through its store poll; a rejection fails the gate and stops the run.

Every request must arrive from the numeric loopback peer with the exact launch `Host`; POST and any supplied `Origin` must match the exact origin. Responses use no-store caching, local assets, and a restrictive content security policy with self-only script, style, and connection sources and no inline or unsafe execution. The client polls every two seconds by default with bounded backoff, and while a selected node is running it re-fetches the selected stream's bounded tail on that cadence. A Refresh control in the top bar runs one cycle at once and restarts the backoff. A failed stream read renders a Retry control that re-requests the selected stream, and Refresh re-requests it too, independently of the poll cycle. After the first successful poll the client selects the most relevant stored run — a waiting approval first, then a running run, then the newest finished run — and the node that explains the run status; with no stored runs it keeps the definition view. While the open run waits on an approval gate, a decision-needed banner appears beside the connection status with the gate's live deadline countdown; clicking it selects the waiting gate and focuses the decision dock. Run history and lineage rows show the waiting label from the run summary's `waitingForApproval` flag. After the launch token is redeemed and stripped, the selected run, node, stream, and rendered/raw view persist in the URL hash; that selection fragment is never sent to the server and carries no credentials, and unknown run or node identifiers in it fall back to that default selection. There are no other mutation routes and no raw-path queries, WebSockets, daemon mode, public-API guarantee, or Codex invocation.

## Human output

Human-readable progress and the viewer launch URL go to stdout. Unexpected CLI diagnostics go to stderr. Prompts and provider output are never printed.

Progress uses stable concepts but is not a line-by-line parsing contract. Automation uses `--json`.

## Machine-readable output

All machine output includes `outputVersion: 1`. IDs are opaque strings. Timestamps are UTC RFC 3339 strings. Fields marked optional are omitted rather than set to `null`. `ErrorCode` is the closed string union listed in [Error codes](#error-codes).

`workflow init`, `workflow list`, `workflow validate`, `ui`, `runs list`, `runs show`, `runs cancel`,
`runs approve`, and `runs reject` emit one JSON document with `--json`. `run`, `trigger`, `rerun`,
`retry`, and `resume` use JSON Lines. `runs wait` emits one attention event. The document-command
success contracts are:

```ts
interface ErrorInfo {
  code: ErrorCode;
  message: string;
  path?: string;
}

interface InitResult {
  outputVersion: 1;
  scope: "project" | "user";
  directory: string;
  manifestFile: string;
  definitionFile: string;
  workflowId: string;
  created: true;
}

interface WorkflowCatalogEntry {
  name: string;
  description: string;
  scope: "project" | "user";
  location: string;
}

interface WorkflowCatalogDiagnostic {
  scope: "project" | "user";
  packageName: string;
  code: "WORKFLOW_PACKAGE_INVALID";
  message: string;
}

interface WorkflowCatalogResult {
  outputVersion: 1;
  projectRoot?: string;
  workflows: WorkflowCatalogEntry[];
  diagnostics: WorkflowCatalogDiagnostic[];
}

interface ValidationResult {
  outputVersion: 1;
  valid: true;
  scope: "project" | "user";
  workflowId: string;
  contentHash: string;
  nodeCount: number;
  edgeCount: number;
  executionOrder: string[];
}

interface ViewerStarted {
  outputVersion: 1;
  type: "viewer.started";
  workflowId: string;
  workflowScope: "project" | "user";
  projectRoot?: string;
  cwd: string;
  url: string;
}

interface RunIdentity {
  runId: string;
  workflowId: string;
  workflowScope: "project" | "user";
  projectRoot?: string;
  revisionId: string;
  rerunOfRunId?: string;
  recoveryOfRunId?: string;
  recoveryMode?: "retry" | "resume";
  trigger?: {
    kind: "cron";
    schedule: string;
    timezone: string;
  };
  cwd: string;
  startedAt: string;
  cancelRequestedAt?: string;
}

interface Completion {
  finishedAt: string;
  durationMs: number;
}

type RunSummary = RunIdentity &
  (
    | { status: "running" }
    | (Completion & { status: "succeeded" | "cancelled" })
    | (Completion & {
        status: "failed" | "interrupted";
        error: ErrorInfo;
      })
  );

type NodeIdentity =
  | {
      nodeId: string;
      ordinal: number;
    }
  | {
      executionId: string;
      nodeId: string;
      loopNodeId: string;
      iteration: number;
      ordinal: number;
    };

type AgentNodeIdentity = NodeIdentity & {
  kind: "agent";
  runtime: "codex" | "claude-code" | "opencode";
  model?: string;
  outputType?: "text" | "json" | "decision_packet" | "artifact" | "choice";
  artifactPath?: string;
  resolvedInputsPath?: string;
  attempt?: number;
  reusedFromRunId?: string;
  reusedFromNodeId?: string;
};

interface NodeStarted {
  startedAt: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

type AgentNodeSummary = AgentNodeIdentity &
  (
    | { status: "pending" }
    | { status: "skipped"; finishedAt: string }
    | (NodeStarted & { status: "running" })
    | (NodeStarted &
        Completion & {
          status: "succeeded";
          exitCode: 0;
        })
    | (NodeStarted &
        Completion & {
          status: "cancelled";
          exitCode?: number;
        })
    | (NodeStarted &
        Completion & {
          status: "failed" | "interrupted";
          exitCode?: number;
          error: ErrorInfo;
        })
  );

interface RecordedApprovalDecision {
  decision: "approve" | "reject";
  actor: "agent" | "human";
  decidedAt: string;
  note?: string;
}

type ApprovalNodeIdentity = NodeIdentity & {
  kind: "approval";
  question: string;
};

interface ApprovalRequest {
  requestedAt: string;
  deadlineAt: string;
}

type ApprovalNodeSummary = ApprovalNodeIdentity &
  (
    | { status: "pending" }
    | { status: "skipped"; finishedAt: string }
    | (ApprovalRequest & {
        status: "waiting_for_approval";
        decision?: RecordedApprovalDecision;
      })
    | (ApprovalRequest &
        Completion & {
          status: "succeeded";
          decision: RecordedApprovalDecision & { decision: "approve" };
        })
    | (ApprovalRequest &
        Completion & {
          status: "cancelled";
          decision?: RecordedApprovalDecision;
        })
    | (ApprovalRequest &
        Completion & {
          status: "failed" | "interrupted";
          decision?: RecordedApprovalDecision;
          error: ErrorInfo;
        })
  );

interface LoopIterationSummary {
  iteration: number;
  decisionExecutionId: string;
  feedbackSourceExecutionId: string;
  feedbackTargetExecutionId: string;
  resultExecutionId: string;
  nodes: Array<AgentNodeSummary | ApprovalNodeSummary>;
}

type LoopNodeSummary = {
  kind: "loop";
  nodeId: string;
  ordinal: number;
  maxIterations: number;
  passChoice: string;
  reviseChoice: string;
  feedbackInputName: string;
  outputType: "text" | "json" | "decision_packet" | "choice";
  iterations: LoopIterationSummary[];
} & (
  | { status: "pending" }
  | { status: "skipped"; finishedAt: string }
  | { status: "running"; startedAt: string }
  | (Completion & {
      status: "succeeded";
      startedAt: string;
      resultPath: string;
    })
  | ({ status: "cancelled"; finishedAt: string } & (
      { startedAt?: never; durationMs?: never } | { startedAt: string; durationMs: number }
    ))
  | (Completion & {
      status: "failed" | "interrupted";
      startedAt: string;
      error: ErrorInfo;
    })
);

type NodeSummary = AgentNodeSummary | ApprovalNodeSummary | LoopNodeSummary;

interface RunListResult {
  outputVersion: 1;
  runs: RunSummary[];
}

interface NodeAttempt {
  runId: string;
  nodeId: string;
  attempt: number;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  failure?: ErrorInfo;
  outputPaths: {
    stdoutPath: string;
    stderrPath: string;
    resultPath: string;
  };
}

interface RunDetailResult {
  outputVersion: 1;
  run: RunSummary;
  nodes: NodeSummary[];
  attempts?: NodeAttempt[];
  workspaces?: Array<{
    runId: string;
    workspaceId: string;
    path: string;
    baseCommit: string;
    status: "provisioned";
    createdAt: string;
  }>;
}

interface ApprovalDecisionResult {
  outputVersion: 1;
  recorded: true;
  runId: string;
  nodeId: string;
  decision: "approve" | "reject";
  actor: "agent" | "human";
  decidedAt: string;
  note?: string;
}
```

`attempts` is present only when at least one node was retried. It contains the immutable attempt
rows for retried nodes, including their distinct evidence paths; runs without retries retain the
existing document shape.

`run`, `trigger`, `rerun`, `retry`, and `resume` emit one JSON object per line. Their discriminated
event union is:

```ts
interface EventBase {
  outputVersion: 1;
  timestamp: string;
}

interface TopLevelNodeEventIdentity {
  runId: string;
  nodeId: string;
  ordinal: number;
}

interface ScopedNodeEventIdentity {
  runId: string;
  executionId: string;
  nodeId: string;
  loopNodeId: string;
  iteration: number;
  ordinal: number;
}

type NodeEventIdentity = TopLevelNodeEventIdentity | ScopedNodeEventIdentity;

interface NodeOutputPaths {
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
}

interface RunStartedEvent extends EventBase {
  type: "run.started";
  runId: string;
  workflowId: string;
  workflowScope: "project" | "user";
  projectRoot?: string;
  revisionId: string;
  cwd: string;
}

interface NodeStartedEvent extends EventBase, NodeEventIdentity, NodeOutputPaths {
  type: "node.started";
  runtime: string;
  model?: string;
  attempt?: number;
}

type AgentNodeFinishedEvent = EventBase &
  NodeEventIdentity & { type: "node.finished"; attempt?: number } & (
    | { status: "skipped" }
    | (NodeOutputPaths & {
        status: "succeeded";
        durationMs: number;
        exitCode: 0;
      })
    | (NodeOutputPaths & {
        status: "cancelled";
        durationMs: number;
        exitCode?: number;
      })
    | (NodeOutputPaths & {
        status: "failed" | "interrupted";
        durationMs: number;
        exitCode?: number;
        error: ErrorInfo;
        willRetry?: true;
      })
  );

interface ApprovalRequestedEvent extends EventBase, NodeEventIdentity {
  type: "approval.requested";
  question: string;
  deadlineAt: string;
}

interface ApprovalResolvedEvent extends EventBase, NodeEventIdentity {
  type: "approval.resolved";
  decision: "approve" | "reject";
  actor: "agent" | "human";
}

type ApprovalNodeFinishedEvent = EventBase &
  NodeEventIdentity & { type: "node.finished"; nodeKind: "approval" } & (
    | { status: "skipped" }
    | { status: "succeeded" | "cancelled"; durationMs: number }
    | {
        status: "failed" | "interrupted";
        durationMs: number;
        error: ErrorInfo;
      }
  );

type NodeFinishedEvent = AgentNodeFinishedEvent | ApprovalNodeFinishedEvent;

type RunFinishedEvent = EventBase & { type: "run.finished"; runId: string; durationMs: number } & (
    { status: "succeeded" | "cancelled" } | { status: "failed" | "interrupted"; error: ErrorInfo }
  );

interface CommandError extends EventBase, ErrorInfo {
  type: "error";
  runId?: string;
  nodeId?: string;
}

type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | NodeFinishedEvent
  | RunFinishedEvent
  | CommandError;
```

The eight document-producing commands use seven success contracts: `InitResult`, `WorkflowCatalogResult`, `ValidationResult`, `RunListResult`, `RunDetailResult`, `RunCancellationResult`, and the shared `ApprovalDecisionResult` for approve/reject. On failure they emit one `CommandError` document instead. Catalog diagnostics describe invalid packages that did not abort the bounded scan; they are distinct from a top-level command failure.

`RunCancellationResult` acknowledges a recorded [`runs cancel`](#runs-cancel) request and never asserts
that the run has stopped:

```text
RunCancellationResult = {
  outputVersion: 1,
  cancellationRequested: true,
  runId: string,
  cancelRequestedAt: string,
}
```

Once a run exists, execution failures are represented by `node.finished` and `run.finished` events containing `ErrorInfo`; pending nodes changed to skipped also receive `node.finished` events in plan order. For an automatic retry, the intermediate failed `node.finished` has `attempt` and `willRetry: true`, followed by the next `node.started` attempt. A retry-aware terminal node event keeps `attempt` but omits `willRetry`. Duration and output paths are required for a node that started and omitted for an unstarted skipped node. The stream ends with exactly one `run.finished` when the CLI remains able to write output. A failure before run creation emits one `CommandError` and no lifecycle event. `CommandError.runId` and `nodeId` are present only when those identities already exist.

Status and error-code vocabularies are stable within a released major CLI version.

Provider JSON Lines are written to `stdout.log`; they are never mixed into Kilin's public JSON stream.

For example, a validation failure is one document:

```json
{
  "outputVersion": 1,
  "type": "error",
  "timestamp": "2026-07-20T12:00:00.000Z",
  "code": "WORKFLOW_GRAPH_INVALID",
  "message": "The dependency graph contains a cycle through node 'verify'. Remove one of the listed edges.",
  "path": "edges"
}
```

Error messages state what happened and what the user can do next.

## Error codes

V1 uses this closed top-level vocabulary:

| Code                         | Meaning                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `OPTION_INVALID`             | a command, flag, value, or positional argument is invalid                                       |
| `INIT_TARGET_EXISTS`         | `workflow init` would overwrite an existing path                                                |
| `WORKFLOW_NOT_FOUND`         | no selected project or user package has the requested workflow name                             |
| `WORKFLOW_PACKAGE_INVALID`   | a workflow package, manifest, package path, or package-scope root violates the package standard |
| `WORKFLOW_SCOPE_INVALID`     | a project workflow was asked to run outside its owning project tree                             |
| `WORKFLOW_SOURCE_NOT_FOUND`  | the requested workflow file cannot be read                                                      |
| `WORKFLOW_PARSE_FAILED`      | YAML bytes or safe parsing rules are invalid                                                    |
| `WORKFLOW_SCHEMA_INVALID`    | the parsed definition does not match the structural schema                                      |
| `WORKFLOW_GRAPH_INVALID`     | node identity, edge, ordering, or DAG semantics are invalid                                     |
| `WORKING_DIRECTORY_INVALID`  | `--cwd` or a stored cwd cannot resolve to an existing directory                                 |
| `WORKSPACE_BUSY`             | another Kilin process holds the canonical cwd lock                                              |
| `STATE_BUSY`                 | SQLite remained busy beyond the documented timeout                                              |
| `RUN_NOT_CANCELLABLE`        | the cancellation target is already terminal or has no attached owner                            |
| `RUN_NOT_FOUND`              | the requested run ID does not exist                                                             |
| `RUN_PARAM_INVALID`          | a supplied run parameter is missing, undeclared, or oversized for the workflow                  |
| `RUNTIME_NOT_FOUND`          | the required runtime executable cannot be resolved                                              |
| `RUNTIME_UNSUPPORTED`        | the workflow names an adapter the installed build does not contain                              |
| `RUNTIME_ACCESS_UNSUPPORTED` | the selected runtime cannot provide the node's declared access mode                             |
| `RUNTIME_CAPABILITY_MISSING` | the installed runtime cannot satisfy a required invocation contract                             |
| `RUNTIME_AUTH_REQUIRED`      | runtime authentication preflight failed                                                         |
| `NODE_EXIT_NONZERO`          | the agent process exited unsuccessfully                                                         |
| `NODE_TIMEOUT`               | the node exceeded its effective wall-clock limit                                                |
| `NODE_OUTPUT_LIMIT`          | captured output exceeded its effective byte limit                                               |
| `NODE_CAPTURE_FAILED`        | a required log or final result could not be made durable                                        |
| `NODE_INPUT_INVALID`         | a declared upstream value cannot be resolved or consumed as the requested input                 |
| `NODE_OUTPUT_INVALID`        | a node's declared structured or artifact output is missing or invalid                           |
| `LOOP_LIMIT_REACHED`         | a bounded loop exhausted its configured iterations without selecting the pass choice            |
| `APPROVAL_NOT_WAITING`       | the requested approval target is not an active undecided approval gate                          |
| `APPROVAL_REJECTED`          | a human rejected the approval gate                                                              |
| `APPROVAL_TIMEOUT`           | no decision was recorded before the approval deadline                                           |
| `RUN_INTERRUPTED`            | a stale active run was reconciled after its owner disappeared                                   |
| `INTERNAL_ERROR`             | Kilin failed outside a more specific documented category                                        |

Messages and optional detail fields explain the precise cause. Automation branches on `code`, not English prose.

## Exit codes

| Code  | Meaning                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------- |
| `0`   | command and, when applicable, workflow run succeeded                                                        |
| `1`   | a recorded run failed or was interrupted                                                                    |
| `2`   | invalid invocation, workflow, path, runtime capability, or authentication; no run started                   |
| `130` | workflow execution or its preflight was stopped by an interrupt, supervisor termination, or terminal hangup |

An internal Kilin failure after a run starts uses exit code `1` and persists an actionable run failure when possible. An internal failure before a run exists uses exit code `2`. `SIGINT`, `SIGTERM`, and `SIGHUP` all stop an attached run through the same path, so terminating `kilin run` from a supervisor, container stop, or CI cancellation is not different from pressing Ctrl-C. Interruption during Codex preflight reaps the probe group, emits no lifecycle event or diagnostic, creates no run, and returns `130`. Interruption after run creation persists terminal cancelled state and lifecycle events before returning `130` when cleanup can complete.

## Automation guarantees

- `--json` writes no human prose to stdout.
- A validation or preflight error starts zero agent processes.
- A run ID is printed or emitted as soon as a run record exists.
- `rerun` never silently switches to the current workflow package.
- Unknown commands and flags fail rather than being ignored.
- `ui` never invokes a runtime or exposes runs outside its exact launch scope; its only recorded-state change is the guarded approval-decision route.
