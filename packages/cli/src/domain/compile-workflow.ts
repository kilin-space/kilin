import { createHash } from "node:crypto";

import { serializeCanonicalJson, type JsonObject } from "./canonical-json.js";
import { KilinError } from "./errors.js";
import type {
  AgentNode,
  AgentOutputDeclaration,
  AgentOutputDeclarationInput,
  AgentRetryPolicy,
  ApprovalNode,
  DependencyEdge,
  ExecutionNode,
  ExecutionPlan,
  InputBinding,
  LoopBody,
  LoopControlNode,
  LoopNode,
  LoopNodeInput,
  NodeAccess,
  NodeJoin,
  PlannedLoop,
  PlannedNode,
  RuntimeId,
  RetryableFailureCode,
  WorkflowCompilationInput,
  WorkflowDefinitionV1,
  WorkflowExecutionDefinition,
  WorkflowNode,
  WorkflowNodeInput,
} from "./workflow.js";
import { isWorkflowNodeIdentifier, retryableFailureCodes, runtimeIds } from "./workflow.js";
import { isLowercaseIdentifier, isWorkflowKebabId } from "./workflow-package.js";

interface Graph {
  outgoing: number[][];
  incoming: number[][];
  order: number[];
}

const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const rootFields = new Set(["schemaVersion", "workflow", "parameters", "nodes", "edges"]);
const workflowFields = new Set(["id", "name"]);
const agentNodeFields = new Set([
  "id",
  "kind",
  "runtime",
  "access",
  "prompt",
  "timeoutMs",
  "model",
  "output",
  "retry",
  "join",
  "workspace",
  "parameters",
]);
const loopNodeFields = new Set([
  "id",
  "kind",
  "maxIterations",
  "body",
  "decision",
  "feedback",
  "result",
]);
const loopBodyFields = new Set(["nodes", "edges"]);
const loopDecisionFields = new Set(["node", "passChoice", "reviseChoice"]);
const loopFeedbackFields = new Set(["from", "to", "input"]);
const loopResultFields = new Set(["node"]);
const approvalNodeFields = new Set(["id", "kind", "question", "join"]);
const outputFields = new Set(["type", "path", "choices"]);
const maximumDeclaredParameters = 32;
const maximumLoopBodyNodes = 128;
const maximumLoopBodyEdges = 512;
const maximumCompiledExecutions = 256;
const maximumCompiledEdges = 1_024;
const minimumAgentTimeoutMs = 1_000;
const maximumAgentTimeoutMs = 86_400_000;

