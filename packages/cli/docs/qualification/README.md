# Release qualification

This directory is the canonical source for release-artifact and authenticated-runtime
qualification. Package, product, runtime, and testing documents link here instead of copying a
mutable result.

## Current status

The [2026-07-27 macOS arm64 record](./2026-07-27-macos-arm64.json) qualifies evaluator commit
`fcb7b8fc013495a3a3e41f2c4faa35ece88f19e9` from baseline
`3bf8144cfdbc729d4a957e0cd2f7092eb840709a`.

- Package: `@kilin-space/cli@0.1.0`
- Tarball SHA-256: `76832c4032fdd24cbae31bb8532c589cc3b9335ee74892f6591e8cd9487d200e`
- Toolchain: Node 24.12.0, pnpm 11.4.0, npm 11.6.2
- Runtimes: Codex CLI 0.145.0, Claude Code 2.1.220, OpenCode 1.18.5
- Authenticated calls: five using provider-default models

The retained tarball passed deterministic global-install checks, preflight redaction, the mixed
authenticated workflow, authored timeout, cancellation, durable-state, containment, and descendant
cleanup checks. The mixed workflow also proved that project-local legacy Codex sandbox
configuration cannot replace the adapter-owned permission profile. Its SHA-256 remained identical
after evidence was written.

Process cleanup snapshots the provider process tree before termination and targets the captured
processes in addition to the provider process group. Delayed individual signals require a stable
process-start identity. Linux uses kernel start ticks; macOS exposes only whole-second start times
and therefore declines delayed individual signals after the original leader exits. A
TERM-resistant descendant that detaches or forks after the snapshot is outside the macOS
foreground-executor guarantee.

## Evidence policy

A dated JSON record identifies the baseline commit, package name and version, tarball filename and
SHA-256, platform, Node/pnpm/npm and provider CLI versions, default-model selection, sanitized
commands, scenario results, model-call count, and known limitations.

Records exclude prompts, raw provider streams, credentials, account identity, environment values,
provider session identifiers, and temporary absolute paths. Deterministic tests and CLI
capability probes are not substitutes for authenticated model execution. The model-call count
describes the retained passing qualification, not failed development or diagnostic attempts.
The evaluator commit and evaluator-script hashes are the reproducible evidence identity; local
actor and run identifiers are intentionally excluded.
