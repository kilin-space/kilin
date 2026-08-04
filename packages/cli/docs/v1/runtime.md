# Runtime Contract

This document owns how Kilin launches and controls external agent CLIs. Workflow authors select a runtime and access mode; they never construct a process command.

## Runtime adapter boundary

V1 needs one small external boundary:

```ts
interface RuntimeAdapter {
  readonly runtimeId: RuntimeId;

  probe(requirements: RuntimeProbeRequirements, context: RuntimeProbeContext): Promise<RuntimeInfo>;

  createInvocation(
    request: ResolvedAgentRequest,
    context: RuntimeExecutionContext,
  ): RuntimeInvocation;

  extractResult(completed: CompletedProcess): Promise<RuntimeResult>;
}

interface RuntimeInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
}
```

The shared process runner, not the adapter, owns process groups, timeouts, byte limits, stdout/stderr files, cancellation, and exit status. The adapter owns runtime-specific capability checks, arguments, access-mode mapping, and extraction of the final result.

There is no plugin discovery or runtime registry API. A small resolver selects the fixed Codex,
Claude Code, or OpenCode adapter for each node's runtime ID.

## Preflight

Kilin probes every distinct runtime and required access mode in the compiled plan before creating a
revision or run. Each probe checks:

1. the executable can be resolved;
2. its version is supported;
3. required non-interactive, machine-output, working-directory, access-control, session, and
   final-output capabilities are present; and
4. the provider-specific authentication check succeeds.

The fixed adapters accept stable releases at or above their tested floors: Codex `0.144.0`, Claude
Code `2.1.215`, and OpenCode `1.18.4`. A newer version must still expose every required capability
and pass authentication preflight; a version string never substitutes for those probes. Older,
prerelease, malformed, or capability-incompatible versions fail closed.

Version, help, capability, and authentication probes verify only the local CLI surface used by
preflight. They are not model-execution evidence. Exact qualified runtime versions and behavioral
results are recorded only in the [qualification index](../qualification/README.md).

A failed probe returns an actionable error and starts no agent process. Version strings alone are not capability proof. A missing safety-critical capability is a hard failure, not a reason to launch with weaker flags. If the attached command is cancelled during preflight, Kilin terminates and reaps the probe process group, creates no run, emits no lifecycle event, and returns the user-interrupt exit path.

Kilin never logs authentication output, reads credential files, copies tokens, or stores
credentials. Authentication remains owned by each provider installation.

## Invocation

Each adapter builds a fixed, shell-free argv array. The concrete flags are documented in the
[runtime flag matrix](../references/agent-runtimes/flag-matrix.md). The Codex shape is:

```text
codex
  --ask-for-approval never
  --config default_permissions="<mapped-profile>"
  --config projects."<canonical-cwd>".trust_level="untrusted"
  exec
  --ignore-user-config
  --ignore-rules
  --json
  -C <canonical-cwd>
  --output-last-message <result-path>
  [--model <model>]
  [--skip-git-repo-check]
  --ephemeral
  -
```

The optional Git flag is used only when the canonical working directory is not a Git repository. The optional model flag is present only when the node declares `model`.

The prompt is sent through stdin. Kilin spawns the executable with an argv array and never uses a shell, string concatenation, or `eval`. Shell syntax inside a prompt is therefore data, not a parent-process command.

The adapter owns all invocation flags. It never accepts workflow-supplied raw arguments and Kilin itself never requests `danger-full-access`, sandbox bypass, an additional writable directory, or an alternate working directory.

Kilin may revise exact provider argv while preserving this contract. Runtime-specific flags are
infrastructure details, not workflow schema.

## Environment

Every provider version, capability, and authentication probe and every agent subprocess receives the
complete environment inherited by Kilin. This keeps CLI authentication, proxies, developer tools,
and project commands working. It also gives the provider CLI and launched agent access to unrelated
credentials and secrets present in the invoking shell. Kilin does not filter this environment and
workflow YAML cannot add or override variables.

Kilin never writes environment variable names or values to public events or error messages.
Provider or agent commands may still copy information they can read into captured private logs.
Users who need a narrower trust boundary must start Kilin from a deliberately sanitized
environment. Provider sandbox limitations still apply independently.

Provider configuration and project instructions may influence a run. Kilin records the runtime
version, requested model, and effective model when reported, but V1 does not snapshot all external
CLI configuration. Rerun means orchestration repeatability, not deterministic output.

## Access modes

Codex and Claude Code support `read_only` and `workspace_write` through qualified adapter-owned
profiles. OpenCode supports only `workspace_write`; a workflow requiring OpenCode `read_only`
fails preflight. The working root is always the occurrence's run-owned source or named workspace.
A provider update that cannot enforce the required mapping fails the probe.

