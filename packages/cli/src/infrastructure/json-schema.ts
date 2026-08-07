import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type { RegExpEngine } from "ajv/dist/types/index.js";

import type { JsonObject, JsonValue } from "../domain/canonical-json.js";
import { KilinError } from "../domain/errors.js";

const maximumPathSegmentLength = 64;
const unsupportedRegularExpressionMessage =
  'The JSON Schema keywords "pattern" and "patternProperties" are not supported because JavaScript regular expressions can block workflow execution.';

export const createAjv = (): InstanceType<typeof Ajv2020Module.default> =>
  new Ajv2020Module.default({
    allErrors: false,
    logger: false,
    strict: true,
  });

const rejectedSchemaRegularExpression: RegExpEngine = () => {
  throw new Error(unsupportedRegularExpressionMessage);
};
rejectedSchemaRegularExpression.code = "new RegExp";

const createValueAjv = (): InstanceType<typeof Ajv2020Module.default> =>
  new Ajv2020Module.default({
    allErrors: false,
    code: { regExp: rejectedSchemaRegularExpression },
    logger: false,
    strict: true,
    validateSchema: false,
  });

const schemaRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const assertNoRegularExpressionKeywords = (root: Readonly<Record<string, unknown>>): void => {
  const pending = [root];
  while (pending.length > 0) {
    const schema = pending.pop();
    if (schema === undefined) {
      continue;
    }
    if (Object.hasOwn(schema, "pattern") || Object.hasOwn(schema, "patternProperties")) {
      throw new Error(unsupportedRegularExpressionMessage);
    }

    for (const keyword of [
      "additionalProperties",
      "unevaluatedProperties",
      "propertyNames",
      "items",
      "contains",
      "unevaluatedItems",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
    ]) {
      const child = schemaRecord(schema[keyword]);
      if (child !== undefined) {
        pending.push(child);
      }
    }
    for (const keyword of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
      const children = schema[keyword];
      if (!Array.isArray(children)) {
        continue;
      }
      for (const childValue of children) {
        const child = schemaRecord(childValue);
        if (child !== undefined) {
          pending.push(child);
        }
      }
    }
    for (const keyword of ["$defs", "definitions", "properties", "dependentSchemas"]) {
      const children = schemaRecord(schema[keyword]);
      if (children === undefined) {
        continue;
      }
      for (const childValue of Object.values(children)) {
        const child = schemaRecord(childValue);
        if (child !== undefined) {
          pending.push(child);
        }
      }
    }
    const dependencies = schemaRecord(schema.dependencies);
    if (dependencies !== undefined) {
      for (const childValue of Object.values(dependencies)) {
        const child = schemaRecord(childValue);
        if (child !== undefined) {
          pending.push(child);
        }
      }
    }
  }
};

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
    const schemaAjv = createAjv();
    if (!schemaAjv.validateSchema(schema)) {
      throw new Error(schemaAjv.errorsText());
    }
    assertNoRegularExpressionKeywords(schema);
    createValueAjv().compile(schema);
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
    validate = createValueAjv().compile(schema);
  } catch {
    return { message: "The declared schema could not be compiled." };
  }
  let isValid: boolean;
  try {
    isValid = validate(value);
  } catch {
    return { message: "The value could not be validated against the declared schema." };
  }
  if (isValid) {
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
