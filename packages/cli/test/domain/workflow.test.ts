import { describe, expect, it } from "vitest";

import {
  compileWorkflow,
  hashWorkflowDefinition,
  normalizeWorkflowDefinition,
} from "../../src/domain/compile-workflow.js";
import { KilinError } from "../../src/domain/errors.js";
import type {
  AgentNode,
  WorkflowCompilationInput,
  WorkflowDefinitionInput,
  WorkflowDefinitionV1,
} from "../../src/domain/workflow.js";

const node = (
  id: string,
  access: AgentNode["access"] = "read_only",
  runtime: AgentNode["runtime"] = "codex",
): AgentNode => ({
  id,
  kind: "agent",
  runtime,
  access,
  prompt: `Run ${id}`,
});

type AgentWorkflowDefinition = Omit<WorkflowDefinitionV1, "nodes"> & { nodes: AgentNode[] };

const workflow = (
  nodes: AgentNode[],
  edges: WorkflowDefinitionV1["edges"] = [],
): AgentWorkflowDefinition => ({
  schemaVersion: 1,
  workflow: { id: "test-workflow", name: "Test workflow" },
  nodes,
  edges,
});

const retryWorkflow = (
  retry: unknown,
  access: AgentNode["access"] = "read_only",
): WorkflowCompilationInput => ({
  schemaVersion: 1,
  workflow: { id: "retry-workflow", name: "Retry workflow" },
  nodes: [
    {
      ...node("retry-node", access),
      retry,
    } as unknown as WorkflowCompilationInput["nodes"][number],
  ],
  edges: [],
});

const workflowV1 = (
  nodes: WorkflowCompilationInput["nodes"],
  edges: WorkflowCompilationInput["edges"] = [],
): WorkflowCompilationInput => ({
  schemaVersion: 1,
  workflow: { id: "routing-workflow", name: "Routing workflow" },
  nodes,
  edges,
});

const workflowWithApproval = (
  question: string,
  edges: WorkflowDefinitionV1["edges"] = [
    { from: "prepare", to: "approve" },
    { from: "approve", to: "apply" },
  ],
): WorkflowCompilationInput => ({
  schemaVersion: 1,
  workflow: { id: "approval-workflow", name: "Approval workflow" },
  nodes: [node("prepare"), { id: "approve", kind: "approval", question }, node("apply")],
  edges,
});

const expectError = (
  definition: WorkflowCompilationInput,
  code: string,
  path?: string,
  messageFragment?: string,
): void => {
  try {
    compileWorkflow(definition);
    throw new Error("Expected workflow compilation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    if (!(error instanceof KilinError)) {
      throw error;
    }
    expect(error).toMatchObject({ code, ...(path === undefined ? {} : { path }) });
    if (messageFragment !== undefined) {
      expect(error.message).toContain(messageFragment);
    }
  }
};

const expectStructuralError = (value: unknown, path?: string): void => {
  try {
    compileWorkflow(value as WorkflowCompilationInput);
    throw new Error("Expected workflow compilation to fail");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(KilinError);
    expect(error).toMatchObject({
      code: "WORKFLOW_GRAPH_INVALID",
      ...(path === undefined ? {} : { path }),
    });
  }
};

