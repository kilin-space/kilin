import { describe, expect, it } from "vitest";

import { KilinError } from "../../src/domain/errors.js";
import {
  decodeStoredNodeRunRow,
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
