import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KilinError } from "../../src/domain/errors.js";
import {
  parseWorkflowBytes,
  readWorkflowSource,
} from "../../src/infrastructure/workflow-source.js";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

const canonicalWorkflow = `schemaVersion: 1

workflow:
  id: change-review
  name: Change review

nodes:
  - id: analyze
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: >-
      Review the current change and write a concise plan to
      .kilin/artifacts/change-review.md. Do not modify product files.

  - id: implement
    kind: agent
    runtime: codex
    access: workspace_write
    prompt: >-
      Read .kilin/artifacts/change-review.md, implement the justified changes,
      and run focused checks.

  - id: verify
    kind: agent
    runtime: codex
    access: read_only
    prompt: >-
      Verify the requested behavior and report any remaining failures.

edges:
  - from: analyze
    to: implement
  - from: implement
    to: verify
`;

const expectKilinError = (operation: () => unknown, code: string, path?: string): KilinError => {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({ code, ...(path === undefined ? {} : { path }) });
    return error as KilinError;
  }
  throw new Error("Expected workflow parsing to fail");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("workflow source parsing", () => {
  it.each([2, 3, 4] as const)("rejects historical schemaVersion %i", (schemaVersion) => {
    expectKilinError(
      () =>
        parseWorkflowBytes(
          encoder.encode(
            canonicalWorkflow.replace(
              "schemaVersion: 1",
              `schemaVersion: ${String(schemaVersion)}`,
            ),
          ),
        ),
      "WORKFLOW_SCHEMA_INVALID",
      "schemaVersion",
    );
  });

  it("accepts an authored approval node", () => {
    const source = `schemaVersion: 1
workflow:
  id: approval-review
  name: Approval review
nodes:
  - id: approve
    kind: approval
    question: Proceed?
edges: []
`;

    expect(parseWorkflowBytes(encoder.encode(source)).nodes[0]).toEqual({
      id: "approve",
      kind: "approval",
      question: "Proceed?",
    });
  });

  it.each([
    [
      "a missing approval question",
      `schemaVersion: 1
workflow: { id: approval-review, name: Approval review }
nodes: [{ id: approve, kind: approval }]
edges: []
`,
      "nodes[0].question",
    ],
    [
      "an agent field on an approval",
      `schemaVersion: 1
workflow: { id: approval-review, name: Approval review }
nodes:
  - id: approve
    kind: approval
    question: Proceed?
    runtime: codex
edges: []
`,
      "nodes[0].runtime",
    ],
  ] as const)("rejects %s at the exact workflow path", (_name, source, path) => {
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source)),
      "WORKFLOW_SCHEMA_INVALID",
      path,
    );
  });

  it.each(["text", "json", "decision_packet"] as const)(
    "accepts a closed %s output declaration",
    (type) => {
      const source = canonicalWorkflow.replace(
        "    access: workspace_write\n    prompt:",
        `    access: workspace_write\n    output:\n      type: ${type}\n    prompt:`,
      );

      expect(parseWorkflowBytes(encoder.encode(source)).nodes[0]).toMatchObject({
        output: { type },
      });
    },
  );

  it("accepts a closed artifact output declaration", () => {
    const source = canonicalWorkflow.replace(
      "    access: workspace_write\n    prompt:",
      "    access: workspace_write\n    output:\n      type: artifact\n      path: outputs/报告.json\n    prompt:",
    );

    expect(parseWorkflowBytes(encoder.encode(source)).nodes[0]).toMatchObject({
      output: { type: "artifact", path: "outputs/报告.json" },
    });
  });

  it("accepts a choice output in V1", () => {
    const source = canonicalWorkflow.replace(
      "    access: workspace_write\n    prompt:",
      "    access: workspace_write\n    output:\n      type: choice\n      choices: [approve, revise]\n    prompt:",
    );

    expect(parseWorkflowBytes(encoder.encode(source)).nodes[0]).toMatchObject({
      output: { type: "choice", choices: ["approve", "revise"] },
    });
  });

  it.each([
    [
      "agent retry",
      canonicalWorkflow.replace(
        "    access: workspace_write\n    prompt:",
        [
          "    access: workspace_write",
          "    retry:",
          "      maxAttempts: 2",
          "      initialBackoffMs: 0",
          "      maxBackoffMs: 0",
          "      safeToRepeat: true",
          "    prompt:",
        ].join("\n"),
      ),
    ],
    [
      "agent join",
      canonicalWorkflow.replace(
        "    access: workspace_write\n    prompt:",
        "    access: workspace_write\n    join: any\n    prompt:",
      ),
    ],
    [
      "approval join",
      `schemaVersion: 1
workflow: { id: approval-review, name: Approval review }
nodes:
  - id: approve
    kind: approval
    question: Proceed?
    join: any
edges: []
`,
    ],
    [
      "agent workspace",
      canonicalWorkflow.replace(
        "    access: workspace_write\n    prompt:",
        "    access: workspace_write\n    workspace: candidate\n    prompt:",
      ),
    ],
    [
      "edge condition",
      canonicalWorkflow.replace(
        "  - from: analyze\n    to: implement",
        "  - from: analyze\n    to: implement\n    when: { choice: approve }",
      ),
    ],
  ] as const)("accepts V1 %s", (_name, source) => {
    expect(() => parseWorkflowBytes(encoder.encode(source))).not.toThrow();
  });

  it("rejects choices on an artifact output", () => {
    const source = canonicalWorkflow.replace(
      "    access: workspace_write\n    prompt:",
      "    access: workspace_write\n    output:\n      type: artifact\n      path: outputs/report.md\n      choices: [approve, revise]\n    prompt:",
    );

    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source)),
      "WORKFLOW_SCHEMA_INVALID",
      "nodes[0].output.choices",
    );
  });

  it("accepts a named input binding structurally", () => {
    const source = canonicalWorkflow.replace(
      "  - from: analyze\n    to: implement",
      "  - from: analyze\n    to: implement\n    input: plan",
    );

    expect(parseWorkflowBytes(encoder.encode(source)).edges[0]).toEqual({
      from: "analyze",
      to: "implement",
      input: "plan",
    });
  });

  it("parses the canonical workflow definition from bytes and a file", async () => {
    const parsedBytes = parseWorkflowBytes(encoder.encode(canonicalWorkflow), "canonical.yaml");
    const directory = await mkdtemp(join(tmpdir(), "kilin-workflow-source-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "workflow.yaml");
    await writeFile(file, canonicalWorkflow);

    expect(parsedBytes.workflow).toEqual({
      id: "change-review",
      name: "Change review",
    });
    expect(parsedBytes.nodes.map(({ id }) => id)).toEqual(["analyze", "implement", "verify"]);
    await expect(readWorkflowSource(file)).resolves.toEqual(parsedBytes);
  });

  it("maps an unreadable workflow path to a typed source error", async () => {
    const missingFile = join(tmpdir(), "kilin-workflow-source-missing", "workflow.yaml");

    await expect(readWorkflowSource(missingFile)).rejects.toMatchObject({
      code: "WORKFLOW_SOURCE_NOT_FOUND",
    });
  });

  it("rejects an oversized definition from bytes and from a file", async () => {
    const oversized = `${canonicalWorkflow}\n# ${"x".repeat(1_048_576)}`;
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(oversized), "oversized.yaml"),
      "WORKFLOW_PARSE_FAILED",
    );

    const directory = await mkdtemp(join(tmpdir(), "kilin-workflow-source-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "oversized.yaml");
    await writeFile(file, "schemaVersion: 1");
    await truncate(file, 1_048_577);

    await expect(readWorkflowSource(file)).rejects.toMatchObject({
      code: "WORKFLOW_PARSE_FAILED",
    });
  });

  it("rejects graphs beyond the structural node and edge bounds", () => {
    const graph = (nodeCount: number, edgeCount: number): string => {
      const nodes = Array.from(
        { length: nodeCount },
        (_, index) =>
          `  - id: n${String(index)}\n    kind: agent\n    runtime: codex\n    access: read_only\n    prompt: Inspect the workspace.`,
      ).join("\n");
      const edges =
        edgeCount === 0
          ? " []"
          : `\n${Array.from({ length: edgeCount }, () => "  - from: n0\n    to: n1").join("\n")}`;
      return `schemaVersion: 1\nworkflow:\n  id: bounded-graph\n  name: Bounded graph\nnodes:\n${nodes}\nedges:${edges}\n`;
    };

    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(graph(129, 0)), "nodes.yaml"),
      "WORKFLOW_SCHEMA_INVALID",
      "nodes",
    );
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(graph(2, 513)), "edges.yaml"),
      "WORKFLOW_SCHEMA_INVALID",
      "edges",
    );
  });

  it.each([
    ["aliases", canonicalWorkflow.replace("schemaVersion: 1", "schemaVersion: *missing")],
    ["anchors", canonicalWorkflow.replace("schemaVersion: 1", "schemaVersion: &version 1")],
    [
      "merge keys",
      canonicalWorkflow.replace(
        "  id: change-review",
        "  <<: { description: merged }\n  id: change-review",
      ),
    ],
    [
      "custom tags",
      canonicalWorkflow.replace("name: Change review", "name: !command Change review"),
    ],
    [
      "duplicate keys",
      canonicalWorkflow.replace("schemaVersion: 1", "schemaVersion: 1\nschemaVersion: 1"),
    ],
    ["multiple documents", `${canonicalWorkflow}---\n${canonicalWorkflow}`],
  ] as const)("rejects YAML %s", (_name, source) => {
    const error = expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source), "hostile.yaml"),
      "WORKFLOW_PARSE_FAILED",
    );

    expect(error.message).toContain("hostile.yaml");
  });

  it.each([
    [
      "root",
      canonicalWorkflow.replace("schemaVersion: 1", "unexpected: true\nschemaVersion: 1"),
      "unexpected",
    ],
    [
      "workflow",
      canonicalWorkflow.replace("  id: change-review", "  unexpected: true\n  id: change-review"),
      "workflow.unexpected",
    ],
    [
      "node",
      canonicalWorkflow.replace("  - id: analyze", "  - unexpected: true\n    id: analyze"),
      "nodes[0].unexpected",
    ],
    [
      "edge",
      canonicalWorkflow.replace("  - from: analyze", "  - unexpected: true\n    from: analyze"),
      "edges[0].unexpected",
    ],
  ] as const)("rejects unknown %s fields with an actionable path", (_name, source, path) => {
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source)),
      "WORKFLOW_SCHEMA_INVALID",
      path,
    );
  });

  it("rejects invalid UTF-8 before YAML parsing", () => {
    const error = expectKilinError(
      () => parseWorkflowBytes(Uint8Array.from([0x73, 0x3a, 0x20, 0xc3, 0x28]), "invalid.yaml"),
      "WORKFLOW_PARSE_FAILED",
    );

    expect(error.message).toContain("UTF-8");
  });

  it("fails deeply nested collections with a typed error instead of exhausting the stack", () => {
    const depth = 10_000;
    const nested = "[".repeat(depth) + "]".repeat(depth);

    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(nested), "nested.yaml"),
      "WORKFLOW_PARSE_FAILED",
    );
  });

  it("does not expose malformed YAML content in parse errors", () => {
    const secret = "SENTINEL_DO_NOT_EXPOSE_7f91";
    const malformedSource = canonicalWorkflow.replace(
      "schemaVersion: 1",
      `schemaVersion: [${secret}`,
    );

    const error = expectKilinError(
      () => parseWorkflowBytes(encoder.encode(malformedSource), "secret.yaml"),
      "WORKFLOW_PARSE_FAILED",
    );

    expect(error.message).not.toContain(secret);
    expect(error.message).toMatch(/line \d+, column \d+/u);
  });

  it("leaves unsupported kinds and duplicate edges for semantic validation", () => {
    const unsupportedKind = canonicalWorkflow.replace("kind: agent", "kind: gate");
    const duplicateEdge = canonicalWorkflow.replace(
      "  - from: implement\n    to: verify",
      "  - from: implement\n    to: verify\n  - from: implement\n    to: verify",
    );

    expect(parseWorkflowBytes(encoder.encode(unsupportedKind)).nodes[0]?.kind).toBe("gate");
    expect(parseWorkflowBytes(encoder.encode(duplicateEdge)).edges).toHaveLength(3);
  });

  it("keeps hostile prompt content inert and exact", () => {
    const hostilePrompt = `- --dangerous "quoted"\n$(touch should-not-run)\n\${SECRET}`;
    const source = canonicalWorkflow.replace(
      `    prompt: >-
      Review the current change and write a concise plan to
      .kilin/artifacts/change-review.md. Do not modify product files.`,
      `    prompt: |-\n${hostilePrompt
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n")}`,
    );

    const definition = parseWorkflowBytes(encoder.encode(source));
    const firstNode = definition.nodes[0];

    expect(firstNode?.kind === "agent" ? firstNode.prompt : undefined).toBe(hostilePrompt);
  });

  it.each(["text", "json", "decision_packet"] as const)("rejects a path on %s output", (type) => {
    const source = canonicalWorkflow.replace(
      "    access: workspace_write\n    prompt:",
      `    access: workspace_write\n    output:\n      type: ${type}\n      path: result.txt\n    prompt:`,
    );

    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source)),
      "WORKFLOW_SCHEMA_INVALID",
      "nodes[0].output.path",
    );
  });

  it("requires a path on an artifact output", () => {
    const withOutput = canonicalWorkflow.replace(
      "    access: workspace_write\n    prompt:",
      "    access: workspace_write\n    output:\n      type: artifact\n    prompt:",
    );
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(withOutput)),
      "WORKFLOW_SCHEMA_INVALID",
      "nodes[0].output.path",
    );
  });

  it.each([
    [
      "an empty prompt",
      canonicalWorkflow.replace(
        `prompt: >-
      Review the current change and write a concise plan to
      .kilin/artifacts/change-review.md. Do not modify product files.`,
        "prompt: ''",
      ),
      "nodes[0].prompt",
    ],
    [
      "a malformed identifier",
      canonicalWorkflow.replace("id: change-review", "id: -change-review"),
      "workflow.id",
    ],
  ] as const)("rejects %s during structural validation", (_name, source, path) => {
    expectKilinError(
      () => parseWorkflowBytes(encoder.encode(source)),
      "WORKFLOW_SCHEMA_INVALID",
      path,
    );
  });
});

describe("V1 loop parsing", () => {
  it("accepts the closed contained-loop grammar", () => {
    const source = `schemaVersion: 1
workflow: { id: review-loop, name: Review loop }
nodes:
  - id: refinement
    kind: loop
    maxIterations: 2
    body:
      nodes:
        - id: worker
          kind: agent
          runtime: codex
          access: read_only
          prompt: Revise the work.
          output: { type: text }
        - id: review
          kind: agent
          runtime: codex
          access: read_only
          prompt: Review the work.
          output: { type: text }
        - id: check
          kind: agent
          runtime: codex
          access: read_only
          prompt: Decide.
          output: { type: choice, choices: [pass, revise] }
      edges:
        - { from: worker, to: review, input: draft }
        - { from: review, to: check, input: feedback }
    decision: { node: check, passChoice: pass, reviseChoice: revise }
    feedback: { from: review, to: worker, input: feedback }
    result: { node: worker }
edges: []
`;

    const definition = parseWorkflowBytes(encoder.encode(source));

    expect(definition.schemaVersion).toBe(1);
    expect(definition.nodes[0]).toMatchObject({
      id: "refinement",
      kind: "loop",
      maxIterations: 2,
    });
  });
});