describe("compileWorkflow", () => {
  it.each([
    ["non-object root", null, undefined],
    ["unknown root field", { ...workflow([node("valid")]), unexpected: true }, "unexpected"],
    [
      "invalid schema version",
      { ...workflow([node("valid")]), schemaVersion: Number("0") },
      "schemaVersion",
    ],
    [
      "numeric workflow ID",
      { ...workflow([node("valid")]), workflow: { id: 1, name: "Invalid" } },
      "workflow.id",
    ],
    [
      "uppercase workflow ID",
      { ...workflow([node("valid")]), workflow: { id: "Invalid", name: "Invalid" } },
      "workflow.id",
    ],
    [
      "dotted workflow ID",
      { ...workflow([node("valid")]), workflow: { id: "invalid.workflow", name: "Invalid" } },
      "workflow.id",
    ],
    [
      "repeated workflow ID hyphen",
      { ...workflow([node("valid")]), workflow: { id: "invalid--workflow", name: "Invalid" } },
      "workflow.id",
    ],
    [
      "oversized workflow ID",
      { ...workflow([node("valid")]), workflow: { id: "a".repeat(65), name: "Invalid" } },
      "workflow.id",
    ],
    ["empty node list", { ...workflow([node("valid")]), nodes: [] }, "nodes"],
    ["non-object node", { ...workflow([node("valid")]), nodes: [1] }, "nodes[0]"],
    [
      "numeric node ID",
      { ...workflow([node("valid")]), nodes: [{ ...node("valid"), id: 1 }] },
      "nodes[0].id",
    ],
    [
      "oversized prompt",
      { ...workflow([node("valid")]), nodes: [{ ...node("valid"), prompt: "x".repeat(65_537) }] },
      "nodes[0].prompt",
    ],
    [
      "invalid model",
      { ...workflow([node("valid")]), nodes: [{ ...node("valid"), model: "bad model" }] },
      "nodes[0].model",
    ],
    [
      "non-object output",
      { ...workflow([node("valid")]), nodes: [{ ...node("valid"), output: "text" }] },
      "nodes[0].output",
    ],
    ["non-array edges", { ...workflow([node("valid")]), edges: {} }, "edges"],
    [
      "numeric edge source",
      { ...workflow([node("valid")]), edges: [{ from: 1, to: "valid" }] },
      "edges[0].from",
    ],
  ] as const)("rejects a structurally invalid %s", (_name, value, path) => {
    expectStructuralError(value, path);
  });

  it.each([2, 3, 4] as const)("rejects historical schemaVersion %i", (schemaVersion) => {
    expectStructuralError({ ...workflow([node("valid")]), schemaVersion }, "schemaVersion");
  });

  it("validates and canonicalizes authored agent timeouts without changing absent definitions", () => {
    const baseline = compileWorkflow(workflow([node("worker")]));
    const minimum = compileWorkflow(workflow([{ ...node("worker"), timeoutMs: 1_000 }]));
    const maximum = compileWorkflow(workflow([{ ...node("worker"), timeoutMs: 86_400_000 }]));

    expect(baseline.normalizedDefinition).not.toContain("timeoutMs");
    expect(minimum.definition.nodes[0]).toMatchObject({ timeoutMs: 1_000 });
    expect(maximum.normalizedDefinition).toContain('"timeoutMs":86400000');
    expect(minimum.contentHash).not.toBe(baseline.contentHash);

    for (const timeoutMs of [999, 86_400_001, 1_000.5]) {
      expectError(
        workflow([{ ...node("worker"), timeoutMs }]),
        "WORKFLOW_GRAPH_INVALID",
        "nodes[0].timeoutMs",
        "1000 through 86400000",
      );
    }
  });

  it("rejects timeoutMs on approval nodes at the authored path", () => {
    expectStructuralError(
      {
        ...workflowWithApproval("Continue?"),
        nodes: [
          node("prepare"),
          { id: "approve", kind: "approval", question: "Continue?", timeoutMs: 1_000 },
          node("apply"),
        ],
      },
      "nodes[1].timeoutMs",
    );
  });

  it("retains retry policy canonically in V1", () => {
    const retry = {
      maxAttempts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      on: ["NODE_TIMEOUT", "NODE_EXIT_NONZERO"],
      safeToRepeat: true,
    } as const;

    const plan = compileWorkflow(retryWorkflow(retry));
    const withoutRetry = compileWorkflow({
      ...retryWorkflow(undefined),
      nodes: [node("retry-node")],
    });
    expect(plan.definition).toMatchObject({
      schemaVersion: 1,
      nodes: [{ retry }],
    });
    expect(plan.normalizedDefinition).toContain(
      '"retry":{"initialBackoffMs":1000,"maxAttempts":3,"maxBackoffMs":30000,"on":["NODE_TIMEOUT","NODE_EXIT_NONZERO"],"safeToRepeat":true}',
    );
    expect(plan.contentHash).not.toBe(withoutRetry.contentHash);
  });

  it.each([
    ["minimum", 1, 0, 0],
    ["maximum", 5, 300_000, 300_000],
  ] as const)(
    "accepts retry values at the %s boundaries",
    (_name, maxAttempts, initialBackoffMs, maxBackoffMs) => {
      const plan = compileWorkflow(
        retryWorkflow({
          maxAttempts,
          initialBackoffMs,
          maxBackoffMs,
          safeToRepeat: true,
        }),
      );
      expect(plan.definition.nodes[0]).toMatchObject({
        retry: { maxAttempts, initialBackoffMs, maxBackoffMs, safeToRepeat: true },
      });
    },
  );

  it.each([
    [
      "maxAttempts below range",
      { maxAttempts: 0, initialBackoffMs: 0, maxBackoffMs: 0, safeToRepeat: true },
      "nodes[0].retry.maxAttempts",
    ],
    [
      "maxAttempts above range",
      { maxAttempts: 6, initialBackoffMs: 0, maxBackoffMs: 0, safeToRepeat: true },
      "nodes[0].retry.maxAttempts",
    ],
    [
      "maxAttempts non-integer",
      { maxAttempts: 1.5, initialBackoffMs: 0, maxBackoffMs: 0, safeToRepeat: true },
      "nodes[0].retry.maxAttempts",
    ],
    [
      "initialBackoffMs below range",
      { maxAttempts: 2, initialBackoffMs: -1, maxBackoffMs: 0, safeToRepeat: true },
      "nodes[0].retry.initialBackoffMs",
    ],
    [
      "initialBackoffMs above range",
      { maxAttempts: 2, initialBackoffMs: 300_001, maxBackoffMs: 300_001, safeToRepeat: true },
      "nodes[0].retry.initialBackoffMs",
    ],
    [
      "maxBackoffMs below range",
      { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: -1, safeToRepeat: true },
      "nodes[0].retry.maxBackoffMs",
    ],
    [
      "maxBackoffMs above range",
      { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 300_001, safeToRepeat: true },
      "nodes[0].retry.maxBackoffMs",
    ],
    [
      "backoff order",
      { maxAttempts: 2, initialBackoffMs: 2, maxBackoffMs: 1, safeToRepeat: true },
      "nodes[0].retry.maxBackoffMs",
    ],
  ] as const)("rejects retry policy with %s", (_name, retry, path) => {
    expectError(retryWorkflow(retry), "WORKFLOW_GRAPH_INVALID", path);
  });

  it.each([
    ["missing safeToRepeat", { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0 }],
    [
      "false safeToRepeat",
      { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, safeToRepeat: false },
    ],
  ] as const)("rejects a workspace_write retry policy with %s", (_name, retry) => {
    expectError(
      retryWorkflow(retry, "workspace_write"),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].retry.safeToRepeat",
      "workspace_write",
    );
  });

  it("accepts only failures that are safe to repeat automatically", () => {
    expect(
      compileWorkflow(
        retryWorkflow({
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          on: ["NODE_OUTPUT_INVALID", "NODE_EXIT_NONZERO", "NODE_TIMEOUT"],
          safeToRepeat: true,
        }),
      ).definition.nodes[0],
    ).toMatchObject({
      retry: { on: ["NODE_OUTPUT_INVALID", "NODE_EXIT_NONZERO", "NODE_TIMEOUT"] },
    });
    for (const code of ["NODE_CAPTURE_FAILED", "RUNTIME_AUTH_REQUIRED", "NOT_A_KILIN_ERROR"]) {
      expectError(
        retryWorkflow({
          maxAttempts: 2,
          initialBackoffMs: 0,
          maxBackoffMs: 0,
          on: [code],
          safeToRepeat: true,
        }),
        "WORKFLOW_GRAPH_INVALID",
        "nodes[0].retry.on[0]",
        "non-retryable",
      );
    }
  });

  it.each([
    ["non-object", "retry", "nodes[0].retry"],
    [
      "unknown field",
      { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0, safeToRepeat: true, jitter: true },
      "nodes[0].retry.jitter",
    ],
    [
      "non-array on",
      {
        maxAttempts: 2,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        on: "NODE_TIMEOUT",
        safeToRepeat: true,
      },
      "nodes[0].retry.on",
    ],
  ] as const)("rejects retry with %s structure", (_name, retry, path) => {
    expectStructuralError(retryWorkflow(retry), path);
  });

  it("compiles closed choice routes, join semantics, and workspace annotations canonically", () => {
    const definition = workflowV1(
      [
        {
          ...node("route"),
          output: { type: "choice", choices: ["implement", "no_change"] },
        },
        { ...node("implement"), join: "any", workspace: "candidate_1" },
        node("no-change"),
      ],
      [
        { from: "route", to: "implement", when: { choice: "implement" } },
        { from: "route", to: "no-change", when: { choice: "no_change" } },
      ],
    );

    const plan = compileWorkflow(definition);

    expect(plan.definition.nodes).toMatchObject([
      {
        join: "all",
        output: { type: "choice", choices: ["implement", "no_change"] },
      },
      { join: "any", workspace: "candidate_1" },
      { join: "all" },
    ]);
    expect(plan.edges).toEqual([
      { from: "route", to: "implement", when: { choice: "implement" } },
      { from: "route", to: "no-change", when: { choice: "no_change" } },
    ]);
    expect(plan.normalizedDefinition).toContain(
      '"output":{"choices":["implement","no_change"],"type":"choice"}',
    );
    expect(plan.normalizedDefinition).toContain('"join":"any"');
    expect(plan.normalizedDefinition).toContain('"workspace":"candidate_1"');
    expect(plan.normalizedDefinition).toContain('"when":{"choice":"implement"}');

    const variants: WorkflowCompilationInput[] = [
      {
        ...definition,
        nodes: definition.nodes.map((candidate) =>
          candidate.kind === "agent" && candidate.id === "implement"
            ? { ...candidate, workspace: "candidate_2" }
            : candidate,
        ),
      },
      {
        ...definition,
        nodes: definition.nodes.map((candidate) =>
          candidate.kind === "agent" && candidate.id === "implement"
            ? { ...candidate, join: "all" }
            : candidate,
        ),
      },
      {
        ...definition,
        edges: [
          { from: "route", to: "implement", when: { choice: "no_change" } },
          { from: "route", to: "no-change", when: { choice: "implement" } },
        ],
      },
      {
        ...definition,
        nodes: definition.nodes.map((candidate) =>
          candidate.kind === "agent" && candidate.id === "route"
            ? {
                ...candidate,
                output: { type: "choice", choices: ["implement", "skip"] },
              }
            : candidate,
        ),
        edges: [
          { from: "route", to: "implement", when: { choice: "implement" } },
          { from: "route", to: "no-change", when: { choice: "skip" } },
        ],
      },
    ];
    for (const variant of variants) {
      expect(compileWorkflow(variant).contentHash).not.toBe(plan.contentHash);
    }
  });

  it.each([
    ["minimum", ["go", "stop"]],
    ["maximum", Array.from({ length: 32 }, (_, index) => `choice_${String(index)}`)],
  ] as const)("accepts a choice output at the %s boundary", (_name, choices) => {
    const targets = choices.map((_, index) => node(`target-${String(index)}`));
    const plan = compileWorkflow(
      workflowV1(
        [{ ...node("route"), output: { type: "choice", choices: [...choices] } }, ...targets],
        choices.map((choice, index) => ({
          from: "route",
          to: `target-${String(index)}`,
          when: { choice },
        })),
      ),
    );

    expect(plan.definition.nodes[0]).toMatchObject({
      output: { type: "choice", choices },
    });
  });

  it.each([
    ["too few choices", ["only"], "nodes[0].output.choices"],
    [
      "too many choices",
      Array.from({ length: 33 }, (_, index) => `choice_${String(index)}`),
      "nodes[0].output.choices",
    ],
    ["duplicate choices", ["go", "go"], "nodes[0].output.choices[1]"],
    ["uppercase choice", ["go", "Stop"], "nodes[0].output.choices[1]"],
    ["hyphenated choice", ["go", "no-change"], "nodes[0].output.choices[1]"],
    ["leading digit", ["go", "1stop"], "nodes[0].output.choices[1]"],
    ["oversized choice", ["go", `s${"x".repeat(64)}`], "nodes[0].output.choices[1]"],
  ] as const)("rejects choice output with %s", (_name, choices, path) => {
    expectError(
      workflowV1([
        {
          ...node("route"),
          output: { type: "choice", choices: [...choices] },
        },
      ]),
      "WORKFLOW_GRAPH_INVALID",
      path,
    );
  });

  it.each([
    ["non-object", "go", "edges[0].when"],
    ["unknown field", { choice: "go", expression: "true" }, "edges[0].when.expression"],
  ] as const)("rejects an edge condition with %s structure", (_name, when, path) => {
    expectStructuralError(
      workflowV1(
        [{ ...node("route"), output: { type: "choice", choices: ["go", "stop"] } }, node("target")],
        [
          {
            from: "route",
            to: "target",
            when,
          } as unknown as WorkflowCompilationInput["edges"][number],
        ],
      ),
      path,
    );
  });

  it("requires conditions to name a declared choice from a choice producer", () => {
    expectError(
      workflowV1(
        [node("source"), node("target")],
        [{ from: "source", to: "target", when: { choice: "go" } }],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].from",
    );

    expectError(
      workflowV1(
        [{ ...node("route"), output: { type: "choice", choices: ["go", "stop"] } }, node("target")],
        [{ from: "route", to: "target", when: { choice: "wait" } }],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].when.choice",
    );
  });

  it("requires every declared choice to have at least one conditional edge", () => {
    expectError(
      workflowV1(
        [{ ...node("route"), output: { type: "choice", choices: ["go", "stop"] } }, node("target")],
        [{ from: "route", to: "target", when: { choice: "go" } }],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].output.choices[1]",
      "no conditional edge",
    );
  });

  it("allows distinct choices to route to one dependency-only target", () => {
    const plan = compileWorkflow(
      workflowV1(
        [
          { ...node("route"), output: { type: "choice", choices: ["approve", "revise"] } },
          { ...node("target"), join: "any" },
        ],
        [
          { from: "route", to: "target", when: { choice: "approve" } },
          { from: "route", to: "target", when: { choice: "revise" } },
        ],
      ),
    );

    expect(plan.edges).toHaveLength(2);
    expect(plan.nodes[1]?.dependencies).toEqual(["route"]);
  });

  it("rejects duplicate choice edges and input bindings on parallel choice routes", () => {
    const nodes: WorkflowCompilationInput["nodes"] = [
      { ...node("route"), output: { type: "choice", choices: ["approve", "revise"] } },
      { ...node("target"), join: "any" },
    ];

    expectError(
      workflowV1(nodes, [
        { from: "route", to: "target", when: { choice: "approve" } },
        { from: "route", to: "target", when: { choice: "approve" } },
      ]),
      "WORKFLOW_GRAPH_INVALID",
      "edges[1]",
    );
    expectError(
      workflowV1(nodes, [
        { from: "route", to: "target", when: { choice: "approve" } },
        { from: "route", to: "target", input: "selection", when: { choice: "revise" } },
      ]),
      "WORKFLOW_GRAPH_INVALID",
      "edges[1].input",
    );
  });

  it("requires join any when mutually exclusive choices route to one target", () => {
    expectError(
      workflowV1(
        [
          { ...node("route"), output: { type: "choice", choices: ["approve", "revise"] } },
          node("target"),
        ],
        [
          { from: "route", to: "target", when: { choice: "approve" } },
          { from: "route", to: "target", when: { choice: "revise" } },
        ],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[1].join",
      'join "all"',
    );
  });

  it("rejects artifact input bindings across effective workspaces", () => {
    expectError(
      workflowV1(
        [
          {
            ...node("source", "workspace_write"),
            output: { type: "artifact", path: "outputs/report.md" },
          },
          { ...node("consumer"), workspace: "candidate" },
        ],
        [{ from: "source", to: "consumer", input: "report" }],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].input",
      "crosses from workspace",
    );
  });

  it("defaults agent and approval joins to all and retains explicit any", () => {
    const plan = compileWorkflow(
      workflowV1([
        node("agent"),
        { id: "approve", kind: "approval", question: "Proceed?", join: "any" },
      ]),
    );

    expect(plan.definition.nodes).toMatchObject([
      { id: "agent", join: "all" },
      { id: "approve", join: "any" },
    ]);
    expect(plan.normalizedDefinition).toContain('"id":"approve","join":"any","kind":"approval"');
  });

  it.each(["some", "", 1] as const)("rejects invalid join value %s", (join) => {
    expectError(
      workflowV1([
        {
          ...node("agent"),
          join,
        } as unknown as WorkflowCompilationInput["nodes"][number],
      ]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].join",
    );
  });

  it.each([
    ["reserved source", "source"],
    ["empty", ""],
    ["slash", "candidate/one"],
    ["parent traversal", "../candidate"],
    ["leading dot", ".candidate"],
    ["uppercase", "Candidate"],
    ["hyphen", "candidate-one"],
    ["oversized", `w${"x".repeat(128)}`],
  ] as const)("rejects a workspace ID with %s", (_name, workspace) => {
    expectError(
      workflowV1([{ ...node("agent"), workspace }]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].workspace",
    );
  });

  it("rejects live artifact output from an isolated workspace", () => {
    expectError(
      workflowV1([
        {
          ...node("writer", "workspace_write"),
          workspace: "candidate",
          output: { type: "artifact", path: "report.md" },
        },
      ]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].output.type",
      "isolated workspace",
    );
  });

  it("compiles an approval gate into canonical dependency order", () => {
    const plan = compileWorkflow(workflowWithApproval("Approve the prepared change?"));

    expect(plan.nodes.map(({ node: plannedNode }) => plannedNode.id)).toEqual([
      "prepare",
      "approve",
      "apply",
    ]);
    expect(plan.definition.nodes[1]).toEqual({
      id: "approve",
      join: "all",
      kind: "approval",
      question: "Approve the prepared change?",
    });
    expect(plan.normalizedDefinition).toContain(
      '"id":"approve","join":"all","kind":"approval","question":"Approve the prepared change?"',
    );
    expect(plan.contentHash).not.toBe(
      compileWorkflow(workflowWithApproval("Approve a different change?")).contentHash,
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n "],
    ["over 2,000 characters", "😀".repeat(2_001)],
  ] as const)("rejects an approval question that is %s", (_name, question) => {
    expectError(
      workflowWithApproval(question),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[1].question",
      "1 through 2,000",
    );
  });

  it.each([
    ["one character", "?"],
    ["2,000 Unicode characters", "😀".repeat(2_000)],
  ] as const)("accepts an approval question with %s", (_name, question) => {
    const plan = compileWorkflow(workflowWithApproval(question));
    const approval = plan.definition.nodes[1];

    expect(approval?.kind === "approval" ? approval.question : undefined).toBe(question);
  });

  it("rejects a non-string approval question", () => {
    const definition = workflowWithApproval("Proceed?");
    definition.nodes[1] = {
      id: "approve",
      kind: "approval",
      question: 1,
    } as unknown as WorkflowCompilationInput["nodes"][number];

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[1].question", "1 through 2,000");
  });

  it.each([
    [
      "source",
      workflowWithApproval("Proceed?", [{ from: "approve", to: "apply", input: "decision" }]),
      "edges[0].from",
    ],
    [
      "target",
      workflowWithApproval("Proceed?", [{ from: "prepare", to: "approve", input: "result" }]),
      "edges[0].to",
    ],
  ] as const)("rejects an approval data-edge %s", (_name, definition, path) => {
    definition.nodes[0] = { ...node("prepare"), output: { type: "text" } };
    expectError(definition, "WORKFLOW_GRAPH_INVALID", path, "Approval node");
  });

  it.each([
    ["runtime", "codex"],
    ["access", "read_only"],
    ["prompt", "Run something"],
    ["model", "gpt-5"],
    ["output", { type: "text" }],
    ["unexpected", true],
  ] as const)("rejects agent field %s on an approval node", (field, value) => {
    const definition = workflowWithApproval("Proceed?");
    definition.nodes[1] = {
      id: "approve",
      kind: "approval",
      question: "Proceed?",
      [field]: value,
    } as unknown as WorkflowCompilationInput["nodes"][number];

    expectError(definition, "WORKFLOW_GRAPH_INVALID", `nodes[1].${field}`, "Remove");
  });

  it("rejects an approval question on an agent node", () => {
    const definition: WorkflowCompilationInput = workflow([node("agent")]);
    definition.nodes[0] = {
      ...node("agent"),
      question: "Proceed?",
    } as unknown as WorkflowCompilationInput["nodes"][number];

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].question", "Remove");
  });

  it("compiles named input bindings in deterministic input-name order", () => {
    const maximumInputName = `z${"x".repeat(63)}`;
    const definition = {
      ...workflow([
        { ...node("source-z"), output: { type: "text" } },
        { ...node("source-a"), output: { type: "json" } },
        node("target"),
      ]),
      edges: [
        { from: "source-z", to: "target", input: maximumInputName },
        { from: "source-a", to: "target", input: "a_value" },
      ],
    } as WorkflowDefinitionInput;

    const target = compileWorkflow(definition).nodes.find(
      ({ node: plannedNode }) => plannedNode.id === "target",
    );

    expect(target?.inputBindings).toEqual([
      { inputName: "a_value", source: { kind: "execution", sourceExecutionId: "source-a" } },
      { inputName: maximumInputName, source: { kind: "execution", sourceExecutionId: "source-z" } },
    ]);
    expect(target?.dependencies).toEqual(["source-z", "source-a"]);
  });

  it.each([
    ["uppercase", "Plan"],
    ["leading digit", "1plan"],
    ["hyphen", "change-plan"],
    ["too long", `a${"b".repeat(64)}`],
  ] as const)("rejects an input name with %s", (_name, input) => {
    const definition = {
      ...workflow(
        [{ ...node("source"), output: { type: "text" } }, node("target")],
        [{ from: "source", to: "target", input }],
      ),
    } as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "edges[0].input");
  });

  it("rejects a data edge whose source has no declared output", () => {
    const definition = workflow(
      [node("source"), node("target")],
      [{ from: "source", to: "target", input: "value" }],
    ) as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "edges[0].from");
  });

  it("rejects duplicate target input names from different sources", () => {
    const definition = workflow(
      [
        { ...node("first"), output: { type: "text" } },
        { ...node("second"), output: { type: "json" } },
        node("target"),
      ],
      [
        { from: "first", to: "target", input: "value" },
        { from: "second", to: "target", input: "value" },
      ],
    ) as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "edges[1].input");
  });

  it("keeps one source-target edge even when input names differ", () => {
    const definition = workflow(
      [{ ...node("source"), output: { type: "text" } }, node("target")],
      [
        { from: "source", to: "target", input: "first" },
        { from: "source", to: "target", input: "second" },
      ],
    ) as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "edges[1]");
  });

  it.each(["text", "json", "decision_packet"] as const)(
    "retains a declared %s output in the semantic plan and revision hash",
    (type) => {
      const legacy = workflow([node("typed")]);
      const definition = {
        ...legacy,
        nodes: [{ ...node("typed"), output: { type } }],
      } as WorkflowDefinitionInput;

      const plan = compileWorkflow(definition);

      expect(plan.definition.nodes[0]).toMatchObject({ output: { type } });
      expect(plan.normalizedDefinition).toContain(`"output":{"type":"${type}"}`);
      expect(plan.contentHash).not.toBe(hashWorkflowDefinition(legacy));
    },
  );

  it("allows a Decision Packet declaration on a read-only agent and binds it as data", () => {
    const definition = workflow(
      [{ ...node("judge"), output: { type: "decision_packet" } }, node("review")],
      [{ from: "judge", to: "review", input: "packet" }],
    ) as WorkflowDefinitionInput;

    const plan = compileWorkflow(definition);

    expect(plan.definition.nodes[0]).toMatchObject({
      access: "read_only",
      output: { type: "decision_packet" },
    });
    expect(plan.nodes[1]?.inputBindings).toEqual([
      { inputName: "packet", source: { kind: "execution", sourceExecutionId: "judge" } },
    ]);
    expect(plan.normalizedDefinition).toContain('"output":{"type":"decision_packet"}');
  });

  it.each([
    ["one byte", "a"],
    ["maximum UTF-8 bytes", `${"界".repeat(341)}a`],
    ["root file", "report.md"],
    ["nested hidden directory", ".kilin/artifacts/change-summary.md"],
    ["Unicode", "outputs/报告.json"],
  ] as const)("retains an artifact output path with %s", (_name, path) => {
    const definition = {
      ...workflow([node("artifact", "workspace_write")]),
      nodes: [{ ...node("artifact", "workspace_write"), output: { type: "artifact", path } }],
    } as WorkflowDefinitionInput;

    const plan = compileWorkflow(definition);

    const compiledNode = plan.definition.nodes[0];
    expect(compiledNode?.kind).toBe("agent");
    expect(compiledNode?.kind === "agent" ? compiledNode.output : undefined).toEqual({
      type: "artifact",
      path,
    });
    expect(plan.normalizedDefinition).toContain(
      `"output":{"path":${JSON.stringify(path)},"type":"artifact"}`,
    );
  });

  it("includes the artifact output path in the revision hash", () => {
    const definition = workflow([
      { ...node("artifact", "workspace_write"), output: { type: "artifact", path: "report.md" } },
    ]);
    const changedPath = {
      ...definition,
      nodes: [
        { ...node("artifact", "workspace_write"), output: { type: "artifact", path: "other.md" } },
      ],
    } satisfies WorkflowDefinitionV1;

    expect(hashWorkflowDefinition(definition)).not.toBe(hashWorkflowDefinition(changedPath));
  });

  it.each([
    ["empty", ""],
    ["over 1,024 UTF-8 bytes", `${"界".repeat(341)}aa`],
    ["leading slash", "/tmp/report.md"],
    ["trailing slash", "outputs/report.md/"],
    ["repeated separator", "outputs//report.md"],
    ["dot segment", "./report.md"],
    ["nested dot segment", "outputs/./report.md"],
    ["parent segment", "a/../report.md"],
    ["backslash", "outputs\\report.md"],
    ["NUL", "outputs/\0report.md"],
    ["ASCII control", "outputs/\u001freport.md"],
    ["delete control", "outputs/\u007freport.md"],
  ] as const)("rejects an artifact output path with %s", (_name, path) => {
    const definition = {
      ...workflow([node("artifact", "workspace_write")]),
      nodes: [{ ...node("artifact", "workspace_write"), output: { type: "artifact", path } }],
    } as WorkflowDefinitionInput;

    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].output.path",
      "normalized POSIX-relative",
    );
  });

  it("requires workspace_write access for an artifact output", () => {
    const definition = {
      ...workflow([node("artifact")]),
      nodes: [{ ...node("artifact"), output: { type: "artifact", path: "report.md" } }],
    } as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].access");
  });

  it.each([
    [{ type: "artifact" }, "nodes[0].output.path"],
    [{ type: "other" }, "nodes[0].output.type"],
    [{ type: "text", path: "result.txt" }, "nodes[0].output.path"],
    [{ type: "decision_packet", path: "packet.json" }, "nodes[0].output.path"],
  ] as const)("rejects an invalid programmatic output declaration", (output, path) => {
    const definition = {
      ...workflow([node("typed")]),
      nodes: [{ ...node("typed"), output }],
    } as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", path);
  });

  it("embeds a declared json output schema in the semantic plan and revision hash", () => {
    const legacy = workflow([{ ...node("scan"), output: { type: "json" } }]);
    const definition = {
      ...legacy,
      nodes: [
        {
          ...node("scan"),
          output: {
            type: "json",
            schema: {
              type: "object",
              required: ["findings"],
              properties: { findings: { type: "array" } },
            },
          },
        },
      ],
    } as WorkflowDefinitionInput;

    const plan = compileWorkflow(definition);

    expect(plan.definition.nodes[0]).toMatchObject({
      output: { type: "json", schema: { required: ["findings"] } },
    });
    expect(plan.normalizedDefinition).toContain(
      '"output":{"schema":{"properties":{"findings":{"type":"array"}},"required":["findings"],' +
        '"type":"object"},"type":"json"}',
    );
    expect(plan.contentHash).not.toBe(compileWorkflow(legacy).contentHash);
  });

  it("canonicalizes a declared json output schema identically regardless of key order", () => {
    const build = (schema: Record<string, unknown>): WorkflowDefinitionInput =>
      ({
        ...workflow([node("scan")]),
        nodes: [{ ...node("scan"), output: { type: "json", schema } }],
      }) as WorkflowDefinitionInput;

    const forward = compileWorkflow(
      build({
        type: "object",
        properties: { severity: { type: "string" } },
        required: ["severity"],
      }),
    );
    const reordered = compileWorkflow(
      build({
        required: ["severity"],
        properties: { severity: { type: "string" } },
        type: "object",
      }),
    );

    expect(reordered.normalizedDefinition).toBe(forward.normalizedDefinition);
    expect(reordered.contentHash).toBe(forward.contentHash);
  });

  it.each([
    ["a string", "schemas/findings.json"],
    ["an array", [{ type: "object" }]],
    ["a number", 42],
  ] as const)("rejects a json output schema that is %s", (_name, schema) => {
    const definition = {
      ...workflow([node("scan")]),
      nodes: [{ ...node("scan"), output: { type: "json", schema } }],
    } as WorkflowDefinitionInput;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].output.schema", "is not an object");
  });

  it.each([
    ["a non-finite number", { maximum: Number.POSITIVE_INFINITY }],
    ["an unsafe integer", { maximum: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)("rejects a json output schema with %s", (_name, schema) => {
    const definition = {
      ...workflow([node("scan")]),
      nodes: [{ ...node("scan"), output: { type: "json", schema } }],
    } as WorkflowDefinitionInput;

    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].output.schema",
      "is not canonical JSON",
    );
  });

  it.each([
    ["text", "read_only", { type: "text" }],
    ["decision_packet", "read_only", { type: "decision_packet" }],
    ["choice", "read_only", { type: "choice", choices: ["pass", "revise"] }],
    ["artifact", "workspace_write", { type: "artifact", path: "report.md" }],
  ] as const)("rejects a schema declared on a %s output", (type, access, output) => {
    const definition = {
      ...workflow([node("typed", access as AgentNode["access"])]),
      nodes: [
        {
          ...node("typed", access as AgentNode["access"]),
          output: { ...output, schema: { type: "object" } },
        },
      ],
    } as WorkflowDefinitionInput;

    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].output.schema",
      `declares a schema for ${type} output`,
    );
  });

  it.each([
    ["codex", "read_only"],
    ["codex", "workspace_write"],
    ["claude-code", "read_only"],
    ["claude-code", "workspace_write"],
    ["opencode", "workspace_write"],
  ] as const)("accepts the fixed %s/%s runtime access pair", (runtime, access) => {
    const plan = compileWorkflow(workflow([node("runtime", access, runtime)]));

    expect(plan.nodes[0]?.node).toMatchObject({ runtime, access });
  });

  it("compiles the canonical writable chain in dependency order", () => {
    const definition = workflow(
      [node("analyze", "workspace_write"), node("implement", "workspace_write"), node("verify")],
      [
        { from: "analyze", to: "implement" },
        { from: "implement", to: "verify" },
      ],
    );

    const plan = compileWorkflow(definition);

    expect(plan.nodes.map(({ node: plannedNode }) => plannedNode.id)).toEqual([
      "analyze",
      "implement",
      "verify",
    ]);
    expect(plan.nodes.map(({ ordinal, dependencies }) => ({ ordinal, dependencies }))).toEqual([
      { ordinal: 0, dependencies: [] },
      { ordinal: 1, dependencies: ["analyze"] },
      { ordinal: 2, dependencies: ["implement"] },
    ]);
    expect(plan.definition).toEqual({
      ...definition,
      nodes: definition.nodes.map((workflowNode) => ({ ...workflowNode, join: "all" })),
    });
    expect(plan.definition).not.toBe(definition);
    expect(plan.definition.nodes[0]).not.toBe(definition.nodes[0]);
    expect(plan.edges).toEqual(definition.edges);
    expect(plan.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("orders simultaneously ready read-only nodes by declaration order", () => {
    const definition = workflow(
      [node("second-declared"), node("first-declared"), node("last")],
      [
        { from: "second-declared", to: "last" },
        { from: "first-declared", to: "last" },
      ],
    );

    expect(
      compileWorkflow(definition).nodes.map(({ node: plannedNode }) => plannedNode.id),
    ).toEqual(["second-declared", "first-declared", "last"]);
  });

  it.each<[string, WorkflowDefinitionInput, string, string]>([
    [
      "duplicate node IDs",
      workflow([node("same"), node("same")]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[1].id",
    ],
    [
      "empty prompts",
      { ...workflow([node("empty")]), nodes: [{ ...node("empty"), prompt: " \n " }] },
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].prompt",
    ],
    [
      "missing edge sources",
      workflow([node("present")], [{ from: "missing", to: "present" }]),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].from",
    ],
    [
      "missing edge targets",
      workflow([node("present")], [{ from: "present", to: "missing" }]),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].to",
    ],
    [
      "self edges",
      workflow([node("self")], [{ from: "self", to: "self" }]),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0]",
    ],
    [
      "duplicate edges",
      workflow(
        [node("a"), node("b")],
        [
          { from: "a", to: "b" },
          { from: "a", to: "b" },
        ],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges[1]",
    ],
    [
      "cycles",
      workflow(
        [node("a"), node("b")],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges",
    ],
    [
      "unordered writers",
      workflow([node("reader"), node("writer", "workspace_write")]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[1]",
    ],
    [
      "unsupported runtime access",
      workflow([node("runtime", "read_only", "opencode")]),
      "RUNTIME_ACCESS_UNSUPPORTED",
      "nodes[0].access",
    ],
    [
      "unsupported runtimes",
      { ...workflow([node("runtime")]), nodes: [{ ...node("runtime"), runtime: "other" }] },
      "RUNTIME_UNSUPPORTED",
      "nodes[0].runtime",
    ],
    [
      "unsupported node kinds",
      { ...workflow([node("kind")]), nodes: [{ ...node("kind"), kind: "gate" }] },
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].kind",
    ],
  ])("rejects %s", (_name, definition, code, path) => {
    expectError(definition, code, path);
  });

  it("compiles a generated larger DAG deterministically", () => {
    const nodeCount = 256;
    const nodes = Array.from({ length: nodeCount }, (_, index) => node(`node-${String(index)}`));
    const edges = Array.from({ length: nodeCount - 1 }, (_, index) => ({
      from: `node-${String(index)}`,
      to: `node-${String(index + 1)}`,
    }));

    const plan = compileWorkflow(workflow(nodes, edges));

    expect(plan.nodes).toHaveLength(nodeCount);
    expect(plan.nodes[0]?.node.id).toBe("node-0");
    expect(plan.nodes.at(-1)?.node.id).toBe("node-255");
  });
});

