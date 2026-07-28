# Agent runtime CLI references

This directory records the evidence used to constrain Kilin V1 local agent runtime adapters. It
separates upstream documentation from the exact command surfaces installed during the
investigation.

Observed on 2026-07-21. No model was invoked.

| Runtime | Installed version | Headless command | Official snapshots | Installed help |
|---|---|---|---|---|
| Codex | `codex-cli 0.144.6` | `codex exec` | [`official/codex`](official/codex/) | [`codex-0.144.6-help.txt`](installed-help/codex-0.144.6-help.txt), [`codex-0.144.6-exec-help.txt`](installed-help/codex-0.144.6-exec-help.txt) |
| Claude Code | `2.1.215` | `claude -p` | [`official/claude-code`](official/claude-code/) | [`claude-code-2.1.215-help.txt`](installed-help/claude-code-2.1.215-help.txt) |
| OpenCode | `1.18.4` | `opencode run` | [`official/opencode`](official/opencode/) | [`opencode-1.18.4-help.txt`](installed-help/opencode-1.18.4-help.txt), [`opencode-1.18.4-run-help.txt`](installed-help/opencode-1.18.4-run-help.txt) |

The OpenCode snapshots are pinned to upstream commit [`849c2598abc7d2b40261e74b5826bc74ffc78308`](https://github.com/anomalyco/opencode/commit/849c2598abc7d2b40261e74b5826bc74ffc78308). Its [`run.ts` source](official/opencode/opencode-run-source.txt) is stored as a text snapshot because stdin prompt handling is implemented in the current command but is not documented as a stable CLI contract. The upstream MIT license is stored beside the snapshots.

The Codex and Claude Code snapshots were retrieved from these official pages:

- Codex: [developer commands](https://learn.chatgpt.com/docs/developer-commands) and [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- Claude Code: [CLI reference](https://code.claude.com/docs/en/cli-usage), [headless mode](https://code.claude.com/docs/en/headless), [permissions](https://code.claude.com/docs/en/permissions), [permission modes](https://code.claude.com/docs/en/permission-modes), and [sandboxing](https://code.claude.com/docs/en/sandboxing)
- OpenCode: [CLI](https://opencode.ai/docs/cli/), [permissions](https://opencode.ai/docs/permissions/), and [agents](https://opencode.ai/docs/agents/)

The design interpretation and flag ownership rules are in [`flag-matrix.md`](flag-matrix.md). Upstream docs describe the current products; the installed help snapshots are the executable capability evidence for Kilin's narrow supported version ranges.
