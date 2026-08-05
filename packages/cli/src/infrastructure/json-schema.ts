import type { ErrorObject } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";

import type { JsonObject, JsonValue } from "../domain/canonical-json.js";
import { KilinError } from "../domain/errors.js";

const maximumPathSegmentLength = 64;

const ajv = new Ajv2020Module.default({
  allErrors: false,
  strict: true,
});

const pointerSegments = (pointer: string): string[] =>
  pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

const appendPathSegment = (path: string, segment: string): string => {
  if (/^(?:0|[1-9]\d*)$/u.test(segment)) {
    return `${path}[${segment}]`;
  }
  return path.length === 0 ? segment : `${path}.${segment}`;
};

const errorPath = (
  error: ErrorObject,
  transformSegment: (segment: string) => string,
): string | undefined => {
  let path = pointerSegments(error.instancePath)
    .map(transformSegment)
    .reduce(appendPathSegment, "");
  const params: Record<string, unknown> = error.params;
  let property: unknown;
  if (error.keyword === "required") {
    property = params.missingProperty;
  } else if (error.keyword === "additionalProperties") {
    property = params.additionalProperty;
  }
  if (typeof property === "string") {
    path = appendPathSegment(path, transformSegment(property));
  }
  return path.length === 0 ? undefined : path;
};

export const schemaErrorPath = (error: ErrorObject): string | undefined =>
  errorPath(error, (segment) => segment);

const sanitizePathSegment = (segment: string): string =>
  Array.from(segment.replaceAll(/\p{Cc}/gu, ""))
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
    ajv.compile(schema);
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
  const validate = ajv.compile(schema);
  if (validate(value)) {
    return undefined;
  }
  const error = validate.errors?.[0];
  if (error === undefined) {
    return { message: "The value does not satisfy the declared schema." };
  }
  const path = errorPath(error, sanitizePathSegment);
  return {
    ...(path === undefined ? {} : { path }),
    message: error.message ?? "The value does not satisfy the declared schema.",
  };
};
