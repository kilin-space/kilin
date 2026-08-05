<img src="https://docs.kilin.space/brand/kilin-mark.svg" alt="Kilin" width="88">

# Kilin

Kilin is a local, CLI-first workflow runtime for coding agents. You describe a finite workflow in
two ordinary files, validate it before anything runs, and execute it through the Codex, Claude
Code, or OpenCode CLI you already have installed. Kilin persists its results, captured logs,
decisions, and lineage locally so they remain inspectable. Content sent to provider CLIs may leave
the host and follows each provider's network and retention policies.

A workflow package pairs discovery metadata in `WORKFLOW.md` with an executable deterministic graph
in `WORKFLOW.yaml`, in either project or user scope. Agent nodes use fixed Codex, Claude Code, or
OpenCode adapters and may return `text`, `json`, `artifact`, `choice`, or Decision Packet V1
outputs. Kilin validates and compiles the graph, records an immutable scope-aware revision,
executes its ready frontier under a caller-selected concurrency bound that defaults to one, and
preserves enough history to rerun the exact stored revision. Execution stays in the foreground
CLI. Its only local-server surface is the attached, authenticated Viewer, whose mutations are a
closed set of two: approving or rejecting an eligible waiting approval, and cancelling a run it
already scopes.

Full documentation, including guides and the command reference, is at
[docs.kilin.space](https://docs.kilin.space/en).

## Driven by a person or by an agent

Workflow authoring, execution, monitoring, and approval are available as commands with `--json`
forms, so the thing driving Kilin can equally be a person at a terminal or an outer agent runtime
supervising work it delegated. Non-interactive setup uses an explicit provider selection such as
`kilin skills link --providers agents`. The Viewer remains a human inspection surface, while an
outer agent can launch and supervise its attached CLI process through `--json`.

```text
┌─────────────────────────────────────────────────────────────────┐
│  OUTER AGENT RUNTIME                                            │
│  a person at a terminal  ·  or Codex / Claude Code / a script   │
└─────────────────────────────────────────────────────────────────┘
        │                                             ▲
        │  create   kilin workflow init               │  monitor   runs list · runs show
        │  update   edit WORKFLOW.yaml                │  track     runs wait --json
        │  start    kilin run · kilin trigger         │  inspect   kilin ui
        │  decide   runs approve · runs reject        │
        ▼                                             │
┌─────────────────────────────────────────────────────────────────┐
│  KILIN                                                          │
│  validate → compile → immutable revision → execute              │
│  SQLite history  ·  captured logs  ·  JSONL event stream        │
└─────────────────────────────────────────────────────────────────┘
        │                                             ▲
        │  spawns provider subprocesses               │  results · logs · decisions
        ▼                                             │
┌─────────────────────────────────────────────────────────────────┐
│  INNER WORKFLOW — one run                                       │
│                                                                 │
│    analyze  ──▶  implement  ──▶  [approval]  ──▶  verify        │
│    read_only     workspace_write   barrier        read_only     │
│    Claude Code   Codex                            Codex         │
└─────────────────────────────────────────────────────────────────┘
```

The outer runtime stays outside the run: it cannot reach into a running node, and no edit to
`WORKFLOW.yaml` can change what this run executes, because Kilin recorded an immutable revision
before the first node started.

A person watches a run through `kilin ui` — the compiled graph, live node states, history,
failures, captured output, Decision Packets, and guarded approval buttons — or through
`kilin runs list` and `kilin runs show <run-id>`.

An agent watches the same run through `--json`. `kilin run --json` streams one JSON object per line
(`run.started`, `node.started`, `node.finished`, `approval.requested`, `approval.resolved`,
`run.finished`, `error`), `kilin runs wait <run-id> --json` blocks until the run next needs
attention or finishes, and failures carry stable error codes rather than only prose. Both views
read the same local SQLite history.

## Install

Kilin requires Node.js 24 or newer and one supported provider CLI installed and authenticated.

```bash
npm install --global @kilin-space/cli
kilin -h
```

Create and validate a first project-scoped workflow without invoking a model:

```bash
cd /absolute/path/to/project
kilin workflow init first-workflow \
  --scope project \
  --project-root "$PWD" \
  --name "First workflow" \
  --description "Inspect this project."
kilin workflow validate first-workflow --scope project --cwd "$PWD"
```

Review the [environment trust boundary](#environment-trust-boundary) before the first provider run.

## V1 journey

Kilin `0.1.0` uses one current workflow contract: every authored definition has
`schemaVersion: 1`. V1 includes bounded retry, continuation-based `retry` and `resume`, quiet
outer-controller attention through `runs wait`, closed choice routing, named Git worktree
isolation, declared run parameters, and one contained feedback loop with at most five iterations.

```bash
kilin workflow init change-review \
  --scope project \
  --project-root /absolute/path/to/project \
  --name "Change review" \
  --description "Analyze, approve, implement, and verify a local change."

kilin workflow list --cwd /absolute/path/to/project
kilin workflow validate change-review --scope project --cwd /absolute/path/to/project

kilin run change-review \
  --cwd /absolute/path/to/project

# reviewed-task is a V1 workflow declaring `parameters: [task]`.
kilin run reviewed-task \
  --cwd /absolute/path/to/project \
  --param task='Review PR 42'

kilin runs list
kilin runs show <run-id>
kilin rerun <run-id> [--max-parallel 4]
kilin retry <run-id>
kilin resume <run-id>
kilin runs wait <run-id> --json
kilin runs cancel <run-id>

kilin runs approve <run-id> <approval-node-id> --actor human
# or: kilin runs reject <run-id> <approval-node-id> --actor human

kilin ui change-review \
  --cwd /absolute/path/to/project \
  --no-open \
  --json
```

`retry` and `resume` require a source run whose `workspace_write` nodes all use named isolated
workspaces.

An external scheduler can start the same foreground execution path through a strict, versioned
request file:

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

```bash
kilin trigger --request /absolute/path/to/change-review-trigger.json --json
```

The host still owns when and how often that command runs. Kilin validates and records the cron
provenance, then reuses its normal package resolution, runtime preflight, workspace lock, execution,
and event stream. See
[host triggers](https://docs.kilin.space/en/reference/configuration#host-triggers).

`workflow init` creates both exact package files and a minimal Codex definition. Every authored
definition uses `schemaVersion: 1`:

```yaml
schemaVersion: 1
workflow: { id: change-review, name: Change review }
nodes:
  - id: analyze
    kind: agent
    runtime: claude-code
    access: read_only
    prompt: Analyze the proposed change.
    output: { type: json }
  - id: implement
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: Implement the justified changes.
    output: { type: artifact, path: outputs/change-summary.md }
  - id: approve
    kind: approval
    question: Accept the completed change?
edges:
  - { from: analyze, to: implement, input: analysis }
  - { from: implement, to: approve }
```

A `json` output may declare a `schema` — an inline JSON Schema 2020-12 object or a
package-relative path to a schema file in the package — and Kilin then validates the node's
returned document against it, failing the producing node with `NODE_OUTPUT_INVALID` on a
violation.

A V1 workflow may declare required run parameters and name their consumers:

```yaml
schemaVersion: 1
workflow: { id: reviewed-task, name: Reviewed task }
parameters: [task]
nodes:
  - id: worker
    kind: agent
    runtime: codex
    access: read_only
    parameters: [task]
    prompt: Complete the supplied task.
edges: []
```

Host cron triggers stay parameterless: `triggerVersion: 1` rejects `--param` and a root `parameters`
request field, and a triggered workflow declaring required parameters fails before any run or cron
provenance is recorded. See
[host triggers](https://docs.kilin.space/en/reference/configuration#host-triggers).

Each declared parameter is required, must have at least one consumer, and reaches only its declared
consumers through the same fenced untrusted-data envelope as an edge binding. Values stay out of
lifecycle events, `runs list`, `runs show`, and the Viewer, and `rerun`, `retry`, and `resume`
reproduce the stored snapshot without an override. `--param` is not secret-safe, because command
arguments can enter shell history and local process listings.

V1 can contain one finite revise-or-pass loop. The compact loop body is expanded at
compile time into one control execution and one occurrence of every body node for each declared
iteration. `maxIterations` is required from 1 through 5; nesting, arbitrary cycles, data-binding
edges into the loop, artifact feedback, and artifact loop results are rejected. Iterations run
strictly in order, while independent read-only work within one iteration may overlap. A pass
publishes the selected bounded result through the loop control; a revise decision at the final
bound fails with `LOOP_LIMIT_REACHED`. `runs show` groups scoped body occurrences by iteration
without exposing parameter, feedback, decision-choice, or result values.

A loop retains the captured output of every expanded occurrence, so a fully expanded run can hold
substantially more private evidence than a flat one. `--max-output-bytes` bounds the capture per
execution; Kilin does not delete history automatically.

`kilin runs cancel <run-id>` records a durable cancellation request from a second local process, so
stopping a run no longer requires the attached terminal. It acknowledges only that the request was
recorded: the owner observes it on its 250 ms cadence and then applies the existing process-group
termination grace. Commit order decides every race, so a node that already completed keeps its
truthful outcome while still-active work settles cancelled, and a run that already finished reports
`RUN_NOT_CANCELLABLE`.

`run` executes a deterministic dependency plan. `--max-parallel N` (1 through 8, default 1) bounds how many independent `read_only` agents overlap; writers and approvals stay exclusive barriers, and the default bound is exactly the original sequential fail-fast behavior. Above it, a failure skips only its transitive descendants while independent branches settle, and the run's primary failure is the lowest compiled ordinal. An agent may declare `timeoutMs`; otherwise `--node-timeout` supplies that run's process fallback. `--approval-timeout` independently bounds approval waits. Both run-level timeouts default to 30 minutes and accept one second through 24 hours. An approval keeps the foreground run attached and the exact working-directory lock held. An automated controller records its decision from a second local CLI process; a human may use either the guarded Viewer controls or a second terminal. `rerun` uses the stored normalized workflow definition, canonical working directory, and persisted execution options from the selected run; it requires fresh approvals and does not reopen the current package definition or restore prior workspace contents.

The Viewer shows the current non-editable DAG, validation/order, typed declarations and bindings, the newest 50 runs for the exact full workflow identity and canonical working directory, lineage, node states, approval metadata, failures, bounded captured output, and structured Decision Packets. It binds only numeric `127.0.0.1` on an operating-system-selected port, never invokes a provider runtime, and stops with the attached CLI process. A scoped waiting approval shows guarded Approve and Reject buttons plus fallback CLI commands, and a running run shows a guarded Cancel run button beside its fallback command. On load it opens the most relevant stored run — waiting for approval first, then running, then the newest finished run — and selects the node that explains the run status; with no stored runs it keeps the current definition view. The selected run, node, stream, and rendered or raw view persist in the URL hash and are restored after a reload. The decision and cancellation routes are the Viewer's whole mutation surface, a closed set of two; it cannot edit workflows, run providers, schedule work, execute Proposed Actions, or perform any other recorded-state change. Use `--no-open` to avoid opening a browser and `--json` to emit one machine-readable `viewer.started` document before the process waits.

## Agent skills

Kilin ships three agent skills as package assets under `agent-skills/`. The published tarball
contains that source directory verbatim, so the shipped skills are the reviewed skills:

- `agent-skills/generate-kilin-workflow` creates a requested project- or explicitly selected user-scoped package, preserves authored prompts and approval questions exactly, stages both files before no-overwrite publication, never runs it, and finishes by validating the exact scope.
- `agent-skills/discover-kilin-workflows` is explicit-invocation only. It streams scoped Codex or Claude Code history into one private sharded bundle, reconstructs root, resume, and child-agent families, and exposes every family and event through bounded cursor pages without global recency truncation or timeline sampling. The active agent shortlists from sanitized previews, deeply analyzes complete plausible families, reports coverage and graph-representation limits, and writes nothing until the user approves a design.
- `agent-skills/run-kilin-workflow` validates the visible package, starts a managed local Viewer when its loopback is user-accessible, supervises the JSON run lifecycle without auto-deciding approvals, and reports run and Viewer outcomes independently.

After a global installation, link all packaged skills into the provider directories you use:

```bash
kilin skills link
```

On a TTY, Kilin shows a Space/Enter checklist for Codex/Agents (`~/.agents/skills`) and/or Claude
Code (`~/.claude/skills`). Non-interactive shells must pass `--providers agents`, `--providers
claude`, or `--providers agents,claude`. The first interactive `kilin` command offers the same
checklist once per data directory (`KILIN_DATA_DIR` or `~/.kilin`). Use `kilin skills status` to
inspect links. Contributors working in a repository checkout can run the compatibility wrapper
from the checkout root; it links both providers without a prompt:

```bash
npm --prefix packages/cli run link:agent-skills
```

The linker is idempotent, refuses to replace existing paths, uses directory symlinks on Linux and
macOS, and uses directory junctions on Windows. Because links target the installed package,
removing or relocating that package breaks them; rerun linking after reinstalling or moving Kilin.

Repository scope, the active provider, and the trailing 30 days are the discovery defaults. Workspace-tree, all-projects, and cross-provider discovery require explicit consent after a sanitized-content model-egress disclosure. Raw history never crosses providers.

## State layout

Workflow source lives in project or user scope. The user-scoped
`~/.agents/workflows/` root is portable; runtime state remains separate:

```text
project/
└── .agents/
    └── workflows/
        └── change-review/
            ├── WORKFLOW.md
            └── WORKFLOW.yaml

~/.agents/workflows/
└── reusable-review/
    ├── WORKFLOW.md
    └── WORKFLOW.yaml

~/.kilin/
├── kilin.db
├── locks/
├── runs/
│   └── <run-id>/
│       └── nodes/
│           ├── <ordinal>-<node-id>/
│           │   ├── resolved-inputs.json  # only with bound inputs
│           │   ├── stdout.log
│           │   ├── stderr.log
│           │   └── result.txt
│           └── <ordinal>-<node-id>-attempt-002/  # only after a retry
│               └── ...
└── workspaces/
    └── <run-id>/
        └── <workspace-id>/  # retained detached Git worktree
```

Approval nodes have SQLite state but no node files. Agent results and resolved inputs are bounded private run files; an artifact remains a live workspace-relative reference rather than copied history.

### Retained worktree cleanup

Kilin deliberately retains isolated worktrees so their changes remain available for inspection. To
reclaim one after its run is terminal:

1. Run `kilin runs show <run-id>` and copy the exact `Working directory` and workspace path.
2. Inspect the worktree and preserve any changes you need.
3. Remove it through the source repository:

   ```bash
   git -C <working-directory> worktree remove -- <workspace-path>
   ```

Git refuses to remove a dirty worktree by default. Do not add `--force` unless you intend to
discard its changes. Kilin retains the historical workspace record, so later run detail may show a
path that no longer exists after manual cleanup.

## Environment trust boundary

Kilin passes the complete parent process environment to every provider preflight and agent
subprocess. This preserves provider authentication, proxy settings, developer tools, and project
commands, but it also means those third-party CLIs and the agents they launch can read unrelated
credentials and secrets from the invoking shell, including exported API keys and access tokens.
Workflow YAML cannot add or override environment variables, and Kilin does not record environment
names or values in public events.

Access modes and provider sandboxes do not remove this ambient trust. Run Kilin from a deliberately
minimal or sanitized environment containing only the credentials that the selected provider needs.
Provider or agent commands can still copy values they can read into captured private logs.

## Scope boundary

The shipped surface includes strict YAML and finite-graph validation, fixed Codex/Claude
Code/OpenCode adapters, typed output binding, declared run parameters, one contained bounded
feedback loop, Decision Packet V1 outputs, foreground approval gates, optional named Git worktree
lanes, deterministic sequential-by-default execution, bounded retry, continuation recovery,
immutable revisions, host-owned cron invocation, SQLite history, bounded file capture, three agent
skills, and the attached Viewer with its two guarded run-scoped mutation routes. Codex
and Claude Code support `read_only` and `workspace_write`; OpenCode fails closed for `read_only`
and supports only `workspace_write`.

It does not include an editable Canvas, daemon, public HTTP API, WebSocket, built-in scheduler or
schedule store, crontab management, transcript database or watcher, embedded LLM, dynamic runtime
plugins, authored input schemas, multiple outputs, nested or unbounded loops, parallel writable
branches, automatic worktree merge, browser mutation beyond the approval decision and run
cancellation, automatic action, Case/owner/ETA management, cloud/team execution, or a plugin
marketplace.

## Toolchain and verification

The CLI requires Node.js `>=24.0.0`. The repository pins pnpm `11.4.0` and enforces a
`minimumReleaseAge` of 1,440 minutes at the workspace root. Run the complete release gate from the
repository root:

```bash
pnpm verify
```

The gate checks formatting, linting, types, unit and browser behavior, documentation links, and an
installed npm tarball containing the bundled schema and agent skills. Real authenticated provider
smoke tests remain separate and opt-in.

Each adapter accepts stable provider releases at or above its tested floor — Codex `0.144.0`,
Claude Code `2.1.215`, OpenCode `1.18.4` — and only when that
provider's required capability and authentication probes also pass.

## Documentation

Guides, the full command reference, and configuration are at
[docs.kilin.space](https://docs.kilin.space/en), also available in
[简体中文](https://docs.kilin.space/zh-cn) and [繁體中文](https://docs.kilin.space/zh-tw).

- [Installation](https://docs.kilin.space/en/getting-started/installation)
- [Quickstart](https://docs.kilin.space/en/getting-started/quickstart)
- [Workflow model](https://docs.kilin.space/en/concepts/workflows)
- [Command reference](https://docs.kilin.space/en/reference/commands)
- [Configuration](https://docs.kilin.space/en/reference/configuration)
- [Trust boundaries](https://docs.kilin.space/en/security/trust-boundaries)
- [Troubleshooting](https://docs.kilin.space/en/troubleshooting)

The workflow JSON Schema is bundled with the published runtime at
`dist/infrastructure/workflow-v1.schema.json`.

Contributors can find the design and contract documents — architecture, the workflow, runtime, and
CLI contracts, the decision record, and the testing strategy — under
[`packages/cli/docs/`](https://github.com/kilin-space/kilin/tree/main/packages/cli/docs).

## License

[MIT](LICENSE)
