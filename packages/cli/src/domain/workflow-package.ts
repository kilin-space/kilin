import type { WorkflowCompilationInput } from "./workflow.js";

export const workflowKebabIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const isWorkflowKebabId = (value: string): boolean =>
  value.length >= 1 && value.length <= 64 && workflowKebabIdPattern.test(value);

export const lowercaseIdentifierPattern = /^[a-z][a-z0-9_]{0,63}$/u;

export const isLowercaseIdentifier = (value: string): boolean =>
  lowercaseIdentifierPattern.test(value);

export const workflowScopeKinds = ["project", "user"] as const;

export type WorkflowScopeKind = (typeof workflowScopeKinds)[number];

export interface ProjectWorkflowScope {
  readonly kind: "project";
  readonly root: string;
}

export interface UserWorkflowScope {
  readonly kind: "user";
}

export type WorkflowScope = ProjectWorkflowScope | UserWorkflowScope;

export interface WorkflowIdentity {
  readonly scope: WorkflowScope;
  readonly workflowId: string;
}

export interface WorkflowManifest {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

export interface WorkflowPackage {
  readonly identity: WorkflowIdentity;
  readonly directory: string;
  readonly manifestFile: string;
  readonly definitionFile: string;
  readonly manifest: WorkflowManifest;
  readonly definition: WorkflowCompilationInput;
}

export interface WorkflowCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: WorkflowScopeKind;
  readonly location: string;
}

export interface WorkflowCatalogDiagnostic {
  readonly scope: WorkflowScopeKind;
  readonly packageName: string;
  readonly code: "WORKFLOW_PACKAGE_INVALID";
  readonly message: string;
}

export interface WorkflowCatalog {
  readonly projectRoot?: string;
  readonly workflows: readonly WorkflowCatalogEntry[];
  readonly diagnostics: readonly WorkflowCatalogDiagnostic[];
}

export const workflowScopeRoot = (scope: WorkflowScope): string =>
  scope.kind === "project" ? scope.root : "";

export const sameWorkflowIdentity = (left: WorkflowIdentity, right: WorkflowIdentity): boolean =>
  left.workflowId === right.workflowId &&
  left.scope.kind === right.scope.kind &&
  workflowScopeRoot(left.scope) === workflowScopeRoot(right.scope);