describe("V1 contained loops", () => {
  interface MutableLoop {
    body: {
      nodes: Record<string, unknown>[];
      edges: Record<string, unknown>[];
    };
    decision: { node: string; passChoice: string; reviseChoice: string };
    feedback: { from: string; to: string; input: string };
    result: { node: string };
  }

  const loopWorkflow = (maxIterations = 2): WorkflowCompilationInput =>
    ({
      schemaVersion: 1,
      workflow: { id: "review-loop", name: "Review loop" },
      nodes: [
        {
          id: "refinement",
          kind: "loop",
          maxIterations,
          body: {
            nodes: [
              { ...node("worker"), output: { type: "text" } },
              { ...node("review"), output: { type: "text" } },
              {
                ...node("check"),
                output: { type: "choice", choices: ["pass", "revise"] },
              },
            ],
            edges: [
              { from: "worker", to: "review", input: "draft" },
              { from: "review", to: "check", input: "feedback" },
            ],
          },
          decision: { node: "check", passChoice: "pass", reviseChoice: "revise" },
          feedback: { from: "review", to: "worker", input: "feedback" },
          result: { node: "worker" },
        },
        node("final"),
      ],
      edges: [{ from: "refinement", to: "final", input: "result" }],
    }) as unknown as WorkflowCompilationInput;

  const mutableLoop = (definition: WorkflowCompilationInput): MutableLoop =>
    definition.nodes[0] as unknown as MutableLoop;

  it("validates agent timeouts inside loop bodies at their authored paths", () => {
    const definition = loopWorkflow();
    mutableLoop(definition).body.nodes[0] = {
      ...mutableLoop(definition).body.nodes[0],
      timeoutMs: 1_500,
    };
    const plan = compileWorkflow(definition);
    const authoredLoop = plan.authoredDefinition.nodes[0];
    if (authoredLoop?.kind !== "loop") {
      throw new Error("Expected the authored loop");
    }
    expect(authoredLoop.body.nodes[0]).toMatchObject({ timeoutMs: 1_500 });

    mutableLoop(definition).body.nodes[0] = {
      ...mutableLoop(definition).body.nodes[0],
      timeoutMs: 999,
    };
    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].body.nodes[0].timeoutMs",
      "1000 through 86400000",
    );
  });

  it("expands every bounded iteration with stable opaque identity and explicit provenance", () => {
    const first = compileWorkflow(loopWorkflow());
    const second = compileWorkflow(loopWorkflow());
    const loop = first.loops[0];

    expect(first.authoredDefinition.nodes).toHaveLength(2);
    expect(first.definition.nodes).toHaveLength(8);
    expect(first.definition.nodes.find(({ id }) => id === "refinement")).toEqual({
      id: "refinement",
      kind: "loop",
      output: { type: "text" },
    });
    expect(loop).toMatchObject({
      executionId: "refinement",
      nodeId: "refinement",
      maxIterations: 2,
      passChoice: "pass",
      reviseChoice: "revise",
      feedbackInputName: "feedback",
    });
    expect(loop?.iterations).toHaveLength(2);
    expect(loop?.iterations[0]?.executionIds).toHaveLength(3);
    expect(loop?.iterations[1]?.executionIds).toHaveLength(3);
    expect(loop?.iterations[0]?.executionIds).toEqual(second.loops[0]?.iterations[0]?.executionIds);
    expect(new Set(first.nodes.map(({ executionId }) => executionId)).size).toBe(
      first.nodes.length,
    );
    const secondWorker = first.nodes.find(
      ({ nodeId, iteration }) => nodeId === "worker" && iteration === 1,
    );
    expect(secondWorker).toMatchObject({
      loopNodeId: "refinement",
      iteration: 1,
      inputBindings: [
        {
          inputName: "feedback",
          source: {
            kind: "execution",
            sourceExecutionId: loop?.iterations[0]?.feedbackSourceExecutionId,
          },
        },
      ],
    });
    expect(first.normalizedDefinition).toContain('"kind":"loop"');
    expect(first.contentHash).toBe(second.contentHash);
  });

  it.each([0, 6, 1.5] as const)("rejects maxIterations %s outside 1 through 5", (value) => {
    expectError(loopWorkflow(value), "WORKFLOW_GRAPH_INVALID", "nodes[0].maxIterations");
  });

  it("rejects a body whose decision is not its unique sink", () => {
    const definition = loopWorkflow();
    const authoredLoop = definition.nodes[0] as unknown as {
      body: { nodes: unknown[]; edges: unknown[] };
    };
    authoredLoop.body.nodes.push(node("orphan"));

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].decision.node", "unique body sink");
  });

  it("rejects nested loops", () => {
    const definition = loopWorkflow();
    const authoredLoop = definition.nodes[0] as unknown as {
      body: { nodes: unknown[] };
    };
    authoredLoop.body.nodes.push({
      id: "nested",
      kind: "loop",
      maxIterations: 1,
      body: { nodes: [node("nested-worker")], edges: [] },
      decision: { node: "nested-worker", passChoice: "pass", reviseChoice: "revise" },
      feedback: { from: "nested-worker", to: "nested-worker", input: "feedback" },
      result: { node: "nested-worker" },
    });

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].body.nodes[3].kind", "nested loop");
  });

  it("rejects conditional body edges through the loop contract", () => {
    const definition = loopWorkflow();
    mutableLoop(definition).body.edges[0] = {
      ...mutableLoop(definition).body.edges[0],
      when: { choice: "pass" },
    };

    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].body.edges[0].when",
      "cannot be conditional",
    );
  });

  it.each([
    ["artifact", { type: "artifact", path: "feedback.txt" }, "workspace_write"],
    ["choice", { type: "choice", choices: ["accept", "reject"] }, "read_only"],
  ] as const)("rejects %s feedback output", (_name, output, access) => {
    const definition = loopWorkflow();
    const review = mutableLoop(definition).body.nodes[1];
    if (review === undefined) {
      throw new Error("Expected review node");
    }
    review.output = output;
    review.access = access;

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].feedback.from", "feedback source");
  });

  it("rejects artifact loop results", () => {
    const definition = loopWorkflow();
    const worker = mutableLoop(definition).body.nodes[0];
    if (worker === undefined) {
      throw new Error("Expected worker node");
    }
    worker.output = { type: "artifact", path: "result.txt" };
    worker.access = "workspace_write";

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].result.node", "non-artifact");
  });

  it("compiles a choice loop result without requiring outer choice coverage", () => {
    const definition = loopWorkflow();
    mutableLoop(definition).result.node = "check";

    const plan = compileWorkflow(definition);

    expect(plan.definition.nodes.find(({ id }) => id === "refinement")).toEqual({
      id: "refinement",
      kind: "loop",
      output: { type: "choice", choices: ["pass", "revise"] },
    });
  });

  it.each([
    ["an extra choice", ["pass", "revise", "other"]],
    ["a substituted choice", ["pass", "redo"]],
  ] as const)("rejects a decision output with %s", (_name, choices) => {
    const definition = loopWorkflow();
    const check = mutableLoop(definition).body.nodes[2];
    if (check === undefined) {
      throw new Error("Expected decision node");
    }
    check.output = { type: "choice", choices };

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes[0].decision.node", "exactly");
  });

  it.each(["parameter", "body edge"] as const)(
    "rejects a feedback input duplicated by a %s",
    (source) => {
      const definition = loopWorkflow();
      const loop = mutableLoop(definition);
      if (source === "parameter") {
        definition.parameters = ["feedback"];
        const worker = loop.body.nodes[0];
        if (worker === undefined) {
          throw new Error("Expected worker node");
        }
        worker.parameters = ["feedback"];
      } else {
        loop.feedback.to = "check";
      }

      expectError(
        definition,
        "WORKFLOW_GRAPH_INVALID",
        "nodes[0].feedback.input",
        "bound more than once",
      );
    },
  );

  it("rejects an outer data binding into a loop", () => {
    const definition = loopWorkflow();
    definition.nodes.unshift({
      ...node("source"),
      output: { type: "text" },
    });
    definition.edges.push({
      from: "source",
      to: "refinement",
      input: "draft",
    });

    expectError(
      definition,
      "WORKFLOW_GRAPH_INVALID",
      "edges[1].to",
      'Loop node "refinement" cannot consume outer data because data bindings into loops are deferred.',
    );
  });

  it("avoids collisions with authored IDs that resemble generated occurrence IDs", () => {
    const baseline = compileWorkflow(loopWorkflow());
    const reservedId = baseline.loops[0]?.iterations[0]?.executionIds[0];
    if (reservedId === undefined) {
      throw new Error("Expected generated loop occurrence");
    }
    const definition = loopWorkflow();
    definition.nodes.push({ ...node(reservedId), prompt: "Authored collision sentinel" });

    const plan = compileWorkflow(definition);
    const occurrenceIds = plan.nodes.map(({ executionId }) => executionId);

    expect(occurrenceIds).toContain(reservedId);
    expect(plan.loops[0]?.iterations[0]?.executionIds[0]).not.toBe(reservedId);
    expect(new Set(occurrenceIds).size).toBe(occurrenceIds.length);
  });

  it.each([
    ["nodes", 129, "nodes[0].body.nodes"],
    ["edges", 513, "nodes[0].body.edges"],
  ] as const)(
    "rejects a loop body beyond the 128-node or 512-edge %s bound",
    (field, count, path) => {
      const definition = loopWorkflow();
      const body = mutableLoop(definition).body;
      if (field === "nodes") {
        body.nodes = Array.from({ length: count }, (_value, index) => ({
          ...node(`body-${String(index)}`),
        }));
      } else {
        body.edges = Array.from({ length: count }, () => ({
          from: "worker",
          to: "review",
        }));
      }

      expectError(definition, "WORKFLOW_GRAPH_INVALID", path, String(count - 1));
    },
  );

  it("rejects expansion beyond 256 executions", () => {
    const definition = loopWorkflow(5);
    const authoredLoop = definition.nodes[0] as unknown as {
      body: { nodes: unknown[]; edges: unknown[] };
      decision: { node: string };
      feedback: { from: string; to: string };
      result: { node: string };
    };
    authoredLoop.body.nodes = Array.from({ length: 52 }, (_value, index) => ({
      ...node(`body-${String(index)}`),
      ...(index === 0 || index === 50 ? { output: { type: "text" } } : {}),
      ...(index === 51 ? { output: { type: "choice", choices: ["pass", "revise"] } } : {}),
    }));
    authoredLoop.body.edges = Array.from({ length: 51 }, (_value, index) => ({
      from: `body-${String(index)}`,
      to: `body-${String(index + 1)}`,
    }));
    authoredLoop.decision.node = "body-51";
    authoredLoop.feedback = { ...authoredLoop.feedback, from: "body-50", to: "body-0" };
    authoredLoop.result.node = "body-0";

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "nodes", "256");
  });

  it("rejects expansion beyond 1,024 edges", () => {
    const definition = loopWorkflow(5);
    const authoredLoop = definition.nodes[0] as unknown as {
      body: { nodes: unknown[]; edges: { from: string; to: string }[] };
      decision: { node: string };
      feedback: { from: string; to: string };
      result: { node: string };
    };
    authoredLoop.body.nodes = Array.from({ length: 50 }, (_value, index) => ({
      ...node(`body-${String(index)}`),
      ...(index === 0 || index === 48 ? { output: { type: "text" } } : {}),
      ...(index === 49 ? { output: { type: "choice", choices: ["pass", "revise"] } } : {}),
    }));
    const edges = Array.from({ length: 49 }, (_value, index) => ({
      from: `body-${String(index)}`,
      to: `body-${String(index + 1)}`,
    }));
    for (let from = 0; from < 48 && edges.length < 205; from += 1) {
      for (let to = from + 2; to <= 49 && edges.length < 205; to += 1) {
        edges.push({ from: `body-${String(from)}`, to: `body-${String(to)}` });
      }
    }
    authoredLoop.body.edges = edges;
    authoredLoop.decision.node = "body-49";
    authoredLoop.feedback = { ...authoredLoop.feedback, from: "body-48", to: "body-0" };
    authoredLoop.result.node = "body-0";

    expectError(definition, "WORKFLOW_GRAPH_INVALID", "edges", "1024");
  });
});