These modes are defense-in-depth, not a complete security boundary. The external runtime may contact its model service. Depending on the host and runtime, it may read user configuration or files outside the project, and sandbox behavior may differ by platform. Kilin does not claim zero network egress, complete read isolation, or deterministic model behavior.

## Output and result capture

For each node occurrence, the parent process creates the node directory and output files before
spawning the selected provider. It captures:

- provider JSON Lines on stdout in `stdout.log`;
- diagnostics on stderr in `stderr.log`; and
- the provider's final message in `result.txt`.

Paths use a stable occurrence-specific directory under the run directory. The parent pre-creates
all three files. An adapter-specific staging path receives the provider result while the parent
monitors its byte growth with stdout and stderr.

On POSIX systems, Kilin creates its data and run directories with mode `0700` and output files with mode `0600`, subject only to stricter host policy. Other platforms use the closest private-user permissions available.

Provider event shapes are not part of the Kilin public contract. The adapter extracts only the result and metadata Kilin needs. `kilin runs show` exposes file paths instead of copying unbounded logs into SQLite.

Default V1 execution limits are:

- a 30-minute process-timeout fallback for agents without authored `timeoutMs`;
- a separate 30-minute approval timeout; and
- 10 MiB of combined stdout, stderr, and final-result bytes per node.

`kilin run` may set the node fallback and approval timeout independently from one second through 24
hours and the output limit from 1 KiB through 100 MiB. An agent may replace the process fallback
with authored `timeoutMs`; that immutable declaration applies to every attempt. Kilin stores the run
options, and `kilin rerun`, `retry`, and `resume` reproduce them. A process timeout or output-limit
breach terminates the process group and fails the node with a stable error code. An approval timeout
uses the existing `APPROVAL_TIMEOUT` transition. Kilin never silently truncates a successful result.

## Cancellation and process cleanup

Kilin starts each runtime in its own process group. On user cancellation it signals the group, waits a bounded grace period, escalates termination if needed, closes capture files, and persists terminal states.

Signals and exact grace periods are platform-specific infrastructure details. Kilin sends an
initial termination signal to the current process tree, retains captured output, and starts no
later node. Delayed signals require a process identity that remains safe after PID reuse.

Linux revalidates delayed signals with the kernel start ticks from `/proc/<pid>/stat`. macOS uses
the whole-second process start that `/bin/ps` reports, read under a pinned locale and time zone so
the same process renders identically across readings. Both platforms therefore force-terminate a
TERM-resistant descendant that outlives its leader. Second resolution is sufficient because a false
match would need a PID to be recycled and its successor to start within the same second, which
requires exhausting the PID space in that second. Hosts without a usable `/bin/ps` take no process
snapshot at all and can only signal the process group while its leader is alive.

An attached run stops on `SIGINT`, `SIGTERM`, or `SIGHUP`. All three route through the same
cancellation path, so a supervisor, container stop, CI cancellation, or terminal close terminates
the provider tree rather than orphaning it, and the command exits `130`.

If the Kilin parent is killed before cleanup can run at all, the next command marks stale records
interrupted. It does not assume the external process or workspace side effects were rolled back.
Kilin records the process identity of each running attempt. Every command that takes the exclusive
working-directory lock to start or continue work terminates the processes an earlier owner of that
directory left behind before it proceeds, so a crashed run's provider never keeps editing a
directory a new run has started using. Reaping does not depend on the recorded status, which an
intervening `kilin runs show` or `runs list` may already have reconciled.

## Adding another runtime

Every additional runtime adapter must pass the same contract tests for:

- capability and authentication preflight;
- fixed working-directory and access-mode ownership;
- no shell launch and no raw authored args;
- bounded output and result extraction;
- non-zero exit, timeout, and cancellation behavior; and
- redaction of auth and environment values.

Only adapter-specific invocation and result parsing should change. If adding a runtime requires changing graph execution, persistence, or CLI semantics, the adapter boundary is wrong and the design must be revisited.

## Qualification boundary

Ordinary tests exercise each adapter contract with fake executables, including
capability/authentication failures, argv and stdin ownership, access selection, final-result
capture, timeouts, output limits, cancellation, and descendant cleanup. They never call a model or
write normal user state.

Real-runtime qualification is opt-in and records exact versions plus access-mode, typed-result,
approval, timeout, cancellation, descendant-cleanup, and redaction behavior without credentials or
account identity. Its current result is owned by the
[qualification index](../qualification/README.md). Packaging or deterministic test success alone
must not be described as real-model qualification.