const retryFields = new Set([
  "maxAttempts",
  "initialBackoffMs",
  "maxBackoffMs",
  "on",
  "safeToRepeat",
]);
const edgeFields = new Set(["from", "to", "input", "when"]);
const conditionFields = new Set(["choice"]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isLoopNodeInput = (node: WorkflowCompilationInput["nodes"][number]): node is LoopNodeInput =>
  node.kind === "loop" && "body" in node;

const invalidStructure = (message: string, path?: string): never => {
  throw new KilinError(
    "WORKFLOW_GRAPH_INVALID",
    `${message} Correct the workflow definition and try again.`,
    path,
  );
};

const rejectUnknownField = (
  value: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlySet<string>,
  subject: string,
  path: string,
): void => {
  const field = Object.keys(value).find((candidate) => !allowedFields.has(candidate));
  if (field !== undefined) {
    const fieldPath = path.length === 0 ? field : `${path}.${field}`;
    invalidStructure(
      `${subject} declares unsupported field "${field}". Remove that field.`,
      fieldPath,
    );
  }
};

const validWorkflowIdentifier = (value: unknown): value is string =>
  typeof value === "string" && isWorkflowKebabId(value);

const validateCompilationStructure = (value: unknown): WorkflowCompilationInput => {
  if (!isRecord(value)) {
    return invalidStructure("The workflow root must be an object.");
  }
  rejectUnknownField(value, rootFields, "The workflow root", "");
  if (value.schemaVersion !== 1) {
    return invalidStructure("The workflow schemaVersion must be 1.", "schemaVersion");
  }

  const metadata = value.workflow;
  if (!isRecord(metadata)) {
    return invalidStructure("The workflow metadata must be an object.", "workflow");
  }
  rejectUnknownField(metadata, workflowFields, "The workflow metadata", "workflow");
  if (!validWorkflowIdentifier(metadata.id)) {
    return invalidStructure(
      "The workflow ID must contain 1 through 64 lowercase ASCII letters, digits, or single hyphen-separated segments.",
      "workflow.id",
    );
  }
  if (
    typeof metadata.name !== "string" ||
    Array.from(metadata.name).length < 1 ||
    Array.from(metadata.name).length > 200
  ) {
    return invalidStructure(
      "The workflow name must contain 1 through 200 characters.",
      "workflow.name",
    );
  }
  if (value.parameters !== undefined && !isUnknownArray(value.parameters)) {
    return invalidStructure("The workflow parameters must be an array of names.", "parameters");
  }
  const nodes = value.nodes;
  if (!isUnknownArray(nodes) || nodes.length === 0) {
    return invalidStructure("The workflow must declare at least one node.", "nodes");
  }
  nodes.forEach((nodeValue, index) => {
    const nodePath = `nodes[${String(index)}]`;
    if (!isRecord(nodeValue)) {
      return invalidStructure("Every workflow node must be an object.", nodePath);
    }
    const node = nodeValue;
    const nodeId = node.id;
    if (!isWorkflowNodeIdentifier(nodeId)) {
      return invalidStructure(
        "Every node ID must contain 1 through 128 ASCII letters, digits, dots, underscores, or hyphens and begin with a letter or digit.",
        `${nodePath}.id`,
      );
    }
    if (typeof node.kind !== "string") {
      invalidStructure("Every node kind must be a string.", `${nodePath}.kind`);
    }
    if (node.kind === "agent") {
      rejectUnknownField(node, agentNodeFields, `Agent node "${nodeId}"`, nodePath);
      if (typeof node.prompt === "string" && Array.from(node.prompt).length > 65_536) {
        invalidStructure(
          `Node "${nodeId}" has a prompt longer than 65,536 characters. Shorten the prompt.`,
          `${nodePath}.prompt`,
        );
      }
      if (
        node.model !== undefined &&
        (typeof node.model !== "string" ||
          node.model.length > 128 ||
          !modelPattern.test(node.model))
      ) {
        invalidStructure(
          `Node "${nodeId}" has an invalid model. Use 1 through 128 supported identifier characters.`,
          `${nodePath}.model`,
        );
      }
      if (node.output !== undefined) {
        const output = node.output;
        if (!isRecord(output)) {
          return invalidStructure(
            `Node "${nodeId}" output must be an object.`,
            `${nodePath}.output`,
          );
        }
        rejectUnknownField(output, outputFields, `Node "${nodeId}" output`, `${nodePath}.output`);
      }
      if (node.retry !== undefined) {
        if (!isRecord(node.retry)) {
          return invalidStructure(
            `Node "${nodeId}" retry policy must be an object.`,
            `${nodePath}.retry`,
          );
        }
        rejectUnknownField(
          node.retry,
          retryFields,
          `Node "${nodeId}" retry policy`,
          `${nodePath}.retry`,
        );
      }
    } else if (node.kind === "approval") {
      rejectUnknownField(node, approvalNodeFields, `Approval node "${nodeId}"`, nodePath);
    } else if (node.kind === "loop") {
      rejectUnknownField(node, loopNodeFields, `Loop node "${nodeId}"`, nodePath);
      const body = node.body;
      if (!isRecord(body)) {
        invalidStructure(`Loop node "${nodeId}" body must be an object.`, `${nodePath}.body`);
      }
      const bodyRecord = body as Readonly<Record<string, unknown>>;
      rejectUnknownField(
        bodyRecord,
        loopBodyFields,
        `Loop node "${nodeId}" body`,
        `${nodePath}.body`,
      );
      if (!isUnknownArray(bodyRecord.nodes) || bodyRecord.nodes.length === 0) {
        invalidStructure(
          `Loop node "${nodeId}" body must declare at least one node.`,
          `${nodePath}.body.nodes`,
        );
      }
      if (!isUnknownArray(bodyRecord.edges)) {
        invalidStructure(
          `Loop node "${nodeId}" body edges must be an array.`,
          `${nodePath}.body.edges`,
        );
      }
      for (const [field, allowedFields] of [
        ["decision", loopDecisionFields],
        ["feedback", loopFeedbackFields],
        ["result", loopResultFields],
      ] as const) {
        const contract = node[field];
        if (!isRecord(contract)) {
          invalidStructure(
            `Loop node "${nodeId}" ${field} must be an object.`,
            `${nodePath}.${field}`,
          );
        }
        rejectUnknownField(
          contract as Readonly<Record<string, unknown>>,
          allowedFields,
          `Loop node "${nodeId}" ${field}`,
          `${nodePath}.${field}`,
        );
      }
    }
  });

  const edges = value.edges;
  if (!isUnknownArray(edges)) {
    return invalidStructure("The workflow edges must be an array.", "edges");
  }
  edges.forEach((edgeValue, index) => {
    const edgePath = `edges[${String(index)}]`;
    if (!isRecord(edgeValue)) {
      return invalidStructure("Every workflow edge must be an object.", edgePath);
    }
    const edge = edgeValue;
    rejectUnknownField(edge, edgeFields, "A workflow edge", edgePath);
    if (!isWorkflowNodeIdentifier(edge.from)) {
      invalidStructure("Every edge source must be a valid node ID.", `${edgePath}.from`);
    }
    if (!isWorkflowNodeIdentifier(edge.to)) {
      invalidStructure("Every edge target must be a valid node ID.", `${edgePath}.to`);
    }
    if (
      edge.input !== undefined &&
      (typeof edge.input !== "string" || !isLowercaseIdentifier(edge.input))
    ) {
      invalidStructure(
        "Every edge input must be a lowercase name beginning with a letter and containing at most 64 letters, digits, or underscores.",
        `${edgePath}.input`,
      );
    }
    const condition = edge.when;
    if (condition !== undefined) {
      if (isRecord(condition)) {
        rejectUnknownField(condition, conditionFields, "An edge condition", `${edgePath}.when`);
      } else {
        invalidStructure("Every edge condition must be an object.", `${edgePath}.when`);
      }
    }
  });

  return value as unknown as WorkflowCompilationInput;
};

const compareEdges = (left: DependencyEdge, right: DependencyEdge): number => {
  if (left.from !== right.from) {
    return left.from < right.from ? -1 : 1;
  }
  if (left.to !== right.to) {
    return left.to < right.to ? -1 : 1;
  }
  const leftInput = left.input ?? "";
  const rightInput = right.input ?? "";
  if (leftInput !== rightInput) {
    return leftInput < rightInput ? -1 : 1;
  }
  const leftChoice = left.when?.choice ?? "";
  const rightChoice = right.when?.choice ?? "";
  if (leftChoice === rightChoice) {
    return 0;
  }
  return leftChoice < rightChoice ? -1 : 1;
};

const canonicalNode = (node: WorkflowNode): JsonObject => {
  if (node.kind === "approval") {
    return {
      id: node.id,
      ...(node.join === undefined ? {} : { join: node.join }),
      kind: node.kind,
      question: node.question,
    };
  }
  if (node.kind === "loop") {
    return {
      body: {
        edges: [...node.body.edges].sort(compareEdges).map(canonicalEdge),
        nodes: node.body.nodes.map(canonicalNode),
      },
      decision: {
        node: node.decision.node,
        passChoice: node.decision.passChoice,
        reviseChoice: node.decision.reviseChoice,
      },
      feedback: {
        from: node.feedback.from,
        input: node.feedback.input,
        to: node.feedback.to,
      },
      id: node.id,
      kind: node.kind,
      maxIterations: node.maxIterations,
      result: { node: node.result.node },
    };
  }
  const result: JsonObject = {
    access: node.access,
    id: node.id,
    kind: node.kind,
    prompt: node.prompt,
    runtime: node.runtime,
  };
  if (node.model !== undefined) {
    result.model = node.model;
  }
  if (node.timeoutMs !== undefined) {
    result.timeoutMs = node.timeoutMs;
  }
  if (node.output !== undefined) {
    if (node.output.type === "artifact") {
      result.output = { path: node.output.path, type: node.output.type };
    } else if (node.output.type === "choice") {
      result.output = { choices: [...node.output.choices], type: node.output.type };
    } else {
      result.output = { type: node.output.type };
    }
  }
  if (node.retry !== undefined) {
    result.retry = {
      initialBackoffMs: node.retry.initialBackoffMs,
      maxAttempts: node.retry.maxAttempts,
      maxBackoffMs: node.retry.maxBackoffMs,
      ...(node.retry.on === undefined ? {} : { on: [...node.retry.on] }),
      safeToRepeat: node.retry.safeToRepeat,
    };
  }
  if (node.join !== undefined) {
    result.join = node.join;
  }
  if (node.workspace !== undefined) {
    result.workspace = node.workspace;
  }
  if (node.parameters !== undefined) {
    result.parameters = [...node.parameters].sort();
  }
  return result;
};

const canonicalEdge = (edge: DependencyEdge): JsonObject => ({
  from: edge.from,
  ...(edge.input === undefined ? {} : { input: edge.input }),
  to: edge.to,
  ...(edge.when === undefined ? {} : { when: { choice: edge.when.choice } }),
});

const canonicalDefinition = (definition: WorkflowDefinitionV1): JsonObject => {
  const metadata: JsonObject = {
    id: definition.workflow.id,
    name: definition.workflow.name,
  };

  return {
    edges: [...definition.edges].sort(compareEdges).map(canonicalEdge),
    nodes: definition.nodes.map(canonicalNode),
    ...(definition.parameters === undefined
      ? {}
      : { parameters: [...definition.parameters].sort() }),
    schemaVersion: definition.schemaVersion,
    workflow: metadata,
  };
};

const pushHeap = (heap: number[], value: number): void => {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (parentValue === undefined || parentValue <= value) {
      break;
    }
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
};

const popHeap = (heap: number[]): number | undefined => {
  const minimum = heap[0];
  const last = heap.pop();
  if (minimum === undefined || last === undefined || heap.length === 0) {
    return minimum;
  }

  let index = 0;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) {
      break;
    }
    const right = left + 1;
    const leftValue = heap[left];
    const rightValue = heap[right];
    if (leftValue === undefined) {
      break;
    }
    const child = rightValue !== undefined && rightValue < leftValue ? right : left;
    const childValue = heap[child];
    if (childValue === undefined || childValue >= last) {
      break;
    }
    heap[index] = childValue;
    index = child;
  }
  heap[index] = last;
  return minimum;
};

const visit = (start: number, adjacency: number[][]): Set<number> => {
  const visited = new Set<number>([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    for (const next of adjacency[current] ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        pending.push(next);
      }
    }
  }
  return visited;
};

const isRuntimeId = (runtime: string): runtime is RuntimeId =>
  runtimeIds.some((candidate) => candidate === runtime);

const isRetryableFailureCode = (code: unknown): code is RetryableFailureCode =>
  typeof code === "string" && retryableFailureCodes.some((candidate) => candidate === code);

const validatedRuntime = (runtime: unknown, nodeId: string, index: number): RuntimeId => {
  if (typeof runtime !== "string" || !isRuntimeId(runtime)) {
    const problem =
      typeof runtime === "string"
        ? `uses unsupported runtime "${runtime}"`
        : "does not declare a runtime";
    throw new KilinError(
      "RUNTIME_UNSUPPORTED",
      `Node "${nodeId}" ${problem}. Use codex, claude-code, or opencode.`,
      `nodes[${String(index)}].runtime`,
    );
  }
  return runtime;
};

const validatedAccess = (access: unknown, nodeId: string, index: number): NodeAccess => {
  if (access !== "read_only" && access !== "workspace_write") {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" has invalid access. Use read_only or workspace_write.`,
      `nodes[${String(index)}].access`,
    );
  }
  return access;
};

const validatedPrompt = (prompt: unknown, nodeId: string, index: number): string => {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" has an empty prompt. Add an instruction for the runtime.`,
      `nodes[${String(index)}].prompt`,
    );
  }
  return prompt;
};

