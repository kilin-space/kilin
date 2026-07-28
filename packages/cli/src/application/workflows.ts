import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stringify } from "yaml";

import { parseCanonicalJson } from "../domain/canonical-json.js";
import { compileWorkflow } from "../domain/compile-workflow.js";
import { KilinError } from "../domain/errors.js";
import type { WorkflowRevisionRecord } from "../domain/run-state.js";
import type { ExecutionPlan, WorkflowDefinitionV1 } from "../domain/workflow.js";
import type {
  WorkflowCatalog,
  WorkflowIdentity,
  WorkflowPackage,
} from "../domain/workflow-package.js";
import {
  discoverWorkflowCatalog,
  parseWorkflowManifest,
  type WorkflowDiscoveryOptions,
  workflowDefinitionFileName,
  workflowManifestFileName,
} from "../infrastructure/workflow-package.js";
import { parseWorkflowBytes } from "../infrastructure/workflow-source.js";

export interface InitializeWorkflowResult {
  directory: string;
  manifestFile: string;
  definitionFile: string;
  workflowId: string;
  created: true;
}

export interface WorkflowInspection {
  workflowId: string;
  contentHash: string;
  nodeCount: number;
  edgeCount: number;
  executionOrder: string[];
}

const initialDefinition = (id: string, name: string): WorkflowDefinitionV1 => ({
  schemaVersion: 1,
  workflow: { id, name },
  nodes: [
    {
      id: "main",
      kind: "agent",
      runtime: "codex",
      access: "read_only",
      prompt: "Describe the task this workflow should perform.",
    },
  ],
  edges: [],
});

const isExistingTargetError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const manifestSource = (id: string, description: string): string =>
  `---\n${stringify({ name: id, description }).trimEnd()}\n---\n`;

const ensurePhysicalDirectory = async (directory: string, subject: string): Promise<void> => {
  try {
    await mkdir(directory);
  } catch (error: unknown) {
    if (!isExistingTargetError(error)) {
      throw error;
    }
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new KilinError(
      "WORKFLOW_PACKAGE_INVALID",
      `${subject} "${directory}" must be a physical directory.`,
    );
  }
};

export const initializeWorkflowPackage = async (
  workflowsDirectory: string,
  id: string,
  name: string,
  description: string,
): Promise<InitializeWorkflowResult> => {
  const definitionSource = stringify(initialDefinition(id, name));
  const manifest = manifestSource(id, description);
  parseWorkflowManifest(new TextEncoder().encode(manifest), id, workflowManifestFileName);
  const definition = parseWorkflowBytes(
    new TextEncoder().encode(definitionSource),
    workflowDefinitionFileName,
  );
  compileWorkflow(definition);

  const agentsDirectory = dirname(workflowsDirectory);
  const scopeRoot = dirname(agentsDirectory);
  const scopeRootMetadata = await lstat(scopeRoot);
  if (scopeRootMetadata.isSymbolicLink() || !scopeRootMetadata.isDirectory()) {
    throw new KilinError(
      "WORKFLOW_PACKAGE_INVALID",
      `Workflow scope root "${scopeRoot}" must be a physical directory.`,
    );
  }
  await ensurePhysicalDirectory(agentsDirectory, "Agent directory");
  await ensurePhysicalDirectory(workflowsDirectory, "Workflow root");
  const directory = join(workflowsDirectory, id);
  const stageDirectory = join(
    agentsDirectory,
    `.workflow-init-${String(process.pid)}-${randomUUID()}`,
  );
  const stagePackageDirectory = join(stageDirectory, id);
  const manifestFile = join(directory, workflowManifestFileName);
  const definitionFile = join(directory, workflowDefinitionFileName);
  try {
    await mkdir(stagePackageDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(stagePackageDirectory, workflowManifestFileName), manifest, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(join(stagePackageDirectory, workflowDefinitionFileName), definitionSource, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      }),
    ]);
    try {
      await lstat(directory);
      throw new KilinError(
        "INIT_TARGET_EXISTS",
        `Workflow package "${directory}" already exists. Choose a different name or remove the existing package first.`,
      );
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await rename(stagePackageDirectory, directory);
  } catch (error: unknown) {
    if (
      isExistingTargetError(error) ||
      (error instanceof Error && "code" in error && error.code === "ENOTEMPTY")
    ) {
      throw new KilinError(
        "INIT_TARGET_EXISTS",
        `Workflow package "${directory}" already exists. Choose a different name or remove the existing package first.`,
      );
    }
    throw error;
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }

  return {
    directory,
    manifestFile,
    definitionFile,
    workflowId: definition.workflow.id,
    created: true,
  };
};

export const inspectWorkflowPackage = (workflowPackage: WorkflowPackage): WorkflowInspection => {
  const plan = compileWorkflow(workflowPackage.definition);

  return {
    workflowId: workflowPackage.identity.workflowId,
    contentHash: plan.contentHash,
    nodeCount: plan.nodes.length,
    edgeCount: plan.edges.length,
    executionOrder: plan.nodes.map(({ node }) => node.id),
  };
};

export const listWorkflowPackages = async (
  options: WorkflowDiscoveryOptions,
): Promise<WorkflowCatalog> => discoverWorkflowCatalog(options);

const storedRevisionError = (revisionId: string, problem: string): KilinError =>
  new KilinError(
    "INTERNAL_ERROR",
    `Stored workflow revision "${revisionId}" ${problem}. This indicates damaged local state rather than a problem with your workflow. Report it at https://github.com/kilin-space/kilin/issues.`,
  );

export const compileStoredWorkflowRevision = (revision: WorkflowRevisionRecord): ExecutionPlan => {
  let value: unknown;
  try {
    value = parseCanonicalJson(revision.normalizedDefinition);
  } catch {
    throw storedRevisionError(revision.id, "is not normalized JSON");
  }
  let plan: ExecutionPlan;
  try {
    plan = compileWorkflow(value as WorkflowDefinitionV1);
  } catch {
    throw storedRevisionError(revision.id, "is invalid");
  }
  if (
    plan.normalizedDefinition !== revision.normalizedDefinition ||
    plan.contentHash !== revision.contentHash ||
    plan.definition.workflow.id !== revision.workflowId
  ) {
    throw storedRevisionError(revision.id, "has an identity that does not match its contents");
  }
  return plan;
};

export const workflowIdentityForRevision = (
  revision: WorkflowRevisionRecord,
): WorkflowIdentity => ({
  scope: revision.scope,
  workflowId: revision.workflowId,
});