describe("workflow normalization", () => {
  it("includes input bindings in canonical edges and their revision hash", () => {
    const legacy = workflow(
      [{ ...node("source"), output: { type: "json" } }, node("target")],
      [{ from: "source", to: "target" }],
    );
    const bound = {
      ...legacy,
      edges: [{ from: "source", to: "target", input: "plan" }],
    } as WorkflowDefinitionV1;

    expect(normalizeWorkflowDefinition(bound)).toContain(
      '"edges":[{"from":"source","input":"plan","to":"target"}]',
    );
    expect(hashWorkflowDefinition(bound)).not.toBe(hashWorkflowDefinition(legacy));
  });

  it("sorts object keys recursively and edges without changing node order or strings", () => {
    const definition = workflow(
      [{ ...node("b"), prompt: "  exact\ntext  ", model: "gpt-5" }, node("a"), node("c")],
      [
        { from: "b", to: "c" },
        { from: "a", to: "c" },
      ],
    );

    const normalized = normalizeWorkflowDefinition(definition);

    expect(normalized).toBe(
      '{"edges":[{"from":"a","to":"c"},{"from":"b","to":"c"}],"nodes":[{"access":"read_only","id":"b","kind":"agent","model":"gpt-5","prompt":"  exact\\ntext  ","runtime":"codex"},{"access":"read_only","id":"a","kind":"agent","prompt":"Run a","runtime":"codex"},{"access":"read_only","id":"c","kind":"agent","prompt":"Run c","runtime":"codex"}],"schemaVersion":1,"workflow":{"id":"test-workflow","name":"Test workflow"}}',
    );
    expect(hashWorkflowDefinition(definition)).toBe(
      "ef3e0557c576b1b5ac4e97095e8147b2d47e3fcef2dc5298327d81958ec0f3b8",
    );
  });

  it("gives semantic equivalents one hash while meaningful changes alter it", () => {
    const base = workflow(
      [node("a"), node("b"), node("c")],
      [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    );
    const reorderedEdges = { ...base, edges: [...base.edges].reverse() };
    const firstNode = base.nodes[0];
    if (firstNode === undefined) {
      throw new Error("Expected the base workflow to contain a node");
    }

    expect(hashWorkflowDefinition(reorderedEdges)).toBe(hashWorkflowDefinition(base));

    const variants: WorkflowDefinitionV1[] = [
      { ...base, nodes: [...base.nodes].reverse() },
      { ...base, nodes: [{ ...firstNode, prompt: "Changed" }, ...base.nodes.slice(1)] },
      { ...base, nodes: [{ ...firstNode, access: "workspace_write" }, ...base.nodes.slice(1)] },
      { ...base, nodes: [{ ...firstNode, model: "gpt-5" }, ...base.nodes.slice(1)] },
      {
        ...base,
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      },
    ];

    for (const variant of variants) {
      expect(hashWorkflowDefinition(variant)).not.toBe(hashWorkflowDefinition(base));
    }
  });
});

describe("V1 run parameters", () => {
  const parameterWorkflow = (
    parameters: unknown,
    nodes: WorkflowCompilationInput["nodes"],
    edges: WorkflowCompilationInput["edges"] = [],
  ): WorkflowCompilationInput =>
    ({
      schemaVersion: 1,
      workflow: { id: "parameter-workflow", name: "Parameter workflow" },
      parameters,
      nodes,
      edges,
    }) as unknown as WorkflowCompilationInput;

  const consumer = (id: string, parameters: unknown): WorkflowCompilationInput["nodes"][number] =>
    ({ ...node(id), parameters }) as unknown as WorkflowCompilationInput["nodes"][number];

  it("binds a declared parameter to its declared consumer only", () => {
    const plan = compileWorkflow(
      parameterWorkflow(["task"], [consumer("worker", ["task"]), node("unrelated")]),
    );

    const worker = plan.nodes.find(({ node: planned }) => planned.id === "worker");
    const unrelated = plan.nodes.find(({ node: planned }) => planned.id === "unrelated");

    expect(worker?.inputBindings).toEqual([
      { inputName: "task", source: { kind: "parameter", parameterName: "task" } },
    ]);
    expect(unrelated?.inputBindings).toEqual([]);
  });

  it("canonicalizes both parameter lists in sorted order", () => {
    const plan = compileWorkflow(
      parameterWorkflow(
        ["zeta", "alpha", "middle"],
        [consumer("worker", ["zeta", "alpha", "middle"])],
      ),
    );

    expect(plan.definition.parameters).toEqual(["alpha", "middle", "zeta"]);
    expect(plan.normalizedDefinition).toContain('"parameters":["alpha","middle","zeta"]');
    expect(
      compileWorkflow(
        parameterWorkflow(
          ["alpha", "middle", "zeta"],
          [consumer("worker", ["alpha", "zeta", "middle"])],
        ),
      ).contentHash,
    ).toBe(plan.contentHash);
  });

  it("rejects a declared parameter that no node consumes", () => {
    expectError(
      parameterWorkflow(["task", "unused"], [consumer("worker", ["task"])]),
      "WORKFLOW_GRAPH_INVALID",
      "parameters[1]",
      'Parameter "unused" has no consumer',
    );
  });

  it.each([["task"], [{}], [5], [null]])(
    "rejects a non-array node parameters collection %s",
    (nodeParameters) => {
      expectError(
        parameterWorkflow(["task"], [consumer("worker", nodeParameters)]),
        "WORKFLOW_GRAPH_INVALID",
        "nodes[0].parameters",
        "must be an array of names",
      );
    },
  );

  it("points the orphan path at the authored declaration order", () => {
    expectError(
      parameterWorkflow(["zeta", "alpha"], [consumer("worker", ["zeta"])]),
      "WORKFLOW_GRAPH_INVALID",
      "parameters[1]",
      'Parameter "alpha" has no consumer',
    );
  });

  it("rejects a consumer naming an undeclared parameter", () => {
    expectError(
      parameterWorkflow(["task"], [consumer("worker", ["task", "other"])]),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[0].parameters[1]",
      'consumes undeclared parameter "other"',
    );
  });

  it("rejects duplicate, malformed, and unbounded declarations", () => {
    expectError(
      parameterWorkflow(["task", "task"], [consumer("worker", ["task"])]),
      "WORKFLOW_GRAPH_INVALID",
      "parameters[1]",
      'duplicate parameter "task"',
    );
    expectError(
      parameterWorkflow(["Task"], [consumer("worker", ["Task"])]),
      "WORKFLOW_GRAPH_INVALID",
      "parameters[0]",
      'invalid parameter "Task"',
    );
    expectError(parameterWorkflow([], [node("worker")]), "WORKFLOW_GRAPH_INVALID", "parameters");
    const tooMany = Array.from({ length: 33 }, (_value, index) => `p${String(index)}`);
    expectError(
      parameterWorkflow(tooMany, [consumer("worker", tooMany)]),
      "WORKFLOW_GRAPH_INVALID",
      "parameters",
    );
  });

  it.each([
    ["minimum", 1],
    ["maximum", 32],
  ] as const)("accepts declarations at the %s boundary", (_name, count) => {
    const declared = Array.from({ length: count }, (_value, index) => `p${String(index)}`);

    const plan = compileWorkflow(parameterWorkflow(declared, [consumer("worker", declared)]));

    expect(plan.definition.parameters).toEqual(declared.toSorted());
  });

  it("rejects a node that binds one input name from both a parameter and an edge", () => {
    expectError(
      parameterWorkflow(
        ["report"],
        [
          {
            ...node("source"),
            output: { type: "text" },
          } as unknown as WorkflowCompilationInput["nodes"][number],
          consumer("worker", ["report"]),
        ],
        [{ from: "source", to: "worker", input: "report" }],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "edges[0].input",
      'Input "report" is bound more than once for node "worker"',
    );
  });

  it("rejects parameters on an approval node", () => {
    expectError(
      parameterWorkflow(
        ["task"],
        [
          consumer("worker", ["task"]),
          {
            id: "gate",
            kind: "approval",
            question: "Ship?",
            parameters: ["task"],
          } as unknown as WorkflowCompilationInput["nodes"][number],
        ],
      ),
      "WORKFLOW_GRAPH_INVALID",
      "nodes[1].parameters",
    );
  });

  it("omits an undeclared parameters collection from normalized V1", () => {
    const plan = compileWorkflow(workflow([node("a"), node("b")], [{ from: "a", to: "b" }]));

    expect(plan.normalizedDefinition).toBe(
      '{"edges":[{"from":"a","to":"b"}],"nodes":[{"access":"read_only","id":"a","join":"all","kind":"agent","prompt":"Run a","runtime":"codex"},{"access":"read_only","id":"b","join":"all","kind":"agent","prompt":"Run b","runtime":"codex"}],"schemaVersion":1,"workflow":{"id":"test-workflow","name":"Test workflow"}}',
    );
    expect(plan.normalizedDefinition).not.toContain("parameters");
  });
});
