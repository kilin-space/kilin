# Decision Packet V1

Decision Packet V1 is a structured, business-domain-neutral output for a workflow stage that
prepares a reviewable judgment. It separates evidence, inference, recommendation, proposed action,
human decision, review, and outcome.

Declaring `output: { type: decision_packet }` does not approve or execute anything. A later
approval node records the Human Decision. Kilin never executes Proposed Actions.

## Wire contract

The output is a JSON object with `kind: "decision_packet"`, `packetVersion: 1`, and these required
top-level fields:

- `subject`
- `objective`
- `observations`
- `evaluation`
- `recommendation`
- `alternatives`
- `proposedActions`
- `risks`
- `unknowns`
- `review`

Unknown fields and duplicate identifiers are rejected. Strings and collections are bounded.
Observations carry evidence and source references; evaluation entries state an inference and cite
the observations that support it. Proposed actions remain inert data.

```json
{
  "kind": "decision_packet",
  "packetVersion": 1,
  "subject": {
    "type": "release",
    "id": "cli-0.1.0",
    "name": "CLI release"
  },
  "objective": "Decide whether the current package is ready to release.",
  "observations": [
    {
      "id": "tests",
      "summary": "The release gate passed.",
      "metrics": [
        {
          "name": "Release gate",
          "value": true,
          "source": { "label": "pnpm verify" },
          "asOf": "2026-07-26T12:00:00Z",
          "maturity": "mature"
        }
      ]
    }
  ],
  "evaluation": {
    "summary": "The verified behavior satisfies the current acceptance criteria.",
    "inferences": [
      {
        "summary": "The deterministic release checks are complete.",
        "basedOn": ["tests"]
      }
    ],
    "guardrails": [
      {
        "name": "Required checks",
        "status": "pass",
        "detail": "The current release gate completed successfully.",
        "basedOn": ["tests"]
      }
    ]
  },
  "recommendation": {
    "summary": "Approve the release.",
    "rationale": "The required deterministic checks passed."
  },
  "alternatives": [
    {
      "summary": "Delay the release.",
      "tradeoffs": "Adds review time without new evidence from the current gate."
    }
  ],
  "proposedActions": [
    {
      "id": "follow-up",
      "summary": "Publish the verified package.",
      "rationale": "The package meets the current release gate."
    }
  ],
  "risks": [],
  "unknowns": [],
  "review": {
    "recommendedAt": "2026-07-26T12:00:00Z",
    "reason": "Review immediately after the release gate."
  }
}
```

The exact structural bounds are enforced by the CLI validator. Runtime adapters receive the
expected output contract, but Kilin validates the final result independently before accepting it.

## Persistence and viewer

The raw validated packet remains in the private result file. Recorded state stores only the
bounded projection required for run inspection. Public lifecycle events do not include packet
content.

The Viewer renders the packet as structured read-only content. It escapes all text, applies its
ordinary output authorization, and exposes no action-execution route. Its only mutation remains
the guarded approve/reject decision for an eligible approval node.

## Security

- Treat packet content and source references as untrusted data.
- Do not place secrets in workflow prompts, approval questions, or packet fields.
- Do not interpret a recommendation as authorization.
- Do not fetch source references automatically.
- Preserve the distinction between observed evidence and inferred judgment.
