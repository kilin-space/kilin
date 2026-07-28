# Lifecycle State Contract

This document is the canonical lifecycle vocabulary for runs, execution occurrences, and attempts.
SQLite is authoritative for lifecycle state. JSONL events, CLI output, and Viewer projections are
observations of committed state; they do not establish or repair state.

## Run lifecycle

```text
running -> succeeded
        -> failed
        -> cancelled
        -> interrupted
```

A run is created as `running` and reaches exactly one terminal status. A terminal run is immutable.
The run remains `running` while an approval occurrence is `waiting_for_approval`.

- `succeeded`: every selected execution needed by the graph completed successfully.
- `failed`: execution or engine failure prevented successful completion.
- `cancelled`: a cancellation request won the durable terminalization race.
- `interrupted`: foreground ownership ended without a cancellation request.

## Execution occurrence lifecycle

`node_runs.node_id` identifies one execution occurrence. For top-level nodes and loop controls it is
the authored node ID. For a loop-body occurrence it is a compiler-generated opaque execution ID;
`bodyNodeId`, `loopNodeId`, and zero-based `iteration` preserve authored provenance and are either
all present or all absent. Consumers must not parse an execution ID.

Agent occurrences:

```text
pending -> running -> succeeded
                   -> failed
                   -> cancelled
                   -> interrupted
        -> skipped
```

Approval occurrences:

```text
pending -> waiting_for_approval -> succeeded
                                -> failed
                                -> cancelled
                                -> interrupted
        -> skipped
```

Loop-control occurrences:

```text
pending -> running -> succeeded
                   -> failed
                   -> cancelled
                   -> interrupted
        -> cancelled
        -> skipped
```

Only approval occurrences enter `waiting_for_approval`. Only agent and loop-control occurrences
enter `running`. A pending loop control may settle directly as `cancelled` when the cancellation
latch commits before loop admission. A loop control is a non-slot aggregate: it has no runtime,
attempt, stdout, or stderr. On success it owns one bounded projected result path and output type.
`skipped` means the compiled route did not select the occurrence or execution became unreachable;
it is not a failure.

The existing aggregate transition guard accepts the union of these transitions for storage
compatibility. New mutation paths must use the kind-specific transition guards.

### Viewer loop-iteration projection

The Viewer groups loop-body occurrences by loop and iteration and derives a display-only status.
There is no durable iteration row or additional state transition. The first matching rule wins:

```text
failed
interrupted
cancelled
waiting_for_approval
running
all succeeded          => succeeded
only succeeded/skipped => skipped
otherwise              => pending
```

This precedence keeps a terminal failure or cancellation visible when sibling occurrences have a
different state. A mixed terminal group containing only `succeeded` and `skipped` occurrences is
shown as `skipped`, while a group is `succeeded` only when every occurrence succeeded.

## Attempt lifecycle

```text
running -> succeeded
        -> failed
        -> cancelled
        -> interrupted
```

An attempt is inserted directly as `running`; `pending` belongs to the aggregate agent occurrence,
not attempt evidence. Attempts are immutable once terminal. `cancelled` means an explicit
cancellation stopped that active attempt. `interrupted` means foreground ownership ended without
an explicit cancellation. The aggregate agent occurrence and run preserve the corresponding
distinction.

Automatic retry is not an attempt transition. It:

1. terminalizes the current attempt as `failed`;
2. explicitly resets only the failed aggregate agent occurrence to `pending`;
3. increments the attempt number;
4. creates and starts a distinct attempt after bounded backoff.

No approval, loop-level, iteration-level, cancelled, or interrupted outcome is automatically
retried. Full rerun and continuation create a new run rather than reopening terminal state.

## Commit and observation rules

- State is committed before a corresponding event or projection becomes observable.
- Durable commit order decides cancellation versus completion.
- A cancellation latch prevents further admission and retry reset.
- Events contain lifecycle metadata, never parameter, feedback, decision-result, or captured-output
  content.
- Missing or delayed events do not change the durable outcome; consumers refresh from run detail.
- Stale-owner reconciliation terminalizes active occurrences and the run, then skips pending work.

The persistence schema, state decoder, executor, JSONL contract, CLI, and Viewer must all implement
this vocabulary before a new lifecycle kind is described as shipped.
