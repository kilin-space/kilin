import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify } from "yaml";

export interface TestWorkflowPackage {
  readonly directory: string;
  readonly manifestFile: string;
  readonly definitionFile: string;
}

export interface TestWorkflowPackageOptions {
  readonly definitionMode?: number;
  readonly instructions?: string;
}

export const writeTestWorkflowPackage = async (
  workflowsDirectory: string,
  name: string,
  description: string,
  definitionSource: string,
  options: TestWorkflowPackageOptions = {},
): Promise<TestWorkflowPackage> => {
  const directory = join(workflowsDirectory, name);
  const manifestFile = join(directory, "WORKFLOW.md");
  const definitionFile = join(directory, "WORKFLOW.yaml");
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      manifestFile,
      `---\n${stringify({ name, description }).trimEnd()}\n---\n${
        options.instructions === undefined ? "" : `\n${options.instructions}\n`
      }`,
    ),
    writeFile(
      definitionFile,
      definitionSource,
      options.definitionMode === undefined ? {} : { mode: options.definitionMode },
    ),
  ]);
  return { directory, manifestFile, definitionFile };
};
