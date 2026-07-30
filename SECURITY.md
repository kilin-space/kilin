# Security policy

## Supported versions

Kilin is pre-1.0. Security fixes land on the latest published `@kilin-space/cli` release; earlier
versions are not patched.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:
[report a vulnerability](https://github.com/kilin-space/kilin/security/advisories/new). Please do
not open a public issue for a suspected vulnerability.

Include the Kilin version (`kilin --version`), your operating system, which provider CLI was
involved, and the smallest reproduction you can share. Redact API keys, tokens, environment values,
cookies, personal data, and unrelated secrets.

## What Kilin isolates, and what it does not

Kilin runs third-party provider CLIs as subprocesses and passes them the complete environment of
the shell that started it. This preserves provider authentication and proxy settings, and it also
means a provider CLI — and any agent it launches — can read unrelated credentials present in that
environment, including exported API keys and access tokens. Workflow YAML cannot add or override
environment variables. Start Kilin from a deliberately minimal or sanitized environment containing
only the credentials that the selected provider needs.

Access modes (`read_only` and `workspace_write`) map onto each provider's own enforcement surface.
They are defense in depth rather than a sandbox Kilin controls, and Kilin does not claim zero
network egress, complete read isolation, or deterministic model output.

Full detail: [trust boundaries](https://docs.kilin.space/en/security/trust-boundaries).

## Documented behavior, not vulnerabilities

The following are deliberate and documented. Please do not file them as vulnerabilities:

- provider subprocesses inheriting the invoking shell's environment;
- `--param` values appearing in shell history and local process listings;
- retained Git worktrees and captured run output persisting under `~/.kilin`;
- the Viewer's loopback listener, which binds numeric `127.0.0.1`, uses a one-use launch
  credential, and terminates with the attached CLI process; and
- a workflow file causing execution. Workflow files are executable input, and running one is an
  explicit user action.
