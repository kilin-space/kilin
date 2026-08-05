import { open } from "node:fs/promises";

import type { SchemaObject } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import { isScalar, LineCounter, parseAllDocuments, visit } from "yaml";
import type { ErrorCode as YamlErrorCode } from "yaml";

import { KilinError } from "../domain/errors.js";
import type { WorkflowCompilationInput } from "../domain/workflow.js";
import { schemaErrorPath } from "./json-schema.js";
import workflowSchema from "./workflow-v1.schema.json" with { type: "json" };

const decoder = new TextDecoder("utf-8", { fatal: true });
const coreTagPrefix = "tag:yaml.org,2002:";

export const maximumWorkflowDefinitionBytes = 1_048_576;

const yamlErrorReasons: Partial<Record<YamlErrorCode, string>> = {
  BAD_ALIAS: "aliases are not allowed",
  DUPLICATE_KEY: "duplicate mapping keys are not allowed",
  MULTIPLE_DOCS: "exactly one YAML document is required",
  TAG_RESOLVE_FAILED: "custom YAML tags are not allowed",
};

const parseSchema = (schema: unknown): SchemaObject => {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("The bundled workflow schema is not a JSON object");
  }
  return schema;
};

const validateWorkflow = new Ajv2020Module.default({
  allErrors: false,
  strict: true,
}).compile<WorkflowCompilationInput>(parseSchema(workflowSchema));

const sourcePosition = (lineCounter: LineCounter, offset: number | undefined): string => {
  if (offset === undefined || offset < 0) {
    return "";
  }
  const { line, col } = lineCounter.linePos(offset);
  return ` at line ${String(line)}, column ${String(col)}`;
};

const throwParseError = (source: string, reason: string, position = ""): never => {
  throw new KilinError(
    "WORKFLOW_PARSE_FAILED",
    `${source} is not valid safe YAML${position}: ${reason}. Fix the YAML and try again.`,
  );
};

const throwDefinitionTooLarge = (source: string): never =>
  throwParseError(
    source,
    `the definition exceeds the ${String(maximumWorkflowDefinitionBytes)} byte limit`,
  );

const throwYamlError = (
  source: string,
  code: YamlErrorCode,
  offset: number,
  lineCounter: LineCounter,
): never =>
  throwParseError(
    source,
    yamlErrorReasons[code] ?? "the YAML syntax is invalid",
    sourcePosition(lineCounter, offset),
  );

const decodeWorkflowBytes = (bytes: Uint8Array, source: string): string => {
  try {
    return decoder.decode(bytes);
  } catch {
    return throwParseError(source, "the file is not valid UTF-8");
  }
};

const rejectProhibitedYaml = (
  document: ReturnType<typeof parseAllDocuments>[number],
  source: string,
  lineCounter: LineCounter,
): void => {
  let prohibitedSyntax: string | undefined;
  let prohibitedOffset: number | undefined;
  visit(document, {
    Alias: (_key, node) => {
      prohibitedSyntax ??= "aliases are not allowed";
      prohibitedOffset ??= node.range?.[0];
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor !== undefined) {
        prohibitedSyntax ??= "anchors are not allowed";
        prohibitedOffset ??= node.range?.[0];
        return visit.BREAK;
      }
      if (node.tag !== undefined && !node.tag.startsWith(coreTagPrefix)) {
        prohibitedSyntax ??= "custom tags are not allowed";
        prohibitedOffset ??= node.range?.[0];
        return visit.BREAK;
      }
      return undefined;
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        prohibitedSyntax ??= "merge keys are not allowed";
        prohibitedOffset ??= pair.key.range?.[0];
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (prohibitedSyntax !== undefined) {
    throwParseError(source, prohibitedSyntax, sourcePosition(lineCounter, prohibitedOffset));
  }
};

export const parseWorkflowBytes = (
  bytes: Uint8Array,
  source = "Workflow source",
): WorkflowCompilationInput => {
  if (bytes.byteLength > maximumWorkflowDefinitionBytes) {
    throwDefinitionTooLarge(source);
  }
  const yamlSource = decodeWorkflowBytes(bytes, source);
  const lineCounter = new LineCounter();

  const documents = parseAllDocuments(yamlSource, {
    lineCounter,
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    throwParseError(
      source,
      "exactly one YAML document is required",
      sourcePosition(lineCounter, documents.at(1)?.range[0]),
    );
  }

  const document = documents[0];
  if (document === undefined) {
    return throwParseError(source, "exactly one YAML document is required");
  }
  const parseError = document.errors[0];
  if (parseError !== undefined) {
    throwYamlError(source, parseError.code, parseError.pos[0], lineCounter);
  }
  rejectProhibitedYaml(document, source, lineCounter);

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!validateWorkflow(value)) {
    const schemaError = validateWorkflow.errors?.[0];
    const path = schemaError === undefined ? undefined : schemaErrorPath(schemaError);
    const location = path === undefined ? "the workflow root" : `"${path}"`;
    const reason =
      schemaError?.message ?? "the definition does not match workflow schema version 1";
    throw new KilinError(
      "WORKFLOW_SCHEMA_INVALID",
      `${source} is invalid at ${location}: ${reason}. Fix the workflow definition and try again.`,
      path,
    );
  }
  return value;
};

export const readWorkflowSource = async (file: string): Promise<WorkflowCompilationInput> => {
  let bytes: Uint8Array;
  try {
    const handle = await open(file, "r");
    try {
      if ((await handle.stat()).size > maximumWorkflowDefinitionBytes) {
        throwDefinitionTooLarge(file);
      }
      const buffer = new Uint8Array(maximumWorkflowDefinitionBytes + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const result = await handle.read(buffer, offset, buffer.byteLength - offset, null);
        if (result.bytesRead === 0) {
          break;
        }
        offset += result.bytesRead;
      }
      bytes = buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (error instanceof KilinError) {
      throw error;
    }
    throw new KilinError(
      "WORKFLOW_SOURCE_NOT_FOUND",
      `Could not read workflow source "${file}". Check that the file exists and is readable, then try again.`,
    );
  }
  return parseWorkflowBytes(bytes, file);
};
