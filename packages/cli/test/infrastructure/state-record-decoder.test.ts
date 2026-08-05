import { describe, expect, it } from "vitest";

import { KilinError } from "../../src/domain/errors.js";
import type { AgentNodeRunRecord, NodeRunRecord } from "../../src/domain/run-state.js";
import {
  decodeStoredAttemptProcessIdentity,
  decodeStoredNodeRunRow,
  withRunningAttemptProcesses,
  type StoredNodeAttemptRow,
  type StoredNodeRunRow,
} from "../../src/infrastructure/state-record-decoder.js";

const pendingAgentRow = (): StoredNodeRunRow => ({
  run_id: "run-1",
  node_id: "loop-11111111111111111111111111111111",
  ordinal: 1,
  kind: "agent",
  body_node_id: "review",
  loop_node_id: "feedback",
  iteration: 0,
  runtime: "codex",
  requested_model: null,
  effective_model: null,
  runtime_version: null,
  status: "pending",
  started_at: null,
  finished_at: null,
  exit_code: null,
  failure_code: null,
  failure_message: null,
  stdout_path: null,
  stderr_path: null,
  result_path: null,
  resolved_inputs_path: null,
  output_type: "text",
  declared_output_type: null,
  artifact_path: null,
  approval_decision: null,
  approval_actor: null,
  approval_note: null,
  approval_requested_at: null,
  approval_deadline_at: null,
  approval_decided_at: null,
  current_attempt: 1,
  reused_from_run_id: null,
  reused_from_node_id: null,
});

const succeededLoopRow = (): StoredNodeRunRow => ({
  ...pendingAgentRow(),
  node_id: "feedback",
  ordinal: 0,
  kind: "loop",
  body_node_id: null,
  loop_node_id: null,
  iteration: null,
  runtime: null,
  status: "succeeded",
  started_at: "2026-07-26T00:00:00.000Z",
  finished_at: "2026-07-26T00:01:00.000Z",
  result_path: "/state/runs/feedback/result.txt",
});

describe("stored node record decoder", () => {
  it("decodes explicit loop-body provenance without parsing the occurrence ID", () => {
    expect(decodeStoredNodeRunRow(pendingAgentRow())).toMatchObject({
      kind: "agent",
      nodeId: "loop-11111111111111111111111111111111",
      bodyNodeId: "review",
      loopNodeId: "feedback",
      iteration: 0,
      status: "pending",
    });
  });

  it("rejects incomplete loop-body provenance", () => {
    const row = { ...pendingAgentRow(), loop_node_id: null };

    expect(() => decodeStoredNodeRunRow(row)).toThrowError(KilinError);
    expect(() => decodeStoredNodeRunRow(row)).toThrow(
      "Stored state has invalid loop execution provenance",
    );
  });

  it("decodes a loop result without manufacturing process streams or attempts", () => {
    const row = succeededLoopRow();

    expect(decodeStoredNodeRunRow(row)).toEqual({
      kind: "loop",
      runId: "run-1",
      nodeId: "feedback",
      ordinal: 0,
      status: "succeeded",
      startedAt: "2026-07-26T00:00:00.000Z",
      finishedAt: "2026-07-26T00:01:00.000Z",
      resultPath: "/state/runs/feedback/result.txt",
      outputType: "text",
    });
  });

  it("rejects a loop control with artifact output metadata", () => {
    const row = {
      ...succeededLoopRow(),
      output_type: "artifact",
    };

    expect(() => decodeStoredNodeRunRow(row)).toThrowError(KilinError);
    expect(() => decodeStoredNodeRunRow(row)).toThrow(
      "Stored state has an invalid loop result type",
    );
  });

  it("rejects a succeeded loop without a result path", () => {
    const row = { ...succeededLoopRow(), result_path: null };

    expect(() => decodeStoredNodeRunRow(row)).toThrowError(KilinError);
    expect(() => decodeStoredNodeRunRow(row)).toThrow(
      "Stored state has an invalid succeeded loop lifecycle",
    );
  });
});

