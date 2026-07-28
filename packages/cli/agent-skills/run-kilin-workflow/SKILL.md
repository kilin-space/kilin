---
name: run-kilin-workflow
description: Run an existing Kilin workflow under an outer agent, supervise its JSON lifecycle, start its attached local Viewer, and return the run identity and Viewer access to the requester. Use when the user asks an agent to execute or run a Kilin workflow; do not use to author a workflow or discover candidates from history.
---

# Run a Kilin workflow

Run one existing workflow from an exact physical working directory. Keep the Kilin run and Viewer
as separate attached processes: the run owns provider execution, while the Viewer only presents the
compiled graph and local history.

## Resolve the invocation

1. Resolve the physical working directory and the requested workflow ID. Do not substitute a
   similarly named directory or workflow.
2. Resolve this skill's physical directory from the `SKILL.md` path supplied by the skill loader.
   The Kilin package root is exactly two directories above it, and the matching built CLI is
   `dist/cli/main.js` beneath that root. Stop and report an invalid or incomplete installation if
   either path cannot be resolved.
3. Run `node <resolved-kilin-cli> workflow validate <id> --cwd <absolute-cwd> --json`. Do not pass
   `--scope`: validation must select the same project-over-user package that `kilin run` will use.
4. Run `node <resolved-kilin-cli> workflow list --cwd <absolute-cwd> --json`, locate the visible
   package, and read its sibling
   `WORKFLOW.yaml` only to identify declared run parameters. Ask for every missing required value;
   do not invent values. Warn that `--param` values can appear in shell history and process lists,
   and never request a secret through that flag.
5. Preserve caller-supplied timeout, output, concurrency, and parameter choices. Otherwise use the
   CLI defaults. Do not add retries, continuations, or approvals that the user did not request.

## Start the Viewer

1. Start
   `node <resolved-kilin-cli> ui <id> --cwd <absolute-cwd> --no-open --json`
   as a managed long-running local process when the agent environment can keep that process alive
   and its numeric `127.0.0.1` is reachable from the requesting human's browser.
2. Read exactly one `viewer.started` document, retain the process handle, and confirm the process
   has not exited. Return its exact `url` directly to the requester. State that the launch
   credential can be redeemed once and never outlives this Viewer process; after redemption, the
   browser session remains usable while the process lives.
3. Treat the fragment-bearing URL as a credential. Do not open or consume it, repeat it into a
   workflow prompt, persist it, place it in an artifact, issue, pull request, public log, or run
   event, or send it to anyone other than the requester.
4. If the Viewer cannot start, continue with the requested run and report the Viewer failure
   separately. Provide the exact manual command above without claiming that a URL exists.
5. If the agent runs on another machine or inside a remote container, do not claim its loopback URL
   is user-accessible. Give the requester
   `kilin ui <id> --cwd <requester-local-project> --no-open --json`, using their local project path
   rather than any agent-host path. Ask for the local path mapping when it is unknown. Explain that
   a local Viewer can show the same history only when it can access the same Kilin data.

## Run and supervise

1. Start `node <resolved-kilin-cli> run <id> --cwd <absolute-cwd> ... --json` without a shell. Read
   the JSON Lines stream, retain the `runId` from `run.started`, and branch on event `type` and error
   `code`, never on prose.
2. Keep the run attached until it reaches a terminal state. Use `runs wait <run-id> --json` only
   when supervision must continue from a separate local process.
3. On `approval.requested`, preserve and present the exact question. Never approve or reject by
   inference. Let the requester decide in the Viewer, or set the decision target to `executionId`
   when the event includes one and otherwise to `nodeId`. When relaying the requester's explicit
   decision, use either
   `node <resolved-kilin-cli> runs approve <run-id> <decision-target> --actor human --json` or
   `node <resolved-kilin-cli> runs reject <run-id> <decision-target> --actor human --json`.
4. Do not treat graph completion as proof of user satisfaction or workflow quality. Do not retry,
   resume, rerun, cancel, or stop the Viewer unless the requester asks or the current run contract
   requires cancellation after an interrupted outer-agent session.

## Report and lifecycle

Report the resolved workflow ID and scope, canonical working directory, `runId`, terminal status,
failure code when present, relevant recorded output paths, and whether the Viewer is still alive.
Keep a successfully started Viewer alive after run success or failure until the requester asks to
stop it, the agent host session ends, or the process exits unexpectedly. Report run and Viewer
outcomes independently; never describe one as successful evidence for the other.
