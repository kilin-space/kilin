export const kilinErrorCodes = [
  "OPTION_INVALID",
  "INIT_TARGET_EXISTS",
  "WORKFLOW_NOT_FOUND",
  "WORKFLOW_PACKAGE_INVALID",
  "WORKFLOW_SCOPE_INVALID",
  "WORKFLOW_SOURCE_NOT_FOUND",
  "WORKFLOW_PARSE_FAILED",
  "WORKFLOW_SCHEMA_INVALID",
  "WORKFLOW_GRAPH_INVALID",
  "WORKING_DIRECTORY_INVALID",
  "WORKSPACE_BUSY",
  "STATE_BUSY",
  "RUN_NOT_CANCELLABLE",
  "RUN_NOT_FOUND",
  "RUN_PARAM_INVALID",
  "RUNTIME_NOT_FOUND",
  "RUNTIME_UNSUPPORTED",
  "RUNTIME_ACCESS_UNSUPPORTED",
  "RUNTIME_CAPABILITY_MISSING",
  "RUNTIME_AUTH_REQUIRED",
  "NODE_EXIT_NONZERO",
  "NODE_TIMEOUT",
  "NODE_OUTPUT_LIMIT",
  "NODE_CAPTURE_FAILED",
  "NODE_INPUT_INVALID",
  "NODE_OUTPUT_INVALID",
  "LOOP_LIMIT_REACHED",
  "APPROVAL_NOT_WAITING",
  "APPROVAL_REJECTED",
  "APPROVAL_TIMEOUT",
  "RUN_INTERRUPTED",
  "INTERNAL_ERROR",
] as const;

export type KilinErrorCode = (typeof kilinErrorCodes)[number];

export const isKilinErrorCode = (value: unknown): value is KilinErrorCode =>
  typeof value === "string" && kilinErrorCodes.some((code) => code === value);

export class KilinError extends Error {
  public readonly code: KilinErrorCode;
  public readonly path?: string;

  public constructor(code: KilinErrorCode, message: string, path?: string) {
    super(message);
    this.name = "KilinError";
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}
