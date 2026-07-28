---
name: generate-kilin-workflow
description: Create a new project- or user-scoped Kilin workflow package from a user's requested operation. Use when the user asks to author, generate, or create a Kilin workflow; do not use to run one or to discover candidates from history.
---

# Generate a Kilin workflow

Create one new workflow package that follows Kilin's current V1 workflow contract. A package contains discovery metadata in `WORKFLOW.md` and the executable definition in `WORKFLOW.yaml`. Every definition uses `schemaVersion: 1`; choose only the fields required by the requested operation. The installed CLI owns final validation.

## Inputs and identity

1. Work from the exact current project, resolving its physical root rather than following a similarly named path.
2. Default to project scope. Use user scope only when the user explicitly requests a user, global, portable, or cross-project workflow. A project package targets the current project's physical root; a user package targets the invoking user's physical home directory. If user-scope permission is denied, stop and report it; never fall back to project scope.
3. Ask only for information required to choose a valid workflow ID, display name, discovery description, complete agent prompt, runtime assignment, data handoff, artifact path, or approval question. Do not infer a materially different operation.
4. Choose a stable workflow ID matching the package and workflow schemas. Target exactly `.agents/workflows/<id>/WORKFLOW.md` and `.agents/workflows/<id>/WORKFLOW.yaml` beneath the selected scope root. The directory name, manifest `name`, and YAML `workflow.id` must be identical. Do not write outside this package.
5. Treat the user's prompt and approval question as authored content. Preserve the received Unicode text, punctuation, line breaks, and whitespace exactly as the decoded YAML `prompt` or `question` value. Do not polish, summarize, prefix, suffix, template, or interpolate it.
6. Explain that approval questions are persisted and emitted in public JSON Lines and displayed in the viewer, so they must not contain secrets. If a proposed question contains sensitive content, stop and ask the user for a non-secret replacement; do not silently redact or rewrite it.

If the user supplies one operation or one prompt, create one agent node containing that prompt. If the user explicitly supplies multiple agent or approval stages, preserve each supplied prompt or question exactly and create only the nodes needed for those stages. Ask for missing authored text instead of silently writing it.

## Package and graph

1. Write `WORKFLOW.md` with YAML frontmatter containing exactly `name` and `description`. Use the workflow ID as `name`; write a concise discovery description from 1 through 1,024 characters. An optional Markdown body may explain when to use the workflow and its preconditions, but it must not duplicate executable graph fields.
2. Write `WORKFLOW.yaml` with `schemaVersion: 1`, one `workflow` mapping, a non-empty `nodes` sequence, and an `edges` sequence. Do not repeat `description` in YAML. Add no fields outside the closed V1 schema.
3. Use the fewest nodes that express the user's explicit stages. Do not add generic planner, reviewer, coordinator, or verifier nodes.
4. Agent nodes use exactly one of `codex`, `claude-code`, and `opencode`. Honor an explicitly requested runtime; otherwise default to `codex`. Omit `model` unless the user explicitly requests one. If the user requests OpenCode for a stage that should remain read-only, stop and ask them to choose Codex or Claude Code or explicitly authorize `workspace_write`. Do not silently grant `workspace_write`.
5. Default an agent node to `read_only`. Use `workspace_write` only when it must change project state. OpenCode supports only `workspace_write`. An approval node uses `kind: approval` with only `id` and a `question` from 1 through 2,000 Unicode characters; it has no runtime, access, prompt, model, or output.
6. Declare at most one agent output only when the requested workflow needs it: `text`, `json`, `decision_packet`, `artifact`, or `choice`. Use `decision_packet` only when the requested stage must produce the standard Decision Packet V1 business-judgment package; it has no `path` and does not itself approve or execute anything. An artifact requires `workspace_write` and a 1- through 1,024-byte POSIX-relative path with `/` separators, no leading or trailing slash, and no empty, `.`, `..`, backslash, NUL, or ASCII-control segment content. Do not normalize an invalid path. A choice output declares 2 through 32 unique lowercase choice IDs. Add a conditional edge only for a choice declared by its source, and cover every declared choice with at least one outgoing conditional edge.
7. Add an edge only for a real prerequisite. Add a named input binding when a target agent must consume a declared source output. Use a unique lowercase input name beginning with a letter and containing only letters, digits, or underscores. An approval may have dependency edges but cannot produce or receive a data binding.
8. Order every pair of nodes when either agent has `workspace_write` access. Leave read-only agents unordered only when they are genuinely independent. Keep the DAG acyclic and avoid duplicate or self edges.

## Run parameters

