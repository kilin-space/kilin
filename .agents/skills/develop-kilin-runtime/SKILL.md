---
name: develop-kilin-runtime
description: Plan, implement, debug, or review Kilin CLI runtime behavior across domain, application, infrastructure, and CLI layers. Use this skill whenever work changes workflow execution, scheduling, run lifecycle, approvals, cancellation, recovery, workspaces, persistence use cases, or CLI orchestration. Do not use it for Viewer-only presentation work, documentation-only edits, provider-adapter-only maintenance, or a change whose main purpose is to evolve a public or persisted contract.
compatibility: Requires the Kilin repository, Node.js 24 or newer, pnpm 11.4.0, and Git.
---

# Develop Kilin runtime behavior

Change Kilin runtime behavior without weakening its deterministic local execution model or mixing
domain, infrastructure, and presentation concerns.

## Establish the change boundary

1. Confirm the physical repository root, current branch, and working-tree state. Preserve unrelated
   changes.
2. Read `AGENTS.md` and `packages/cli/docs/agents/system-design.md` completely.
3. Read only the V1 contracts affected by the requested behavior:
   - `packages/cli/docs/v1/architecture.md` for lifecycle, scheduling, locking, and persistence;
   - `packages/cli/docs/v1/workflow.md` and `bounded-feedback.md` for graph semantics;
   - `packages/cli/docs/v1/runtime.md` for process execution;
   - `packages/cli/docs/v1/cli.md` for command behavior;
   - `packages/cli/docs/v1/testing.md` for observable contracts.
4. Reproduce a non-trivial defect before fixing it. Treat the first root-cause theory as tentative.
5. Classify the change risk. Present a scoped plan before medium- or high-risk mutation unless the
   user has already approved implementation.

If the primary change affects the workflow schema, SQLite shape, lifecycle vocabulary, public
JSON or JSON Lines, exit codes, or a Viewer DTO, use `evolve-kilin-contract` instead.

## Map ownership before editing

Assign each behavior to its narrowest owner:

- `src/domain/`: pure workflow rules, state transitions, compilation, and value types;
- `src/application/`: use cases, scheduling, lifecycle coordination, and ports;
- `src/infrastructure/`: SQLite, files, subprocesses, locks, runtime adapters, and HTTP;
- `src/cli/`: argument parsing and human or machine rendering;
- `src/ui/`: Viewer presentation only.

Do not make the domain import I/O. Do not make the application import concrete infrastructure.
Keep concrete wiring at the composition boundary. Add an interface only for an external boundary or
multiple real implementations.

Before implementation, record the likely effects on:

- durable state and transaction order;
- workspace ownership and process lifetime;
- JSON or JSON Lines output;
- security and secret exposure;
- Viewer projections;
- public and internal documentation;
- existing runs, reruns, retries, and recovery.

## Implement the smallest complete behavior

1. For a bug, add the smallest failing behavior test when the contract can be automated.
2. Change the domain rule before adapting higher layers when the behavior is a domain rule.
3. Preserve fail-closed validation and deterministic ordering.
4. Keep the foreground CLI as the execution owner. Do not add daemons, queues, dynamic plugins,
   generic schedulers, or speculative extension points.
5. Preserve immutable stored revisions and explicit workspace ownership.
6. Treat workflow content, provider output, paths, and persisted rows as untrusted at their
   boundaries.
7. Do not add backward-compatibility handling unless a current documented contract requires it.
8. Update every source, test, and contract document made stale by the change.

## Test the real contract

Use tests that can fail when the requested behavior is broken:

- domain tests for validation, compilation, ordering, and transitions;
- application tests for lifecycle, scheduling, cancellation, and recovery;
- infrastructure tests with real temporary SQLite, files, locks, and fake processes;
- CLI tests for exact output, diagnostics, exit behavior, and side-effect boundaries;
- Playwright only when Viewer-observable behavior changes.

Automated tests must use fake provider runtimes and temporary Kilin data roots. They must not call
models or write normal `~/.kilin` state.

Run the narrowest useful check first. Use the repository root and the Node.js 24 toolchain:

```bash
pnpm turbo run test --filter=@kilin-space/cli
pnpm lint
pnpm typecheck
```

Run `pnpm verify` before declaring a pull-request-ready change. Real-provider qualification is
explicit, opt-in, and separate from ordinary verification.

## Review and report

Review the final diff for layer violations, unnecessary abstraction, stale docs, and tests that
assert implementation shape.

Report:

1. the reproduced behavior or accepted requirement;
2. the owning layer and changed files;
3. state, security, CLI, Viewer, and documentation impact;
4. tests and commands run, with results;
5. unresolved risks or checks not run.

Do not claim release readiness from focused tests alone.
