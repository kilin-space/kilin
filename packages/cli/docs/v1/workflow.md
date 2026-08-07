# Workflow Contract

This document owns the semantic contract for Kilin workflow definitions. The
[JSON Schema](../../src/infrastructure/workflow-v1.schema.json) owns their structural shape.

This is the complete V1 contract. Every definition uses `schemaVersion: 1`. See
[Reliable Orchestration](reliable-orchestration.md), [Bounded Feedback](bounded-feedback.md), and
[Decision Packet V1](decision-packets.md) for focused contracts.

## Source and identity

A workflow definition is the exact `WORKFLOW.yaml` file in a project- or user-scoped [Workflow Package](workflow-packages.md). Commands resolve packages by name; they do not accept arbitrary definition paths.

`workflow.id` contains 1 through 64 lowercase ASCII letters or digits in single-hyphen-separated segments. It must equal the package directory and manifest name. The schema, compiler, and package resolver enforce the same lexical contract. Durable identity also includes the resolved scope kind and canonical project root, so same-named workflows in user scope or different projects remain distinct.

Node IDs are stable within a workflow revision. They appear in diagnostics, run history, and log paths, so authors should not use presentation labels as IDs.

## V1 definition

```yaml
schemaVersion: 1

workflow:
  id: change-review
  name: Change review

nodes:
  - id: analyze
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: >-
      Review the current change and write a concise plan to
      .kilin/artifacts/change-review.md. Do not modify product files.

  - id: implement
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: >-
      Read .kilin/artifacts/change-review.md, implement the justified changes,
      and run focused checks.

  - id: verify
    kind: agent
    runtime: codex
    access: read_only
    prompt: >-
      Verify the requested behavior and report any remaining failures.

edges:
  - from: analyze
    to: implement
  - from: implement
    to: verify
```

Every root field and nested field is closed: unknown fields are errors. Workflow definitions do
not contain host triggers, schedules, raw runtime arguments, environment variables, or publish
state.

## Node semantics

V1 supports agent, approval, and loop nodes:

```yaml
kind: agent
kind: approval
kind: loop
```

An agent node contains:

- `id`: a stable identifier unique within the workflow;
- `runtime`: the runtime adapter name;
- `access`: `read_only` or `workspace_write`;
- `prompt`: the complete instruction sent to the runtime;
- `timeoutMs`: an optional integer process timeout from 1,000 through 86,400,000 milliseconds; and
- `model`: an optional runtime model identifier.

When `timeoutMs` is absent, execution uses the run's `--node-timeout` fallback. The authored value
applies independently to every retry attempt. Approval and loop-control nodes reject this field;
approval waits use the run's separate approval timeout.

The structural schema accepts a non-empty runtime identifier. Semantic validation rejects any
runtime the installed Kilin build does not support. V1 ships fixed `codex`, `claude-code`, and
`opencode` adapters. OpenCode supports only `workspace_write`; `read_only` fails closed.

Model identifiers must start with an ASCII letter or digit and then contain only letters, digits, `.`, `_`, `:`, `/`, or `-`. The selected runtime adapter performs any additional model validation before persistence; availability at the remote provider can still change after preflight.

The adapter owns executable paths, arguments, environment handling, sandbox flags, output flags, and authentication. Workflow authors cannot add or override them.

## Edge semantics

An unconditional edge from `A` to `B` makes `A` a prerequisite. A named `input` binds the source
agent's declared output to the target agent. A `when` edge activates only for the named value of a
declared `choice` output. Approval nodes may have dependency edges but cannot produce or consume a
binding.