const validatedApprovalQuestion = (question: unknown, nodeId: string, index: number): string => {
  if (
    typeof question !== "string" ||
    question.trim().length === 0 ||
    Array.from(question).length > 2_000
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Approval node "${nodeId}" has an invalid question. Use 1 through 2,000 characters with at least one non-whitespace character.`,
      `nodes[${String(index)}].question`,
    );
  }
  return question;
};

const validatedJoin = (join: unknown, nodeId: string, index: number): NodeJoin => {
  if (join === undefined) {
    return "all";
  }
  if (join !== "all" && join !== "any") {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" has invalid join semantics. Use "all" or "any".`,
      `nodes[${String(index)}].join`,
    );
  }
  return join;
};

const validatedWorkspace = (
  workspace: unknown,
  nodeId: string,
  index: number,
): string | undefined => {
  if (workspace === undefined) {
    return undefined;
  }
  if (typeof workspace !== "string" || !isLowercaseIdentifier(workspace)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" has an invalid workspace ID. Use 1 through 64 lowercase ASCII letters, digits, or underscores, beginning with a letter.`,
      `nodes[${String(index)}].workspace`,
    );
  }
  if (workspace === "source") {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" explicitly selects reserved workspace "source". Remove workspace to use the source workspace.`,
      `nodes[${String(index)}].workspace`,
    );
  }
  return workspace;
};

const validatedAgentTimeout = (
  timeoutMs: unknown,
  nodeId: string,
  index: number,
): number | undefined => {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (
    !Number.isInteger(timeoutMs) ||
    (timeoutMs as number) < minimumAgentTimeoutMs ||
    (timeoutMs as number) > maximumAgentTimeoutMs
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" timeoutMs must be an integer from 1000 through 86400000 milliseconds.`,
      `nodes[${String(index)}].timeoutMs`,
    );
  }
  return timeoutMs as number;
};

const validatedOutput = (
  output: AgentOutputDeclarationInput | undefined,
  nodeId: string,
  index: number,
): AgentOutputDeclaration | undefined => {
  if (output === undefined) {
    return undefined;
  }
  if (
    output.type !== "text" &&
    output.type !== "json" &&
    output.type !== "decision_packet" &&
    output.type !== "artifact" &&
    output.type !== "choice"
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" uses unsupported output type "${output.type}". Use type "text", "json", "decision_packet", "artifact", or "choice".`,
      `nodes[${String(index)}].output.type`,
    );
  }
  if (output.type === "choice") {
    const choicesPath = `nodes[${String(index)}].output.choices`;
    if (
      !isUnknownArray(output.choices) ||
      output.choices.length < 2 ||
      output.choices.length > 32
    ) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" choice output must declare 2 through 32 choices.`,
        choicesPath,
      );
    }
    const choices: string[] = [];
    const seen = new Set<string>();
    output.choices.forEach((choice, choiceIndex) => {
      const choicePath = `${choicesPath}[${String(choiceIndex)}]`;
      if (typeof choice !== "string" || !isLowercaseIdentifier(choice)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Node "${nodeId}" has invalid choice "${choice}". Use 1 through 64 lowercase ASCII letters, digits, or underscores, beginning with a letter.`,
          choicePath,
        );
      }
      if (seen.has(choice)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Node "${nodeId}" declares duplicate choice "${choice}". Remove the duplicate.`,
          choicePath,
        );
      }
      seen.add(choice);
      choices.push(choice);
    });
    if (output.path !== undefined) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" declares a path for choice output. Remove the output path.`,
        `nodes[${String(index)}].output.path`,
      );
    }
    return { type: "choice", choices };
  }
  if (output.choices !== undefined) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" declares choices for ${output.type} output. Remove the choices.`,
      `nodes[${String(index)}].output.choices`,
    );
  }
  if (output.type === "artifact") {
    const errorPath = `nodes[${String(index)}].output.path`;
    const errorMessage = `Node "${nodeId}" has an invalid artifact output path. Use 1 through 1,024 UTF-8 bytes in normalized POSIX-relative form with no leading or trailing "/", non-empty segments, "/" separators, and no ".", "..", backslash, or control characters.`;
    const artifactPath = output.path;
    if (typeof artifactPath !== "string") {
      throw new KilinError("WORKFLOW_GRAPH_INVALID", errorMessage, errorPath);
    }
    const segments = artifactPath.split("/");
    const byteLength = Buffer.byteLength(artifactPath, "utf8");
    const hasControlCharacter = Array.from(artifactPath).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (
      byteLength < 1 ||
      byteLength > 1_024 ||
      artifactPath.startsWith("/") ||
      artifactPath.endsWith("/") ||
      artifactPath.includes("\\") ||
      hasControlCharacter ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new KilinError("WORKFLOW_GRAPH_INVALID", errorMessage, errorPath);
    }
    return { type: "artifact", path: artifactPath };
  }
  if (output.path !== undefined) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" declares a path for ${output.type} output. Remove the output path.`,
      `nodes[${String(index)}].output.path`,
    );
  }
  return { type: output.type };
};

const validatedRetryInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  nodeId: string,
  field: "maxAttempts" | "initialBackoffMs" | "maxBackoffMs",
  index: number,
): number => {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" retry.${field} must be an integer from ${String(minimum)} through ${String(maximum)}.`,
      `nodes[${String(index)}].retry.${field}`,
    );
  }
  return value as number;
};

const validatedRetry = (
  retry: unknown,
  nodeId: string,
  index: number,
  access: NodeAccess,
): AgentRetryPolicy | undefined => {
  if (retry === undefined) {
    return undefined;
  }
  const retryPath = `nodes[${String(index)}].retry`;
  if (!isRecord(retry)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" retry policy must be an object.`,
      retryPath,
    );
  }
  rejectUnknownField(retry, retryFields, `Node "${nodeId}" retry policy`, retryPath);

  const maxAttempts = validatedRetryInteger(retry.maxAttempts, 1, 5, nodeId, "maxAttempts", index);
  const initialBackoffMs = validatedRetryInteger(
    retry.initialBackoffMs,
    0,
    300_000,
    nodeId,
    "initialBackoffMs",
    index,
  );
  const maxBackoffMs = validatedRetryInteger(
    retry.maxBackoffMs,
    0,
    300_000,
    nodeId,
    "maxBackoffMs",
    index,
  );
  if (maxBackoffMs < initialBackoffMs) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" retry.maxBackoffMs must be greater than or equal to retry.initialBackoffMs.`,
      `${retryPath}.maxBackoffMs`,
    );
  }
  if (retry.safeToRepeat !== true) {
    const reason =
      access === "workspace_write"
        ? "A workspace_write node can retry only when safeToRepeat is true."
        : "Set safeToRepeat to true to acknowledge that repeating the node is safe.";
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" has an unsafe retry policy. ${reason}`,
      `${retryPath}.safeToRepeat`,
    );
  }

  let on: AgentRetryPolicy["on"];
  if (retry.on !== undefined) {
    if (!isUnknownArray(retry.on)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" retry.on must be an array of Kilin error codes.`,
        `${retryPath}.on`,
      );
    }
    on = retry.on.map((code, errorIndex) => {
      if (!isRetryableFailureCode(code)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Node "${nodeId}" retry.on contains non-retryable failure code "${String(code)}". Choose NODE_OUTPUT_INVALID, NODE_EXIT_NONZERO, or NODE_TIMEOUT.`,
          `${retryPath}.on[${String(errorIndex)}]`,
        );
      }
      return code;
    });
  }

  return {
    maxAttempts,
    initialBackoffMs,
    maxBackoffMs,
    ...(on === undefined ? {} : { on }),
    safeToRepeat: true,
  };
};

const validatedDeclaredParameters = (
  definition: WorkflowCompilationInput,
): string[] | undefined => {
  const declared = definition.parameters;
  if (declared === undefined) {
    return undefined;
  }
  if (declared.length === 0 || declared.length > maximumDeclaredParameters) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `The workflow must declare 1 through ${String(maximumDeclaredParameters)} parameters. Remove the parameters field or list a bounded set of names.`,
      "parameters",
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  declared.forEach((name, index) => {
    const path = `parameters[${String(index)}]`;
    if (typeof name !== "string" || !isLowercaseIdentifier(name)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `The workflow declares invalid parameter "${String(name)}". Use a lowercase name beginning with a letter and containing at most 64 letters, digits, or underscores.`,
        path,
      );
    }
    if (seen.has(name)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `The workflow declares duplicate parameter "${name}". Remove the duplicate.`,
        path,
      );
    }
    seen.add(name);
    names.push(name);
  });
  return names.sort();
};

const validatedConsumedParameters = (
  parameters: unknown,
  nodeId: string,
  index: number,
  declared: ReadonlySet<string>,
): string[] | undefined => {
  if (parameters === undefined) {
    return undefined;
  }
  const parametersPath = `nodes[${String(index)}].parameters`;
  if (!isUnknownArray(parameters)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" parameters must be an array of names.`,
      parametersPath,
    );
  }
  if (parameters.length === 0 || parameters.length > maximumDeclaredParameters) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Node "${nodeId}" must consume 1 through ${String(maximumDeclaredParameters)} declared parameters. Remove the parameters field or list the names it needs.`,
      parametersPath,
    );
  }
  const names: string[] = [];
  const seen = new Set<string>();
  parameters.forEach((name, nameIndex) => {
    const path = `${parametersPath}[${String(nameIndex)}]`;
    if (typeof name !== "string" || !isLowercaseIdentifier(name)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" consumes invalid parameter "${String(name)}". Use a lowercase name beginning with a letter and containing at most 64 letters, digits, or underscores.`,
        path,
      );
    }
    if (!declared.has(name)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" consumes undeclared parameter "${name}". Add it to the workflow parameters or remove the consumer.`,
        path,
      );
    }
    if (seen.has(name)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${nodeId}" consumes duplicate parameter "${name}". Remove the duplicate.`,
        path,
      );
    }
    seen.add(name);
    names.push(name);
  });
  return names.sort();
};

