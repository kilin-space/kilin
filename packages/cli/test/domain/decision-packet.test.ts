/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-dynamic-delete, @typescript-eslint/no-non-null-assertion -- Invalid-packet fixtures intentionally mutate inferred valid shapes into malformed values. */
import { describe, expect, it } from "vitest";

import {
  decisionPacketMaximumBytes,
  DecisionPacketValidationError,
  parseDecisionPacket,
} from "../../src/domain/decision-packet.js";

const validPacket = () => ({
  kind: "decision_packet",
  packetVersion: 1,
  subject: {
    type: "inventory_policy",
    id: "west-coast-buffer",
    name: "West Coast safety-stock policy",
  },
  objective: "Reduce stockouts without exceeding the approved working-capital range.",
  observations: [
    {
      id: "service-level",
      summary: "The trailing service level is below the operating target.",
      metrics: [
        {
          name: "Service level",
          value: 93.4,
          unit: "percent",
          source: {
            label: "Operations warehouse snapshot",
            reference: "snapshot-2026-07-21",
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
    summary: "Model a limited buffer increase before changing the policy.",
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

const clone = <Value>(value: Value): Value => structuredClone(value);

const expectInvalid = (value: unknown, path?: string): DecisionPacketValidationError => {
  try {
    parseDecisionPacket(typeof value === "string" ? value : JSON.stringify(value));
    throw new Error("Expected Decision Packet validation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(DecisionPacketValidationError);
    if (!(error instanceof DecisionPacketValidationError)) {
      throw error;
    }
    if (path !== undefined) {
      expect(error.path).toBe(path);
    }
    return error;
  }
};

describe("parseDecisionPacket", () => {
  it("accepts a general Decision Packet and preserves typed business values", () => {
    expect(parseDecisionPacket(JSON.stringify(validPacket()))).toEqual(validPacket());
  });

  it.each([
    "kind",
    "packetVersion",
    "subject",
    "objective",
    "observations",
    "evaluation",
    "recommendation",
    "alternatives",
    "risks",
    "unknowns",
    "proposedActions",
    "review",
  ] as const)("rejects a missing root field %s", (field) => {
    const packet = validPacket() as Record<string, unknown>;
    delete packet[field];
    expectInvalid(packet, field);
  });

  it.each([
    [
      "subject.type",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.subject as Partial<typeof packet.subject>).type,
    ],
    [
      "subject.name",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.subject as Partial<typeof packet.subject>).name,
    ],
    [
      "observations[0].id",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.observations[0] as Partial<(typeof packet.observations)[number]>).id,
    ],
    [
      "observations[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.observations[0] as Partial<(typeof packet.observations)[number]>).summary,
    ],
    [
      "observations[0].metrics",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.observations[0] as Partial<(typeof packet.observations)[number]>).metrics,
    ],
    [
      "observations[0].metrics[0].name",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0] as Partial<
            (typeof packet.observations)[number]["metrics"][number]
          >
        ).name,
    ],
    [
      "observations[0].metrics[0].value",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0] as Partial<
            (typeof packet.observations)[number]["metrics"][number]
          >
        ).value,
    ],
    [
      "observations[0].metrics[0].source",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0] as Partial<
            (typeof packet.observations)[number]["metrics"][number]
          >
        ).source,
    ],
    [
      "observations[0].metrics[0].source.label",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0]!.source as Partial<
            (typeof packet.observations)[number]["metrics"][number]["source"]
          >
        ).label,
    ],
    [
      "observations[0].metrics[0].asOf",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0] as Partial<
            (typeof packet.observations)[number]["metrics"][number]
          >
        ).asOf,
    ],
    [
      "observations[0].metrics[0].maturity",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.observations[0]!.metrics[0] as Partial<
            (typeof packet.observations)[number]["metrics"][number]
          >
        ).maturity,
    ],
    [
      "evaluation.summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.evaluation as Partial<typeof packet.evaluation>).summary,
    ],
    [
      "evaluation.inferences",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.evaluation as Partial<typeof packet.evaluation>).inferences,
    ],
    [
      "evaluation.guardrails",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.evaluation as Partial<typeof packet.evaluation>).guardrails,
    ],
    [
      "evaluation.inferences[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.inferences[0] as Partial<(typeof packet.evaluation.inferences)[number]>
        ).summary,
    ],
    [
      "evaluation.inferences[0].basedOn",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.inferences[0] as Partial<(typeof packet.evaluation.inferences)[number]>
        ).basedOn,
    ],
    [
      "evaluation.guardrails[0].name",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.guardrails[0] as Partial<(typeof packet.evaluation.guardrails)[number]>
        ).name,
    ],
    [
      "evaluation.guardrails[0].status",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.guardrails[0] as Partial<(typeof packet.evaluation.guardrails)[number]>
        ).status,
    ],
    [
      "evaluation.guardrails[0].detail",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.guardrails[0] as Partial<(typeof packet.evaluation.guardrails)[number]>
        ).detail,
    ],
    [
      "evaluation.guardrails[0].basedOn",
      (packet: ReturnType<typeof validPacket>) =>
        delete (
          packet.evaluation.guardrails[0] as Partial<(typeof packet.evaluation.guardrails)[number]>
        ).basedOn,
    ],
    [
      "recommendation.summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.recommendation as Partial<typeof packet.recommendation>).summary,
    ],
    [
      "recommendation.rationale",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.recommendation as Partial<typeof packet.recommendation>).rationale,
    ],
    [
      "alternatives[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.alternatives[0] as Partial<(typeof packet.alternatives)[number]>).summary,
    ],
    [
      "alternatives[0].tradeoffs",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.alternatives[0] as Partial<(typeof packet.alternatives)[number]>).tradeoffs,
    ],
    [
      "risks[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.risks[0] as Partial<(typeof packet.risks)[number]>).summary,
    ],
    [
      "risks[0].severity",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.risks[0] as Partial<(typeof packet.risks)[number]>).severity,
    ],
    [
      "unknowns[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.unknowns[0] as Partial<(typeof packet.unknowns)[number]>).summary,
    ],
    [
      "proposedActions[0].id",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.proposedActions[0] as Partial<(typeof packet.proposedActions)[number]>).id,
    ],
    [
      "proposedActions[0].summary",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.proposedActions[0] as Partial<(typeof packet.proposedActions)[number]>)
          .summary,
    ],
    [
      "proposedActions[0].rationale",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.proposedActions[0] as Partial<(typeof packet.proposedActions)[number]>)
          .rationale,
    ],
    [
      "review.recommendedAt",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.review as Partial<typeof packet.review>).recommendedAt,
    ],
    [
      "review.reason",
      (packet: ReturnType<typeof validPacket>) =>
        delete (packet.review as Partial<typeof packet.review>).reason,
    ],
  ] as const)("rejects a missing nested field %s", (path, mutate) => {
    const packet = validPacket();
    mutate(packet);
    expectInvalid(packet, path);
  });

  it.each([
    ["non-object root", [], undefined],
    ["wrong kind", { ...validPacket(), kind: "kilin.packet" }, "kind"],
    ["old version", { ...validPacket(), packetVersion: 0 }, "packetVersion"],
    ["future version", { ...validPacket(), packetVersion: 2 }, "packetVersion"],
    ["empty objective", { ...validPacket(), objective: " \n " }, "objective"],
    ["empty observations", { ...validPacket(), observations: [] }, "observations"],
    [
      "empty guardrails",
      { ...validPacket(), evaluation: { ...validPacket().evaluation, guardrails: [] } },
      "evaluation.guardrails",
    ],
    ["empty alternatives", { ...validPacket(), alternatives: [] }, "alternatives"],
    ["empty actions", { ...validPacket(), proposedActions: [] }, "proposedActions"],
    [
      "invalid maturity",
      (() => {
        const packet = validPacket();
        packet.observations[0]!.metrics[0]!.maturity = "fresh";
        return packet;
      })(),
      "observations[0].metrics[0].maturity",
    ],
    [
      "invalid guardrail status",
      (() => {
        const packet = validPacket();
        packet.evaluation.guardrails[0]!.status = "warning";
        return packet;
      })(),
      "evaluation.guardrails[0].status",
    ],
    [
      "invalid risk severity",
      (() => {
        const packet = validPacket();
        packet.risks[0]!.severity = "critical";
        return packet;
      })(),
      "risks[0].severity",
    ],
    [
      "null metric value",
      (() => {
        const packet = validPacket();
        (packet.observations[0]!.metrics[0] as { value: unknown }).value = null;
        return packet;
      })(),
      "observations[0].metrics[0].value",
    ],
    [
      "invalid as-of",
      (() => {
        const packet = validPacket();
        packet.observations[0]!.metrics[0]!.asOf = "2026-07-21";
        return packet;
      })(),
      "observations[0].metrics[0].asOf",
    ],
    [
      "impossible as-of date",
      (() => {
        const packet = validPacket();
        packet.observations[0]!.metrics[0]!.asOf = "2026-02-30T23:00:00Z";
        return packet;
      })(),
      "observations[0].metrics[0].asOf",
    ],
    [
      "offset review time",
      {
        ...validPacket(),
        review: { ...validPacket().review, recommendedAt: "2026-07-29T10:00:00-07:00" },
      },
      "review.recommendedAt",
    ],
    [
      "no metric anywhere",
      (() => {
        const packet = validPacket();
        packet.observations[0]!.metrics = [];
        return packet;
      })(),
      "observations",
    ],
    [
      "unknown observation reference",
      (() => {
        const packet = validPacket();
        packet.evaluation.inferences[0]!.basedOn = ["missing"];
        return packet;
      })(),
      "evaluation.inferences[0].basedOn[0]",
    ],
    [
      "duplicate observation reference",
      (() => {
        const packet = validPacket();
        packet.evaluation.guardrails[0]!.basedOn = ["service-level", "service-level"];
        return packet;
      })(),
      "evaluation.guardrails[0].basedOn[1]",
    ],
    [
      "duplicate observation ID",
      (() => {
        const packet = validPacket();
        packet.observations.push(clone(packet.observations[0]!));
        return packet;
      })(),
      "observations[1].id",
    ],
    [
      "duplicate action ID",
      (() => {
        const packet = validPacket();
        packet.proposedActions.push(clone(packet.proposedActions[0]!));
        return packet;
      })(),
      "proposedActions[1].id",
    ],
    [
      "invalid identifier",
      (() => {
        const packet = validPacket();
        packet.observations[0]!.id = "bad id";
        return packet;
      })(),
      "observations[0].id",
    ],
  ] as const)("rejects %s", (_name, value, path) => {
    expectInvalid(value, path);
  });

  it.each([
    ["subject container", { ...validPacket(), subject: [] }, "subject"],
    ["objective primitive", { ...validPacket(), objective: 42 }, "objective"],
    ["observations container", { ...validPacket(), observations: {} }, "observations"],
    ["evaluation container", { ...validPacket(), evaluation: null }, "evaluation"],
    [
      "recommendation container",
      { ...validPacket(), recommendation: "recommend" },
      "recommendation",
    ],
    ["alternatives container", { ...validPacket(), alternatives: {} }, "alternatives"],
    ["risks container", { ...validPacket(), risks: {} }, "risks"],
    ["unknowns container", { ...validPacket(), unknowns: {} }, "unknowns"],
    ["actions container", { ...validPacket(), proposedActions: {} }, "proposedActions"],
    ["review container", { ...validPacket(), review: [] }, "review"],
    [
      "metrics container",
      (() => {
        const packet = validPacket();
        (packet.observations[0] as { metrics: unknown }).metrics = {};
        return packet;
      })(),
      "observations[0].metrics",
    ],
    [
      "metric source container",
      (() => {
        const packet = validPacket();
        (packet.observations[0]!.metrics[0] as { source: unknown }).source = "warehouse";
        return packet;
      })(),
      "observations[0].metrics[0].source",
    ],
    [
      "inferences container",
      (() => {
        const packet = validPacket();
        (packet.evaluation as { inferences: unknown }).inferences = {};
        return packet;
      })(),
      "evaluation.inferences",
    ],
    [
      "guardrails container",
      (() => {
        const packet = validPacket();
        (packet.evaluation as { guardrails: unknown }).guardrails = {};
        return packet;
      })(),
      "evaluation.guardrails",
    ],
    [
      "evidence references container",
      (() => {
        const packet = validPacket();
        (packet.evaluation.inferences[0] as { basedOn: unknown }).basedOn = "service-level";
        return packet;
      })(),
      "evaluation.inferences[0].basedOn",
    ],
  ] as const)("rejects a wrong %s type", (_name, value, path) => {
    expectInvalid(value, path);
  });

  it.each([
    [
      "root",
      (packet: Record<string, unknown>) => {
        packet.unexpected = true;
      },
      "unexpected",
    ],
    [
      "human decision",
      (packet: Record<string, unknown>) => {
        packet.humanDecision = "approve";
      },
      "humanDecision",
    ],
    [
      "outcome",
      (packet: Record<string, unknown>) => {
        packet.outcome = { status: "effective" };
      },
      "outcome",
    ],
    [
      "metric",
      (packet: Record<string, unknown>) => {
        const observations = packet.observations as Record<string, unknown>[];
        const metrics = observations[0]?.metrics as Record<string, unknown>[];
        if (metrics[0] !== undefined) {
          metrics[0].threshold = 95;
        }
      },
      "observations[0].metrics[0].threshold",
    ],
  ] as const)("rejects an unknown %s field", (_name, mutate, path) => {
    const packet = validPacket() as unknown as Record<string, unknown>;
    mutate(packet);
    expectInvalid(packet, path);
  });

  it.each([
    ["unsafe integer", "9007199254740992"],
    ["non-finite parsed number", "1e400"],
  ] as const)("rejects a %s metric", (_name, value) => {
    const source = JSON.stringify(validPacket()).replace("93.4", value);
    expectInvalid(source, "observations[0].metrics[0].value");
  });

  it("accepts exact large metric values encoded as strings", () => {
    const packet = validPacket();
    (packet.observations[0]!.metrics[0] as { value: unknown }).value = "9007199254740992";
    expect(parseDecisionPacket(JSON.stringify(packet))).toEqual(packet);
  });

  it("enforces the raw 64 KiB boundary including JSON whitespace", () => {
    const source = JSON.stringify(validPacket());
    const atLimit = source + " ".repeat(decisionPacketMaximumBytes - Buffer.byteLength(source));
    expect(Buffer.byteLength(atLimit)).toBe(decisionPacketMaximumBytes);
    expect(parseDecisionPacket(atLimit)).toEqual(validPacket());

    const aboveLimit = `${atLimit} `;
    const error = expectInvalid(aboveLimit);
    expect(error.message).toContain("65,536");
  });

  it("measures multibyte UTF-8 rather than JavaScript string length", () => {
    const packet = validPacket();
    packet.observations[0]!.summary = "界".repeat(22_000);
    const source = JSON.stringify(packet);
    expect(source.length).toBeLessThan(decisionPacketMaximumBytes);
    expect(Buffer.byteLength(source)).toBeGreaterThan(decisionPacketMaximumBytes);
    const error = expectInvalid(source);
    expect(error.message).toContain("65,536");
  });

  it("identifies invalid JSON as a Decision Packet V1 error", () => {
    const error = expectInvalid("{");
    expect(error.message).toContain("one valid JSON object");
  });

  it("keeps hostile HTML, URLs, commands, and template text as inert string data", () => {
    const packet = validPacket();
    packet.recommendation.summary = '<script>alert("x")</script>';
    packet.proposedActions[0]!.summary = "rm -rf / ${SECRET}";
    packet.observations[0]!.metrics[0]!.source.reference = "javascript:alert(1)";
    expect(parseDecisionPacket(JSON.stringify(packet))).toEqual(packet);
  });
});
