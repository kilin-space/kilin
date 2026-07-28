import { serializeCanonicalJson } from "./canonical-json.js";
import { KilinError } from "./errors.js";
import type { ExecutionPlan } from "./workflow.js";

export const maximumParameterSnapshotBytes = 262_144;

export type RunParameters = Readonly<Record<string, string>>;

export const emptyRunParameters: RunParameters = Object.freeze({});

const invalidParameter = (message: string, path: string): never => {
  throw new KilinError("RUN_PARAM_INVALID", message, path);
};

/**
 * Reads one supplied value by own property only. A bare index read would resolve inherited names
 * such as `constructor` or `toString`, which are legal parameter names under the input-name grammar.
 */
export const runParameterValue = (parameters: RunParameters, name: string): string | undefined =>
  Object.hasOwn(parameters, name) ? parameters[name] : undefined;

/** Canonical invocation snapshot: sorted keys, stable bytes, independent of caller ordering. */
export const canonicalParameterSnapshot = (parameters: RunParameters): string =>
  serializeCanonicalJson({ ...parameters });

export const parameterSnapshotBytes = (parameters: RunParameters): number =>
  Buffer.byteLength(canonicalParameterSnapshot(parameters), "utf8");

/**
 * Validates a run's parameter snapshot against the compiled workflow before the run has any side
 * effect. Rejects unknown names, missing declarations, an oversized snapshot, and any single
 * consumer whose parameter-only envelope already exceeds the run's output-byte limit. The final
 * combined envelope is checked later, once that consumer's producers have settled.
 */
export const assertRunParameters = (
  plan: ExecutionPlan,
  parameters: RunParameters,
  maxOutputBytes: number,
): void => {
  const declared = plan.definition.parameters ?? [];
  const declaredNames = new Set(declared);
  const supplied = Object.keys(parameters).sort();

  const unknownName = supplied.find((name) => !declaredNames.has(name));
  if (unknownName !== undefined) {
    invalidParameter(
      `Parameter "${unknownName}" is not declared by workflow "${plan.definition.workflow.id}". Remove it or declare it in the workflow.`,
      `parameters.${unknownName}`,
    );
  }
  const missingName = declared.find((name) => runParameterValue(parameters, name) === undefined);
  if (missingName !== undefined) {
    invalidParameter(
      `Workflow "${plan.definition.workflow.id}" requires parameter "${missingName}". Supply it with --param ${missingName}=<value>.`,
      `parameters.${missingName}`,
    );
  }

  const snapshotBytes = parameterSnapshotBytes(parameters);
  if (snapshotBytes > maximumParameterSnapshotBytes) {
    invalidParameter(
      `The parameter snapshot is ${String(snapshotBytes)} bytes and exceeds the ${String(maximumParameterSnapshotBytes)} byte limit. Shorten the supplied values.`,
      "parameters",
    );
  }
  if (snapshotBytes > maxOutputBytes) {
    invalidParameter(
      `The parameter snapshot is ${String(snapshotBytes)} bytes and exceeds the run output-byte limit of ${String(maxOutputBytes)}. Shorten the values or choose a larger limit.`,
      "parameters",
    );
  }

  for (const { node } of plan.nodes) {
    if (node.kind !== "agent" || node.parameters === undefined) {
      continue;
    }
    const inputs: Record<string, { type: "text"; value: string }> = {};
    for (const name of node.parameters) {
      const value = runParameterValue(parameters, name);
      if (value === undefined) {
        continue;
      }
      inputs[name] = { type: "text", value };
    }
    const envelopeBytes = Buffer.byteLength(serializeCanonicalJson({ inputs, version: 1 }), "utf8");
    if (envelopeBytes > maxOutputBytes) {
      invalidParameter(
        `Node "${node.id}" would receive a ${String(envelopeBytes)} byte parameter envelope, which exceeds the run output-byte limit of ${String(maxOutputBytes)}. Shorten the values or choose a larger limit.`,
        "parameters",
      );
    }
  }
};

/** Revalidates a snapshot recovered from storage before it is reused or copied into a new run. */
export const parsedStoredParameters = (value: unknown): RunParameters | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, parameterValue] of entries) {
    if (typeof parameterValue !== "string") {
      return undefined;
    }
    parameters[name] = parameterValue;
  }
  return parameters;
};
