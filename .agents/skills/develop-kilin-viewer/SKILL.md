---
name: develop-kilin-viewer
description: Plan, implement, debug, or review the Kilin local Viewer UI, including graph and evidence presentation, interactions, accessibility, responsive behavior, approval decisions, and browser tests. Use this skill whenever work touches packages/cli/src/ui, Viewer projections or routes, or visible Viewer behavior. Do not use it for the Fumadocs site, CLI-only rendering, or a change whose main purpose is to evolve a public Viewer DTO or another versioned contract.
compatibility: Requires the Kilin repository, Node.js 24 or newer, pnpm 11.4.0, and Playwright for browser verification.
---

# Develop the Kilin Viewer

Change the attached local Viewer while preserving its self-contained delivery model, evidence
security, and accessible interaction contracts.

## Establish the Viewer boundary

1. Confirm the repository root, current branch, and working-tree state. Preserve unrelated changes.
2. Read `AGENTS.md`, `packages/cli/docs/agents/system-design.md`, and the Viewer sections of:
   - `packages/cli/docs/v1/architecture.md`;
   - `packages/cli/docs/v1/cli.md`;
   - `packages/cli/docs/v1/decisions.md`;
   - `packages/cli/docs/v1/testing.md`.
3. Inspect `packages/cli/src/ui/contracts.ts`, `client.ts`, and `assets.ts` before proposing a UI
   change.
4. Inspect `packages/cli/src/application/viewer.ts` and
   `packages/cli/src/infrastructure/viewer-server.ts` when data or route behavior is involved.
5. Reproduce interaction or rendering defects in a browser when practical.

If the main change alters a versioned DTO, lifecycle vocabulary, stored state, or public command
contract, use `evolve-kilin-contract` instead.

## Preserve the delivery architecture

The Viewer is static HTML, CSS, and a no-framework DOM client served by the CLI:

- keep `client.ts` and `assets.ts` self-contained;
- do not add a bundler, frontend workspace, framework, or browser build;
- treat `contracts.ts` as the presentation DTO boundary;
- keep application projection logic outside the DOM client;
- do not make the Viewer start runs, edit workflows, or become a public API.

The attached Viewer binds numeric loopback and uses a one-use launch credential, a scoped session,
CSRF protection, and bounded reads. Its mutation authority is a closed set of two guarded run-scoped
routes recorded in D-016: an eligible approval decision, and a cancellation request for a run already
in the Viewer's scope. Do not add a third mutation as part of presentation work; a new mutation class
needs its own recorded decision.

## Use the existing visual language

Inspect the current tokens and component patterns before editing. Preserve:

- light evidence surfaces and restrained neutral panels;
- color for semantic state, not decoration;
- readable evidence measures and monospace data where appropriate;
- visible focus treatment and minimum 44 by 44 pixel interactive targets;
- consistent spacing, borders, status chips, and control hierarchy;
- responsive layouts that keep the selected run, graph, evidence, and inspector understandable.

Do not introduce a second token system or copy documentation-site components into the Viewer. When
a requested change needs a new durable design rule, state that rule explicitly and update an
appropriate repository design document if the task authorizes documentation changes.

## Protect untrusted evidence

Provider streams, Markdown-like results, workflow fields, errors, paths, and notes are untrusted.

- Escape content before inserting it into the DOM.
- Do not pass provider HTML through.
- Keep links inert unless a reviewed contract explicitly permits navigation.
- Preserve Content Security Policy and origin, session, CSRF, workflow, cwd, run, node, and file
  scoping.
- Use hostile input and unauthorized actors in security tests.
- Do not expose credentials, environment values, prompts, cookies, or private output in diagnostics.

## Build accessible interactions

1. Use native elements and correct names, roles, states, and relationships.
2. Preserve keyboard navigation, focus after refresh or selection changes, and a visible focus ring.
3. Announce connection, copy, approval, and error state changes through an appropriate live region.
4. Provide a non-visual equivalent for graph structure and execution order.
5. Respect `prefers-reduced-motion`.
6. Do not encode node kind or status through color alone.
7. Test loading, empty, running, waiting, failed, interrupted, and completed states affected by the
   change.

## Verify behavior and appearance

Use the narrowest layer that protects each contract:

- application tests for projections;
- server tests for scope, session, CSRF, and route behavior;
- Playwright for browser interaction, accessibility behavior, hostile rendering, responsive layout,
  and visible state.

Run focused tests first, then:

```bash
pnpm turbo run test --filter=@kilin-space/cli
pnpm --filter @kilin-space/cli test:e2e
pnpm lint
pnpm typecheck
```

Run `pnpm verify` before declaring the change pull-request ready. For a visible change, inspect the
running Viewer at representative desktop and narrow widths and retain screenshots outside the
repository.

## Review and report

Report:

1. the changed user journey and states;
2. the affected DTO, application, server, client, and style boundaries;
3. accessibility and security behavior verified;
4. browser sizes and screenshots used for visual verification;
5. test commands and results;
6. unresolved risks or checks not run.