When the caller must supply a required string at run time, declare 1 through 32 unique lowercase names at the root, list each name on only the agent consumers that need it, and ensure every declared parameter has a consumer. An approval cannot consume a parameter, and one consumer input name cannot be both a parameter and an edge binding. Parameter values are invocation data, not authored YAML; never ask the user to place a value or secret in the definition.

## Contained bounded feedback loop

Use a loop only when the requested operation explicitly repeats the same finite revise-or-pass procedure and sends one bounded feedback value to the next iteration. One provider invocation may iterate internally; that does not by itself justify a Kilin loop.

A V1 definition may contain at most one loop, with no nested loop. `maxIterations` is required and must be 1 through 5. The body is an acyclic graph of agent and approval nodes with unconditional dependency or input-binding edges. The decision node must be an agent, the unique body sink, and reachable from every other body node. It declares exactly one `choice` output containing exactly the configured pass and revise choices.

The feedback source is an agent with a bounded `text`, `json`, or `decision_packet` output. The feedback target is an agent, and the configured feedback input name must have no parameter or body-edge binding. Artifact and choice feedback are invalid. The result node is an agent with a bounded `text`, `json`, `decision_packet`, or `choice` output; an artifact loop result is invalid. Outer data-binding edges into the loop are not supported; use declared run parameters for initial body input. Dependency-only edges into the loop and typed edges out of the loop are valid.

Before publication, show the user the iteration bound, pass and revise choices, feedback source, feedback consumer and input name, result node, and compiled execution count. Count one loop control plus `maxIterations × body node count`, plus every top-level non-loop node; the total must not exceed 256. The compiler also enforces at most 1,024 expanded edges and writer ordering across every expanded iteration.

Use this shape, adapting only the authored operation:

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

Kilin compiles this compact authoring form into a finite acyclic execution plan. Iterations are strictly sequential, while independent read-only nodes within one iteration may use the run's parallel bound. A revise decision at the final bound fails with `LOOP_LIMIT_REACHED`. Rerun and eligible continuation start the whole loop again at iteration 0; they do not resume a provider session or historical iteration. There is no loop-level or iteration-level retry, `forEach`, arbitrary cycle, nested loop, conditional body edge, accumulator, or `onLimit: continue`.

## Exclusive creation and validation

1. Resolve this skill's physical directory from the `SKILL.md` path supplied by the skill loader, not from the process working directory. The Kilin package root is exactly two directories above it, and the built CLI is `dist/cli/main.js` beneath that root. This one layout holds for the repository source and the installed package alike, including global symlinks resolved from unrelated working directories. If the package root cannot be resolved, stop and report the invalid installation path. If the CLI does not exist, stop and report the incomplete Kilin installation; generation must not build or otherwise mutate project files beyond the requested workflow package.
2. Write the complete intended `WORKFLOW.md` and `WORKFLOW.yaml` to two private temporary candidate files. Verify by parsing the YAML candidate that every user-supplied prompt and approval question decodes to the exact received string. Do not create or reserve the target package yourself.
3. Publish both candidates only through `scripts/publish-workflow.mjs` beneath the resolved physical skill directory. Pass `--scope project|user`, the selected physical `--scope-root`, the exact current project as `--cwd`, the resolved built CLI, both candidate files, and the exact `.agents/workflows/<id>` target. Invoke arguments directly without a shell. The script validates a staged complete package, rejects symlinked or out-of-scope workflow paths observed during its checks, and atomically publishes the staged package directory without overwriting a non-empty target. The physical paths must remain stable while the helper runs; stop if another process may be replacing `.agents` or its parent directories. If the target exists, stop; never replace, merge, truncate, rename, or delete it.
4. Delete both private candidate files after publication or failure. The publisher removes its staged package on every path.
5. Do not invoke `kilin run`, `kilin rerun`, Codex, Claude Code, OpenCode, another model, or any network service. Generation authors and validates; it never executes a workflow.
6. After publication, make `node <resolved-kilin-cli> workflow validate <id> --scope <selected-scope> --cwd <absolute-project-root> --json` the last operation. Explicit scope prevents a same-ID project package from hiding a newly published user package. If validation fails, report the failure without changing the published package. The final operation must be successful validation, not a run or prose-only inspection.

Report the selected scope, package directory, both created files, assumptions made, validation `contentHash`, deterministic `executionOrder`, each node kind, every agent's effective access/output and input bindings, and every approval question. If a project package with the same ID shadows a user package from the current working directory, report that precedence explicitly. For a loop, also report its bound, pass/revise rule, feedback consumer, result node, and compiled execution count. Do not claim the workflow was run.
