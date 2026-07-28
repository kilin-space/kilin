# Host-owned cron triggers

Kilin can be invoked by an existing host scheduler without becoming a scheduler itself. The host
decides when a job is due and starts one foreground `kilin trigger` process. Kilin validates a
bounded request, records its cron provenance, and sends the run through the same executor used by
`kilin run`.

## Request contract

Create a private JSON file such as `/etc/kilin/change-review.json`:

```json
{
  "triggerVersion": 1,
  "workflow": "change-review",
  "cwd": "/srv/change-review",
  "source": {
    "kind": "cron",
    "schedule": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  }
}
```

The contract is deliberately closed:

- the UTF-8 JSON file is at most 65,536 bytes and rejects unknown or missing fields;
- `triggerVersion` is exactly `1`;
- `workflow` is a valid workflow package ID and `cwd` is absolute;
- `source.kind` is exactly `cron`;
- `schedule` is a numeric, five-field cron expression; names, macros, seconds, and implementation
  extensions are rejected; and
- `timezone` is an `Area/Location` IANA time-zone ID recognized by the installed runtime, or `UTC`;
  recognized aliases in that form are normalized before persistence. Numeric offsets and
  single-label identifiers are rejected. The runtime resolves an abbreviation like `EST` — to
  `America/Panama`, not to any zone the author named — as readily as an alias like `Japan`, and
  offers no way to tell the two apart, so the zone has to be named directly.

Kilin resolves `cwd` to its canonical existing directory and applies normal project-scope checks
before creating a run. The request has no arbitrary metadata, run-option overrides, environment
values, prompts, or secrets.

The request path itself must be absolute and name a regular file, not a final-component symlink. On
supported POSIX hosts, the file must be owned by the invoking user and must not be group- or
world-writable. This keeps a privileged scheduler from accepting a request another account can
replace in place.

## Invocation

Run the request directly first:

```bash
kilin trigger --request /etc/kilin/change-review.json --json
```

Then configure the host's scheduler to invoke the same command. A conventional five-field crontab
entry could look like this:

```cron
0 9 * * 1-5 /usr/local/bin/kilin trigger --request /etc/kilin/change-review.json --json >>/var/log/kilin-change-review.jsonl 2>&1
```

Configure the host scheduler itself to use `America/Los_Angeles`, matching the request. Time-zone
configuration differs between cron implementations, so Kilin does not prescribe `CRON_TZ` or
another host-specific mechanism. The request's schedule and runtime-normalized time zone are
provenance for audit; Kilin does not calculate whether the invocation is due.

The process inherits the scheduler's environment. It must be able to find Kilin and the required
provider CLI, access that provider's authentication, read the workflow package, and use the
requested workspace. Use absolute executable and request paths and a deliberately bounded
environment.

## Execution and failure semantics

After request validation, `trigger` uses normal package resolution, compilation, runtime preflight,
canonical-workspace locking, SQLite creation, sequential execution, approval, cancellation, and
JSON Lines events. Effective run limits are the normal defaults. The recorded run detail includes:

```json
{
  "trigger": {
    "kind": "cron",
    "schedule": "0 9 * * 1-5",
    "timezone": "America/Los_Angeles"
  }
}
```

Invalid or oversized requests fail before run creation with exit code `2`. If another Kilin process
holds the canonical workspace lock, the invocation returns `WORKSPACE_BUSY` with exit code `2` and
does not create or queue a run. Once a run exists, the ordinary exit contract applies: `0` for
success, `1` for a recorded failure or interruption, and `130` for cancellation.

`rerun`, `retry`, and `resume` create lineage runs, not new cron invocations, so they do not copy the
trigger provenance onto the new run. The originating run remains inspectable through that lineage.

Kilin does not install or edit crontabs, persist schedules, poll clocks, queue overlapping
invocations, catch up missed runs, deduplicate invocations, or claim exactly-once execution. Those
responsibilities remain with the host.

## Run parameters are outside Trigger V1

`triggerVersion: 1` is closed and parameterless. It coexists with
[declared run parameters](workflow.md#run-parameters) under an explicit boundary:

- the invocation fields remain `triggerVersion`, `workflow`, `cwd`, and `source`. A root `parameters`
  field is an unsupported request field and fails with `OPTION_INVALID` at `parameters`;
- `kilin trigger` does not accept `--param`; the flag fails with `OPTION_INVALID` as an unknown option
  rather than bypassing the closed request contract;
- a selected workflow that declares no parameters follows the ordinary foreground run path and stores
  a null parameter snapshot;
- a selected workflow that declares any required parameter fails with `RUN_PARAM_INVALID` at
  `parameters.<name>` for the lowest canonical missing name. That happens after workflow resolution
  and compilation but before runtime probing, lock acquisition, run creation, trigger-provenance
  persistence, or agent execution, so a rejected trigger leaves no run and no provenance behind;
- a missing parameter is never reinterpreted as an empty string or a default, and the closed request
  parser is not weakened to admit one; and
- `source.kind`, `source.schedule`, and `source.timezone` are invocation provenance only. No trigger
  field enters `KILIN_RESOLVED_INPUTS_V1`, a resolved-input file, or an agent prompt.

A parameter-carrying host trigger requires a new `triggerVersion` and a separately approved design.
That contract must reuse the workflow-aware validation, canonical parameter snapshot, consumer-scoped
fence, disclosure rules, and rerun semantics described in the
[Workflow Contract](workflow.md#run-parameters); it must not add a trigger-specific input channel or
repurpose cron metadata as task content.
