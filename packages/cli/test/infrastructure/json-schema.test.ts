import { execFile } from "node:child_process";
import type { ErrorObject } from "ajv";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "../../src/domain/canonical-json.js";
import {
  assertValidJsonSchema,
  createAjv,
  schemaErrorPath,
  validateJsonValue,
} from "../../src/infrastructure/json-schema.js";

const execFileAsync = promisify(execFile);
const builtJsonSchemaModule = new URL("../../dist/infrastructure/json-schema.js", import.meta.url)
  .href;

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
  it("returns a validation failure when generated validation exhausts the stack", () => {
    const schema: JsonObject = {
      anyOf: [{ type: "array", items: { $ref: "#" } }, { type: "null" }],
    };
    let value: JsonValue = null;
    for (let depth = 0; depth < 4_000; depth += 1) {
      value = [value];
    }

    expect(validateJsonValue(schema, value)).toEqual({
      message: "The value could not be validated against the declared schema.",
    });
  });

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

describe("json schema admission", () => {
  it("rejects regex keywords in unreferenced schema definitions", () => {
    expect(() =>
      assertValidJsonSchema(
        {
          $defs: {
            dormant: { type: "string", pattern: "^(a+)+$" },
          },
          type: "string",
        },
        "an unreferenced definition",
      ),
    ).toThrowError(/pattern.*patternProperties/u);
  });

  it("does not write generated validator source when Ajv compilation fails", async () => {
    const script = `
      const { createAjv } = await import(${JSON.stringify(builtJsonSchemaModule)});
      globalThis.Function = function forcedCompilationFailure() {
        throw new Error("forced validator compilation failure");
      };
      try {
        createAjv().compile({ type: "string" });
      } catch {}
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
  });

  it("rejects hostile regex keywords before validation can block the process", async () => {
    const script = `
      const { assertValidJsonSchema, validateJsonValue } = await import(${JSON.stringify(builtJsonSchemaModule)});
      const cases = [
        [{ type: "string", pattern: "^(a+)+$" }, "a".repeat(27) + "!"],
        [{ type: "object", patternProperties: { "^(a+)+$": true } }, { ["a".repeat(27) + "!"]: null }],
      ];
      for (const [schema, value] of cases) {
        try {
          assertValidJsonSchema(schema, "hostile subprocess schema");
          validateJsonValue(schema, value);
          console.log("accepted");
        } catch (error) {
          console.log(error instanceof Error && "code" in error ? error.code : "unknown");
        }
      }
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 1_000,
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "WORKFLOW_SCHEMA_INVALID",
      "WORKFLOW_SCHEMA_INVALID",
    ]);
  });

  it("rejects hostile regex keywords on the runtime validation path", async () => {
    const script = `
      const { validateJsonValue } = await import(${JSON.stringify(builtJsonSchemaModule)});
      const failures = [
        validateJsonValue({ type: "string", pattern: "^(a+)+$" }, "a".repeat(27) + "!"),
        validateJsonValue(
          { type: "object", patternProperties: { "^(a+)+$": true } },
          { ["a".repeat(27) + "!"]: null },
        ),
      ];
      console.log(JSON.stringify(failures));
    `;

    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 1_000,
      },
    );

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout) as unknown).toEqual([
      { message: "The declared schema could not be compiled." },
      { message: "The declared schema could not be compiled." },
    ]);
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
