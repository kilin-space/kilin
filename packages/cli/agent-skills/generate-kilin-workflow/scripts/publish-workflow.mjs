#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

const execFileAsync = promisify(execFile);
const expectedOptions = new Set([
  "--scope",
  "--scope-root",
  "--cwd",
  "--cli",
  "--manifest-candidate",
  "--definition-candidate",
  "--target",
]);
const workflowNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const fail = (message) => {
  throw new Error(message);
};

const usage = () =>
  "Usage: publish-workflow.mjs --scope <project|user> --scope-root <directory> --cwd <directory> --cli <file> --manifest-candidate <file> --definition-candidate <file> --target .agents/workflows/<name>";

const parseOptions = (arguments_) => {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!expectedOptions.has(name) || value === undefined || value.startsWith("--")) {
      fail(usage());
    }
    if (options.has(name)) {
      fail(`Option ${name} was provided more than once.`);
    }
    options.set(name, value);
  }
  if (options.size !== expectedOptions.size) {
    fail(
      "Provide --scope, --scope-root, --cwd, --cli, --manifest-candidate, --definition-candidate, and --target.",
    );
  }
  return options;
};

const requireOption = (options, name) => {
  const value = options.get(name);
  if (value === undefined) {
    fail(`Missing required option ${name}.`);
  }
  return value;
};

const isErrorCode = (error, code) =>
  error instanceof Error && "code" in error && error.code === code;

const ensurePhysicalDirectory = async (directory) => {
  try {
    await mkdir(directory);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) {
      throw error;
    }
  }
  const status = await lstat(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail(`Refusing unsafe workflow path component: ${directory}`);
  }
};

const requireAbsent = async (path) => {
  try {
    await lstat(path);
    fail(`Workflow target already exists: ${path}`);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
};

const requireRegularFile = async (file, label) => {
  const status = await lstat(file);
  if (status.isSymbolicLink() || !status.isFile()) {
    fail(`${label} must be a regular file: ${file}`);
  }
};

const requirePhysicalDirectory = async (directory, label) => {
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(directory);
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) {
      fail(`${label} must be an existing physical directory.`);
    }
    throw error;
  }
  if (!(await lstat(canonicalDirectory)).isDirectory()) {
    fail(`${label} must be a physical directory.`);
  }
  return canonicalDirectory;
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isNormalizedRelativePath = (value) => {
  const segments = value.split("/");
  const byteLength = Buffer.byteLength(value, "utf8");
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  return (
    byteLength >= 1 &&
    byteLength <= 1_024 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !hasControlCharacter &&
    !segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  );
};

const collectDeclaredSchemaPaths = (definition) => {
  const declared = [];
  const collectFromNodes = (nodes) => {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (!isRecord(node)) {
        continue;
      }
      if (node.kind === "loop") {
        collectFromNodes(isRecord(node.body) ? node.body.nodes : undefined);
        continue;
      }
      if (isRecord(node.output) && typeof node.output.schema === "string") {
        declared.push(node.output.schema);
      }
    }
  };
  collectFromNodes(isRecord(definition) ? definition.nodes : undefined);
  return declared;
};

const stageDeclaredSchemaFiles = async (definitionBytes, definitionCandidate, stagePackage) => {
  let definition;
  try {
    definition = parse(definitionBytes.toString("utf8"), {
      maxAliasCount: 0,
      schema: "core",
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    fail(
      `Candidate workflow definition is not valid YAML: ${error instanceof Error ? error.message : "parse failure"}`,
    );
  }
  const candidateDirectory = await realpath(dirname(definitionCandidate));
  const staged = new Set();
  for (const declared of collectDeclaredSchemaPaths(definition)) {
    const relativePath = declared.startsWith("./") ? declared.slice(2) : declared;
    if (!isNormalizedRelativePath(relativePath)) {
      fail(
        `The json output schema path "${declared}" is invalid. Use 1 through 1,024 UTF-8 bytes in normalized POSIX-relative form with no leading or trailing "/", non-empty segments, "/" separators, and no ".", "..", backslash, or control characters.`,
      );
    }
    if (relativePath === "WORKFLOW.md" || relativePath === "WORKFLOW.yaml") {
      fail(
        `The json output schema "${declared}" collides with the reserved workflow package file "${relativePath}".`,
      );
    }
    if (staged.has(relativePath)) {
      continue;
    }
    staged.add(relativePath);
    let schemaFile;
    try {
      schemaFile = await realpath(resolve(candidateDirectory, relativePath));
    } catch (error) {
      if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) {
        fail(`The json output schema "${declared}" does not exist or is unreadable.`);
      }
      throw error;
    }
    const containment = relative(candidateDirectory, schemaFile);
    if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
      fail(`The json output schema "${declared}" resolves outside the candidate directory.`);
    }
    await requireRegularFile(schemaFile, `The json output schema "${declared}"`);
    const schemaBytes = await readFile(schemaFile);
    const stagedFile = join(stagePackage, ...relativePath.split("/"));
    await mkdir(dirname(stagedFile), { recursive: true, mode: 0o700 });
    try {
      await writeFile(stagedFile, schemaBytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        fail(`The json output schema "${declared}" collides with another staged package file.`);
      }
      throw error;
    }
  }
};

