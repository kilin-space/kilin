# Changelog

All notable changes to `@kilin-space/cli` are documented here.

## Unreleased

- Open the Viewer on the most relevant stored run — waiting for approval first, then running,
  then the newest finished run — and select the node that explains the run status; with no stored
  runs the definition view is unchanged (#14, #15).
- Persist the selected Viewer run, node, stream, and rendered/raw view in the URL hash and
  restore them after a reload; a stale hash run id falls back to the default selection without an
  error state (#22).

## 0.1.0

- Establish the V1 workflow schema and the initial `0.1.0` package contract.
- Include fixed Codex, Claude Code, and OpenCode adapters; typed outputs; approval gates; bounded
  parallel reads and retry; continuation recovery; named workspaces; run parameters; host-owned
  triggers; and one bounded feedback loop.
- Add authored agent timeouts and an independent persisted approval deadline.
- Include Decision Packet V1, the authenticated local Viewer with machine-readable startup,
  exact-scope validation and generation, and packaged workflow discovery, generation, and
  execution skills.
- Qualify the exact globally installed package artifact with deterministic and opt-in authenticated
  runtime scenarios.
- Add `kilin skills link`, `kilin skills status`, and first-run skill-link setup for Codex/Agents
  and Claude Code provider directories.
