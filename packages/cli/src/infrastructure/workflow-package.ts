import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parseDocument, visit } from "yaml";

import { parseCanonicalJson, type JsonValue } from "../domain/canonical-json.js";
import { isNormalizedRelativePath } from "../domain/compile-workflow.js";
import { KilinError } from "../domain/errors.js";
import type { WorkflowCompilationInput } from "../domain/workflow.js";
import type {
  WorkflowCatalog,
  WorkflowCatalogDiagnostic,
  WorkflowCatalogEntry,
  WorkflowManifest,
  WorkflowPackage,
  WorkflowScope,
  WorkflowScopeKind,
} from "../domain/workflow-package.js";
import { isWorkflowKebabId } from "../domain/workflow-package.js";
import { assertValidJsonSchema } from "./json-schema.js";
import { maximumWorkflowDefinitionBytes, parseWorkflowBytes } from "./workflow-source.js";

export const workflowManifestFileName = "WORKFLOW.md";
export const workflowDefinitionFileName = "WORKFLOW.yaml";
export const projectWorkflowDirectory = join(".agents", "workflows");

export const maximumOutputSchemaBytes = 262_144;

const maximumManifestBytes = 65_536;
const maximumPackagesPerScope = 2_000;
const decoder = new TextDecoder("utf-8", { fatal: true });

const packageError = (message: string, path?: string): KilinError =>
  new KilinError("WORKFLOW_PACKAGE_INVALID", message, path);

const isMissingPath = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const validateWorkflowName = (name: string, subject = "Workflow name"): void => {
  if (!isWorkflowKebabId(name)) {
    throw packageError(
      `${subject} must be 1-64 lowercase ASCII letters, numbers, or single hyphen-separated segments.`,
      "name",
    );
  }
};

const openRegularFile = async (file: string, subject: string): Promise<FileHandle> => {
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      throw packageError(`${subject} "${file}" does not exist or is unreadable.`);
    }
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw packageError(`${subject} "${file}" must be a regular file, not a symlink.`);
    }
    throw error;
  }
  const metadata = await handle.stat();
  if (!metadata.isFile()) {
    await handle.close();
    throw packageError(`${subject} "${file}" must be a regular file, not a symlink or directory.`);
  }
  return handle;
};