An agent declares at most one `text`, `json`, `decision_packet`, `artifact`, or `choice` output.
A `choice` node must answer with exactly one JSON object `{"choice":"<value>"}` naming a declared
choice, and a `json` node must answer with exactly one JSON document and no surrounding text; the
injected output contract states these requirements to the runtime, and a violation fails the
attempt with `NODE_OUTPUT_INVALID`.
A `json` output may also declare `schema`, as an inline JSON object or as a package-relative path
to a JSON file in the same package (see [Workflow Package Contract](workflow-packages.md#package-layout)).
The schema is a JSON Schema 2020-12 object; the boolean schema form is not supported, and every
other output type rejects `schema`. Validation is strict: unknown keywords, unknown `format`
values (`ajv-formats` is not shipped), strict type, tuple, and `required` rules, and external or
unresolvable `$ref` references are all rejected. The `pattern` and `patternProperties` keywords
are not supported because JavaScript regular expressions can block the runtime on hostile input.
Schemas are inert data; Kilin never fetches anything remote. A malformed schema fails package
loading with `WORKFLOW_SCHEMA_INVALID` and an
unresolvable schema file with `WORKFLOW_PACKAGE_INVALID`, each naming the declared source, so
`kilin workflow validate` reports both without invoking a provider. At run time, a returned
document that does not satisfy the declared schema fails the producing node with
`NODE_OUTPUT_INVALID` naming the failing instance path (for example `findings[0].severity`, or
the document root); the existing retry policy is unchanged, and the retry attempt's prompt
restates the schema. The resolved schema is serialized into the producer's injected output
contract on every attempt. Kilin does not enforce a prompt-size limit; the 256 KiB
(262,144-byte) schema-file cap at package load is the only bound Kilin enforces on schema files
(inline schemas are bounded by the 1,048,576-byte definition cap), and a provider can still
reject an oversized prompt at run time, so keep schemas small.
Artifacts are live workspace-relative references and require `workspace_write`; Kilin does not
copy them into managed storage. Bound text, JSON, Decision Packets, choices, and run parameters
reach only declared consumers through the `KILIN_RESOLVED_INPUTS_V1` untrusted-data envelope.

## Run parameters

V1 lets a caller supply declared string values to an existing workflow:

```yaml
schemaVersion: 1

workflow:
  id: reviewed-task
  name: Reviewed task

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

Rules:

- root `parameters` is an optional set-like list of 1 through 32 unique names using the edge input-name grammar;
- an agent's optional `parameters` list names only root-declared parameters;
- approval nodes cannot consume parameters;
- every declared parameter is required at run time and must have at least one consumer, otherwise compilation fails with `WORKFLOW_GRAPH_INVALID`;
- a node cannot use one input name for both a parameter and an edge binding;
- canonicalization sorts both lists.

A parameter reaches only its declared consumers, through the same `KILIN_RESOLVED_INPUTS_V1`
envelope as an edge binding, and is labelled untrusted data rather than instructions. Values never
appear in lifecycle events, `runs list`, `runs show`, or the Viewer. They are invocation data, not
part of the immutable workflow revision, so the same revision serves many different snapshots.

## Contained bounded feedback loop

V1 may declare one compact, finite revise-or-pass loop:

```yaml
schemaVersion: 1
workflow: { id: refine-change, name: Refine change }
parameters: [task]
nodes:
  - id: refinement
    kind: loop
    maxIterations: 3
    body:
      nodes:
        - id: worker
          kind: agent
          runtime: codex
          access: workspace_write
          parameters: [task]
          prompt: Implement the supplied task and return a concise change summary.
          output: { type: text }
        - id: review
          kind: agent
          runtime: codex
          access: read_only
          prompt: Review the change and return bounded revision feedback.
          output: { type: text }
        - id: decision
          kind: agent
          runtime: codex
          access: read_only
          prompt: Decide whether the change passes or needs revision.
          output: { type: choice, choices: [pass, revise] }
      edges:
        - { from: worker, to: review, input: draft }
        - { from: review, to: decision, input: feedback }
    decision: { node: decision, passChoice: pass, reviseChoice: revise }
    feedback: { from: review, to: worker, input: feedback }
    result: { node: worker }
edges: []
```

Agent nodes inside the loop body support the same optional `timeoutMs` field and validation path as
top-level agents.

The outer graph and body graph remain acyclic. V1 permits at most one loop and no
nested loop. Body nodes are agents or approvals, and body edges are unconditional dependencies or
named bindings. The decision node is an agent, is the unique body sink, and has every other body
node as an ancestor. Its `choice` output contains exactly the configured pass and revise choices.

The feedback source is an agent with a bounded `text`, `json`, or `decision_packet` output. Its
target is an agent whose feedback input name has no other parameter or edge binding. Artifact and
choice feedback are rejected. The result node is an agent with a bounded `text`, `json`,
`decision_packet`, or `choice` output; artifact loop results are rejected. Outer data-binding
edges into the loop are deferred, so initial body data comes from declared run parameters.
Dependency-only outer edges into the loop and typed edges out of the loop are valid.

`maxIterations` is required from 1 through 5. Compilation expands one loop control plus one
occurrence of every body node for every possible iteration into the same finite acyclic execution
plan. The complete plan is capped at 256 executions and 1,024 expanded edges. Iterations are
strictly sequential; independent read-only nodes within one iteration may overlap under
`--max-parallel`. A pass copies the selected bounded result to the loop control before outer
dependents become eligible. A revise decision at the final bound fails with
`LOOP_LIMIT_REACHED`.

The finite plan makes the row count predictable but does not make retained evidence small. At 256
executions and five attempts, the default 10 MiB combined-capture and separately bounded 10 MiB
resolved-input limits produce a rough 25 GiB run bound. Raising `--max-output-bytes` to its 100 MiB
maximum raises the same rough bound to 250 GiB, before metadata and projections. Automatic
retention is separate.

Body nodes use ordinary retry, approval, cancellation, and evidence contracts. There is no
iteration-level or loop-level retry. Full rerun and eligible `retry` or `resume` restart the
entire loop at iteration 0; they never continue a historical provider session or iteration.
Nested loops, `forEach`, arbitrary graph back-edges, conditional body edges, accumulators,
parallel iterations, and `onLimit: continue` remain deferred.

## Parsing rules

Kilin parses YAML in safe mode and rejects:

- custom tags;
- aliases and anchors;
- duplicate mapping keys;
- multiple YAML documents;
- non-UTF-8 input; and
- any value that fails the structural schema.

A definition larger than 1,048,576 bytes is rejected before parsing. The structural schema bounds a workflow to 128 nodes and 512 edges.

Parsing and validation never execute templates, environment substitutions, shell expressions, or runtime commands.

## Semantic validation

After structural validation, Kilin rejects a workflow when any of the following is true:

- a node ID is duplicated;
- a prompt is empty after trimming for validation purposes;
- an edge references a missing node;
- an edge points from a node to itself;
- the same edge appears more than once;
- the graph contains a cycle;
- a node kind or runtime is unsupported; or
- unordered writers would share the same workspace.

The final rule prevents hidden ordering between operations that can observe or change one
workspace. Read-only nodes may be unordered. Writable branches require distinct named isolated
workspaces.

Diagnostics include a stable error code, an actionable message, and a YAML path when one is available.

## Deterministic order

The compiler produces a topological execution plan. When multiple nodes are ready, declaration
order assigns stable ordinals. The run's `maxParallel` bound permits only independent read-only
agents to overlap; writers and approvals remain exclusive.

Node declaration order is therefore semantic only as the tie-break between ready read-only nodes. Dependency edges remain the authoritative ordering mechanism.

## Normalization and revisions

Before a run starts, Kilin converts the validated YAML to normalized JSON:

1. Only schema-defined values are included.
2. Object keys are sorted recursively.
3. Node array order is preserved because it is an execution tie-break.
4. Edges are sorted lexicographically by `from`, then `to`, because edge declaration order has no meaning.
5. Strings and array values are preserved exactly after YAML decoding.
6. The result is serialized as UTF-8 JSON without insignificant whitespace.

The revision content hash is the lowercase hexadecimal SHA-256 hash of those bytes. YAML comments, indentation, key order, and edge order do not change the hash. Node order, prompts, access, model, and graph structure do. A declared `json` output schema is resolved and embedded in the definition as an object before normalization, so the hash covers it: editing a referenced schema file produces a new revision.

`kilin workflow validate` performs package and normalization checks but stores nothing. `kilin run` resolves the requested package, reads its definition once, then creates or reuses the immutable scope-aware revision after parsing, validation, compilation, and runtime preflight succeed, immediately before it creates the run record. The executor uses that in-memory definition rather than reopening the file. Every run references one revision.

`kilin rerun <run-id>` loads the stored normalized definition. It reads neither the original YAML file nor any schema file the definition referenced, even if they still exist.

## Versioning rule

The current authored contract is `schemaVersion: 1`. Machine protocols such as `outputVersion`,
`triggerVersion`, `packetVersion`, and the resolved-input envelope are independent contracts and
retain their own value of `1`.

An incompatible future authored-contract change must use a deliberate versioning decision. Kilin
does not preserve compatibility with unpublished prototype schemas.