const validateParameterConsumers = (
  definition: WorkflowDefinitionV1,
  authoredParameters: readonly unknown[] | undefined,
): void => {
  const declared = definition.parameters;
  if (declared === undefined || authoredParameters === undefined) {
    return;
  }
  const consumed = new Set<string>();
  const collectConsumers = (nodes: readonly WorkflowNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "loop") {
        collectConsumers(node.body.nodes);
      } else if (node.kind === "agent" && node.parameters !== undefined) {
        for (const name of node.parameters) {
          consumed.add(name);
        }
      }
    }
  };
  collectConsumers(definition.nodes);
  const orphan = declared.find((name) => !consumed.has(name));
  if (orphan !== undefined) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Parameter "${orphan}" has no consumer. List it in an agent node's parameters or remove the declaration.`,
      // `declared` is canonically sorted, so the reported path must address the authored order.
      `parameters[${String(authoredParameters.indexOf(orphan))}]`,
    );
  }
};

const rebaseLoopError = (error: unknown, loopPath: string): never => {
  if (!(error instanceof KilinError)) {
    throw error;
  }
  const path =
    error.path === undefined
      ? loopPath
      : error.path.startsWith("nodes") || error.path.startsWith("edges")
        ? `${loopPath}.body.${error.path}`
        : error.path;
  throw new KilinError(error.code, error.message, path);
};

const validatedLoopReference = (value: unknown, path: string, subject: string): string => {
  if (!isWorkflowNodeIdentifier(value)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `${subject} must name a declared body node.`,
      path,
    );
  }
  return value;
};

const validatedLoopChoice = (value: unknown, path: string, subject: string): string => {
  if (typeof value !== "string" || !isLowercaseIdentifier(value)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `${subject} must be a lowercase choice name.`,
      path,
    );
  }
  return value;
};

