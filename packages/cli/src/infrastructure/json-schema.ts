import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

import type { JsonObject, JsonValue } from "../domain/canonical-json.js";
import { KilinError } from "../domain/errors.js";

const maximumPathSegmentLength = 64;

export const createAjv = (): InstanceType<typeof Ajv2020Module.default> =>
  new Ajv2020Module.default({
    allErrors: false,
    strict: true,
  });

const pointerSegments = (pointer: string): string[] =>
  pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

const identifierSegmentPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

const appendMemberSegment = (path: string, segment: string): string =>
  identifierSegmentPattern.test(segment)
    ? path.length === 0
      ? segment
      : `${path}.${segment}`
    : `${path}[${JSON.stringify(segment)}]`;

const errorPath = (
  error: ErrorObject,
  value: unknown,
  transformSegment: (segment: string) => string,
): string | undefined => {
  let path = "";
  let container: unknown = value;
  for (const segment of pointerSegments(error.instancePath)) {
    path = Array.isArray(container)
      ? `${path}[${transformSegment(segment)}]`
      : appendMemberSegment(path, transformSegment(segment));
    container =
      container !== null && typeof container === "object"
        ? (container as Record<string, unknown>)[segment]
        : undefined;
  }
  const params: Record<string, unknown> = error.params;
  let property: unknown;
  if (error.keyword === "required") {
    property = params.missingProperty;
  } else if (error.keyword === "additionalProperties") {
    property = params.additionalProperty;
  }
  if (typeof property === "string") {
    path = appendMemberSegment(path, transformSegment(property));
  }
  return path.length === 0 ? undefined : path;
};

export const schemaErrorPath = (error: ErrorObject, value: unknown): string | undefined =>
  errorPath(error, value, (segment) => segment);

const sanitizePathSegment = (segment: string): string =>
  Array.from(segment.replaceAll(/[\p{Cc}\p{Cf}]/gu, ""))
    .slice(0, maximumPathSegmentLength)
    .join("");

export interface JsonValidationFailure {
  readonly path?: string;
  readonly message: string;
}

export const assertValidJsonSchema = (
  schema: Readonly<Record<string, unknown>>,
  source: string,
): void => {
  try {
    createAjv().compile(schema);
  } catch (error: unknown) {
    throw new KilinError(
      "WORKFLOW_SCHEMA_INVALID",
      `The json output schema ${source} is not a valid JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }. Correct the schema and try again.`,
    );
  }
};

export const validateJsonValue = (
  schema: JsonObject,
  value: JsonValue,
): JsonValidationFailure | undefined => {
  let validate: ValidateFunction;
  try {
    validate = createAjv().compile(schema);
  } catch {
    return { message: "The declared schema could not be compiled." };
  }
  if (validate(value)) {
    return undefined;
  }
  const error = validate.errors?.[0];
  if (error === undefined) {
    return { message: "The value does not satisfy the declared schema." };
  }
  const path = errorPath(error, value, sanitizePathSegment);
  return {
    ...(path === undefined ? {} : { path }),
    message: error.message ?? "The value does not satisfy the declared schema.",
  };
};
