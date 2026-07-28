# Contributing to Kilin

Thanks for your interest in Kilin. This page covers local setup and the checks a change has to
pass. Repository conventions — layer boundaries, naming, testing rules, commit style — live in
[AGENTS.md](AGENTS.md).

## Repository layout

```text
kilin/
├── apps/
│   └── docs/          Next.js and Fumadocs site published at docs.kilin.space
├── packages/
│   └── cli/           @kilin-space/cli, the kilin executable, and its agent-skills/ assets
├── turbo.json
└── pnpm-workspace.yaml
```

The documentation app is intentionally independent of the CLI package. It does not import the CLI
or bundle the CLI's Node.js and native runtime dependencies.

## Prerequisites

- Node.js 24 or newer.
- pnpm 11.4.0. The version is pinned by `packageManager`, so Corepack will select it for you.

## Setup

```bash
git clone https://github.com/kilin-space/kilin.git
cd kilin
pnpm install
```

`pnpm install` points `core.hooksPath` at `.githooks`, whose pre-commit hook runs `format:check`,
`lint`, and `typecheck`.

## Everyday commands

```bash
pnpm dev               # run the documentation site
pnpm dev:cli --help    # run the CLI from TypeScript
pnpm build             # build every workspace
pnpm format            # apply Prettier formatting
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e          # CLI browser tests
```

`pnpm dev:cli ui` serves the built viewer client from `dist/ui/client.js`, so run
`pnpm --filter @kilin-space/cli build` first and after every `src/ui/client.ts` edit. Without a
build the command reports the missing asset and names this build step.

Browser tests need a local browser:

```bash
pnpm --filter @kilin-space/cli exec playwright install --with-deps chromium
```

Turbo tasks carry prerequisites (`test` needs `build`, `test:e2e` needs `test`), so scope work with
filters rather than package scripts:

```bash
pnpm turbo run test --filter=@kilin-space/cli
```

## Before opening a pull request

```bash
pnpm verify
```

`pnpm verify` is the complete gate: formatting, linting, types, unit and browser behavior, the
documentation links, and the installed npm-package contract. CI runs it on every pull request.

Automated tests use fake provider runtimes and temporary data roots. They never call a model and
never write normal `~/.kilin` state.

## Pull requests

Follow Conventional Commits (`feat(viewer): ...`, `fix: ...`, `docs: ...`) and keep commits focused.
A pull request should explain the behavior and boundaries it changes, link the relevant issue or
decision, list the verification commands you ran, and include screenshots for visible Viewer
changes. Call out security, state-format, or runtime-contract impacts explicitly.

Documentation changes must keep the locales in parity: `apps/docs` tests assert identical routes
and `meta.json` entries across `en`, `zh-cn`, and `zh-tw`, and exercise search in each locale.

## Where things live

- User documentation: `apps/docs/content/docs/<locale>/`
- Internal contracts and design decisions: `packages/cli/docs/`
- Published agent skills: `packages/cli/agent-skills/`

Read `packages/cli/docs/agents/system-design.md` before changing architecture or workflow-runtime
behavior.

Maintainer release and deployment steps are in [RELEASING.md](RELEASING.md).
