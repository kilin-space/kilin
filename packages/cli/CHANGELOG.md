# Changelog

All notable changes to `@kilin-space/cli` are documented here.

## Unreleased

- Write an approval note across several lines: the Viewer decision dock now offers a four-row text
  area where Enter starts a new line, and Approve and Reject remain the only submit path. The
  1000-character limit is unchanged, a background refresh no longer moves the caret to the end of
  the note, and the recorded decision keeps the note's line breaks (#21).
- Expand the Viewer graph strip when a workflow has more parallel branches than the short default
  viewport can show. An Expand control beside the workflow status raises the graph height cap to
  roughly 70% of the viewport height, works from the keyboard, keeps its state across polls, and
  honours `prefers-reduced-motion`. It appears only while the graph is taller than the strip
  (#23).

- State Viewer status in plain words: the steady connection reads `Live` instead of naming the
  attachment and approval guard, and the definition chip reads `Definition valid` or
  `Definition invalid` instead of a bare lowercase state (#17).
- Show how long ago each stored run started — `3 min ago`, `2 days ago` — in run history, with the
  exact timestamp on hover and in the row's accessible name. A finished run keeps its fixed
  duration and never ages (#18).
- Remove noise from run details: the lineage section stays hidden for a run with no ancestry, run
  history rows show a short run id while the copy button still yields the whole id, and the
  truncated content hash is labelled `Revision (content hash)` (#20).
- Offer a copyable `kilin runs cancel <run-id>` command in the Viewer run inspector while a run is
  running and no cancellation is recorded yet. It is presentation only, and it disappears once a
  cancellation is requested or the run reaches a terminal state (#24).
- Recover from a failed Viewer evidence read without reselecting the node: the error state now
  carries a Retry control that re-requests the stream. A Refresh control in the top bar runs a
  poll cycle at once, restarts the backoff, and re-requests a failed evidence read (#19).
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
