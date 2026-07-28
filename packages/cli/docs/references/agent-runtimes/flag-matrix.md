# Agent runtime CLI flag matrix for V1

## Scope

Kilin V1 starts one local foreground process per agent node. It uses the direct non-interactive
surface of Codex, Claude Code, or OpenCode; it does not use a provider daemon, HTTP server, ACP
server, remote session, or interactive TUI.

The workflow never supplies raw provider arguments, environment variables, settings, permissions, tools, or session identifiers. An adapter owns the complete invocation. The only authored values that may affect provider arguments are `runtime`, `access`, and optional `model`. The engine resolves `prompt`, the canonical run working directory, and the output contract before invoking the adapter.

The tables below describe the flags relevant to this boundary. The installed `--help` snapshots contain the exhaustive command surfaces.

## Common capability map

| Concern | Codex | Claude Code | OpenCode | V1 consequence |
|---|---|---|---|---|
| Non-interactive entry | `codex exec` | `claude -p` | `opencode run` | Fixed by the adapter; not authored. |
| Prompt transport | Documented stdin; `-` explicitly selects it | Documented stdin in print mode | Current `1.18.4` source reads non-TTY stdin, but the public CLI page documents only positional messages | Prompt transport is adapter-specific. OpenCode stdin needs a version contract test and authenticated qualification; it is not assumed from `--help`. |
| Working directory | `-C`, `--cd` | Child process `cwd`; no CLI cwd flag | `--dir` | The canonical working directory remains run-owned. `--add-dir` is never a substitute. |
| Model | `-m`, `--model` | `--model` | `-m`, `--model` in `provider/model` form | `model` remains an opaque provider string. |
| Machine output | `--json` JSONL plus `-o`, `--output-last-message` | `--output-format json` or `stream-json` | `--format json` raw events | Format and final-result extraction are adapter-owned. |
| Provider-native output schema | `--output-schema` | `--json-schema` | None on `run` | Not used. Kilin validates its own `text`, `json`, `decision_packet`, or `artifact` contract after execution. |
| Non-persistent session | `--ephemeral` | `--no-session-persistence` with `-p` | No equivalent documented flag | Kilin never resumes a provider session. OpenCode may retain a local session record. |
| Access control | `default_permissions=:read-only\|:workspace` | Permission mode, tool rules, and separately configured OS sandbox | Tool permission configuration; no documented OS filesystem sandbox | Access support is capability-qualified per adapter; similarly named provider modes are not treated as equivalent. |

## Codex

Recommended command shape, subject to the version probe:

```text
codex --ask-for-approval never \
  --config 'default_permissions="<mapped-profile>"' \
  --config 'projects."<canonical-workspace>".trust_level="untrusted"' \
  exec --ignore-user-config --ignore-rules --json \
  -C <canonical-cwd> --output-last-message <private-path> \
  [--model <model>] [--skip-git-repo-check] --ephemeral -
```

| Flag or surface | Effect | Kilin handling |
|---|---|---|
| `exec` | Runs Codex non-interactively. | Required and fixed. |
| `--json` | Emits JSONL events on stdout. | Required for machine capture. |
| `-o`, `--output-last-message` | Writes the final agent message to a file. | Required; points only to an adapter-owned staging path. |
| `-s`, `--sandbox` | Selects the legacy command sandbox. | Not emitted; the permission profile is the single access authority. |
| `-c default_permissions=...` | Selects the current filesystem and network permission profile. | Maps `read_only` to `:read-only` and `workspace_write` to `:workspace` after user configuration and exec-policy rules are skipped. |
| `-c projects."<workspace>".trust_level="untrusted"` | Prevents project `.codex` configuration, hooks, and rules from loading. | Required so a project-local legacy `sandbox_mode` cannot disable the adapter-owned permission profile. |
| `--ignore-user-config` | Skips `$CODEX_HOME/config.toml` while retaining authentication. | Required so legacy user `sandbox_mode` settings cannot override the adapter-owned permission profile. |
| `--ignore-rules` | Skips user and project exec-policy rules. | Required so ambient rules cannot change subprocess handling for an unattended node. |
| `-C`, `--cd` | Sets the working root. | Maps the canonical run working directory. |
| `-m`, `--model` | Selects the model. | Included only for authored `model`. |
| `--ephemeral` | Avoids persisting rollout/session files. | Required. |
| `--skip-git-repo-check` | Allows execution outside a Git repository. | Added only when preflight established that the working directory is not a Git repository. |
| `-a`, `--ask-for-approval` | Selects `untrusted`, `on-request`, or `never`. | Fixed to `never` before `exec`, so an unattended node cannot prompt for or receive wider access. |
| `--output-schema` | Requests provider-native structured output. | Not used; Kilin owns output validation. |
| `--strict-config` | Changes ambient configuration validation. | Not emitted and never a workflow field. |
| Other `-c`, `--config`, `--profile`, `--enable`, `--disable`, `--oss`, `--local-provider` values | Change provider or runtime configuration. | No authored passthrough. |
| `--add-dir`, `--image`, `--search`, resume/fork/remote surfaces | Widen access, inputs, network capability, or session scope. | Outside V1's node contract. |
| `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, deprecated `--full-auto` | Bypass safety boundaries. | Forbidden. |

## Claude Code

Recommended command shape, subject to access qualification:

```text
spawn cwd=<canonical-cwd> claude -p --input-format text \
  --output-format stream-json --verbose --no-session-persistence \
  --permission-mode <mapped-mode> --settings <Kilin-settings> \
  --safe-mode [--model <model>]
