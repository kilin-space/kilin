# V1 Testing Strategy

Tests protect behavior, data integrity, security, accessibility, and documented CLI contracts. They do not preserve private helper names, SQL formatting, import order, CSS class order, or other implementation shape.

Ordinary automated tests use fake provider executables, synthetic history fixtures, real temporary
SQLite/files, and temporary Kilin data roots. They make no model calls, require no provider
authentication, and never write normal `~/.kilin` state.

## Test layers

### Domain and workflow application tests

- safe YAML and closed-schema acceptance/rejection;
- semantic graph validation and writer ordering;
- deterministic topological order and large generated DAGs;
- V1 loop validation, deterministic finite expansion, scoped execution identity,
  compiled execution/edge bounds, and expanded writer ordering;
- normalization and content hashing;
- lifecycle transition and execution-option rules; and
- no-overwrite initialization and side-effect-free validation.

### Infrastructure and execution integration tests

- the exact V1 state baseline, foreign keys, WAL, five-second busy handling, concurrent startup,
  and rejection of incompatible state;
- atomic revision/run/all-pending-node creation before spawn and revision deduplication;
- canonical cwd resolution, descriptor-held cross-process locking, and stale reconciliation;
- application-owned loop-control transitions, iteration eligibility, and scoped stale
  reconciliation without event replay or same-run continuation;
- exact argv, cwd, stdin, environment, `shell: false`, sandbox selection, Git handling, and final-result extraction;
- private ordinal output paths, bounded combined output, durable capture, and failure injection;
- non-zero exit, timeout, output limit, spawn/capture failure, process-group cancellation, descendant cleanup, and leader-exit pipe retention;
- preflight version/capability/authentication failures and preflight cancellation with zero run rows; and
- event-sink failure and corrupt stored-state invariants without leaving active lifecycle rows.

### CLI behavior tests

- initialize and validate a workflow;
- run a multi-node DAG, fail fast, list/show history, rerun a changed or deleted source, and
  prove that rerunning a failed run starts a fresh whole-workflow execution rather than retrying
  only the failed node;
- verify bounded automatic attempts, target-only continuation recovery, resume lineage, closed
  choice routing, outer-controller attention waits, and retained Git worktree isolation;
- execute bounded feedback through pass, revise, limit, body failure, cancellation, and
  owner-loss outcomes while keeping future iterations and outer dependents in the correct state;
- exact human output, single JSON documents, JSON Lines events, error vocabulary, and exit codes;
- prompt/provider-output isolation and secret-safe errors;
- unknown, duplicate, missing, and extra arguments; and
- SIGINT during preflight, and each stop signal after run creation.

### Authoring skill tests

Generation tests exercise the publisher as a behavior boundary:

- hostile Unicode and multiline prompts decode exactly;
- invalid candidates create no target;
- existing targets retain every byte;
- pre-existing symlinked `.kilin` or `workflows` components and out-of-root targets fail closed;
- complete staged bytes use private mode, clean up on every path, and publish atomically with no replacement; and
- concurrent publishers yield exactly one complete valid workflow.

Discovery uses only bounded synthetic/provider-normalized JSON Lines fixtures. Tests cover:

- exact repository, path-contained workspace, all-projects, selected-provider, and half-open `[now - 30 days, now)` filtering;
- reconstruction and ordering of root, resume, and child-agent session families;
- preservation of sanitized user and assistant turns, tool evidence, artifacts, corrections, and outcomes;
- hostile historical instructions and excluded payload classes remaining inert;
- credential, secret, personal-data, path, URL, and control-character redaction;
- streaming shard rotation beyond 5 MiB and 10,000 records, complete cursor pagination across every family and event, bounded sanitized manifest previews, and one-family evidence reads;
- private normalized-input enforcement and no second evidence copy;
- explicit consent after sanitized-content egress disclosure for workspace, all-projects, or cross-provider scope;
- invocation from a working directory unrelated to the Kilin checkout; and
- idempotent, no-overwrite provider links to the repository-owned skills.

Authoring prose conformance tests normalize Markdown and whitespace before checking required
author-visible contracts. They protect instructions that affect generated behavior, consent,
privacy, evidence sufficiency, or representability; they do not pin headings, list numbering,
emphasis, line wrapping, or exact explanatory copy.

### Viewer application, server, and browser tests

Application/server tests use recorded synthetic state and never expose a runtime adapter:

- current source revalidation and stored-revision integrity;
- exact workflow-ID plus canonical-cwd history/detail/lineage scope;
- absent database remains absent through read-only inspection;
- numeric-loopback peer, exact Host and Origin, fixed methods/routes, content types, body bounds, CSP, no-store, and local-only assets;
- one-use fragment-token exchange, process-lifetime cookie, CSRF resume and API enforcement;
- exactly two authenticated, CSRF-protected, scope-checked mutation routes — the waiting-approval decision and the run cancellation — each covered on its own; rejection of every other mutation, reconciliation, generic file, raw-path, WebSocket, or runtime route; and
- exact stored-path authorization, traversal/symlink/non-regular rejection, identity recheck, and 64 KiB output tail.

Playwright exercises the built CLI/server/client with fake or pre-recorded state:

- authentication and shutdown behavior;
- current/invalid workflow, running/succeeded/failed/cancelled/interrupted/skipped states, errors, lineage, and output;
- semantic SVG plus textual execution-order equivalent;
- keyboard focus and graph navigation, visible focus, status text independent of color, and reduced motion;
- polling without runtime invocation; and
- 1440x900 and 390x844 screenshots with no horizontal page overflow.

## Required behavior contracts

### Parsing, graph, and revision identity

- The canonical example in [Workflow Contract](workflow.md#v1-definition) validates against
  [the JSON Schema](../../src/infrastructure/workflow-v1.schema.json).
- Unknown fields, duplicate keys, aliases/anchors, merge keys, custom tags, multiple documents, invalid UTF-8, empty prompts, and malformed identifiers fail.
- Missing endpoints, duplicate node IDs/edges, self-edges, cycles, unsupported kinds/runtimes, and unordered writer pairs fail before persistence or spawn.
- The outer graph and a contained loop body are independently acyclic. At most one non-nested loop
  compiles to a deterministic finite plan with stable, opaque occurrence identities and explicit
  loop/body/iteration provenance; arbitrary cycles and over-bound plans fail before persistence.
- Unordered read-only nodes execute by declaration order; a dependency chain executes once per node in topological order.
- Formatting, comments, object-key order, and edge order do not alter a hash; node order, prompt, access, model, and dependencies do.
- The source is read once for `run`; rerun recompiles and verifies exact stored normalized JSON after source change or deletion.

### Workspace and durability

- Relative cwd resolves from invocation location; symlinks canonicalize; missing/non-directory values fail before persistence or spawn.
- Child cwd and the adapter-owned working-directory argument identify the assigned canonical
  source or named workspace; rerun uses the recorded source path and fails without a new run if it
  disappears.
- Kilin never copies, cleans, resets, rolls back, or adds its data root as a writable project directory.
- Two Kilin processes cannot execute against one canonical cwd; different cwd runs may proceed independently.
- State baseline initialization or validation occurs before the cwd lock, and replacement
  execution retains one cwd descriptor across reconciliation and terminal persistence.
- Run and every pending node row commit before the first agent side effect; a node is `running` with paths before output preparation or spawn.
- Terminal transitions are durable despite observer errors. Stored-state decoding rejects status/timestamp/failure/path/exit-code contradictions and unknown error codes.
- A live locked run is not reconciled; an unlocked stale run becomes interrupted and its pending nodes skipped, with no replay.
- Stale reconciliation terminalizes active scoped occurrences and their loop control as
  interrupted, or as cancelled when a cancellation request is durably latched, and skips all
  future occurrences. It never resumes the same run at iteration N.

### Runtime safety and failure

- A missing provider, outside-band version, missing required capability, or failed authentication
  probe causes zero agent spawns and no run row.
- The prompt is exact stdin data; authored YAML cannot alter argv, cwd, environment, sandbox, output path, or writable roots.
- Each supported access mode maps through a qualified provider profile; OpenCode `read_only` fails
  closed; no shell or bypass path exists.
- Authentication/environment values never appear in Kilin-generated events or errors.
- Zero exit plus durable capture succeeds. Non-zero exit, timeout, output breach, final-result/log failure, and internal post-create failure terminally fail and skip later nodes.
- Partial output remains inspectable. Cancellation and timeout signal the current process tree,
  retain capture, and force-terminate revalidated descendants on every host that exposes a process
  snapshot.
- A run killed without a chance to clean up leaves its recorded process identity behind, and the
  next command to take that working directory — a plain `run` as much as a recovery — terminates
  those survivors, even after an intervening `runs show` reconciled the run.
- A passing decision publishes the declared bounded result through the loop control before outer
  consumers become eligible. A revising decision exposes only the declared bounded feedback to the
  next iteration's designated consumer. Revising at the final bound fails with
  `LOOP_LIMIT_REACHED`.
- Missing, invalid, or oversized feedback and invalid or missing decisions fail the scoped
  occurrence and loop without starting a later iteration. Body failures preserve their durable
  provenance, and the lowest-ordinal independent failure is primary.
- Cancellation during any body phase drains active work, starts no later iteration, cancels the
  loop and run, and does not publish a materialized-but-unauthorized result.
- Pre-run SIGINT reaps probe descendants, emits no public event or diagnostic, creates no state, and exits `130`; post-create SIGINT, SIGTERM, and SIGHUP each persist normal cancelled lifecycle, reap the provider tree, and start no later node.

### CLI and viewer contracts

- `workflow init` and generation never overwrite an existing target.
- Document-producing JSON commands emit one document and no human stdout; `run` and `rerun` emit only the exact `RunEvent` JSON Lines union.
- Each recorded run stream has exactly one terminal `run.finished` when output remains writable; fail-fast emits skipped-node events in plan order.
- Provider JSON and prompts never enter public CLI output. Exit codes match [CLI Contract](cli.md#exit-codes).
- Parameter, feedback, and result content never enters public lifecycle events. Loop controls emit
  no agent/approval node events; scoped body events expose occurrence identity and loop/iteration
  provenance only when applicable.
- Viewer cookies and CSRF cannot authorize another origin, workflow, cwd, run, node path, or arbitrary filesystem file.
- Viewer GETs are pure recorded-state/current-source reads and never invoke Codex or reconcile state.
- All documented local Markdown links resolve.

### Bounded feedback lifecycle

- Validation rejects nested or multiple loops, an invalid or non-sink decision node, mismatched
  pass/revise choices, ambiguous feedback input, unsupported artifact feedback/result, and
  out-of-range iteration or compiled-plan bounds.
- Recompiling the same stored authored definition produces the same execution identities,
  ordinals, iteration gates, result projection, and content hash. Tests consume explicit scope
  metadata and fail if correctness depends on parsing generated identities.
- Pass on iteration zero succeeds the loop once, authorizes one loop-owned result, skips future
  occurrences, and releases only declared outer consumers.
- Revise then pass carries the declared feedback to exactly the next iteration consumer; revise to
  the bound leaves the final decision succeeded and fails the loop and run with
  `LOOP_LIMIT_REACHED`.
- Retry success and exhaustion remain node-attempt behavior inside one iteration. There is no
  loop-level or iteration-level retry.
- Body failure, approval rejection/timeout, malformed decision, invalid feedback, cancellation,
  and stale-owner recovery preserve scoped occurrence, attempt, decision, feedback, result, and
  failure provenance in durable state.
- Full rerun and any eligible continuation start the whole loop at iteration zero from the stored
  revision. Historical body occurrences are evidence, not resumable checkpoints.
- Run detail and Viewer iteration projections derive from the stored definition, compiled scope
  metadata, SQLite, and authorized files. They do not replay events, parse generated identities,
  expose private values, or invoke a runtime.

## Real-runtime qualification

`pnpm qualify:release` is the explicit-opt-in artifact and authenticated-runtime gate. It refuses
to run without `--allow-model-call`, packs one retained tarball, installs it into an isolated global
prefix, and passes that installed binary to the repository-side runtime harness. Provider CLIs use
their authenticated default models. The tarball output must be outside the Git worktree so the
clean-tree revalidation remains meaningful; sanitized evidence may be written into the
qualification directory after every artifact check passes.

The harness runs four isolated scenarios:

- deterministic redacted Codex and Claude authentication failures plus fail-closed OpenCode
  `read_only` rejection, with no model calls or run rows;
- one mixed Codex text to Claude JSON to approval to OpenCode artifact workflow, including named
  bindings and native/subprocess hostile-write evidence;
- one authored Codex process timeout with descendant cleanup; and
- one Codex run cancelled from a second public CLI process with descendant cleanup.

The complete matrix makes five model calls. Its sanitized record contains the exact artifact hash,
tool and runtime versions, default-model selection, commands, status/check booleans, and known
limits. It excludes prompts, raw provider streams, credentials, account identity, environment
values, session IDs, and temporary paths. The current result lives only in the
[qualification index](../qualification/README.md). The harness is repository-side and is not
included in the published package.

## Release gate

The single canonical release gate is maintained in
[RELEASING.md](../../../../RELEASING.md#release-gate). This strategy does
not restate the commands, so package verification and deterministic checks cannot drift between
documents. Real-provider qualification remains a separate explicit opt-in gate.
