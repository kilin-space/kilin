export const decisionPacketMaximumBytes = 65_536;
export const decisionPacketVersion = 1 as const;

export const dataMaturities = ["preliminary", "directional", "mature", "unknown"] as const;
export type DataMaturity = (typeof dataMaturities)[number];

export const guardrailStatuses = ["pass", "fail", "unknown"] as const;
export type GuardrailStatus = (typeof guardrailStatuses)[number];

export const riskSeverities = ["low", "medium", "high"] as const;
export type RiskSeverity = (typeof riskSeverities)[number];

export type DecisionMetricValue = string | number | boolean;

export interface DecisionPacketSubject {
  type: string;
  name: string;
  id?: string;
}

export interface DecisionMetricSource {
  label: string;
  reference?: string;
}

export interface DecisionMetric {
  name: string;
  value: DecisionMetricValue;
  unit?: string;
  source: DecisionMetricSource;
  asOf: string;
  maturity: DataMaturity;
}

export interface DecisionObservation {
  id: string;
  summary: string;
  metrics: DecisionMetric[];
}

export interface DecisionInference {
  summary: string;
  basedOn: string[];
}

export interface DecisionGuardrail {
  name: string;
  status: GuardrailStatus;
  detail: string;
  basedOn: string[];
}

export interface DecisionEvaluation {
  summary: string;
  inferences: DecisionInference[];
  guardrails: DecisionGuardrail[];
}

export interface DecisionRecommendation {
  summary: string;
  rationale: string;
}

export interface DecisionAlternative {
  summary: string;
  tradeoffs: string;
}

export interface DecisionRisk {
  summary: string;
  severity: RiskSeverity;
}

export interface DecisionUnknown {
  summary: string;
}

export interface DecisionProposedAction {
  id: string;
  summary: string;
  rationale: string;
}

export interface DecisionReview {
  recommendedAt: string;
  reason: string;
}

export interface DecisionPacketV1 {
  kind: "decision_packet";
  packetVersion: 1;
  subject: DecisionPacketSubject;
  objective: string;
  observations: DecisionObservation[];
  evaluation: DecisionEvaluation;
  recommendation: DecisionRecommendation;
  alternatives: DecisionAlternative[];
  risks: DecisionRisk[];
  unknowns: DecisionUnknown[];
  proposedActions: DecisionProposedAction[];
  review: DecisionReview;
}

export class DecisionPacketValidationError extends Error {
  public readonly path?: string;

  public constructor(message: string, path?: string) {
    super(message);
    this.name = "DecisionPacketValidationError";
    if (path !== undefined) {
      this.path = path;
    }
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const rootFields = new Set([
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
]);
const subjectFields = new Set(["type", "name", "id"]);
const observationFields = new Set(["id", "summary", "metrics"]);
const metricFields = new Set(["name", "value", "unit", "source", "asOf", "maturity"]);
const sourceFields = new Set(["label", "reference"]);
const evaluationFields = new Set(["summary", "inferences", "guardrails"]);
const inferenceFields = new Set(["summary", "basedOn"]);
const guardrailFields = new Set(["name", "status", "detail", "basedOn"]);
const recommendationFields = new Set(["summary", "rationale"]);
const alternativeFields = new Set(["summary", "tradeoffs"]);
const riskFields = new Set(["summary", "severity"]);
const unknownFields = new Set(["summary"]);
const actionFields = new Set(["id", "summary", "rationale"]);
const reviewFields = new Set(["recommendedAt", "reason"]);

const fail = (message: string, path?: string): never => {
  throw new DecisionPacketValidationError(message, path);
};

const childPath = (path: string, field: string): string =>
  path === "" ? field : `${path}.${field}`;

const itemPath = (path: string, index: number): string => `${path}[${String(index)}]`;

const recordAt = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("Decision Packet fields must use the documented object shape.", path || undefined);
  }
  return value as Record<string, unknown>;
};

const closedRecordAt = (
  value: unknown,
  path: string,
  fields: ReadonlySet<string>,
): Record<string, unknown> => {
  const record = recordAt(value, path);
  const unknown = Object.keys(record).find((field) => !fields.has(field));
  if (unknown !== undefined) {
    fail("Decision Packet objects cannot contain unknown fields.", childPath(path, unknown));
  }
  return record;
};

