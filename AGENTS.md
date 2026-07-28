# Repository Guidelines

## Project Structure & Module Organization

This pnpm/Turbo monorepo has two workspaces. `packages/cli` contains the published CLI:
business rules live in `src/domain`, use cases in `src/application`, external adapters in
`src/infrastructure`, and presentation code in `src/cli` and `src/ui`. Keep these layers separate.
CLI tests mirror this structure under `packages/cli/test`; browser tests are in
`packages/cli/e2e`, and packaged workflow skills are in `packages/cli/agent-skills`.

Dependencies point inward: `cli` and `ui` depend on `application`, which depends on `domain`.
`application` orchestrates through ports and never imports `infrastructure`. The viewer client
`src/ui/client.ts` is one self-contained file that the CLI serves from `dist/ui/client.js`—the
package `tsc` build emits it, and there is no bundler and no separate frontend build.
Read `packages/cli/docs/agents/system-design.md` before you change architecture or workflow-runtime
behavior.

`apps/docs` is the independent Next.js documentation site. Localized content is under
`apps/docs/content/docs/{en,zh-cn,zh-tw}`, and static assets are in `apps/docs/public`. The docs
app must not import `@kilin-space/cli`.

Repository agent skills are in `.agents/skills/`, symlinked into `.claude/skills/`. They cover
runtime, Viewer, contract, and public-documentation work.

## Build, Test, and Development Commands

Use Node.js 24 or newer and pnpm 11.4.0.

- `pnpm install` installs all workspaces and configures repository Git hooks.
- `pnpm dev` starts the documentation site; `pnpm dev:cli --help` runs the CLI from TypeScript.
  `pnpm dev:cli ui` serves the built viewer client, so run `pnpm --filter @kilin-space/cli build`
  first and after every `src/ui/client.ts` edit.
- `pnpm build` builds all workspaces.
- `pnpm format` applies Prettier changes. Use `pnpm format:check`, `pnpm lint`, `pnpm typecheck`,
  and `pnpm test` for focused quality checks.
- `pnpm verify` runs the full pull-request gate, including E2E and package checks.
- `pnpm turbo run test --filter=@kilin-space/cli` scopes a Turbo task to the CLI.

Turbo tasks carry prerequisites (`test` needs `build`, `test:e2e` needs `test`, `pack:check` needs
`test:e2e`), so scope work with `turbo run --filter`; a package script can test a stale `dist/`.
Browser tests need a local browser—install it with
`pnpm --filter @kilin-space/cli exec playwright install --with-deps chromium`. Playwright writes
results to `/tmp/kilin/playwright-results`, outside the repository. The `.githooks/pre-commit` hook
runs `format:check`, `lint`, and `typecheck`.

Pin new dependencies to exact versions. `pnpm-workspace.yaml` sets `minimumReleaseAge` to 24 hours,
so a freshly published version is rejected until it ages, and any package that needs install
scripts requires an explicit `allowBuilds` entry.

## Coding Style & Naming Conventions

Write ESM TypeScript with two-space indentation. Prettier enforces a 100-column width. ESLint uses
strict type-aware rules; use explicit return types, type-only imports, and precise domain types
instead of `any`. Use kebab-case file names such as `run-state.ts` and clear domain names. Do not
add dead code, TODOs, speculative abstractions, or compatibility paths without a current contract.

## Testing Guidelines

Vitest tests use `*.test.ts`; Playwright tests use `*.spec.ts`. No numeric coverage threshold is
configured, so each change must add focused coverage for its behavior, data, security, or public
API contract. Prefer public interfaces over private implementation details. Bug fixes should start
with the smallest meaningful failing test. Tests must use fake provider runtimes and temporary
data roots; do not call real models or write normal `~/.kilin` state. Keep all documentation
locales in route and metadata parity.

## Packaging & Release

`packages/cli` publishes as `@kilin-space/cli`. When adding a shipped package-root asset, update
both the `files` allowlist in `packages/cli/package.json` and `PACKAGE_ROOT_FILES` in
`packages/cli/scripts/package-artifact.mjs`, then run `pnpm turbo run pack:check`.

Real-model qualification is manual and opt-in
(`pnpm --filter @kilin-space/cli qualify:release -- --allow-model-call`). Never add it to
`pnpm verify` or CI, and do not run it without explicit authorization for model calls.

Release with a `cli-v<version>` GitHub tag that matches `packages/cli/package.json`, and record
user-visible changes in `packages/cli/CHANGELOG.md`.

## Commit & Pull Request Guidelines

Follow Conventional Commits, for example `feat(cli): add ...`, `fix(viewer): correct ...`, or
`docs: clarify ...`. Keep commits focused. Pull requests must describe changed behavior and
boundaries, link the relevant issue or decision, list verification commands, and include
screenshots for visible Viewer changes. State any security, persisted-state, or runtime-contract
impact explicitly. Per-path review expectations are encoded in `.coderabbit.yaml`.
