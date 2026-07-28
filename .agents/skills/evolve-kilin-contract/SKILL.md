---
name: evolve-kilin-contract
description: Design, implement, or review a Kilin public or persisted contract change. Use this skill whenever work changes WORKFLOW.yaml schema, compiled semantics, SQLite schema or decoding, lifecycle states, public JSON or JSON Lines, CLI flags or exit behavior, runtime adapter contracts, output versions, or Viewer DTOs. This skill takes precedence over develop-kilin-runtime and develop-kilin-viewer when the main risk is contract evolution.
compatibility: Requires the Kilin repository, Node.js 24 or newer, pnpm 11.4.0, and Git.
---

# Evolve a Kilin contract

Change a versioned, public, or persisted contract deliberately. Make ownership, compatibility,
failure behavior, and verification explicit before editing code.

## Identify the contract owner

1. Confirm the repository root, branch, working-tree state, and exact requested behavior.
2. Read `AGENTS.md` and `packages/cli/docs/agents/system-design.md`.
3. Locate the current canonical owner:
   - workflow authoring: `src/domain/workflow.ts`, `compile-workflow.ts`, and
     `src/infrastructure/workflow-v1.schema.json`;
   - run lifecycle: `src/domain/run-state.ts` and `src/application/run-events.ts`;
   - persisted state: `src/infrastructure/state-schema.ts`, `state-store.ts`, and
     `state-record-decoder.ts`;
   - CLI surface: `src/cli/arguments.ts`, rendering, and `docs/v1/cli.md`;
   - runtime boundary: application runtime ports, infrastructure adapters, and
     `docs/v1/runtime.md`;
   - Viewer output: `src/ui/contracts.ts` and application Viewer projections;
   - package surface: `packages/cli/package.json` and package-artifact checks.
4. Read the matching V1 design, decision, and testing documents completely.

Do not infer the contract from one consumer or one test. Trace every producer, persistence point,
consumer, renderer, and document.

## Produce an impact decision before mutation

Record:

- the old and proposed shapes or behaviors;
- whether the contract is public, persisted, versioned, or internal;
- affected producers and consumers;
- validation and fail-closed behavior;
- compatibility or migration requirement;
- security and privacy effects;
- version, documentation, package, and release effects;
- a focused verification matrix.

Treat contract work as medium risk unless it affects authentication, authorization, deletion,
release authority, or destructive migration, which is high risk. Present the plan and wait for
approval unless the user already authorized implementation.

Kilin does not add backward-compatibility handling by default. Add it only when a current supported
contract requires it. Do not create a new version only to avoid making a clear pre-release contract
decision. Do not mutate or silently accept malformed, historical, future, or tampered state unless
an approved migration contract requires that behavior.

## Implement one coherent contract

1. Change the canonical domain or schema owner first.
2. Validate external data as `unknown` at its boundary and decode it into precise internal types.
3. Keep schema, semantic validation, normalization, compilation, persistence, and rendering
   responsibilities separate.
4. Preserve deterministic normalization, content hashing, execution ordering, and error paths.
5. Preserve exact machine-output rules: document commands emit one JSON document; run streams emit
   the closed JSON Lines event union.
6. Preserve secret and private-data exclusions.
7. Update every producer and consumer in the same change. Do not leave dual shapes or unused
   compatibility paths.
8. Update internal contracts, public documentation, examples, changelog entries, and package
   assertions made stale by the change.

For persisted-state changes, define transaction ordering, partial-failure behavior, concurrency
control, old-state handling, and tamper handling. Never perform destructive migration without
explicit authorization and recovery evidence.

## Verify the contract end to end

Tests must prove observable behavior, not the presence of schema text or helper names.

Include applicable coverage for:

- valid and hostile invalid inputs;
- lowest canonical error paths and stable codes;
- normalization and deterministic identity;
- persistence round trips and state decoding;
- old, future, partial, and tampered state behavior;
- CLI human and machine output;
- Viewer projection and browser behavior;
- documentation examples and package contents.

Use fake runtimes, temporary SQLite databases, temporary files, and temporary Kilin data roots.
Run focused tests before the full gate:

```bash
pnpm turbo run test --filter=@kilin-space/cli
pnpm lint
pnpm typecheck
pnpm verify
```

Real-model qualification remains explicit and separate. Do not run it without authorization for
model calls.

## Review and report

Report:

1. the contract owner and before-and-after behavior;
2. the compatibility or migration decision and why;
3. all producers, persistence points, consumers, and docs updated;
4. security, privacy, and failure behavior;
5. verification commands and results;
6. residual risks, unsupported old states, or checks not run.
