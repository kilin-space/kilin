import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../src/domain/canonical-json.js";
import {
  createAjv,
  schemaErrorPath,
  validateJsonValue,
} from "../../src/infrastructure/json-schema.js";

const firstError = (schema: JsonObject, value: JsonValue): ErrorObject => {
  const validate = createAjv().compile(schema);
  expect(validate(value)).toBe(false);
  const error = validate.errors?.[0];
  if (error === undefined) {
    throw new Error("expected a validation error");
  }
  return error;
};

describe("validateJsonValue", () => {
  it("quotes a dotted member name instead of rendering it as nested segments", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { "a.b": { type: "integer" } },
    };

    const failure = validateJsonValue(schema, { "a.b": "nope" });

    expect(failure?.path).toBe('["a.b"]');
  });

  it("keeps dot notation for real nesting", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { a: { type: "object", properties: { b: { type: "integer" } } } },
    };

    const failure = validateJsonValue(schema, { a: { b: "nope" } });

    expect(failure?.path).toBe("a.b");
  });

  it("quotes a numeric member name instead of rendering it as an array index", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { "0": { type: "integer" } },
    };

    const failure = validateJsonValue(schema, { 0: "nope" });

    expect(failure?.path).toBe('["0"]');
  });

  it("keeps bracket notation for array indices", () => {
    const schema: JsonObject = { type: "array", items: { type: "integer" } };

    const failure = validateJsonValue(schema, [1, "nope"]);

    expect(failure?.path).toBe("[1]");
  });

  it("quotes a dotted required property name", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { "a.b": { type: "integer" } },
      required: ["a.b"],
    };

    const failure = validateJsonValue(schema, {});

    expect(failure?.path).toBe('["a.b"]');
  });
});

describe("schemaErrorPath", () => {
  it("keeps bracket notation for array members of the validated document", () => {
    const value: JsonObject = { nodes: [1] };
    const error = firstError(
      {
        type: "object",
        properties: { nodes: { type: "array", items: { type: "string" } } },
      },
      value,
    );

    expect(schemaErrorPath(error, value)).toBe("nodes[0]");
  });

  it("quotes a dotted member name of the validated document", () => {
    const value: JsonObject = { "a.b": "nope" };
    const error = firstError({ type: "object", properties: { "a.b": { type: "integer" } } }, value);

    expect(schemaErrorPath(error, value)).toBe('["a.b"]');
  });
});