const required = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
): unknown => {
  if (!Object.hasOwn(record, field)) {
    fail("Decision Packet is missing a required field.", childPath(path, field));
  }
  return record[field];
};

const arrayAt = (value: unknown, path: string, minimum = 0): unknown[] => {
  if (!Array.isArray(value) || value.length < minimum) {
    return fail(
      minimum === 0
        ? "Decision Packet field must be an array."
        : "Decision Packet field must be a non-empty array.",
      path,
    );
  }
  return value;
};

const textAt = (value: unknown, path: string, maximumCharacters: number): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > maximumCharacters
  ) {
    return fail(
      `Decision Packet text must contain 1 through ${String(maximumCharacters)} characters.`,
      path,
    );
  }
  return value;
};

const optionalTextAt = (
  record: Readonly<Record<string, unknown>>,
  field: string,
  path: string,
  maximumCharacters: number,
): string | undefined => {
  if (!Object.hasOwn(record, field)) {
    return undefined;
  }
  return textAt(record[field], childPath(path, field), maximumCharacters);
};

const identifierAt = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    return fail(
      "Decision Packet IDs must contain 1 through 64 supported identifier characters.",
      path,
    );
  }
  return value;
};

const timestampAt = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    return fail("Decision Packet timestamps must be UTC RFC 3339 values ending in Z.", path);
  }
  const match = utcTimestampPattern.exec(value);
  if (match === null) {
    return fail("Decision Packet timestamps must be UTC RFC 3339 values ending in Z.", path);
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part));
  const daysInMonth =
    year === undefined || month === undefined || month < 1 || month > 12
      ? 0
      : new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    year === undefined ||
    year === 0 ||
    month === undefined ||
    day === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour === undefined ||
    hour > 23 ||
    minute === undefined ||
    minute > 59 ||
    second === undefined ||
    second > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    return fail("Decision Packet timestamps must be UTC RFC 3339 values ending in Z.", path);
  }
  return value;
};

const enumAt = <Value extends string>(
  value: unknown,
  path: string,
  allowed: readonly Value[],
): Value => {
  if (typeof value !== "string" || !allowed.some((candidate) => candidate === value)) {
    return fail("Decision Packet field uses an unsupported value.", path);
  }
  return value as Value;
};

const metricValueAt = (value: unknown, path: string): DecisionMetricValue => {
  if (typeof value === "string") {
    return textAt(value, path, 2_000);
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  ) {
    return value;
  }
  return fail(
    "Decision Packet metric values must be text, booleans, finite numbers, or safe integers.",
    path,
  );
};

const sourceAt = (value: unknown, path: string): DecisionMetricSource => {
  const record = closedRecordAt(value, path, sourceFields);
  const reference = optionalTextAt(record, "reference", path, 2_000);
  return {
    label: textAt(required(record, "label", path), childPath(path, "label"), 200),
    ...(reference === undefined ? {} : { reference }),
  };
};

const metricAt = (value: unknown, path: string): DecisionMetric => {
  const record = closedRecordAt(value, path, metricFields);
  const unit = optionalTextAt(record, "unit", path, 200);
  return {
    name: textAt(required(record, "name", path), childPath(path, "name"), 200),
    value: metricValueAt(required(record, "value", path), childPath(path, "value")),
    ...(unit === undefined ? {} : { unit }),
    source: sourceAt(required(record, "source", path), childPath(path, "source")),
    asOf: timestampAt(required(record, "asOf", path), childPath(path, "asOf")),
    maturity: enumAt(
      required(record, "maturity", path),
      childPath(path, "maturity"),
      dataMaturities,
    ),
  };
};

const observationAt = (value: unknown, path: string): DecisionObservation => {
  const record = closedRecordAt(value, path, observationFields);
  return {
    id: identifierAt(required(record, "id", path), childPath(path, "id")),
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    metrics: arrayAt(required(record, "metrics", path), childPath(path, "metrics")).map(
      (metric, index) => metricAt(metric, itemPath(childPath(path, "metrics"), index)),
    ),
  };
};

