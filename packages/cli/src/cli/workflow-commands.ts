import { homedir } from "node:os";
import { join } from "node:path";

import {
  initializeWorkflowPackage,
  inspectWorkflowPackage,
  listWorkflowPackages,
} from "../application/workflows.js";
import {
  projectWorkflowDirectory,
  resolveWorkflowPackage,
} from "../infrastructure/workflow-package.js";
import { resolveWorkingDirectory } from "../infrastructure/workspace-lock.js";

import { OptionError, parseOptions, requireOption, requirePositional } from "./arguments.js";
import {
  renderInit,
  renderJson,
  renderValidation,
  renderWorkflowCatalog,
  type InitResultDocument,
  type ValidationResultDocument,
  type WorkflowCatalogDocument,
} from "./render.js";

const userWorkflowsDirectory = (): string => join(homedir(), ".agents", "workflows");

export const runWorkflowCommand = async (arguments_: string[]): Promise<void> => {
  const action = arguments_[0];

  if (action === "init") {
    const workflowId = requirePositional(arguments_[1], "A workflow name");
    const options = parseOptions(
      arguments_.slice(2),
      new Set(["--scope", "--project-root", "--name", "--description"]),
    );
    const scope = requireOption(options, "--scope");
    if (scope !== "project" && scope !== "user") {
      throw new OptionError('Flag "--scope" must be "project" or "user".');
    }
    const projectRootOption = options.values.get("--project-root");
    if (scope === "project" && projectRootOption === undefined) {
      throw new OptionError(
        'Project workflow initialization requires "--project-root <directory>".',
      );
    }
    if (scope === "user" && projectRootOption !== undefined) {
      throw new OptionError(
        'Flag "--project-root" cannot be used with user-scoped workflow initialization.',
      );
    }
    const workflowsDirectory =
      scope === "user"
        ? userWorkflowsDirectory()
        : join(
            await resolveWorkingDirectory(requireOption(options, "--project-root")),
            projectWorkflowDirectory,
          );
    const initialized = await initializeWorkflowPackage(
      workflowsDirectory,
      workflowId,
      requireOption(options, "--name"),
      requireOption(options, "--description"),
    );
    const document: InitResultDocument = {
      outputVersion: 1,
      scope,
      ...initialized,
    };
    if (options.flags.has("--json")) {
      renderJson(document);
    } else {
      renderInit(document);
    }
    return;
  }

  if (action === "validate") {
    const workflowId = requirePositional(arguments_[1], "A workflow name");
    const options = parseOptions(arguments_.slice(2), new Set(["--cwd", "--scope"]));
    const cwd = options.values.get("--cwd") ?? process.cwd();
    const scope = options.values.get("--scope");
    if (scope !== undefined && scope !== "project" && scope !== "user") {
      throw new OptionError('Flag "--scope" must be "project" or "user".');
    }
    const workflowPackage = await resolveWorkflowPackage(workflowId, {
      workingDirectory: cwd,
      userWorkflowsDirectory: userWorkflowsDirectory(),
      ...(scope === undefined ? {} : { scope }),
    });
    const inspected = inspectWorkflowPackage(workflowPackage);
    const document: ValidationResultDocument = {
      outputVersion: 1,
      valid: true,
      scope: workflowPackage.identity.scope.kind,
      ...inspected,
    };
    if (options.flags.has("--json")) {
      renderJson(document);
    } else {
      renderValidation(document);
    }
    return;
  }

  if (action === "list") {
    const options = parseOptions(arguments_.slice(1), new Set(["--cwd"]));
    const catalog = await listWorkflowPackages({
      workingDirectory: options.values.get("--cwd") ?? process.cwd(),
      userWorkflowsDirectory: userWorkflowsDirectory(),
    });
    const document: WorkflowCatalogDocument = {
      outputVersion: 1,
      ...catalog,
    };
    if (options.flags.has("--json")) {
      renderJson(document);
    } else {
      renderWorkflowCatalog(document);
    }
    return;
  }

  throw new OptionError('A workflow action is required. Use "init", "list", or "validate".');
};