const validatedLoop = (
  input: LoopNodeInput,
  index: number,
  definition: WorkflowCompilationInput,
): LoopNode => {
  const loopPath = `nodes[${String(index)}]`;
  if (
    !Number.isInteger(input.maxIterations) ||
    (input.maxIterations as number) < 1 ||
    (input.maxIterations as number) > 5
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" maxIterations must be an integer from 1 through 5.`,
      `${loopPath}.maxIterations`,
    );
  }
  if (
    !isRecord(input.body) ||
    !isUnknownArray(input.body.nodes) ||
    !isUnknownArray(input.body.edges)
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" body must contain node and edge arrays.`,
      `${loopPath}.body`,
    );
  }
  if (input.body.nodes.length > maximumLoopBodyNodes) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" body declares ${String(input.body.nodes.length)} nodes, exceeding the limit of ${String(maximumLoopBodyNodes)}.`,
      `${loopPath}.body.nodes`,
    );
  }
  if (input.body.edges.length > maximumLoopBodyEdges) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" body declares ${String(input.body.edges.length)} edges, exceeding the limit of ${String(maximumLoopBodyEdges)}.`,
      `${loopPath}.body.edges`,
    );
  }
  const nestedIndex = input.body.nodes.findIndex(
    (bodyNode) => isRecord(bodyNode) && bodyNode.kind === "loop",
  );
  if (nestedIndex !== -1) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" contains a nested loop. Move the nested loop to the outer graph.`,
      `${loopPath}.body.nodes[${String(nestedIndex)}].kind`,
    );
  }
  const conditionalBodyEdgeIndex = input.body.edges.findIndex(
    (edge) => isRecord(edge) && edge.when !== undefined,
  );
  if (conditionalBodyEdgeIndex !== -1) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" body edges cannot be conditional.`,
      `${loopPath}.body.edges[${String(conditionalBodyEdgeIndex)}].when`,
    );
  }
  const bodyInput = {
    schemaVersion: 1,
    workflow: definition.workflow,
    ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
    nodes: input.body.nodes,
    edges: input.body.edges,
  };
  const { bodyDefinition, bodyGraph } = ((): {
    bodyDefinition: WorkflowDefinitionV1;
    bodyGraph: Graph;
  } => {
    try {
      const structuredBody = validateCompilationStructure(bodyInput);
      const bodyNodeIndices = validateNodes(structuredBody);
      const semanticBody = semanticDefinition(structuredBody);
      return {
        bodyDefinition: semanticBody,
        bodyGraph: buildGraph(
          semanticBody,
          bodyNodeIndices,
          new Set([
            isRecord(input.decision) && typeof input.decision.node === "string"
              ? input.decision.node
              : "",
            isRecord(input.feedback) && typeof input.feedback.from === "string"
              ? input.feedback.from
              : "",
          ]),
        ),
      };
    } catch (error: unknown) {
      return rebaseLoopError(error, loopPath);
    }
  })();

  if (!isRecord(input.decision)) {
    return invalidStructure(
      `Loop node "${input.id}" decision must be an object.`,
      `${loopPath}.decision`,
    );
  }
  if (!isRecord(input.feedback)) {
    return invalidStructure(
      `Loop node "${input.id}" feedback must be an object.`,
      `${loopPath}.feedback`,
    );
  }
  if (!isRecord(input.result)) {
    return invalidStructure(
      `Loop node "${input.id}" result must be an object.`,
      `${loopPath}.result`,
    );
  }
  const decisionNodeId = validatedLoopReference(
    input.decision.node,
    `${loopPath}.decision.node`,
    `Loop node "${input.id}" decision.node`,
  );
  const passChoice = validatedLoopChoice(
    input.decision.passChoice,
    `${loopPath}.decision.passChoice`,
    `Loop node "${input.id}" decision.passChoice`,
  );
  const reviseChoice = validatedLoopChoice(
    input.decision.reviseChoice,
    `${loopPath}.decision.reviseChoice`,
    `Loop node "${input.id}" decision.reviseChoice`,
  );
  if (passChoice === reviseChoice) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" passChoice and reviseChoice must differ.`,
      `${loopPath}.decision.reviseChoice`,
    );
  }
  const feedbackFrom = validatedLoopReference(
    input.feedback.from,
    `${loopPath}.feedback.from`,
    `Loop node "${input.id}" feedback.from`,
  );
  const feedbackTo = validatedLoopReference(
    input.feedback.to,
    `${loopPath}.feedback.to`,
    `Loop node "${input.id}" feedback.to`,
  );
  if (typeof input.feedback.input !== "string" || !isLowercaseIdentifier(input.feedback.input)) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" feedback.input must be a lowercase input name.`,
      `${loopPath}.feedback.input`,
    );
  }
  const resultNodeId = validatedLoopReference(
    input.result.node,
    `${loopPath}.result.node`,
    `Loop node "${input.id}" result.node`,
  );
  const bodyNodeIndices = new Map(
    bodyDefinition.nodes.map((node, bodyIndex) => [node.id, bodyIndex]),
  );
  const decisionIndex = bodyNodeIndices.get(decisionNodeId);
  const feedbackFromIndex = bodyNodeIndices.get(feedbackFrom);
  const feedbackToIndex = bodyNodeIndices.get(feedbackTo);
  const resultIndex = bodyNodeIndices.get(resultNodeId);
  if (decisionIndex === undefined) {
    return invalidStructure(
      `Loop node "${input.id}" decision node "${decisionNodeId}" does not exist in the body.`,
      `${loopPath}.decision.node`,
    );
  }
  if (feedbackFromIndex === undefined) {
    return invalidStructure(
      `Loop node "${input.id}" feedback source "${feedbackFrom}" does not exist in the body.`,
      `${loopPath}.feedback.from`,
    );
  }
  if (feedbackToIndex === undefined) {
    return invalidStructure(
      `Loop node "${input.id}" feedback target "${feedbackTo}" does not exist in the body.`,
      `${loopPath}.feedback.to`,
    );
  }
  if (resultIndex === undefined) {
    return invalidStructure(
      `Loop node "${input.id}" result node "${resultNodeId}" does not exist in the body.`,
      `${loopPath}.result.node`,
    );
  }
  const decisionNode = bodyDefinition.nodes[decisionIndex];
  if (
    decisionNode?.kind !== "agent" ||
    decisionNode.output?.type !== "choice" ||
    decisionNode.output.choices.length !== 2 ||
    !decisionNode.output.choices.includes(passChoice) ||
    !decisionNode.output.choices.includes(reviseChoice)
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" decision node must be an agent whose choice output declares exactly "${passChoice}" and "${reviseChoice}".`,
      `${loopPath}.decision.node`,
    );
  }
  const sinkIndices = bodyDefinition.nodes
    .map((_node, bodyIndex) => bodyIndex)
    .filter((bodyIndex) => (bodyGraph.outgoing[bodyIndex] ?? []).length === 0);
  if (sinkIndices.length !== 1 || sinkIndices[0] !== decisionIndex) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" decision node must be the unique body sink.`,
      `${loopPath}.decision.node`,
    );
  }
  if (visit(decisionIndex, bodyGraph.incoming).size !== bodyDefinition.nodes.length) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Every node in loop "${input.id}" must be an ancestor of the decision node.`,
      `${loopPath}.decision.node`,
    );
  }
  const feedbackSource = bodyDefinition.nodes[feedbackFromIndex];
  if (
    feedbackSource?.kind !== "agent" ||
    feedbackSource.output === undefined ||
    feedbackSource.output.type === "artifact" ||
    feedbackSource.output.type === "choice"
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" feedback source must declare a bounded text, json, or decision_packet output.`,
      `${loopPath}.feedback.from`,
    );
  }
  const feedbackTarget = bodyDefinition.nodes[feedbackToIndex];
  if (feedbackTarget?.kind !== "agent") {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" feedback target must be an agent.`,
      `${loopPath}.feedback.to`,
    );
  }
  const feedbackInput = input.feedback.input;
  if (
    feedbackTarget.parameters?.includes(feedbackInput) === true ||
    bodyDefinition.edges.some((edge) => edge.to === feedbackTo && edge.input === feedbackInput)
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop feedback input "${feedbackInput}" is bound more than once for node "${feedbackTo}".`,
      `${loopPath}.feedback.input`,
    );
  }
  const resultNode = bodyDefinition.nodes[resultIndex];
  if (
    resultNode?.kind !== "agent" ||
    resultNode.output === undefined ||
    resultNode.output.type === "artifact"
  ) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `Loop node "${input.id}" result node must declare a bounded non-artifact output.`,
      `${loopPath}.result.node`,
    );
  }
  return {
    id: input.id,
    kind: "loop",
    maxIterations: input.maxIterations as number,
    body: { nodes: bodyDefinition.nodes as LoopBody["nodes"], edges: bodyDefinition.edges },
    decision: { node: decisionNodeId, passChoice, reviseChoice },
    feedback: { from: feedbackFrom, to: feedbackTo, input: feedbackInput },
    result: { node: resultNodeId },
  };
};

const validateNodes = (definition: WorkflowCompilationInput): Map<string, number> => {
  const nodeIndices = new Map<string, number>();
  let loopCount = 0;
  definition.nodes.forEach((node, index) => {
    if (nodeIndices.has(node.id)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node ID "${node.id}" is duplicated. Give every node a unique ID.`,
        `nodes[${String(index)}].id`,
      );
    }
    nodeIndices.set(node.id, index);
    const kind: string = node.kind;
    if (kind !== "agent" && kind !== "approval" && kind !== "loop") {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${node.id}" uses unsupported kind "${kind}". Use kind "agent", "approval", or "loop".`,
        `nodes[${String(index)}].kind`,
      );
    }
    if (isLoopNodeInput(node)) {
      loopCount += 1;
      if (loopCount > 1) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          "A workflow may declare at most one loop.",
          `nodes[${String(index)}].kind`,
        );
      }
      return;
    }
    if (node.kind === "approval") {
      const unsupportedField = Object.keys(node).find((field) => !approvalNodeFields.has(field));
      if (unsupportedField !== undefined) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Approval node "${node.id}" declares unsupported field "${unsupportedField}". Remove that field from the approval node.`,
          `nodes[${String(index)}].${unsupportedField}`,
        );
      }
      validatedApprovalQuestion(node.question, node.id, index);
      validatedJoin(node.join, node.id, index);
      return;
    }
    const agentNode = node as WorkflowNodeInput;
    const unsupportedField = Object.keys(agentNode).find((field) => !agentNodeFields.has(field));
    if (unsupportedField !== undefined) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Agent node "${node.id}" declares unsupported field "${unsupportedField}". Remove that field from the agent node.`,
        `nodes[${String(index)}].${unsupportedField}`,
      );
    }
    validatedPrompt(agentNode.prompt, node.id, index);
    validatedAgentTimeout(agentNode.timeoutMs, node.id, index);
    const runtime = validatedRuntime(agentNode.runtime, node.id, index);
    const access = validatedAccess(agentNode.access, node.id, index);
    validatedRetry(agentNode.retry, node.id, index, access);
    validatedJoin(agentNode.join, node.id, index);
    validatedWorkspace(agentNode.workspace, node.id, index);
    if (runtime === "opencode" && access === "read_only") {
      throw new KilinError(
        "RUNTIME_ACCESS_UNSUPPORTED",
        `Node "${node.id}" cannot use read_only access with OpenCode. Use workspace_write or choose a runtime that supports read_only.`,
        `nodes[${String(index)}].access`,
      );
    }
  });
  return nodeIndices;
};