describe("stored attempt process identity decoder", () => {
  it("decodes a complete recorded identity", () => {
    expect(
      decodeStoredAttemptProcessIdentity({
        process_pid: 4242,
        process_group_id: 4242,
        process_start_identifier: "Tue Aug 4 14:45:17 2026",
      }),
    ).toEqual({
      pid: 4242,
      processGroupId: 4242,
      startIdentifier: "Tue Aug 4 14:45:17 2026",
    });
  });

  it("reports no identity when the attempt recorded none", () => {
    expect(
      decodeStoredAttemptProcessIdentity({
        process_pid: null,
        process_group_id: null,
        process_start_identifier: null,
      }),
    ).toBeUndefined();
  });

  it.each([
    [
      "a pid stored as text, which SQLite column affinity admits",
      { process_pid: "4242; rm -rf /", process_group_id: 4242, process_start_identifier: "start" },
    ],
    [
      "a fractional pid",
      { process_pid: 42.5, process_group_id: 4242, process_start_identifier: "start" },
    ],
    [
      "a negative process group, which would signal an unrelated group",
      { process_pid: 4242, process_group_id: -1, process_start_identifier: "start" },
    ],
    [
      "an empty start identifier, which would match any process",
      { process_pid: 4242, process_group_id: 4242, process_start_identifier: "" },
    ],
    [
      "a partial triple",
      { process_pid: 4242, process_group_id: null, process_start_identifier: null },
    ],
  ])("rejects %s", (_name, row) => {
    expect(() =>
      decodeStoredAttemptProcessIdentity(
        row as Parameters<typeof decodeStoredAttemptProcessIdentity>[0],
      ),
    ).toThrow(KilinError);
  });
});

describe("running attempt process projection", () => {
  const attemptRow = (nodeId: string, attempt: number): StoredNodeAttemptRow => ({
    run_id: "run-1",
    node_id: nodeId,
    attempt,
    status: "running",
    started_at: "2026-07-26T00:00:00.000Z",
    finished_at: null,
    exit_code: null,
    failure_code: null,
    failure_message: null,
    stdout_path: "/state/stdout.log",
    stderr_path: "/state/stderr.log",
    result_path: "/state/result.txt",
    process_pid: 4242,
    process_group_id: 4242,
    process_start_identifier: "recorded-start",
  });

  const agentNode = (status: AgentNodeRunRecord["status"], attempt = 1): NodeRunRecord => ({
    kind: "agent",
    runId: "run-1",
    nodeId: "analyze",
    ordinal: 0,
    runtime: "codex",
    status,
    attempt,
  });

  it("names the process of a running node's current attempt", () => {
    const [projected] = withRunningAttemptProcesses(
      [agentNode("running")],
      [attemptRow("analyze", 1)],
    );

    expect(projected).toMatchObject({
      process: { pid: 4242, processGroupId: 4242, startIdentifier: "recorded-start" },
    });
  });

  it.each([
    ["a terminal node", agentNode("succeeded"), attemptRow("analyze", 1)],
    ["an earlier attempt", agentNode("running", 2), attemptRow("analyze", 1)],
    ["a different node", agentNode("running"), attemptRow("verify", 1)],
  ])("reports no process for %s", (_name, node, row) => {
    const [projected] = withRunningAttemptProcesses([node], [row]);

    expect(projected).not.toHaveProperty("process");
  });

  it("leaves approval and loop nodes untouched", () => {
    const nodes: NodeRunRecord[] = [
      { kind: "approval", runId: "run-1", nodeId: "gate", ordinal: 1, status: "pending" },
      { kind: "loop", runId: "run-1", nodeId: "refine", ordinal: 2, status: "running" },
    ];

    expect(withRunningAttemptProcesses(nodes, [attemptRow("gate", 1)])).toEqual(nodes);
  });
});
