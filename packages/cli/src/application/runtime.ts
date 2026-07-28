import type { NodeAccess, RuntimeId } from "../domain/workflow.js";

/** Information established by a successful runtime preflight. */
export interface RuntimeInfo {
  readonly runtimeId: RuntimeId;
  readonly executable: string;
  readonly version: string;
}

/** Access capabilities the compiled workflow requires from one runtime. */
export interface RuntimeProbeRequirements {
  readonly requiredAccessModes: readonly NodeAccess[];
}

/** Host-owned inputs available while probing an installed runtime. */
export interface RuntimeProbeContext {
  readonly canonicalCwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Host-owned execution details that a runtime must not override. */
export interface RuntimeExecutionContext {
  readonly runtimeResultPath: string;
  readonly env: Readonly<Record<string, string>>;
}

/** Provider-neutral assignment fully resolved by the foreground engine. */
export interface ResolvedAgentRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly ordinal: number;
  readonly runtime: RuntimeId;
  readonly prompt: string;
  readonly canonicalWorkingDirectory: string;
  readonly access: NodeAccess;
  readonly model?: string;
  readonly isGitRepository: boolean;
}

/** Complete, shell-free process specification produced by a runtime adapter. */
export interface RuntimeInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
}

/** Capture paths and status supplied after the shared process runner exits. */
export interface CompletedProcess {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly resultPath: string;
  readonly runtimeResultPath: string;
  readonly outputBytes: number;
}

/** Provider-independent final output extracted from a completed invocation. */
export interface RuntimeResult {
  readonly finalMessage: string;
}

/** Boundary for runtime-specific preflight, invocation, and result extraction. */
export interface RuntimeAdapter {
  readonly runtimeId: RuntimeId;

  probe(requirements: RuntimeProbeRequirements, context: RuntimeProbeContext): Promise<RuntimeInfo>;

  createInvocation(
    request: ResolvedAgentRequest,
    context: RuntimeExecutionContext,
  ): RuntimeInvocation;

  extractResult(completed: CompletedProcess): Promise<RuntimeResult>;
}
