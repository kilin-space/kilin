# V1 Bounded Feedback

V1 supports one contained revise-or-pass loop. The authored form is compact, but compilation
expands it into a finite acyclic execution plan before persistence.

## Authoring contract

A workflow may contain at most one loop and may not nest loops. `maxIterations` is required from 1
through 5. The body is an acyclic graph of agent and approval nodes.

The loop declares:

- one decision agent that is the unique body sink and returns exactly the configured `pass` or
  `revise` choice;
- one bounded feedback output and one agent input that receives it on the next iteration; and
- one result-producing agent whose bounded output becomes the loop result after a pass.

Feedback may be `text`, `json`, or `decision_packet`. A loop result may be `text`, `json`,
`decision_packet`, or `choice`. Artifact feedback and artifact loop results are rejected. Outer
data-binding edges cannot enter a loop; declared run parameters provide initial input.

```yaml
schemaVersion: 1
workflow: { id: refine-change, name: Refine change }
parameters: [task]
nodes:
  - id: refinement
    kind: loop
    maxIterations: 3
    body:
      nodes:
        - id: worker
          kind: agent
          runtime: codex
          access: workspace_write
          parameters: [task]
          prompt: Implement the supplied task and return a concise summary.
          output: { type: text }
        - id: review
          kind: agent
          runtime: codex
          access: read_only
          prompt: Review the change and return revision feedback.
          output: { type: text }
        - id: decision
          kind: agent
          runtime: codex
          access: read_only
          prompt: Decide whether the change passes or needs revision.
          output: { type: choice, choices: [pass, revise] }
      edges:
        - { from: worker, to: review, input: draft }
        - { from: review, to: decision, input: feedback }
    decision: { node: decision, passChoice: pass, reviseChoice: revise }
    feedback: { from: review, to: worker, input: feedback }
    result: { node: worker }
edges: []
```

## Compilation and execution

Compilation creates one loop control plus one occurrence of every body node for each possible
iteration. The whole workflow remains bounded to 256 execution occurrences and 1,024 expanded
edges. Occurrence records carry explicit loop, authored body-node, and zero-based iteration
provenance; clients must not parse opaque execution IDs.

Only one iteration is eligible at a time. Independent `read_only` work inside that iteration may
use the ordinary parallel bound. The loop control is application-owned and does not consume a
runtime slot.

A pass publishes the selected result and skips later compiled iterations. A revise decision sends
the declared bounded feedback to the next iteration. Revising at the final bound fails with
`LOOP_LIMIT_REACHED`.

Failure, cancellation, timeout, and output bounds use the ordinary occurrence lifecycle. Rerun and
continuation restart the loop from iteration 0; they do not resume a historical iteration or
provider session.

V1 does not support arbitrary cycles, nested loops, parallel iterations, accumulators,
iteration-level retry, dynamic nodes, or unbounded execution.
