import { serializeCanonicalJson } from "../../src/domain/canonical-json.js";
import type { DecisionPacketV1 } from "../../src/domain/decision-packet.js";

export const decisionPacketFixture = (marker = "BASE_PACKET"): DecisionPacketV1 => ({
  kind: "decision_packet",
  packetVersion: 1,
  subject: {
    type: "inventory_policy",
    id: "west-coast-buffer",
    name: `West Coast safety-stock policy ${marker}`,
  },
  objective: "Reduce stockouts without exceeding the approved working-capital range.",
  observations: [
    {
      id: "service-level",
      summary: `The trailing service level is below the operating target. ${marker}`,
      metrics: [
        {
          name: "Service level",
          value: 93.4,
          unit: "percent",
          source: {
            label: "Operations warehouse snapshot",
            reference: `snapshot-2026-07-21-${marker}`,
          },
          asOf: "2026-07-21T23:00:00.000Z",
          maturity: "mature",
        },
      ],
    },
  ],
  evaluation: {
    summary: "The current buffer is likely insufficient for observed demand variability.",
    inferences: [
      {
        summary: "A modest buffer increase is proportionate.",
        basedOn: ["service-level"],
      },
    ],
    guardrails: [
      {
        name: "Working-capital range",
        status: "unknown",
        detail: "The current snapshot does not include the proposed capital impact.",
        basedOn: ["service-level"],
      },
    ],
  },
  recommendation: {
    summary: `Model a limited buffer increase before changing the policy. ${marker}`,
    rationale: "Service is below target while the capital guardrail remains unknown.",
  },
  alternatives: [
    {
      summary: "Keep the current buffer until another mature period closes.",
      tradeoffs: "Avoids immediate capital risk but accepts continued stockout exposure.",
    },
  ],
  risks: [
    {
      summary: "Recent demand may not represent the next planning period.",
      severity: "medium",
    },
  ],
  unknowns: [
    {
      summary: "Incremental working-capital impact has not been calculated.",
    },
  ],
  proposedActions: [
    {
      id: "model-buffer",
      summary: "Model a limited safety-stock increase.",
      rationale: "Resolve the unknown guardrail before a human decides.",
    },
  ],
  review: {
    recommendedAt: "2026-07-29T17:00:00.000Z",
    reason: "Review after the capital model and another snapshot are available.",
  },
});

export const decisionPacketJson = (marker?: string): string =>
  serializeCanonicalJson(decisionPacketFixture(marker));