const readRegularFile = async (
  file: string,
  subject: string,
  maximumBytes?: number,
): Promise<Uint8Array> => {
  const handle = await openRegularFile(file, subject);
  try {
    if (maximumBytes !== undefined) {
      const metadata = await handle.stat();
      if (metadata.size > maximumBytes) {
        throw packageError(`${subject} "${file}" exceeds the ${String(maximumBytes)} byte limit.`);
      }
      const bytes = new Uint8Array(maximumBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, null);
        if (result.bytesRead === 0) {
          break;
        }
        offset += result.bytesRead;
      }
      if (offset > maximumBytes) {
        throw packageError(`${subject} "${file}" exceeds the ${String(maximumBytes)} byte limit.`);
      }
      return bytes.subarray(0, offset);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const assertRegularFile = async (file: string, subject: string): Promise<void> => {
  const handle = await openRegularFile(file, subject);
  await handle.close();
};

const parseManifestFrontmatter = (
  bytes: Uint8Array,
  file: string,
): { metadata: unknown; instructions: string } => {
  const label = file;
  if (bytes.byteLength > maximumManifestBytes) {
    throw packageError(`${label} exceeds the ${String(maximumManifestBytes)} byte limit.`);
  }
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    throw packageError(`${label} must be valid UTF-8.`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  if (match === null) {
    throw packageError(`${label} must begin with YAML frontmatter delimited by exact "---" lines.`);
  }
  const frontmatter = match[1] ?? "";
  const document = parseDocument(frontmatter, {
    prettyErrors: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  const parseError = document.errors[0];
  if (parseError !== undefined) {
    throw packageError(`${label} frontmatter is invalid YAML: ${parseError.message}.`);
  }
  let prohibitedSyntax: string | undefined;
  visit(document, {
    Alias: () => {
      prohibitedSyntax = "aliases";
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor !== undefined) {
        prohibitedSyntax = "anchors";
        return visit.BREAK;
      }
      if (node.tag !== undefined) {
        prohibitedSyntax = "explicit tags";
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (prohibitedSyntax !== undefined) {
    throw packageError(`${label} frontmatter cannot contain ${prohibitedSyntax}.`);
  }
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw packageError(`${label} frontmatter cannot contain aliases.`);
  }
  return {
    metadata,
    instructions: source.slice(match[0].length).trim(),
  };
};

export const parseWorkflowManifest = (
  bytes: Uint8Array,
  directoryName: string,
  file = workflowManifestFileName,
): WorkflowManifest => {
  const { metadata, instructions } = parseManifestFrontmatter(bytes, file);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw packageError(`${workflowManifestFileName} frontmatter must be a mapping.`);
  }
  const record = metadata as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "description" || keys[1] !== "name") {
    throw packageError(
      `${workflowManifestFileName} frontmatter must contain exactly "name" and "description".`,
    );
  }
  if (typeof record.name !== "string") {
    throw packageError(`${workflowManifestFileName} field "name" must be a string.`, "name");
  }
  validateWorkflowName(record.name, `${workflowManifestFileName} field "name"`);
  if (record.name !== directoryName) {
    throw packageError(
      `${workflowManifestFileName} name "${record.name}" must match its parent directory "${directoryName}".`,
      "name",
    );
  }
  if (
    typeof record.description !== "string" ||
    Array.from(record.description).length < 1 ||
    Array.from(record.description).length > 1_024
  ) {
    throw packageError(
      `${workflowManifestFileName} field "description" must be a non-empty string of at most 1024 characters.`,
      "description",
    );
  }
  return {
    name: record.name,
    description: record.description,
    instructions,
  };
};

const packageDirectoryExists = async (directory: string): Promise<boolean> => {
  try {
    await lstat(directory);
    return true;
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
};

const physicalDirectoryExists = async (directory: string, subject: string): Promise<boolean> => {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw packageError(`${subject} "${directory}" must be a physical directory.`);
  }
  return true;
};

const projectWorkflowsDirectory = async (projectRoot: string): Promise<string | undefined> => {
  const agentsDirectory = join(projectRoot, ".agents");
  if (!(await physicalDirectoryExists(agentsDirectory, "Project agent directory"))) {
    return undefined;
  }
  const workflowsDirectory = join(agentsDirectory, "workflows");
  return (await physicalDirectoryExists(workflowsDirectory, "Project workflow root"))
    ? workflowsDirectory
    : undefined;
};

const userWorkflowsRootExists = async (workflowsDirectory: string): Promise<boolean> => {
  const agentsDirectory = dirname(workflowsDirectory);
  if (!(await physicalDirectoryExists(agentsDirectory, "User agent directory"))) {
    return false;
  }
  return physicalDirectoryExists(workflowsDirectory, "User workflow root");
};

const readPackage = async (scope: WorkflowScope, directory: string): Promise<WorkflowPackage> => {
  const directoryName = directory.slice(dirname(directory).length + 1);
  validateWorkflowName(directoryName, "Workflow package directory");
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw packageError(
      `Workflow package "${directory}" must be a directory, not a symlink or file.`,
    );
  }
  const manifestFile = join(directory, workflowManifestFileName);
  const definitionFile = join(directory, workflowDefinitionFileName);
  const manifest = parseWorkflowManifest(
    await readRegularFile(manifestFile, "Workflow manifest", maximumManifestBytes),
    directoryName,
    manifestFile,
  );
  const definition = parseWorkflowBytes(
    await readRegularFile(definitionFile, "Workflow definition", maximumWorkflowDefinitionBytes),
    definitionFile,
  );
  await resolveJsonOutputSchemas(definition, directory);
  if (definition.workflow.id !== manifest.name) {
    throw packageError(
      `${workflowDefinitionFileName} workflow.id "${definition.workflow.id}" must match package name "${manifest.name}".`,
      "workflow.id",
    );
  }
  return {
    identity: { scope, workflowId: manifest.name },
    directory,
    manifestFile,
    definitionFile,
    manifest,
    definition,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const resolveDeclaredSchema = async (
  declared: string,
  packageDirectory: string,
): Promise<Record<string, unknown>> => {
  const relativePath = declared.startsWith("./") ? declared.slice(2) : declared;
  if (!isNormalizedRelativePath(relativePath)) {
    throw packageError(
      `The json output schema path "${declared}" is invalid. Use 1 through 1,024 UTF-8 bytes in normalized POSIX-relative form with no leading or trailing "/", non-empty segments, "/" separators, and no ".", "..", backslash, or control characters.`,
    );
  }
  let bytes: Uint8Array;
  try {
    const resolvedFile = resolve(packageDirectory, relativePath);
    let canonicalFile: string;
    try {
      canonicalFile = await realpath(resolvedFile);
    } catch (error: unknown) {
      if (isMissingPath(error)) {
        throw packageError(`The json output schema "${declared}" does not exist or is unreadable.`);
      }
      throw error;
    }
    if (!isWithin(await realpath(packageDirectory), canonicalFile)) {
      throw packageError(
        `The json output schema "${declared}" resolves outside the workflow package. Declare a schema file within the package.`,
      );
    }
    await assertRegularFile(resolvedFile, `Json output schema "${declared}"`);
    bytes = await readRegularFile(
      canonicalFile,
      `Json output schema "${declared}"`,
      maximumOutputSchemaBytes,
    );
  } catch (error: unknown) {
    if (error instanceof KilinError) {
      throw error;
    }
    throw packageError(
      `The json output schema "${declared}" could not be read: ${
        error instanceof Error ? error.message : String(error)
      }. Make the file readable and try again.`,
    );
  }
  let parsed: JsonValue;
  try {
    parsed = parseCanonicalJson(decoder.decode(bytes));
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof SyntaxError) {
      throw packageError(
        `The json output schema "${declared}" is not valid canonical JSON. ${error.message}`,
      );
    }
    throw error;
  }
  if (!isRecord(parsed)) {
    throw packageError(`The json output schema "${declared}" must contain a JSON object.`);
  }
  assertValidJsonSchema(parsed, `from "${declared}"`);
  return parsed;
};

const resolveNodeOutputSchemas = async (
  nodes: WorkflowCompilationInput["nodes"],
  packageDirectory: string,
): Promise<void> => {
  for (const node of nodes) {
    if (node.kind === "loop") {
      if ("body" in node && isRecord(node.body) && Array.isArray(node.body.nodes)) {
        await resolveNodeOutputSchemas(
          node.body.nodes as WorkflowCompilationInput["nodes"],
          packageDirectory,
        );
      }
      continue;
    }
    if (node.kind !== "agent") {
      continue;
    }
    const output = node.output;
    if (output?.schema === undefined) {
      continue;
    }
    if (typeof output.schema === "string") {
      output.schema = await resolveDeclaredSchema(output.schema, packageDirectory);
    } else if (isRecord(output.schema)) {
      assertValidJsonSchema(output.schema, "declared inline");
    }
  }
};

export const resolveJsonOutputSchemas = async (
  definition: WorkflowCompilationInput,
  packageDirectory: string,
): Promise<void> => resolveNodeOutputSchemas(definition.nodes, packageDirectory);

const canonicalDirectory = async (
  directory: string,
  subject = "Working directory",
): Promise<string> => {
  try {
    const canonical = await realpath(directory);
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory()) {
      throw new Error("not a directory");
    }
    return canonical;
  } catch {
    throw new KilinError(
      "WORKING_DIRECTORY_INVALID",
      `${subject} "${directory}" must resolve to an existing directory.`,
    );
  }
};

export const findProjectWorkflowRoot = async (
  workingDirectory: string,
  userWorkflowsDirectory: string,
): Promise<string | undefined> => {
  let candidate = await canonicalDirectory(workingDirectory);
  const userScopeRoot = await canonicalDirectory(
    dirname(dirname(userWorkflowsDirectory)),
    "User workflow scope root",
  );
  for (;;) {
    if (candidate === userScopeRoot) {
      return undefined;
    }
    if ((await projectWorkflowsDirectory(candidate)) !== undefined) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return undefined;
    }
    candidate = parent;
  }
};

const isWithin = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
};

export const assertWorkflowScopeAllowsWorkingDirectory = async (
  workflowPackage: WorkflowPackage,
  workingDirectory: string,
): Promise<string> => {
  const canonicalCwd = await canonicalDirectory(workingDirectory);
  const { scope } = workflowPackage.identity;
  if (scope.kind === "project" && !isWithin(scope.root, canonicalCwd)) {
    throw new KilinError(
      "WORKFLOW_SCOPE_INVALID",
      `Project workflow "${workflowPackage.identity.workflowId}" can run only in "${scope.root}" or one of its descendant directories.`,
    );
  }
  return canonicalCwd;
};

export interface WorkflowDiscoveryOptions {
  readonly workingDirectory: string;
  readonly userWorkflowsDirectory: string;
  readonly scope?: WorkflowScopeKind;
}

export const resolveWorkflowPackage = async (
  name: string,
  options: WorkflowDiscoveryOptions,
): Promise<WorkflowPackage> => {
  validateWorkflowName(name);
  if (options.scope === "user") {
    await canonicalDirectory(options.workingDirectory);
  }
  const projectRoot =
    options.scope === "user"
      ? undefined
      : await findProjectWorkflowRoot(options.workingDirectory, options.userWorkflowsDirectory);
  if (projectRoot !== undefined) {
    const directory = join(projectRoot, projectWorkflowDirectory, name);
    if (await packageDirectoryExists(directory)) {
      return readPackage({ kind: "project", root: projectRoot }, directory);
    }
  }
  if (options.scope === "project") {
    throw new KilinError(
      "WORKFLOW_NOT_FOUND",
      `Workflow "${name}" was not found in the nearest project scope.`,
    );
  }
  const userRootExists = await userWorkflowsRootExists(options.userWorkflowsDirectory);
  const userDirectory = join(options.userWorkflowsDirectory, name);
  if (userRootExists && (await packageDirectoryExists(userDirectory))) {
    return readPackage({ kind: "user" }, userDirectory);
  }
  if (options.scope === "user") {
    throw new KilinError("WORKFLOW_NOT_FOUND", `Workflow "${name}" was not found in user scope.`);
  }
  throw new KilinError(
    "WORKFLOW_NOT_FOUND",
    `Workflow "${name}" was not found in the nearest project scope or user scope.`,
  );
};

interface ScopeCatalog {
  readonly entries: WorkflowCatalogEntry[];
  readonly diagnostics: WorkflowCatalogDiagnostic[];
  readonly reservedNames: Set<string>;
}

const readCatalogEntry = async (
  scope: WorkflowScope,
  directory: string,
): Promise<WorkflowCatalogEntry> => {
  const directoryName = directory.slice(dirname(directory).length + 1);
  validateWorkflowName(directoryName, "Workflow package directory");
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw packageError(
      `Workflow package "${directory}" must be a directory, not a symlink or file.`,
    );
  }
  const manifestFile = join(directory, workflowManifestFileName);
  const definitionFile = join(directory, workflowDefinitionFileName);
  const manifest = parseWorkflowManifest(
    await readRegularFile(manifestFile, "Workflow manifest", maximumManifestBytes),
    directoryName,
    manifestFile,
  );
  await assertRegularFile(definitionFile, "Workflow definition");
  return {
    name: manifest.name,
    description: manifest.description,
    scope: scope.kind,
    location: manifestFile,
  };
};

const readScopeCatalog = async (
  scope: WorkflowScope,
  workflowsDirectory: string,
): Promise<ScopeCatalog> => {
  if (!(await physicalDirectoryExists(workflowsDirectory, "Workflow root"))) {
    return { entries: [], diagnostics: [], reservedNames: new Set() };
  }
  const directoryEntries = await readdir(workflowsDirectory, { withFileTypes: true });
  if (directoryEntries.length > maximumPackagesPerScope) {
    throw packageError(
      `Workflow scope "${workflowsDirectory}" exceeds the ${String(maximumPackagesPerScope)} package limit.`,
    );
  }
  const entries: WorkflowCatalogEntry[] = [];
  const diagnostics: WorkflowCatalogDiagnostic[] = [];
  const reservedNames = new Set<string>();
  for (const directoryEntry of directoryEntries.sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    if (!directoryEntry.isDirectory() && !directoryEntry.isSymbolicLink()) {
      try {
        validateWorkflowName(directoryEntry.name, "Workflow package path");
      } catch {
        continue;
      }
    }
    reservedNames.add(directoryEntry.name);
    const directory = join(workflowsDirectory, directoryEntry.name);
    try {
      entries.push(await readCatalogEntry(scope, directory));
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : `Workflow package "${directoryEntry.name}" is invalid.`;
      diagnostics.push({
        scope: scope.kind,
        packageName: directoryEntry.name,
        code: "WORKFLOW_PACKAGE_INVALID",
        message,
      });
    }
  }
  return { entries, diagnostics, reservedNames };
};

export const discoverWorkflowCatalog = async (
  options: WorkflowDiscoveryOptions,
): Promise<WorkflowCatalog> => {
  const projectRoot = await findProjectWorkflowRoot(
    options.workingDirectory,
    options.userWorkflowsDirectory,
  );
  const projectCatalog =
    projectRoot === undefined
      ? { entries: [], diagnostics: [], reservedNames: new Set<string>() }
      : await readScopeCatalog(
          { kind: "project", root: projectRoot },
          join(projectRoot, projectWorkflowDirectory),
        );
  const userCatalog = (await userWorkflowsRootExists(options.userWorkflowsDirectory))
    ? await readScopeCatalog({ kind: "user" }, options.userWorkflowsDirectory)
    : { entries: [], diagnostics: [], reservedNames: new Set<string>() };
  const workflows = [
    ...projectCatalog.entries,
    ...userCatalog.entries.filter(({ name }) => !projectCatalog.reservedNames.has(name)),
  ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  return {
    ...(projectRoot === undefined ? {} : { projectRoot }),
    workflows,
    diagnostics: [...projectCatalog.diagnostics, ...userCatalog.diagnostics],
  };
};
