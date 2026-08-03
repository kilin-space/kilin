# Changelog

All notable changes to `@kilin-space/cli` are documented here.

## Unreleased

- Retry `NODE_OUTPUT_INVALID` once by default for `read_only` agents with a declared output, so
  one serialization slip no longer fails the whole run; an authored `retry` replaces the default
  (#28).
- State the required wire shape for `choice` and `json` outputs in the injected output contract
  and in the choice JSON-parse failure message (#28).
- Open the Viewer on the most relevant stored run — waiting for approval first, then running,
  then the newest finished run — and select the node that explains the run status; with no stored
  runs the definition view is unchanged (#14, #15).
- Persist the selected Viewer run, node, stream, and rendered/raw view in the URL hash and
  restore them after a reload; a stale hash run id falls back to the default selection without an
  error state (#22).
- Surface a pending approval in the Viewer: a decision-needed banner beside the connection
  status with a live deadline countdown that selects the waiting gate and focuses the decision
  dock, a waiting label and glyph on run history and lineage rows, and live-region announcements
  for waiting-state transitions (#16).
- Add the derived `waitingForApproval` flag to the Viewer run summary, which also delivers the
  documented waiting-first initial selection (#16).

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
