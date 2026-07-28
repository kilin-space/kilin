---
name: maintain-kilin-public-docs
description: Create, update, or review Kilin public documentation in README files, package docs, and the localized Fumadocs site. Use this skill whenever a change affects apps/docs/content/docs, public command examples, configuration, workflow behavior, monitoring, troubleshooting, or security claims. Require source-backed accuracy and English, Simplified Chinese, and Traditional Chinese route parity. Do not use it for internal design documents only or for implementing the underlying CLI behavior.
compatibility: Requires the Kilin repository, Node.js 24 or newer, and pnpm 11.4.0.
---

# Maintain Kilin public documentation

Keep public documentation accurate to the current repository behavior and consistent across English,
Simplified Chinese, and Traditional Chinese.

## Establish the documentation contract

1. Confirm the repository root, branch, and working-tree state. Preserve unrelated changes.
2. Read `AGENTS.md`, `CONTRIBUTING.md`, and the source or internal V1 contract that owns the
   documented behavior.
3. Identify every public surface affected:
   - root `README.md`;
   - `packages/cli/README.md`;
   - `apps/docs/content/docs/{en,zh-cn,zh-tw}/`;
   - `packages/cli/CHANGELOG.md` for user-visible released-package changes;
   - command help or examples when the implementation is in scope.
4. Run or inspect the current CLI rather than copying stale examples. Distinguish source-checkout
   commands from globally installed CLI commands.
5. Do not present an unimplemented design, dirty working-tree experiment, or historical result as
   current product behavior.

## Keep one meaning across three locales

For every localized route:

- keep the same route set and matching `meta.json` entries;
- preserve command names, flags, identifiers, schema fields, error codes, and file names exactly;
- preserve security requirements and limitations without softening them in translation;
- adapt prose naturally for each locale instead of translating word by word;
- keep examples semantically equivalent;
- update cross-links when a route or heading changes.

If one locale cannot state the same supported behavior, stop and resolve the source-contract
ambiguity. Do not publish asymmetric promises.

## Preserve the docs application boundary

The Fumadocs site is independent of `@kilin-space/cli`:

- do not import the CLI package or its Node.js and native dependencies;
- preserve server and client component boundaries;
- do not expose secrets, environment values, private paths, or unsafe HTML;
- check metadata, sitemap, robots, navigation, search, and canonical public routes when relevant;
- do not add a new abstraction for one page or component.

Public documentation explains supported behavior and trust boundaries. It does not expose private
implementation details unless they are necessary for a user decision.

## Write verifiable instructions

1. Use commands that work from the stated installation context.
2. State prerequisites before the command that needs them.
3. Describe observable outcomes, not internal helper names.
4. Keep JSON and YAML examples valid and aligned with the current schema.
5. State destructive effects, credential exposure, network use, model calls, and local-only
   boundaries before users encounter them.
6. Link to one canonical owner for mutable qualification or release status instead of copying it.
7. Keep troubleshooting steps diagnostic and reproducible.

## Verify the documentation

Run the documentation checks with Node.js 24:

```bash
pnpm --filter @kilin-space/docs test
pnpm --filter @kilin-space/docs lint
pnpm --filter @kilin-space/docs typecheck
pnpm --filter @kilin-space/docs build
```

For command or schema examples, also run the narrow CLI validation or test that proves the example.
Run `pnpm verify` before declaring a repository-wide or pull-request-ready change.

Inspect representative pages in all three locales when layout, navigation, search, or rendering
changes. Check narrow and desktop widths for visible documentation-site changes.

## Review and report

Report:

1. the source contract used to verify the content;
2. routes and public files changed;
3. how locale parity was maintained;
4. commands or examples checked against live behavior;
5. documentation checks and results;
6. screenshots for visible changes;
7. unresolved ambiguity or checks not run.