const semanticDefinition = (definition: WorkflowCompilationInput): WorkflowDefinitionV1 => {
  const parameters = validatedDeclaredParameters(definition);
  const declaredParameters = new Set(parameters ?? []);
  const nodes: WorkflowNode[] = definition.nodes.map((node, index) => {
    if (isLoopNodeInput(node)) {
      return validatedLoop(node, index, definition);
    }
    if (node.kind === "approval") {
      const join = validatedJoin(node.join, node.id, index);
      const semanticNode: ApprovalNode = {
        id: node.id,
        join,
        kind: "approval",
        question: validatedApprovalQuestion(node.question, node.id, index),
      };
      return semanticNode;
    }
    const agentNode = node as WorkflowNodeInput;
    const output = validatedOutput(agentNode.output, node.id, index);
    const access = validatedAccess(agentNode.access, node.id, index);
    const retry = validatedRetry(agentNode.retry, node.id, index, access);
    const join = validatedJoin(agentNode.join, node.id, index);
    const workspace = validatedWorkspace(agentNode.workspace, node.id, index);
    const timeoutMs = validatedAgentTimeout(agentNode.timeoutMs, node.id, index);
    const consumedParameters = validatedConsumedParameters(
      agentNode.parameters,
      node.id,
      index,
      declaredParameters,
    );
    if (output?.type === "artifact" && access !== "workspace_write") {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${node.id}" declares an artifact output with ${access} access. Use workspace_write access or declare a text, JSON, or Decision Packet output.`,
        `nodes[${String(index)}].access`,
      );
    }
    if (output?.type === "artifact" && workspace !== undefined) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Node "${node.id}" declares an artifact output in isolated workspace "${workspace}". Remove the artifact output or the workspace.`,
        `nodes[${String(index)}].output.type`,
      );
    }
    const semanticNode: AgentNode = {
      id: node.id,
      join,
      kind: "agent",
      runtime: validatedRuntime(agentNode.runtime, node.id, index),
      access,
      prompt: validatedPrompt(agentNode.prompt, node.id, index),
    };
    if (agentNode.model !== undefined) {
      semanticNode.model = agentNode.model;
    }
    if (timeoutMs !== undefined) {
      semanticNode.timeoutMs = timeoutMs;
    }
    if (output !== undefined) {
      semanticNode.output = output;
    }
    if (retry !== undefined) {
      semanticNode.retry = retry;
    }
    if (workspace !== undefined) {
      semanticNode.workspace = workspace;
    }
    if (consumedParameters !== undefined) {
      semanticNode.parameters = consumedParameters;
    }
    return semanticNode;
  });
  const workflow = {
    id: definition.workflow.id,
    name: definition.workflow.name,
  };

  return {
    schemaVersion: definition.schemaVersion,
    workflow,
    ...(parameters === undefined ? {} : { parameters }),
    nodes,
    edges: definition.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.input === undefined ? {} : { input: edge.input }),
      ...(edge.when === undefined ? {} : { when: { choice: edge.when.choice } }),
    })),
  };
};

const nodeOutput = (node: WorkflowNode | ExecutionNode): AgentOutputDeclaration | undefined => {
  if (node.kind === "agent") {
    return node.output;
  }
  if (node.kind === "approval") {
    return undefined;
  }
  if (!("result" in node)) {
    return node.output;
  }
  const resultNode = node.body.nodes.find((candidate) => candidate.id === node.result.node);
  return resultNode?.kind === "agent" ? resultNode.output : undefined;
};

const buildGraph = (
  definition: WorkflowDefinitionV1,
  nodeIndices: Map<string, number>,
  uncoveredChoiceExceptions: ReadonlySet<string> = new Set(),
): Graph => {
  const outgoing = definition.nodes.map(() => [] as number[]);
  const incoming = definition.nodes.map(() => [] as number[]);
  const edgeKeys = new Set<string>();
  const dependencyKeys = new Set<string>();
  const conditionalDependencyKeys = new Set<string>();
  const dependenciesWithInputs = new Set<string>();
  const targetInputKeys = new Set<string>();
  const coveredChoices = new Map<number, Set<string>>();

  definition.nodes.forEach((node, index) => {
    if (node.kind !== "agent" || node.parameters === undefined) {
      return;
    }
    for (const parameterName of node.parameters) {
      targetInputKeys.add(`${String(index)}\0${parameterName}`);
    }
  });

  definition.edges.forEach((edge, index) => {
    const from = nodeIndices.get(edge.from);
    const to = nodeIndices.get(edge.to);
    if (from === undefined) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Edge source "${edge.from}" does not exist. Use the ID of a declared node.`,
        `edges[${String(index)}].from`,
      );
    }
    if (to === undefined) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Edge target "${edge.to}" does not exist. Use the ID of a declared node.`,
        `edges[${String(index)}].to`,
      );
    }
    if (from === to) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Edge from "${edge.from}" points to itself. Remove the self-dependency.`,
        `edges[${String(index)}]`,
      );
    }
    const sourceNode = definition.nodes[from];
    const targetNode = definition.nodes[to];
    const dependencyKey = `${edge.from}\0${edge.to}`;
    const edgeKey = `${dependencyKey}\0${edge.when?.choice ?? ""}`;
    if (edgeKeys.has(edgeKey)) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Edge from "${edge.from}" to "${edge.to}" is duplicated. Remove the duplicate edge.`,
        `edges[${String(index)}]`,
      );
    }
    edgeKeys.add(edgeKey);
    if (
      dependencyKeys.has(dependencyKey) &&
      (edge.input !== undefined || dependenciesWithInputs.has(dependencyKey))
    ) {
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Conditional edges from "${edge.from}" to "${edge.to}" cannot mix routing with input bindings. Remove the input binding or route through distinct target nodes.`,
        edge.input === undefined ? `edges[${String(index)}]` : `edges[${String(index)}].input`,
      );
    }
    if (edge.input !== undefined) {
      dependenciesWithInputs.add(dependencyKey);
    }
    if (edge.when !== undefined) {
      const sourceOutput = sourceNode === undefined ? undefined : nodeOutput(sourceNode);
      if (sourceOutput?.type !== "choice") {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Conditional edge source "${edge.from}" does not declare a choice output. Add a choice output or remove the condition.`,
          `edges[${String(index)}].from`,
        );
      }
      const choice = edge.when.choice;
      if (typeof choice !== "string" || !isLowercaseIdentifier(choice)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Conditional edge from "${edge.from}" has invalid choice "${choice}". Use a declared lowercase choice ID.`,
          `edges[${String(index)}].when.choice`,
        );
      }
      if (!sourceOutput.choices.includes(choice)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Conditional edge from "${edge.from}" uses undeclared choice "${choice}". Use one of the source node's declared choices.`,
          `edges[${String(index)}].when.choice`,
        );
      }
      const sourceCoverage = coveredChoices.get(from) ?? new Set<string>();
      sourceCoverage.add(choice);
      coveredChoices.set(from, sourceCoverage);
      if (
        conditionalDependencyKeys.has(dependencyKey) &&
        (targetNode?.kind === "loop" || targetNode?.join !== "any")
      ) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Target node "${edge.to}" receives mutually exclusive choices from "${edge.from}" with join "all". Set join to "any" so either choice can activate the target.`,
          `nodes[${String(to)}].join`,
        );
      }
      conditionalDependencyKeys.add(dependencyKey);
    }
    if (edge.input !== undefined) {
      if (!isLowercaseIdentifier(edge.input)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Edge input "${edge.input}" is invalid. Use a lowercase name beginning with a letter and containing at most 64 letters, digits, or underscores.`,
          `edges[${String(index)}].input`,
        );
      }
      if (sourceNode?.kind === "approval") {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Approval node "${edge.from}" cannot produce data. Remove the input name to keep a dependency-only edge.`,
          `edges[${String(index)}].from`,
        );
      }
      if (targetNode?.kind === "approval") {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Approval node "${edge.to}" cannot consume data. Remove the input name to keep a dependency-only edge.`,
          `edges[${String(index)}].to`,
        );
      }
      if (targetNode?.kind === "loop") {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Loop node "${edge.to}" cannot consume outer data because data bindings into loops are deferred. Remove the input name to keep a dependency-only edge.`,
          `edges[${String(index)}].to`,
        );
      }
      const sourceOutput = sourceNode === undefined ? undefined : nodeOutput(sourceNode);
      if (sourceOutput === undefined) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Edge source "${edge.from}" has no declared output. Add an output declaration to that node or remove the input binding.`,
          `edges[${String(index)}].from`,
        );
      }
      const sourceWorkspace =
        sourceNode?.kind === "agent" ? (sourceNode.workspace ?? "source") : "source";
      const targetWorkspace =
        targetNode?.kind === "agent" ? (targetNode.workspace ?? "source") : "source";
      if (sourceOutput.type === "artifact" && sourceWorkspace !== targetWorkspace) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Artifact input "${edge.input}" crosses from workspace "${sourceWorkspace}" to "${targetWorkspace}". Keep the producer and consumer in the same effective workspace.`,
          `edges[${String(index)}].input`,
        );
      }
      const targetInputKey = `${String(to)}\0${edge.input}`;
      if (targetInputKeys.has(targetInputKey)) {
        throw new KilinError(
          "WORKFLOW_GRAPH_INVALID",
          `Input "${edge.input}" is bound more than once for node "${edge.to}". Rename or remove one binding.`,
          `edges[${String(index)}].input`,
        );
      }
      targetInputKeys.add(targetInputKey);
    }
    if (!dependencyKeys.has(dependencyKey)) {
      dependencyKeys.add(dependencyKey);
      outgoing[from]?.push(to);
      incoming[to]?.push(from);
    }
  });

  definition.nodes.forEach((node, nodeIndex) => {
    const output = nodeOutput(node);
    if (
      output?.type !== "choice" ||
      node.kind === "loop" ||
      uncoveredChoiceExceptions.has(node.id)
    ) {
      return;
    }
    const coverage = coveredChoices.get(nodeIndex);
    const uncoveredIndex = output.choices.findIndex((choice) => !(coverage?.has(choice) ?? false));
    if (uncoveredIndex !== -1) {
      const choice = output.choices[uncoveredIndex];
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Choice producer "${node.id}" has no conditional edge for choice "${choice ?? "unknown"}". Add at least one edge covering every declared choice.`,
        `nodes[${String(nodeIndex)}].output.choices[${String(uncoveredIndex)}]`,
      );
    }
  });

  const indegree = incoming.map((dependencies) => dependencies.length);
  const ready: number[] = [];
  indegree.forEach((count, index) => {
    if (count === 0) {
      pushHeap(ready, index);
    }
  });

  const order: number[] = [];
  while (ready.length > 0) {
    const current = popHeap(ready);
    if (current === undefined) {
      break;
    }
    order.push(current);
    for (const dependent of outgoing[current] ?? []) {
      const remaining = (indegree[dependent] ?? 0) - 1;
      indegree[dependent] = remaining;
      if (remaining === 0) {
        pushHeap(ready, dependent);
      }
    }
  }

  if (order.length !== definition.nodes.length) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      "The workflow graph contains a cycle. Remove a dependency that closes the cycle.",
      "edges",
    );
  }

  return { outgoing, incoming, order };
};

