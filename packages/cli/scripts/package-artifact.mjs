import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAXIMUM_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const PACKAGE_ROOT_FILES = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "scripts/link-agent-skills.mjs",
]);
const SKILL_NAMES = ["discover-kilin-workflows", "generate-kilin-workflow"];
const SKILL_PROVIDER_ROOTS = [".agents", ".claude"];

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const runCommand = async (executable, arguments_, options = {}) =>
  execFileAsync(executable, arguments_, {
    encoding: "utf8",
    maxBuffer: MAXIMUM_COMMAND_OUTPUT_BYTES,
    shell: false,
    ...options,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });

const collectFilePaths = async (root, prefix = "") => {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const entryPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    assert.notEqual(entry.name, ".DS_Store", `Generated package input contains ${entryPath}`);
    if (entry.isDirectory()) {
      paths.push(...(await collectFilePaths(root, entryPath)));
      continue;
    }
    assert.ok(entry.isFile(), `Generated package input is not a regular file: ${entryPath}`);
    paths.push(entryPath);
  }
  return paths;
};

const expectedPackedFiles = async () => {
  const distFiles = await collectFilePaths(join(packageRoot, "dist"));
  const agentSkillFiles = await collectFilePaths(join(packageRoot, "agent-skills"));
  return new Set([
    ...PACKAGE_ROOT_FILES,
    ...agentSkillFiles.map((path) => `agent-skills/${path}`),
    ...distFiles.map((path) => `dist/${path}`),
  ]);
};

const listPackedFiles = async (tarballPath) => {
  const listed = await runCommand("tar", ["-tzf", tarballPath]);
  return new Set(
    listed.stdout
      .split("\n")
      .filter((path) => path !== "" && !path.endsWith("/"))
      .map((path) => {
        assert.ok(path.startsWith("package/"), `Packed entry is outside package/: ${path}`);
        const packagePath = path.slice("package/".length);
        assert.ok(
          packagePath !== ".." && !packagePath.startsWith(`..${sep}`) && !isAbsolute(packagePath),
          `Packed entry escapes package/: ${path}`,
        );
        return packagePath;
      }),
  );
};

const assertMatchingFiles = (actual, expected) => {
  const missing = [...expected].filter((path) => !actual.has(path)).sort();
  const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
  assert.deepEqual(missing, [], `Packed package is missing:\n${missing.join("\n")}`);
  assert.deepEqual(
    unexpected,
    [],
    `Packed package contains unexpected files:\n${unexpected.join("\n")}`,
  );
};

export const calculateSha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

export const createPackageArtifact = async (tarballPath) => {
  const resolvedTarballPath = resolve(tarballPath);
  assert.ok(isAbsolute(tarballPath), "The package artifact path must be absolute.");
  await mkdir(dirname(resolvedTarballPath), { recursive: true });
  await runCommand("pnpm", ["pack", "--json", "--out", resolvedTarballPath], {
    cwd: packageRoot,
  });
  const actualFiles = await listPackedFiles(resolvedTarballPath);
  const expectedFiles = await expectedPackedFiles();
  assertMatchingFiles(actualFiles, expectedFiles);
  return {
    filename: resolvedTarballPath.split(sep).at(-1),
    path: resolvedTarballPath,
    sha256: await calculateSha256(resolvedTarballPath),
    files: [...actualFiles].sort(),
  };
};

const credentialFreeEnvironment = (temporaryRoot, npmCache, additions = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: join(temporaryRoot, "home"),
  TMPDIR: join(temporaryRoot, "tmp"),
  KILIN_DATA_DIR: join(temporaryRoot, "state"),
  npm_config_cache: npmCache,
  npm_config_userconfig: join(temporaryRoot, "empty-npmrc"),
  ...additions,
});

const createFakeCodex = async (binaryDirectory) => {
  const fakeCodexPath = join(binaryDirectory, "codex");
  await writeFile(
    fakeCodexPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--ask-for-approval <POLICY>\\n--config <key=value>\\n");
  process.exit(0);
}
if (args.length === 2 && args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("--config <key=value>\\n--json\\n--sandbox <MODE>\\n--ignore-user-config\\n--ignore-rules\\n-C, --cd <DIR>\\n--output-last-message <FILE>\\n--model <MODEL>\\n--skip-git-repo-check\\n--ephemeral\\n");
  process.exit(0);
}
if (args.length === 2 && args[0] === "login" && args[1] === "status") {
  process.stdout.write("Authenticated\\n");
  process.exit(0);
}
if (
  args[0] === "--ask-for-approval" &&
  args[1] === "never" &&
  args[2] === "--config" &&
  args[3] === 'default_permissions=":read-only"' &&
  args[4] === "--config" &&
  args[5] === \`projects.\${JSON.stringify(process.cwd())}.trust_level="untrusted"\` &&
  args[6] === "exec" &&
  args[7] === "--ignore-user-config" &&
  args[8] === "--ignore-rules"
) {
  const resultIndex = args.indexOf("--output-last-message");
  const resultPath = args[resultIndex + 1];
  if (resultIndex === -1 || resultPath === undefined) {
    process.stderr.write("Missing result path.\\n");
    process.exit(64);
  }
  let prompt = "";
  for await (const chunk of process.stdin) {
    prompt += chunk.toString();
  }
  if (!prompt.includes("PACKED_ARTIFACT_PROBE")) {
    process.stderr.write("Unexpected prompt.\\n");
    process.exit(65);
  }
  writeFileSync(resultPath, "PACKED_ARTIFACT_RESULT");
  process.stdout.write('{"type":"probe.completed"}\\n');
  process.exit(0);
}
process.stderr.write("Unexpected fake Codex invocation.\\n");
process.exit(66);
`,
  );
  await chmod(fakeCodexPath, 0o755);
  return fakeCodexPath;
};