const validationFailure = (error) => {
  if (error instanceof Error && "stdout" in error && typeof error.stdout === "string") {
    const output = error.stdout.trim();
    if (output.length > 0) {
      return `Candidate validation failed: ${output}`;
    }
  }
  return "Candidate validation failed. Correct the workflow package and try again.";
};

const validatePackage = async (cliFile, workflowName, workingDirectory, scope) => {
  let result;
  try {
    result = await execFileAsync(
      process.execPath,
      [
        cliFile,
        "workflow",
        "validate",
        workflowName,
        "--scope",
        scope,
        "--cwd",
        workingDirectory,
        "--json",
      ],
      { encoding: "utf8", shell: false },
    );
  } catch (error) {
    fail(validationFailure(error));
  }
  const validation = JSON.parse(result.stdout);
  if (validation.valid !== true) {
    fail("Candidate validation did not report a valid workflow package.");
  }
  return validation;
};

const publish = async () => {
  const options = parseOptions(process.argv.slice(2));
  const scope = requireOption(options, "--scope");
  if (scope !== "project" && scope !== "user") {
    fail("Scope must be project or user.");
  }
  const scopeRoot = await requirePhysicalDirectory(
    requireOption(options, "--scope-root"),
    "Workflow scope root",
  );
  const workingDirectory = await requirePhysicalDirectory(
    requireOption(options, "--cwd"),
    "Working directory",
  );
  if (scope === "user" && (await realpath(homedir())) !== scopeRoot) {
    fail("User workflow scope root must be the invoking user's physical home directory.");
  }
  if (scope === "project" && workingDirectory !== scopeRoot) {
    fail("Project workflow scope root must be the exact physical working directory.");
  }
  const cliFile = resolve(requireOption(options, "--cli"));
  const manifestCandidate = resolve(requireOption(options, "--manifest-candidate"));
  const definitionCandidate = resolve(requireOption(options, "--definition-candidate"));
  const targetArgument = requireOption(options, "--target");
  const targetMatch = /^\.agents\/workflows\/([^/]+)$/u.exec(targetArgument);
  const workflowName = targetMatch?.[1];
  if (
    workflowName === undefined ||
    workflowName.length > 64 ||
    !workflowNamePattern.test(workflowName)
  ) {
    fail("Target must be exactly .agents/workflows/<name> with a valid lowercase workflow name.");
  }

  const targetDirectory = resolve(scopeRoot, targetArgument);
  if (relative(scopeRoot, targetDirectory) !== join(".agents", "workflows", workflowName)) {
    fail("Target resolves outside the exact workflow scope root.");
  }

  await requireRegularFile(cliFile, "Built Kilin CLI");
  await requireRegularFile(manifestCandidate, "Candidate workflow manifest");
  await requireRegularFile(definitionCandidate, "Candidate workflow definition");
  const [manifestBytes, definitionBytes] = await Promise.all([
    readFile(manifestCandidate),
    readFile(definitionCandidate),
  ]);
  const agentsDirectory = join(scopeRoot, ".agents");
  const workflowsDirectory = join(agentsDirectory, "workflows");
  await ensurePhysicalDirectory(agentsDirectory);
  await ensurePhysicalDirectory(workflowsDirectory);
  await requireAbsent(targetDirectory);

  const stageProject = join(agentsDirectory, `.workflow-stage-${process.pid}-${randomUUID()}`);
  const stagePackage = join(stageProject, ".agents", "workflows", workflowName);
  try {
    await mkdir(stagePackage, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(join(stagePackage, "WORKFLOW.md"), manifestBytes, {
        mode: 0o600,
        flag: "wx",
      }),
      writeFile(join(stagePackage, "WORKFLOW.yaml"), definitionBytes, {
        mode: 0o600,
        flag: "wx",
      }),
    ]);
    await stageDeclaredSchemaFiles(definitionBytes, definitionCandidate, stagePackage);
    await validatePackage(cliFile, workflowName, stageProject, "project");

    await ensurePhysicalDirectory(agentsDirectory);
    await ensurePhysicalDirectory(workflowsDirectory);
    if ((await realpath(workflowsDirectory)) !== workflowsDirectory) {
      fail("Workflow directory no longer resolves inside the exact workflow scope root.");
    }
    await requireAbsent(targetDirectory);
    await rename(stagePackage, targetDirectory);
    const validation = await validatePackage(cliFile, workflowName, workingDirectory, scope);
    process.stdout.write(
      `${JSON.stringify({
        scope,
        directory: targetDirectory,
        manifestFile: join(targetDirectory, "WORKFLOW.md"),
        definitionFile: join(targetDirectory, "WORKFLOW.yaml"),
        validation,
      })}\n`,
    );
  } catch (error) {
    if (isErrorCode(error, "EEXIST") || isErrorCode(error, "ENOTEMPTY")) {
      fail(`Workflow target already exists: ${targetDirectory}`);
    }
    throw error;
  } finally {
    await rm(stageProject, { recursive: true, force: true });
  }
};

try {
  await publish();
} catch (error) {
  const message = error instanceof Error ? error.message : "Workflow publication failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