const validateWriterOrdering = (
  definition: { nodes: readonly ExecutionNode[] },
  graph: Pick<Graph, "outgoing" | "incoming">,
): void => {
  definition.nodes.forEach((writer, writerIndex) => {
    if (writer.kind !== "agent" || writer.access !== "workspace_write") {
      return;
    }
    const comparable = visit(writerIndex, graph.outgoing);
    for (const ancestor of visit(writerIndex, graph.incoming)) {
      comparable.add(ancestor);
    }
    const writerWorkspace = writer.workspace ?? "source";
    const unorderedIndex = definition.nodes.findIndex((candidate, index) => {
      if (candidate.kind !== "agent") {
        return false;
      }
      const candidateWorkspace = candidate.workspace ?? "source";
      return candidateWorkspace === writerWorkspace && !comparable.has(index);
    });
    if (unorderedIndex !== -1) {
      const unordered = definition.nodes[unorderedIndex];
      throw new KilinError(
        "WORKFLOW_GRAPH_INVALID",
        `Nodes "${writer.id}" and "${unordered?.id ?? "unknown"}" are unordered while "${writer.id}" can write to the workspace. Add a dependency path between them.`,
        `nodes[${String(writerIndex)}]`,
      );
    }
  });
};

const createExecutionId = (
  loopNodeId: string,
  iteration: number,
  bodyNodeId: string,
  reservedIds: Set<string>,
): string => {
  let nonce = 0;
  for (;;) {
    const digest = createHash("sha256")
      .update(`${loopNodeId}\0${String(iteration)}\0${bodyNodeId}\0${String(nonce)}`, "utf8")
      .digest("hex");
    const executionId = `x${digest}`;
    if (!reservedIds.has(executionId)) {
      reservedIds.add(executionId);
      return executionId;
    }
    nonce += 1;
  }
};

const getOccurrenceId = (executionIds: readonly string[], index: number): string => {
  const executionId = executionIds[index];
  if (executionId === undefined) {
    throw new KilinError(
      "INTERNAL_ERROR",
      "Kilin could not finish expanding the workflow's loop. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
    );
  }
  return executionId;
};

interface ExpandedWorkflow {
  definition: WorkflowExecutionDefinition;
  nodes: PlannedNode[];
  edges: DependencyEdge[];
  loops: PlannedLoop[];
  writerGraph: Pick<Graph, "outgoing" | "incoming">;
}