const referencesAt = (value: unknown, path: string): string[] => {
  const references = arrayAt(value, path, 1).map((reference, index) =>
    identifierAt(reference, itemPath(path, index)),
  );
  const seen = new Set<string>();
  for (const [index, reference] of references.entries()) {
    if (seen.has(reference)) {
      fail("Decision Packet evidence references cannot be duplicated.", itemPath(path, index));
    }
    seen.add(reference);
  }
  return references;
};

const inferenceAt = (value: unknown, path: string): DecisionInference => {
  const record = closedRecordAt(value, path, inferenceFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    basedOn: referencesAt(required(record, "basedOn", path), childPath(path, "basedOn")),
  };
};

const guardrailAt = (value: unknown, path: string): DecisionGuardrail => {
  const record = closedRecordAt(value, path, guardrailFields);
  return {
    name: textAt(required(record, "name", path), childPath(path, "name"), 200),
    status: enumAt(required(record, "status", path), childPath(path, "status"), guardrailStatuses),
    detail: textAt(required(record, "detail", path), childPath(path, "detail"), 2_000),
    basedOn: referencesAt(required(record, "basedOn", path), childPath(path, "basedOn")),
  };
};

const evaluationAt = (value: unknown, path: string): DecisionEvaluation => {
  const record = closedRecordAt(value, path, evaluationFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    inferences: arrayAt(required(record, "inferences", path), childPath(path, "inferences")).map(
      (inference, index) => inferenceAt(inference, itemPath(childPath(path, "inferences"), index)),
    ),
    guardrails: arrayAt(required(record, "guardrails", path), childPath(path, "guardrails"), 1).map(
      (guardrail, index) => guardrailAt(guardrail, itemPath(childPath(path, "guardrails"), index)),
    ),
  };
};

const recommendationAt = (value: unknown, path: string): DecisionRecommendation => {
  const record = closedRecordAt(value, path, recommendationFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    rationale: textAt(required(record, "rationale", path), childPath(path, "rationale"), 2_000),
  };
};

const alternativeAt = (value: unknown, path: string): DecisionAlternative => {
  const record = closedRecordAt(value, path, alternativeFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    tradeoffs: textAt(required(record, "tradeoffs", path), childPath(path, "tradeoffs"), 2_000),
  };
};

const riskAt = (value: unknown, path: string): DecisionRisk => {
  const record = closedRecordAt(value, path, riskFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    severity: enumAt(
      required(record, "severity", path),
      childPath(path, "severity"),
      riskSeverities,
    ),
  };
};

const unknownAt = (value: unknown, path: string): DecisionUnknown => {
  const record = closedRecordAt(value, path, unknownFields);
  return {
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
  };
};

const actionAt = (value: unknown, path: string): DecisionProposedAction => {
  const record = closedRecordAt(value, path, actionFields);
  return {
    id: identifierAt(required(record, "id", path), childPath(path, "id")),
    summary: textAt(required(record, "summary", path), childPath(path, "summary"), 2_000),
    rationale: textAt(required(record, "rationale", path), childPath(path, "rationale"), 2_000),
  };
};

const reviewAt = (value: unknown, path: string): DecisionReview => {
  const record = closedRecordAt(value, path, reviewFields);
  return {
    recommendedAt: timestampAt(
      required(record, "recommendedAt", path),
      childPath(path, "recommendedAt"),
    ),
    reason: textAt(required(record, "reason", path), childPath(path, "reason"), 2_000),
  };
};

const assertUniqueIds = (values: readonly { readonly id: string }[], path: string): void => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      fail(
        "Decision Packet IDs must be unique within their collection.",
        `${itemPath(path, index)}.id`,
      );
    }
    seen.add(value.id);
  }
};

const assertReferences = (
  values: readonly { readonly basedOn: readonly string[] }[],
  observations: ReadonlySet<string>,
  path: string,
): void => {
  for (const [itemIndex, value] of values.entries()) {
    for (const [referenceIndex, reference] of value.basedOn.entries()) {
      if (!observations.has(reference)) {
        fail(
          "Decision Packet evidence references must name a declared Observation.",
          `${itemPath(path, itemIndex)}.basedOn[${String(referenceIndex)}]`,
        );
      }
    }
  }
};