```

| Flag or surface | Effect | Kilin handling |
|---|---|---|
| `-p`, `--print` | Runs one non-interactive request and exits. | Required and fixed. |
| `--input-format text` | Accepts a text request in print mode. | Adapter-owned. The prompt is sent on stdin. |
| `--output-format stream-json` | Returns a JSON event stream. | Required and fixed; the adapter owns parsing. |
| `--verbose` | Enables the complete `stream-json` event contract. | Required and fixed with `stream-json`. |
| `--no-session-persistence` | Prevents saving or resuming the print-mode session. | Required. |
| `--model` | Selects the model. | Included only for authored `model`; `--fallback-model` is not exposed. |
| `--permission-mode` | Selects `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`, or `bypassPermissions`. | Maps `access` only through an adapter-owned, version-qualified permission profile. `auto` and `bypassPermissions` are forbidden. |
| `--settings` | Loads settings from a Kilin-controlled file or JSON value. | Adapter-owned for sandbox and permission settings; arbitrary authored settings are forbidden. |
| `--safe-mode` | Disables ordinary local customizations while preserving authentication, built-in tools, and permissions; managed policy still applies. | Candidate fixed flag that must be included in adapter qualification. |
| `--bare` | Skips more startup context, but also skips OAuth and keychain authentication. | Must not be enabled unconditionally; it is usable only for a separately qualified API-key or `apiKeyHelper` setup. |
| `--tools`, `--allowedTools`, `--disallowedTools` | Select or constrain tool calls. | Adapter-owned parts of the access profile; never authored. |
| `--json-schema` | Requests provider-native structured output. | Not used; Kilin owns output validation. |
| `--add-dir`, `--agent`, `--agents`, plugins, MCP, system-prompt overrides, file download, resume/session, background/worktree, Chrome/IDE, and remote-control surfaces | Widen roots, alter instructions/tools/permissions, introduce external state, or change lifecycle. | Outside V1's node contract. |
| `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions` | Bypass permission checks. | Forbidden. |

Claude's permission mode and OS sandbox are separate controls. A V1 `read_only` mapping must deny
file-edit tools, deny writes to the canonical workspace for sandboxed Bash, set
`sandbox.enabled: true`, set `sandbox.failIfUnavailable: true`, and set
`sandbox.allowUnsandboxedCommands: false`. The adapter may claim support only after a hostile-write
qualification proves both file-tool and subprocess writes fail. The default Claude sandbox is not
read-only because it permits writes inside the working directory.

## OpenCode

Recommended command shape for supported operations, subject to the version probe:

```text
opencode run --pure --format json --dir <canonical-cwd> \
  [--model <provider/model>]
```

The prompt is supplied on stdin only for versions whose adapter contract tests establish that behavior. The current pinned `run.ts` combines a positional message and piped stdin, but the public CLI page does not promise this protocol.

| Flag, variable, or surface | Effect | Kilin handling |
|---|---|---|
| `run` | Runs OpenCode non-interactively. | Required and fixed. |
| `--format json` | Emits raw JSON events. | Required for machine capture. |
| `--dir` | Sets the execution directory. | Maps the canonical run working directory. |
| `-m`, `--model` | Selects a `provider/model`. | Included only for authored `model`. |
| `--pure` | Disables external plugins. | Adapter-owned defense in depth. It does not disable all configuration, prompts, skills, MCP servers, or tool permissions and is not a sandbox. |
| `OPENCODE_PERMISSION` | Supplies inline JSON tool permissions. | Adapter-owned environment configuration. It cannot be authored and is not treated as OS-level isolation. |
| `OPENCODE_CONFIG_CONTENT` and related config variables | Change runtime configuration. | Adapter qualification choices only; no authored environment passthrough. |
| `--agent` | Selects an agent preset that may change prompts, tools, model, and permissions. | Forbidden as a node field because it can bypass Kilin's access abstraction. The built-in `plan` agent is not sufficient evidence for `read_only`. |
| `--auto` | Auto-approves permission requests that are not explicitly denied. | Forbidden. |
| `--continue`, `--session`, `--fork`, `--share`, `--attach`, server credentials/port, and interactive mode | Reuses, publishes, or attaches to external session/server state. | Outside V1's direct-process lifecycle. |
| `--command`, `--file`, `--variant`, `--thinking` | Selects provider-specific commands, attachments, tuning, or extra output. | Not exposed in V1. |

An explicit permission profile can deny OpenCode's `edit`, `bash`, `task`, and external-directory
actions, but this remains a provider tool policy. There is no documented equivalent to the Codex
or Claude OS-level filesystem sandbox, and OpenCode configuration can define agent-specific
permissions. Therefore V1 rejects `read_only` OpenCode nodes rather than silently substitute a
weaker guarantee.

## Runtime node constraints

The flag survey produces these V1 rules:

1. `read_only` means the adapter can verifiably prevent provider file tools and provider-launched subprocesses from modifying the canonical workspace even when the agent attempts a hostile write. A provider label such as `plan` does not by itself satisfy the contract.
2. `workspace_write` permits modification of the canonical workspace. V1 does not claim hermetic containment against the same operating-system user or hostile ambient provider configuration. Neither access mode lets a workflow add writable roots or select a bypass mode.
3. Working directory stays run-owned. V1 does not add node-level `cwd`, `add_dir`, `args`, `env`, `tools`, `permissions`, `agent`, `session`, or provider settings.
4. Prompt transport and result extraction are adapter details. Provider event names, session IDs, and native JSON-schema flags do not enter the workflow contract.
5. A node declaring `output.type: artifact` requires `access: workspace_write`; validation fails before runtime probing otherwise.
6. OpenCode stdin, all access mappings, and final-event extraction are version-qualified adapter capabilities with contract tests. A capability that cannot be proven fails closed.