const expandWorkflow = (
  authoredDefinition: WorkflowDefinitionV1,
  outerGraph: Graph,
): ExpandedWorkflow => {
  const reservedIds = new Set(authoredDefinition.nodes.map((node) => node.id));
  const executionNodes: ExecutionNode[] = [];
  const plannedSeeds: Omit<PlannedNode, "ordinal" | "dependencies" | "inputBindings">[] = [];
  const expandedEdges: DependencyEdge[] = authoredDefinition.edges.map((edge) => ({ ...edge }));
  const loops: PlannedLoop[] = [];
  const virtualWriterEdges: DependencyEdge[] = [];

  for (const outerIndex of outerGraph.order) {
    const outerNode = authoredDefinition.nodes[outerIndex];
    if (outerNode === undefined) {
      throw new KilinError(
        "INTERNAL_ERROR",
        "Kilin's expanded workflow referenced a node that does not exist. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
      );
    }
    if (outerNode.kind !== "loop") {
      executionNodes.push(outerNode);
      plannedSeeds.push({
        node: outerNode,
        executionId: outerNode.id,
        nodeId: outerNode.id,
      });
      continue;
    }

    const resultNode = outerNode.body.nodes.find(
      (candidate) => candidate.id === outerNode.result.node,
    );
    if (resultNode?.kind !== "agent" || resultNode.output === undefined) {
      throw new KilinError(
        "INTERNAL_ERROR",
        "Kilin could not resolve the loop's result node. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
      );
    }
    const controlNode: LoopControlNode = {
      id: outerNode.id,
      kind: "loop",
      output: resultNode.output,
    };
    executionNodes.push(controlNode);
    plannedSeeds.push({
      node: controlNode,
      executionId: outerNode.id,
      nodeId: outerNode.id,
    });

    const bodyIndices = new Map(
      outerNode.body.nodes.map((bodyNode, bodyIndex) => [bodyNode.id, bodyIndex]),
    );
    const bodyGraph = buildGraph(
      {
        schemaVersion: 1,
        workflow: authoredDefinition.workflow,
        ...(authoredDefinition.parameters === undefined
          ? {}
          : { parameters: authoredDefinition.parameters }),
        nodes: outerNode.body.nodes,
        edges: outerNode.body.edges,
      },
      bodyIndices,
      new Set([outerNode.decision.node]),
    );
    const roots = bodyGraph.order.filter(
      (bodyIndex) => (bodyGraph.incoming[bodyIndex] ?? []).length === 0,
    );
    const iterations: PlannedLoop["iterations"] = [];
    const occurrenceIds: string[][] = [];

    for (let iteration = 0; iteration < outerNode.maxIterations; iteration += 1) {
      const idsByBodyIndex = outerNode.body.nodes.map((bodyNode) =>
        createExecutionId(outerNode.id, iteration, bodyNode.id, reservedIds),
      );
      occurrenceIds.push(idsByBodyIndex);
      for (const bodyIndex of bodyGraph.order) {
        const bodyNode = outerNode.body.nodes[bodyIndex];
        const executionId = idsByBodyIndex[bodyIndex];
        if (bodyNode === undefined || executionId === undefined) {
          throw new KilinError(
            "INTERNAL_ERROR",
            "Kilin's expanded loop referenced a body node that does not exist. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
          );
        }
        const occurrenceNode = { ...bodyNode, id: executionId };
        executionNodes.push(occurrenceNode);
        plannedSeeds.push({
          node: occurrenceNode,
          executionId,
          nodeId: bodyNode.id,
          loopNodeId: outerNode.id,
          iteration,
        });
      }
      for (const edge of outerNode.body.edges) {
        const fromIndex = bodyIndices.get(edge.from);
        const toIndex = bodyIndices.get(edge.to);
        const from = fromIndex === undefined ? undefined : idsByBodyIndex[fromIndex];
        const to = toIndex === undefined ? undefined : idsByBodyIndex[toIndex];
        if (from === undefined || to === undefined) {
          throw new KilinError(
            "INTERNAL_ERROR",
            "Kilin's expanded loop referenced a body edge that does not exist. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
          );
        }
        expandedEdges.push({ ...edge, from, to });
      }

      const decisionIndex = bodyIndices.get(outerNode.decision.node);
      const feedbackFromIndex = bodyIndices.get(outerNode.feedback.from);
      const feedbackToIndex = bodyIndices.get(outerNode.feedback.to);
      const resultIndex = bodyIndices.get(outerNode.result.node);
      if (
        decisionIndex === undefined ||
        feedbackFromIndex === undefined ||
        feedbackToIndex === undefined ||
        resultIndex === undefined
      ) {
        throw new KilinError(
          "INTERNAL_ERROR",
          "Kilin could not resolve the loop's validated contract. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
        );
      }
      const decisionExecutionId = idsByBodyIndex[decisionIndex];
      const feedbackSourceExecutionId = idsByBodyIndex[feedbackFromIndex];
      const feedbackTargetExecutionId = idsByBodyIndex[feedbackToIndex];
      const resultExecutionId = idsByBodyIndex[resultIndex];
      if (
        decisionExecutionId === undefined ||
        feedbackSourceExecutionId === undefined ||
        feedbackTargetExecutionId === undefined ||
        resultExecutionId === undefined
      ) {
        throw new KilinError(
          "INTERNAL_ERROR",
          "Kilin could not finish expanding the workflow's loop. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
        );
      }
      iterations.push({
        iteration,
        executionIds: bodyGraph.order.map((bodyIndex) =>
          getOccurrenceId(idsByBodyIndex, bodyIndex),
        ),
        rootExecutionIds: roots.map((bodyIndex) => getOccurrenceId(idsByBodyIndex, bodyIndex)),
        decisionExecutionId,
        feedbackSourceExecutionId,
        feedbackTargetExecutionId,
        resultExecutionId,
      });
      if (iteration > 0) {
        const previous = iterations[iteration - 1];
        if (previous === undefined) {
          throw new KilinError(
            "INTERNAL_ERROR",
            "Kilin could not resolve the previous loop iteration. This is a defect in Kilin. Report it at https://github.com/kilin-space/kilin/issues.",
          );
        }
        expandedEdges.push({
          from: previous.feedbackSourceExecutionId,
          to: feedbackTargetExecutionId,
          input: outerNode.feedback.input,
        });
        for (const rootExecutionId of iterations[iteration]?.rootExecutionIds ?? []) {
          expandedEdges.push({ from: previous.decisionExecutionId, to: rootExecutionId });
        }
      }
    }

    const firstIteration = iterations[0];
    const lastIteration = iterations.at(-1);
    if (firstIteration !== undefined) {
      for (const edge of authoredDefinition.edges) {
        if (edge.to === outerNode.id) {
          for (const rootExecutionId of firstIteration.rootExecutionIds) {
            virtualWriterEdges.push({ from: edge.from, to: rootExecutionId });
          }
        }
      }
    }
    if (lastIteration !== undefined) {
      virtualWriterEdges.push({
        from: lastIteration.decisionExecutionId,
        to: outerNode.id,
      });
    }
    loops.push({
      executionId: outerNode.id,
      nodeId: outerNode.id,
      maxIterations: outerNode.maxIterations,
      passChoice: outerNode.decision.passChoice,
      reviseChoice: outerNode.decision.reviseChoice,
      feedbackInputName: outerNode.feedback.input,
      iterations,
    });
  }

  if (executionNodes.length > maximumCompiledExecutions) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `The expanded workflow contains ${String(executionNodes.length)} executions, exceeding the limit of ${String(maximumCompiledExecutions)}.`,
      "nodes",
    );
  }
  if (expandedEdges.length > maximumCompiledEdges) {
    throw new KilinError(
      "WORKFLOW_GRAPH_INVALID",
      `The expanded workflow contains ${String(expandedEdges.length)} edges, exceeding the limit of ${String(maximumCompiledEdges)}.`,
      "edges",
    );
  }

  const executionIndices = new Map(executionNodes.map((node, index) => [node.id, index]));
  const writerOutgoing = executionNodes.map(() => [] as number[]);
  const writerIncoming = executionNodes.map(() => [] as number[]);
  for (const edge of [...expandedEdges, ...virtualWriterEdges]) {
    const from = executionIndices.get(edge.from);
    const to = executionIndices.get(edge.to);
    if (from !== undefined && to !== undefined && !writerOutgoing[from]?.includes(to)) {
      writerOutgoing[from]?.push(to);
      writerIncoming[to]?.push(from);
    }
  }
  const writerGraph: Pick<Graph, "outgoing" | "incoming"> = {
    outgoing: writerOutgoing,
    incoming: writerIncoming,
  };

  const incomingByExecutionId = new Map<string, string[]>();
  const executionInputBindingsByTarget = new Map<string, InputBinding[]>();
  for (const edge of expandedEdges) {
    const dependencies = incomingByExecutionId.get(edge.to) ?? [];
    if (!dependencies.includes(edge.from)) {
      dependencies.push(edge.from);
      incomingByExecutionId.set(edge.to, dependencies);
    }
    if (edge.input !== undefined) {
      const inputBindings = executionInputBindingsByTarget.get(edge.to) ?? [];
      inputBindings.push({
        inputName: edge.input,
        source: { kind: "execution", sourceExecutionId: edge.from },
      });
      executionInputBindingsByTarget.set(edge.to, inputBindings);
    }
  }
  const nodes: PlannedNode[] = plannedSeeds.map((seed, ordinal) => {
    const inputBindings: InputBinding[] = [];
    if (seed.node.kind === "agent" && seed.node.parameters !== undefined) {
      for (const parameterName of seed.node.parameters) {
        inputBindings.push({
          inputName: parameterName,
          source: { kind: "parameter", parameterName },
        });
      }
    }
    inputBindings.push(...(executionInputBindingsByTarget.get(seed.executionId) ?? []));
    inputBindings.sort((left, right) => {
      if (left.inputName === right.inputName) {
        return 0;
      }
      return left.inputName < right.inputName ? -1 : 1;
    });
    return {
      ...seed,
      ordinal,
      dependencies: (incomingByExecutionId.get(seed.executionId) ?? []).sort(
        (left, right) =>
          (executionIndices.get(left) ?? Number.MAX_SAFE_INTEGER) -
          (executionIndices.get(right) ?? Number.MAX_SAFE_INTEGER),
      ),
      inputBindings,
    };
  });
  return {
    definition: {
      schemaVersion: authoredDefinition.schemaVersion,
      workflow: authoredDefinition.workflow,
      ...(authoredDefinition.parameters === undefined
        ? {}
        : { parameters: authoredDefinition.parameters }),
      nodes: executionNodes,
      edges: expandedEdges,
    },
    nodes,
    edges: [...expandedEdges].sort(compareEdges),
    loops,
    writerGraph,
  };
};

export const normalizeWorkflowDefinition = (definition: WorkflowDefinitionV1): string =>
  serializeCanonicalJson(canonicalDefinition(definition));

export const hashWorkflowDefinition = (definition: WorkflowDefinitionV1): string =>
  createHash("sha256").update(normalizeWorkflowDefinition(definition), "utf8").digest("hex");

export const compileWorkflow = (input: WorkflowCompilationInput): ExecutionPlan => {
  const validatedInput = validateCompilationStructure(input);
  const nodeIndices = validateNodes(validatedInput);
  const definition = semanticDefinition(validatedInput);
  validateParameterConsumers(definition, validatedInput.parameters);
  const graph = buildGraph(definition, nodeIndices);
  const expanded = expandWorkflow(definition, graph);
  validateWriterOrdering(expanded.definition, expanded.writerGraph);
  const normalizedDefinition = normalizeWorkflowDefinition(definition);

  return {
    authoredDefinition: definition,
    definition: expanded.definition,
    normalizedDefinition,
    contentHash: createHash("sha256").update(normalizedDefinition, "utf8").digest("hex"),
    nodes: expanded.nodes,
    edges: expanded.edges,
    loops: expanded.loops,
  };
};