const parseJsonLines = (output) =>
  output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));

const verifyFakeRuntimeWorkflow = async (cliPath, temporaryRoot, environment) => {
  const projectRoot = join(temporaryRoot, "project");
  const workflowRoot = join(projectRoot, ".agents", "workflows", "packed-artifact-probe");
  const binaryDirectory = join(temporaryRoot, "bin");
  await Promise.all([
    mkdir(workflowRoot, { recursive: true }),
    mkdir(binaryDirectory, { recursive: true }),
  ]);
  await createFakeCodex(binaryDirectory);
  await writeFile(
    join(workflowRoot, "WORKFLOW.md"),
    "---\nname: packed-artifact-probe\ndescription: Exercise the globally installed package.\n---\n",
  );
  await writeFile(
    join(workflowRoot, "WORKFLOW.yaml"),
    [
      "schemaVersion: 1",
      "workflow:",
      "  id: packed-artifact-probe",
      "  name: Packed artifact probe",
      "nodes:",
      "  - id: execute",
      "    kind: agent",
      "    runtime: codex",
      "    access: read_only",
      "    prompt: PACKED_ARTIFACT_PROBE",
      "    output:",
      "      type: text",
      "edges: []",
      "",
    ].join("\n"),
  );
  const executionEnvironment = {
    ...environment,
    PATH: `${binaryDirectory}${delimiter}${environment.PATH}`,
  };
  const execution = await runCommand(
    cliPath,
    ["run", "packed-artifact-probe", "--cwd", projectRoot, "--json"],
    { env: executionEnvironment },
  );
  const events = parseJsonLines(execution.stdout);
  const started = events.find((event) => event.type === "run.started");
  const finished = events.at(-1);
  assert.equal(typeof started?.runId, "string");
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "node.started", "node.finished", "run.finished"],
  );
  assert.equal(finished?.status, "succeeded");

  const durable = await runCommand(cliPath, ["runs", "show", started.runId, "--json"], {
    env: executionEnvironment,
  });
  const runDetail = JSON.parse(durable.stdout);
  assert.equal(runDetail.run.runId, started.runId);
  assert.equal(runDetail.run.status, "succeeded");
  assert.equal(runDetail.nodes.length, 1);
  assert.equal(runDetail.nodes[0].nodeId, "execute");
  assert.equal(runDetail.nodes[0].status, "succeeded");
  const resultPath = runDetail.nodes[0].resultPath;
  assert.equal(typeof resultPath, "string");
  assert.equal(await readFile(resultPath, "utf8"), "PACKED_ARTIFACT_RESULT");
  return {
    eventTypes: events.map((event) => event.type),
    runStatus: runDetail.run.status,
    nodeStatus: runDetail.nodes[0].status,
    resultVerified: true,
  };
};

export const installAndVerifyPackageArtifact = async (artifact, temporaryRoot) => {
  const prefix = join(temporaryRoot, "global");
  const npmCache = join(temporaryRoot, "npm-cache");
  const environment = credentialFreeEnvironment(temporaryRoot, npmCache);
  await Promise.all([
    mkdir(environment.HOME, { recursive: true }),
    mkdir(environment.TMPDIR, { recursive: true }),
    mkdir(environment.KILIN_DATA_DIR, { recursive: true }),
    writeFile(environment.npm_config_userconfig, ""),
  ]);
  await runCommand(
    "npm",
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", artifact.path],
    { env: environment },
  );

  const cliPath = join(prefix, "bin", "kilin");
  const installedPackageRoot = join(prefix, "lib", "node_modules", "@kilin-space", "cli");
  const help = await runCommand(cliPath, ["--help"], { env: environment });
  assert.match(help.stdout, /kilin workflow/u);
  const version = await runCommand(cliPath, ["--version"], { env: environment });
  const manifest = JSON.parse(await readFile(join(installedPackageRoot, "package.json"), "utf8"));
  assert.equal(version.stdout.trim(), manifest.version);
  JSON.parse(
    await readFile(
      join(installedPackageRoot, "dist", "infrastructure", "workflow-v1.schema.json"),
      "utf8",
    ),
  );

  const linkHome = join(temporaryRoot, "link-home");
  await runCommand(
    "npm",
    ["--prefix", installedPackageRoot, "run", "link:agent-skills", "--", "--home", linkHome],
    { env: environment },
  );
  for (const providerRoot of SKILL_PROVIDER_ROOTS) {
    for (const skillName of SKILL_NAMES) {
      const installedLink = join(linkHome, providerRoot, "skills", skillName);
      assert.equal((await lstat(installedLink)).isSymbolicLink(), true);
      assert.equal(
        await realpath(installedLink),
        await realpath(join(installedPackageRoot, "agent-skills", skillName)),
      );
    }
  }
  const workflow = await verifyFakeRuntimeWorkflow(cliPath, temporaryRoot, environment);
  return {
    cliPath,
    installedPackageRoot,
    packageName: manifest.name,
    packageVersion: manifest.version,
    checks: {
      help: true,
      schema: true,
      skillLinks: true,
      workflow,
    },
  };
};

export const assertArtifactUnchanged = async (artifact) => {
  assert.equal(
    await calculateSha256(artifact.path),
    artifact.sha256,
    "The package artifact changed after qualification.",
  );
};