export const parseDecisionPacket = (source: string): DecisionPacketV1 => {
  if (Buffer.byteLength(source, "utf8") > decisionPacketMaximumBytes) {
    fail("Decision Packet V1 must not exceed 65,536 UTF-8 bytes.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return fail("Decision Packet V1 must be exactly one valid JSON object.");
  }

  const root = closedRecordAt(value, "", rootFields);
  if (required(root, "kind", "") !== "decision_packet") {
    fail('Decision Packet kind must be "decision_packet".', "kind");
  }
  if (required(root, "packetVersion", "") !== decisionPacketVersion) {
    fail("Decision Packet packetVersion must be 1.", "packetVersion");
  }

  const subjectRecord = closedRecordAt(required(root, "subject", ""), "subject", subjectFields);
  const subjectId = Object.hasOwn(subjectRecord, "id")
    ? identifierAt(subjectRecord.id, "subject.id")
    : undefined;
  const observations = arrayAt(required(root, "observations", ""), "observations", 1).map(
    (observation, index) => observationAt(observation, itemPath("observations", index)),
  );
  const evaluation = evaluationAt(required(root, "evaluation", ""), "evaluation");
  const recommendation = recommendationAt(required(root, "recommendation", ""), "recommendation");
  const alternatives = arrayAt(required(root, "alternatives", ""), "alternatives", 1).map(
    (alternative, index) => alternativeAt(alternative, itemPath("alternatives", index)),
  );
  const risks = arrayAt(required(root, "risks", ""), "risks").map((risk, index) =>
    riskAt(risk, itemPath("risks", index)),
  );
  const unknowns = arrayAt(required(root, "unknowns", ""), "unknowns").map((unknown, index) =>
    unknownAt(unknown, itemPath("unknowns", index)),
  );
  const proposedActions = arrayAt(required(root, "proposedActions", ""), "proposedActions", 1).map(
    (action, index) => actionAt(action, itemPath("proposedActions", index)),
  );

  assertUniqueIds(observations, "observations");
  assertUniqueIds(proposedActions, "proposedActions");
  if (!observations.some((observation) => observation.metrics.length > 0)) {
    fail(
      "Decision Packet must contain at least one metric across its Observations.",
      "observations",
    );
  }
  const observationIds = new Set(observations.map(({ id }) => id));
  assertReferences(evaluation.inferences, observationIds, "evaluation.inferences");
  assertReferences(evaluation.guardrails, observationIds, "evaluation.guardrails");

  return {
    kind: "decision_packet",
    packetVersion: decisionPacketVersion,
    subject: {
      type: textAt(required(subjectRecord, "type", "subject"), "subject.type", 200),
      name: textAt(required(subjectRecord, "name", "subject"), "subject.name", 200),
      ...(subjectId === undefined ? {} : { id: subjectId }),
    },
    objective: textAt(required(root, "objective", ""), "objective", 2_000),
    observations,
    evaluation,
    recommendation,
    alternatives,
    risks,
    unknowns,
    proposedActions,
    review: reviewAt(required(root, "review", ""), "review"),
  };
};

export const tryParseDecisionPacket = (source: string): DecisionPacketV1 | undefined => {
  try {
    return parseDecisionPacket(source);
  } catch {
    return undefined;
  }
};

export const decisionPacketOutputInstructions = [
  "KILIN_DECISION_PACKET_V1",
  "Return exactly one UTF-8 JSON object no larger than 65,536 bytes, with no Markdown fence, explanation, or trailing text.",
  'Use the closed root {"kind":"decision_packet","packetVersion":1,"subject":...,"objective":...,"observations":...,"evaluation":...,"recommendation":...,"alternatives":...,"risks":...,"unknowns":...,"proposedActions":...,"review":...}.',
  "Every metric requires name, value, source {label, optional reference}, asOf UTC RFC 3339, and maturity preliminary|directional|mature|unknown.",
  "Observations are claimed facts; put inference only in evaluation and cite Observation IDs from every inference and Guardrail.",
  "Include at least one Observation, metric, Guardrail, alternative, and Proposed Action. Risks and unknowns are required arrays and may be empty.",
  "Proposed Actions are inert proposals without owner, ETA, command, connector, or execution semantics.",
  "An AI recommendation is not a Human Decision, and run success does not establish a business Outcome.",
].join("\n");
