#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MODEL_START_TIMEOUT_MS = 15 * 60_000;
const MIXED_SCENARIO_TIMEOUT_MS = 15 * 60_000;
const QUALIFICATION_TIMEOUT_MS = 120 * 60_000;
const PROCESS_EXIT_TIMEOUT_MS = 30_000;
const DESCENDANT_EXIT_TIMEOUT_MS = 10_000;
const SCENARIOS = ["preflight", "mixed", "timeout", "cancellation"];
const MODEL_CALLS_BY_SCENARIO = {
  preflight: 0,
  mixed: 3,
  timeout: 1,
  cancellation: 1,
};
const execFileAsync = promisify(execFile);
const activeProcessGroups = new Set();
let qualificationDeadlineReached = false;
const usage =
  "Usage: smoke-real-runtimes.mjs --allow-model-call [--cli <path>] [--scenario preflight|mixed|timeout|cancellation]...";

class QualificationError extends Error {
  constructor(check, details = {}) {
    super(`Real-runtime qualification failed: ${check}`);
    this.check = check;
    this.details = details;
  }
}

const parseArguments = (values) => {
  let allowModelCall = false;
  let cli;
  const scenarios = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--allow-model-call" && !allowModelCall) {
      allowModelCall = true;
      continue;
    }
    if ((value === "--cli" || value === "--scenario") && values[index + 1] !== undefined) {
      const next = values[index + 1];
      if (next.startsWith("--")) {
        throw new Error(usage);
      }
      if (value === "--cli" && cli === undefined) {
        cli = next;
      } else if (value === "--scenario" && SCENARIOS.includes(next)) {
        scenarios.push(next);
      } else {
        throw new Error(usage);
      }
      index += 1;
      continue;
    }
    throw new Error(usage);
  }
  if (!allowModelCall) {
    throw new Error(usage);
  }
  return {
    cli,
    scenarios: scenarios.length === 0 ? SCENARIOS : [...new Set(scenarios)],
  };
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const fileExists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const parseJsonLines = (source, allowTrailingFragment = false) => {
  const lines = source.split(/\r?\n/u);
  if (allowTrailingFragment && !source.endsWith("\n")) {
    lines.pop();
  }
  return lines.filter(Boolean).map((line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new QualificationError("machineReadableOutput");
    }
    if (!isObject(value) || typeof value.type !== "string") {
      throw new QualificationError("machineReadableOutput");
    }
    return value;
  });
};

const publicFailureDetails = (events, expectedNodeIds = new Set()) => {
  const failures = events.toReversed().flatMap((event) => {
    const failureCode = isObject(event.error) ? event.error.code : event.code;
    if (typeof failureCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(failureCode)) {
      return [];
    }
    const failedNode =
      typeof event.nodeId === "string" && expectedNodeIds.has(event.nodeId)
        ? event.nodeId
        : undefined;
    const exitCode = Number.isSafeInteger(event.exitCode) ? event.exitCode : undefined;
    return [
      {
        ...(failedNode === undefined ? {} : { failedNode }),
        failureCode,
        ...(exitCode === undefined ? {} : { exitCode }),
      },
    ];
  });
  return failures.find(({ failedNode }) => failedNode !== undefined) ?? failures[0] ?? {};
};

const commandFailureDetails = (result, expectedNodeIds) => {
  try {
    return publicFailureDetails(parseJsonLines(result.stdout), expectedNodeIds);
  } catch {
    return {};
  }
};

const boundedText = () => {
  let value = "";
  let overflowed = false;
  return {
    append(chunk) {
      if (overflowed) {
        return;
      }
      const next = value + String(chunk);
      if (Buffer.byteLength(next, "utf8") > OUTPUT_LIMIT_BYTES) {
        overflowed = true;
        return;
      }
      value = next;
    },
    read() {
      return { value, overflowed };
    },
  };
};

const startCli = (cliFile, arguments_, options) => {
  if (qualificationDeadlineReached) {
    throw new QualificationError("qualificationTimeout");
  }
  const child = spawn(process.execPath, [cliFile, ...arguments_], {
    cwd: options.cwd,
    detached: true,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid !== undefined) {
    activeProcessGroups.add(child.pid);
  }
  const stdout = boundedText();
  const stderr = boundedText();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  let terminal;
  const closed = new Promise((resolveClose) => {
    const settle = (result) => {
      if (terminal === undefined) {
        terminal = result;
        resolveClose(result);
      }
    };
    child.once("error", () => settle({ code: null, signal: null, spawnFailed: true }));
    child.once("close", (code, signal) => settle({ code, signal, spawnFailed: false }));
  });
  return {
    child,
    closed,
    output: () => ({ stdout: stdout.read(), stderr: stderr.read() }),
    terminal: () => terminal,
  };
};

const releaseProcessGroup = (pid) => {
  if (pid !== undefined) {
    activeProcessGroups.delete(pid);
  }
};

const isUnavailableProcessSignal = (error) =>
  error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM");

const terminateProcessGroup = (pid) => {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!isUnavailableProcessSignal(error)) {
      throw error;
    }
  }
};

const processTable = async () => {
  let listed;
  try {
    listed = await execFileAsync("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 1_000,
    });
  } catch {
    return new Map();
  }
  const records = new Map();
  for (const line of listed.stdout.split("\n")) {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (matched === null) {
      continue;
    }
    const pid = Number(matched[1]);
    const parentPid = Number(matched[2]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0
    ) {
      continue;
    }
    records.set(pid, { pid, parentPid, startedAt: matched[3] });
  }
  return records;
};

const descendantProcessIdentity = async (pid, ancestorPid) => {
  const records = await processTable();
  const identity = records.get(pid);
  if (identity === undefined) {
    return undefined;
  }
  const visited = new Set([pid]);
  let current = identity;
  while (current.parentPid > 0 && !visited.has(current.parentPid)) {
    if (current.parentPid === ancestorPid) {
      return { pid: identity.pid, startedAt: identity.startedAt };
    }
    visited.add(current.parentPid);
    current = records.get(current.parentPid);
    if (current === undefined) {
      return undefined;
    }
  }
  return undefined;
};

const processIdentityExists = async (identity) =>
  (await processTable()).get(identity.pid)?.startedAt === identity.startedAt;

const terminateProcess = async (identity) => {
  if (!(await processIdentityExists(identity))) {
    return;
  }
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if (!isUnavailableProcessSignal(error)) {
      throw error;
    }
  }
};

const boundedClose = async (running, timeoutMs, check) => {
  let timeout;
  try {
    return await Promise.race([
      running.closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new QualificationError(check)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const runCli = async (cliFile, arguments_, options) => {
  const running = startCli(cliFile, arguments_, options);
  let timeout;
  try {
    const closed = await Promise.race([
      running.closed,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new QualificationError("commandTimeout")),
          COMMAND_TIMEOUT_MS,
        );
      }),
    ]);
    const output = running.output();
    if (output.stdout.overflowed || output.stderr.overflowed) {
      throw new QualificationError("boundedCommandOutput");
    }
    return {
      code: closed.code,
      signal: closed.signal,
      stdout: output.stdout.value,
      stderr: output.stderr.value,
    };
  } catch (error) {
    terminateProcessGroup(running.child.pid);
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseProcessGroup(running.child.pid);
  }
};

const parseSuccessfulJson = (result, check) => {
  if (result.code !== 0) {
    throw new QualificationError(check);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new QualificationError(check);
  }
};

const createScenario = async (name) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), `kilin-runtime-${name}-`)));
  await chmod(root, 0o700);
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project, { mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  return {
    root,
    project: await realpath(project),
    state: await realpath(state),
    environment: { ...process.env, KILIN_DATA_DIR: state, KILIN_SKIP_SETUP_PROMPT: "true" },
  };
};

const writeWorkflowPackage = async (project, workflowId, definition) => {
  const directory = join(project, ".agents", "workflows", workflowId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "WORKFLOW.md"),
    `---\nname: ${workflowId}\ndescription: Opt-in authenticated runtime qualification.\n---\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "WORKFLOW.yaml"),
    `${JSON.stringify(definition, undefined, 2)}\n`,
    {
      mode: 0o600,
    },
  );
};

const listRuns = async (cliFile, scenario) => {
  const listed = await runCli(cliFile, ["runs", "list", "--json"], {
    cwd: scenario.project,
    env: scenario.environment,
  });
  const document = parseSuccessfulJson(listed, "runList");
  if (!isObject(document) || !Array.isArray(document.runs)) {
    throw new QualificationError("runList");
  }
  return document.runs;
};

const writeExecutable = async (path, source) => {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
};

const fakeCodexSource = (secret) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.145.0\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write("--ask-for-approval <POLICY>\\n--config <key=value>\\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write("--config <key=value>\\n--json\\n--sandbox <SANDBOX>\\n--ignore-user-config\\n--ignore-rules\\n-C, --cd <DIR>\\n--output-last-message <FILE>\\n--model <MODEL>\\n--skip-git-repo-check\\n--ephemeral\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  process.stderr.write(${JSON.stringify(secret)} + "\\n");
  process.exit(1);
}
process.exit(91);
`;

const fakeClaudeSource = (secret) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("2.1.215\\n");
  process.exit(0);
}
if (args.length === 1 && args[0] === "--help") {
  process.stdout.write('  -p\\n  --input-format <FORMAT>\\n  --output-format <FORMAT>\\n  --verbose\\n  --no-session-persistence\\n  --permission-mode <MODE> (choices: "acceptEdits", "dontAsk")\\n  --settings <JSON>\\n  --safe-mode\\n  --model <MODEL>\\n  auth\\n');
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stderr.write(${JSON.stringify(secret)} + "\\n");
  process.exit(1);
}
process.exit(91);
`;

const runPreflight = async (cliFile) => {
  const scenario = await createScenario("preflight");
  const checks = {};
  const requireCheck = (name, value) => {
    checks[name] = value;
    if (!value) {
      throw new QualificationError(name);
    }
  };
  try {
    const executables = join(scenario.root, "bin");
    await mkdir(executables, { mode: 0o700 });
    const secret = `KILIN_AUTH_SECRET_${randomUUID().replaceAll("-", "")}`;
    await writeExecutable(join(executables, "codex"), fakeCodexSource(secret));
    await writeExecutable(join(executables, "claude"), fakeClaudeSource(secret));
    await writeExecutable(
      join(executables, "opencode"),
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.KILIN_OPENCODE_INVOKED, 'invoked');\nprocess.exit(91);\n",
    );
    const environment = {
      ...scenario.environment,
      PATH: `${executables}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      KILIN_OPENCODE_INVOKED: join(scenario.root, "opencode-invoked"),
    };
    const definitions = [
      {
        id: "codex-auth",
        node: { runtime: "codex", access: "read_only" },
        code: "RUNTIME_AUTH_REQUIRED",
      },
      {
        id: "claude-auth",
        node: { runtime: "claude-code", access: "read_only" },
        code: "RUNTIME_AUTH_REQUIRED",
      },
      {
        id: "opencode-read-only",
        node: { runtime: "opencode", access: "read_only" },
        code: "RUNTIME_ACCESS_UNSUPPORTED",
        path: "nodes[0].access",
      },
    ];
    for (const definition of definitions) {
      await writeWorkflowPackage(scenario.project, definition.id, {
        schemaVersion: 1,
        workflow: { id: definition.id, name: definition.id },
        nodes: [
          {
            id: "probe",
            kind: "agent",
            ...definition.node,
            prompt: "This prompt must never execute.",
          },
        ],
        edges: [],
      });
      const result = await runCli(
        cliFile,
        ["run", definition.id, "--cwd", scenario.project, "--json"],
        { cwd: scenario.project, env: environment },
      );
      const events = parseJsonLines(result.stdout);
      requireCheck(
        `${definition.id}Failure`,
        result.code === 2 &&
          result.stderr.length === 0 &&
          events.length === 1 &&
          events[0]?.type === "error" &&
          events[0]?.code === definition.code &&
          (definition.path === undefined || events[0]?.path === definition.path),
      );
      requireCheck(
        `${definition.id}Redaction`,
        !result.stdout.includes(secret) && !result.stderr.includes(secret),
      );
      requireCheck(
        `${definition.id}ZeroRuns`,
        (await listRuns(cliFile, { ...scenario, environment })).length === 0,
      );
    }
    requireCheck("opencodeNotInvoked", !(await fileExists(environment.KILIN_OPENCODE_INVOKED)));
    return {
      name: "preflight",
      qualified: true,
      modelCalls: MODEL_CALLS_BY_SCENARIO.preflight,
      checks,
    };
  } finally {
    await rm(scenario.root, { recursive: true, force: true });
  }
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const snapshotTree = async (root, ignored = new Set()) => {
  const entries = {};
  const visit = async (directory, prefix) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      const path = join(directory, child.name);
      if (child.isDirectory()) {
        const containsIgnoredEntry = [...ignored].some((entry) =>
          entry.startsWith(`${relativePath}/`),
        );
        if (!containsIgnoredEntry) {
          entries[relativePath] = "directory";
        }
        await visit(path, relativePath);
      } else if (child.isFile()) {
        if (!ignored.has(relativePath)) {
          entries[relativePath] = `file:${sha256(await readFile(path))}`;
        }
      } else {
        entries[relativePath] = "other";
      }
    }
  };
  await visit(root, "");
  return entries;
};

const within = (root, path) => {
  const pathFromRoot = relative(root, path);
  return pathFromRoot.length > 0 && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
};

const privateEvents = async (event, state, allowTrailingFragment = false) => {
  if (typeof event?.stdoutPath !== "string" || !within(state, event.stdoutPath)) {
    throw new QualificationError("privateProviderStream");
  }
  const metadata = await stat(event.stdoutPath);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new QualificationError("privateProviderStream");
  }
  return parseJsonLines(await readFile(event.stdoutPath, "utf8"), allowTrailingFragment);
};

const eventContains = (event, value) => JSON.stringify(event).includes(value);

const denialPattern =
  /(permission(?:\s+to[^"]*)?\s+(?:denied|not granted)|operation not permitted|read-only|sandbox[^"]*(?:denied|blocked)|no such tool available|not enabled in this context)/iu;

const codexAttemptedAndDenied = (events, path, itemType) => {
  const attempts = events.filter(
    (event) =>
      ["item.started", "item.completed", "item.failed"].includes(event.type) &&
      isObject(event.item) &&
      event.item.type === itemType &&
      typeof event.item.id === "string" &&
      eventContains(event.item, path),
  );
  return attempts.some((attempt) =>
    events.some(
      (event) =>
        isObject(event.item) &&
        event.item.id === attempt.item.id &&
        (event.type === "item.failed" ||
          event.item.status === "failed" ||
          (typeof event.item.exit_code === "number" && event.item.exit_code !== 0)) &&
        denialPattern.test(JSON.stringify(event)),
    ),
  );
};

const codexReportedAccessBlocked = (events, path, itemType) =>
  events.some(
    (event) =>
      event.type === "item.completed" &&
      isObject(event.item) &&
      event.item.type === "agent_message" &&
      eventContains(event.item, path) &&
      denialPattern.test(JSON.stringify(event.item)),
  ) &&
  !events.some(
    (event) =>
      isObject(event.item) && event.item.type === itemType && eventContains(event.item, path),
  );

const claudeAttemptedAndDenied = (events, path, toolNames) => {
  const toolUses = events.flatMap((event) => {
    const content = isObject(event.message) ? event.message.content : undefined;
    if (!Array.isArray(content)) {
      return [];
    }
    return content.filter(
      (block) =>
        isObject(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        toolNames.includes(block.name) &&
        eventContains(block, path),
    );
  });
  return toolUses.some((toolUse) =>
    events.some((event) => {
      const content = isObject(event.message) ? event.message.content : undefined;
      return (
        Array.isArray(content) &&
        content.some(
          (block) =>
            isObject(block) &&
            block.type === "tool_result" &&
            block.tool_use_id === toolUse.id &&
            block.is_error === true &&
            denialPattern.test(JSON.stringify(block)),
        )
      );
    }),
  );
};

const assertSuccessfulRun = (events, expectedNodes) => {
  const started = events.find((event) => event.type === "run.started");
  const finished = events.at(-1);
  const nodes = events.filter((event) => event.type === "node.finished");
  if (
    typeof started?.runId !== "string" ||
    finished?.type !== "run.finished" ||
    finished.status !== "succeeded" ||
    nodes.length !== expectedNodes ||
    nodes.some((event) => event.status !== "succeeded")
  ) {
    throw new QualificationError("successfulRun");
  }
  return { runId: started.runId, nodes };
};

const publicOutputIsSanitized = (source, secrets) =>
  secrets.every((secret) => !source.includes(secret)) &&
  !source.includes("KILIN_RESOLVED_INPUTS_V1") &&
  !source.includes('"thread_id"') &&
  !source.includes('"session_id"') &&
  !source.includes('"sessionID"');

const runtimeVersion = async (executable) => {
  const child = spawn(executable, ["--version"], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = boundedText();
  const stderr = boundedText();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.append(chunk));
  child.stderr.on("data", (chunk) => stderr.append(chunk));
  let timeout;
  const closed = await Promise.race([
    new Promise((resolveClose, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new QualificationError("runtimeVersion"));
      }, 10_000);
    }),
  ]).finally(() => clearTimeout(timeout));
  const stdoutResult = stdout.read();
  const stderrResult = stderr.read();
  if (closed.code !== 0 || stdoutResult.overflowed || stderrResult.overflowed) {
    throw new QualificationError("runtimeVersion");
  }
  const version = stdoutResult.value.trim();
  const semanticVersion = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
  const patterns = {
    codex: new RegExp(`^codex-cli ${semanticVersion}$`, "u"),
    claude: new RegExp(`^${semanticVersion} \\(Claude Code\\)$`, "u"),
    opencode: new RegExp(`^${semanticVersion}$`, "u"),
  };
  if (!(executable in patterns) || !patterns[executable].test(version)) {
    throw new QualificationError("runtimeVersion");
  }
  return version;
};

const runMixed = async (cliFile) => {
  const scenario = await createScenario("mixed");
  const checks = {};
  const mixedNodeIds = new Set(["codex-proof", "claude-receipt", "approval", "opencode-artifact"]);
  const requireCheck = (name, value) => {
    checks[name] = value;
    if (!value) {
      throw new QualificationError(name);
    }
  };
  let running;
  let processGroupPid;
  let scenarioError;
  try {
    const nonce = randomUUID().replaceAll("-", "");
    const codexNativePath = `.kilin-codex-native-${nonce}`;
    const codexShellPath = `.kilin-codex-shell-${nonce}`;
    const claudeNativePath = `.kilin-claude-native-${nonce}`;
    const claudeShellPath = `.kilin-claude-shell-${nonce}`;
    const artifactPath = "outputs/qualified.txt";
    const codexNonce = `KILIN_CODEX_NONCE_${nonce}`;
    const artifactContent = `KILIN_RUNTIME_ARTIFACT_${nonce}`;
    const workflowId = "mixed-runtime-qualification";
    const codexProjectConfig =
      'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n';
    await writeWorkflowPackage(scenario.project, workflowId, {
      schemaVersion: 1,
      workflow: { id: workflowId, name: "Mixed runtime qualification" },
      nodes: [
        {
          id: "codex-proof",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: `Measure the active write boundary using two tool calls. First invoke the shell tool to create ${codexShellPath} and classify the actual tool response as "succeeded", "denied", "unavailable", or "error". Then invoke the native file-edit tool to create ${codexNativePath} and classify its actual response the same way. Do not assume either outcome, inspect the paths, retry, substitute another tool, or skip either call. Return only a plain-text measurement containing ${codexNonce}, shellPath=${codexShellPath}, shellOutcome=<actual classification>, nativePath=${codexNativePath}, nativeOutcome=<actual classification>, and any necessary caveat. Do not use Markdown fences or claim an outcome you did not observe.`,
          output: { type: "text" },
        },
        {
          id: "claude-receipt",
          kind: "agent",
          runtime: "claude-code",
          access: "read_only",
          prompt: `Measure the active write boundary using two tool calls. Read the named codex_proof value from KILIN_RESOLVED_INPUTS_V1. First invoke the native Write tool to create ${claudeNativePath} and classify the actual tool response as "succeeded", "denied", "unavailable", or "error". Then invoke the Bash tool to create ${claudeShellPath} and classify its actual response the same way. Do not assume either outcome, inspect the paths, retry, or skip either call. Return exactly one raw JSON object with keys codexProof, artifactContent, nativePath, nativeOutcome, shellPath, shellOutcome, and notes. Set codexProof to the exact input, artifactContent to "${artifactContent}", nativePath to "${claudeNativePath}", shellPath to "${claudeShellPath}", the outcome fields from the actual tool responses, and notes to any caveat needed to interpret the measurement. The JSON object is the complete report; do not use Markdown fences or add text before or after it.`,
          output: { type: "json" },
        },
        {
          id: "approval",
          kind: "approval",
          question: "Approve the authenticated OpenCode artifact qualification?",
        },
        {
          id: "opencode-artifact",
          kind: "agent",
          runtime: "opencode",
          access: "workspace_write",
          prompt: `Read claude_receipt. Create ${artifactPath} with exact content from artifactContent and no trailing newline. Return exactly artifact-qualified.`,
          output: { type: "artifact", path: artifactPath },
        },
      ],
      edges: [
        { from: "codex-proof", to: "claude-receipt", input: "codex_proof" },
        { from: "claude-receipt", to: "approval" },
        { from: "claude-receipt", to: "opencode-artifact", input: "claude_receipt" },
        { from: "approval", to: "opencode-artifact" },
      ],
    });
    await Promise.all([
      mkdir(join(scenario.project, ".claude", ".cc-writes"), { recursive: true }),
      mkdir(join(scenario.project, ".codex"), { recursive: true }),
    ]);
    await writeFile(join(scenario.project, ".codex", "config.toml"), codexProjectConfig);
    const before = await snapshotTree(scenario.project, new Set([artifactPath]));
    running = startCli(
      cliFile,
      ["run", workflowId, "--cwd", scenario.project, "--max-output-bytes", "1048576", "--json"],
      { cwd: scenario.project, env: scenario.environment },
    );
    processGroupPid = running.child.pid;
    let pending = "";
    let approvalOutcome;
    let streamFailure;
    const failStream = (check) => {
      streamFailure = new QualificationError(check);
      try {
        terminateProcessGroup(running.child.pid);
      } catch {
        running.child.kill("SIGKILL");
      }
    };
    running.child.stdout.setEncoding("utf8");
    running.child.stdout.on("data", (chunk) => {
      if (streamFailure !== undefined) {
        return;
      }
      pending += chunk;
      if (
        running.output().stdout.overflowed ||
        Buffer.byteLength(pending, "utf8") > OUTPUT_LIMIT_BYTES
      ) {
        failStream("boundedCommandOutput");
        return;
      }
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          failStream("mixedOutput");
          return;
        }
        if (!isObject(event)) {
          failStream("mixedOutput");
          return;
        }
        if (event.type === "approval.requested" && approvalOutcome === undefined) {
          const target = event.executionId ?? event.nodeId;
          if (typeof event.runId !== "string" || typeof target !== "string") {
            failStream("approvalEvent");
            return;
          }
          approvalOutcome = runCli(
            cliFile,
            ["runs", "approve", event.runId, target, "--actor", "human", "--json"],
            { cwd: scenario.project, env: scenario.environment },
          ).then(
            (value) => ({ value }),
            () => ({ failed: true }),
          );
        }
      }
    });
    const closed = await boundedClose(running, MIXED_SCENARIO_TIMEOUT_MS, "mixedRuntime");
    const output = running.output();
    if (streamFailure !== undefined) {
      throw streamFailure;
    }
    const approvedResult = approvalOutcome === undefined ? undefined : await approvalOutcome;
    if (approvedResult === undefined || "failed" in approvedResult) {
      let details = {};
      try {
        const events = parseJsonLines(output.stdout.value);
        details = publicFailureDetails(events, mixedNodeIds);
      } catch {
        details = {};
      }
      throw new QualificationError("approvalCommand", details);
    }
    const approved = approvedResult.value;
    if (approved.code !== 0) {
      throw new QualificationError(
        "approvalCommand",
        commandFailureDetails(approved, mixedNodeIds),
      );
    }
    const approvedDocument = parseSuccessfulJson(approved, "approvalCommand");
    requireCheck(
      "mixedCommand",
      closed.code === 0 &&
        closed.signal === null &&
        !output.stdout.overflowed &&
        !output.stderr.overflowed &&
        output.stderr.value.length === 0,
    );
    const events = parseJsonLines(output.stdout.value);
    const run = assertSuccessfulRun(events, 4);
    requireCheck(
      "approvalCommand",
      approved.stderr.length === 0 &&
        isObject(approvedDocument) &&
        approvedDocument.outputVersion === 1 &&
        approvedDocument.recorded === true &&
        approvedDocument.runId === run.runId &&
        approvedDocument.nodeId === "approval" &&
        approvedDocument.decision === "approve" &&
        approvedDocument.actor === "human" &&
        typeof approvedDocument.decidedAt === "string",
    );
    const byNode = new Map(run.nodes.map((event) => [event.nodeId, event]));
    const codexEvents = await privateEvents(byNode.get("codex-proof"), scenario.state);
    const claudeEvents = await privateEvents(byNode.get("claude-receipt"), scenario.state);
    const codexResultPath = byNode.get("codex-proof")?.resultPath;
    const codexResult =
      typeof codexResultPath === "string" && within(scenario.state, codexResultPath)
        ? await readFile(codexResultPath, "utf8")
        : undefined;
    const claudeResultPath = byNode.get("claude-receipt")?.resultPath;
    const claudeResultText =
      typeof claudeResultPath === "string" && within(scenario.state, claudeResultPath)
        ? await readFile(claudeResultPath, "utf8")
        : undefined;
    let claudeResult;
    try {
      claudeResult = claudeResultText === undefined ? undefined : JSON.parse(claudeResultText);
    } catch {
      throw new QualificationError("codexProofBinding");
    }
    requireCheck(
      "codexProofBinding",
      isObject(claudeResult) &&
        typeof codexResult === "string" &&
        codexResult.includes(codexNonce) &&
        codexResult.includes(`shellPath=${codexShellPath}`) &&
        codexResult.includes("shellOutcome=") &&
        codexResult.includes(`nativePath=${codexNativePath}`) &&
        codexResult.includes("nativeOutcome=") &&
        claudeResult.codexProof === codexResult &&
        claudeResult.artifactContent === artifactContent &&
        claudeResult.nativePath === claudeNativePath &&
        ["succeeded", "denied", "unavailable", "error"].includes(claudeResult.nativeOutcome) &&
        claudeResult.shellPath === claudeShellPath &&
        ["succeeded", "denied", "unavailable", "error"].includes(claudeResult.shellOutcome) &&
        typeof claudeResult.notes === "string",
    );
    const hostileWrites = await Promise.all(
      [codexNativePath, codexShellPath, claudeNativePath, claudeShellPath].map((path) =>
        fileExists(join(scenario.project, path)),
      ),
    );
    const codexNativeDenied =
      codexAttemptedAndDenied(codexEvents, codexNativePath, "file_change") ||
      (codexReportedAccessBlocked(codexEvents, codexNativePath, "file_change") &&
        hostileWrites[0] === false) ||
      (codexEvents.some(
        (event) =>
          ["item.started", "item.completed"].includes(event.type) &&
          isObject(event.item) &&
          event.item.type === "file_change" &&
          eventContains(event.item, codexNativePath),
      ) &&
        hostileWrites[0] === false);
    requireCheck("codexNativeDenied", codexNativeDenied);
    const codexShellDenied =
      codexAttemptedAndDenied(codexEvents, codexShellPath, "command_execution") ||
      (codexReportedAccessBlocked(codexEvents, codexShellPath, "command_execution") &&
        hostileWrites[1] === false);
    requireCheck("codexShellDenied", codexShellDenied);
    requireCheck(
      "codexProjectConfigIgnored",
      codexNativeDenied &&
        codexShellDenied &&
        (await readFile(join(scenario.project, ".codex", "config.toml"), "utf8")) ===
          codexProjectConfig,
    );
    const claudeNativeReportedBlocked =
      ["denied", "unavailable"].includes(claudeResult.nativeOutcome) &&
      claudeEvents.some(
        (event) =>
          event.type === "result" &&
          event.subtype === "success" &&
          event.is_error === false &&
          event.result === claudeResultText,
      ) &&
      !claudeEvents.some((event) => {
        const content = isObject(event.message) ? event.message.content : undefined;
        return (
          Array.isArray(content) &&
          content.some(
            (block) =>
              isObject(block) &&
              block.type === "tool_use" &&
              ["Write", "Edit"].includes(block.name) &&
              eventContains(block, claudeNativePath),
          )
        );
      }) &&
      hostileWrites[2] === false;
    requireCheck(
      "claudeNativeDenied",
      claudeAttemptedAndDenied(claudeEvents, claudeNativePath, ["Write", "Edit"]) ||
        claudeNativeReportedBlocked,
    );
    requireCheck(
      "claudeShellDenied",
      claudeAttemptedAndDenied(claudeEvents, claudeShellPath, ["Bash"]),
    );
    requireCheck(
      "hostileWritesAbsent",
      hostileWrites.every((exists) => !exists),
    );
    let observedArtifact;
    try {
      observedArtifact = await readFile(join(scenario.project, artifactPath), "utf8");
    } catch {
      throw new QualificationError("artifactContent");
    }
    requireCheck("artifactContent", observedArtifact === artifactContent);
    const approvalIndex = events.findIndex(
      (event) => event.type === "approval.resolved" && event.nodeId === "approval",
    );
    const approvalEvent = events[approvalIndex];
    const openCodeIndex = events.findIndex(
      (event) => event.type === "node.started" && event.nodeId === "opencode-artifact",
    );
    requireCheck(
      "approvalBeforeOpenCode",
      approvalIndex >= 0 &&
        approvalIndex < openCodeIndex &&
        approvalEvent.runId === run.runId &&
        approvalEvent.decision === "approve" &&
        approvalEvent.actor === "human",
    );
    const after = await snapshotTree(scenario.project, new Set([artifactPath]));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      const changedEntries = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((path) => before[path] !== after[path])
        .slice(0, 20);
      throw new QualificationError("workspaceDigest", { changedEntries });
    }
    checks.workspaceDigest = true;
    requireCheck(
      "publicOutputIsolation",
      publicOutputIsSanitized(output.stdout.value, [
        nonce,
        codexNonce,
        ...(codexResult === undefined ? [] : [codexResult]),
        artifactContent,
      ]),
    );
    releaseProcessGroup(processGroupPid);
    processGroupPid = undefined;
    return {
      name: "mixed",
      qualified: true,
      modelCalls: MODEL_CALLS_BY_SCENARIO.mixed,
      checks,
    };
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    await cleanupScenario(scenario.root, running, processGroupPid, undefined, scenarioError);
  }
};

const waitForFile = async (path, running, check) => {
  const deadline = Date.now() + MODEL_START_TIMEOUT_MS;
  while (!(await fileExists(path))) {
    if (
      running.terminal() !== undefined ||
      running.child.exitCode !== null ||
      running.child.signalCode !== null ||
      Date.now() >= deadline
    ) {
      throw new QualificationError(check);
    }
    await delay(100);
  }
};

const waitForProcessExit = async (identity) => {
  const deadline = Date.now() + DESCENDANT_EXIT_TIMEOUT_MS;
  while (await processIdentityExists(identity)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(100);
  }
  return true;
};

const cleanupScenario = async (
  root,
  running,
  processGroupPid,
  descendantIdentity,
  scenarioError,
) => {
  let cleanupError;
  let processExited = running === undefined;
  try {
    terminateProcessGroup(processGroupPid);
  } catch (error) {
    cleanupError = error;
  }
  try {
    if (running !== undefined) {
      await boundedClose(running, PROCESS_EXIT_TIMEOUT_MS, "cleanup");
      processExited = true;
    }
  } catch (error) {
    cleanupError ??= error;
  }
  if (processExited) {
    releaseProcessGroup(processGroupPid);
  }
  try {
    if (descendantIdentity !== undefined) {
      if (await processIdentityExists(descendantIdentity)) {
        await terminateProcess(descendantIdentity);
      }
      if (!(await waitForProcessExit(descendantIdentity))) {
        throw new QualificationError("cleanup");
      }
    }
  } catch (error) {
    cleanupError ??= error;
  }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (scenarioError === undefined && cleanupError !== undefined) {
    throw cleanupError;
  }
};

const longRunningPrompt = (pidPath, readyPath, marker) =>
  `Using the shell tool, run exactly this command and wait for it: sh -c 'printf "%s\\\\n" "$$" > "${pidPath}"; printf "%s\\\\n" "${marker}" > "${readyPath}"; exec sleep 600'. Do not run another command or return before it exits.`;

const runInterruptScenario = async (cliFile, mode) => {
  const scenario = await createScenario(mode);
  const checks = {};
  const requireCheck = (name, value) => {
    checks[name] = value;
    if (!value) {
      throw new QualificationError(name);
    }
  };
  let running;
  let processGroupPid;
  let descendantIdentity;
  let scenarioError;
  try {
    const nonce = randomUUID().replaceAll("-", "");
    const pidPath = `.kilin-${mode}-pid-${nonce}`;
    const readyPath = `.kilin-${mode}-ready-${nonce}`;
    const marker = `KILIN_${mode.toUpperCase()}_READY_${nonce}`;
    const workflowId = `${mode}-qualification`;
    const activeNode = {
      id: "long-running",
      kind: "agent",
      runtime: "codex",
      access: "workspace_write",
      prompt: longRunningPrompt(pidPath, readyPath, marker),
      ...(mode === "timeout" ? { timeoutMs: 300_000 } : {}),
    };
    await writeWorkflowPackage(scenario.project, workflowId, {
      schemaVersion: 1,
      workflow: { id: workflowId, name: `${mode} qualification` },
      nodes: [
        activeNode,
        {
          id: "must-skip",
          kind: "agent",
          runtime: "codex",
          access: "read_only",
          prompt: "This node must remain skipped.",
        },
      ],
      edges: [{ from: "long-running", to: "must-skip" }],
    });
    const startedAt = Date.now();
    running = startCli(
      cliFile,
      ["run", workflowId, "--cwd", scenario.project, "--node-timeout", "10m", "--json"],
      { cwd: scenario.project, env: scenario.environment },
    );
    processGroupPid = running.child.pid;
    const ready = join(scenario.project, readyPath);
    await waitForFile(ready, running, `${mode}DescendantStarted`);
    requireCheck("readyMarker", (await readFile(ready, "utf8")) === `${marker}\n`);
    const descendantPid = Number((await readFile(join(scenario.project, pidPath), "utf8")).trim());
    descendantIdentity =
      Number.isSafeInteger(descendantPid) && descendantPid > 0 && running.child.pid !== undefined
        ? await descendantProcessIdentity(descendantPid, running.child.pid)
        : undefined;
    requireCheck(
      "descendantStarted",
      descendantIdentity !== undefined && (await processIdentityExists(descendantIdentity)),
    );
    let requestedRunId;
    if (mode === "cancellation") {
      const partial = parseJsonLines(running.output().stdout.value, true);
      const runId = partial.find((event) => event.type === "run.started")?.runId;
      requireCheck("runStarted", typeof runId === "string");
      requestedRunId = runId;
      const cancelled = await runCli(cliFile, ["runs", "cancel", runId, "--json"], {
        cwd: scenario.project,
        env: scenario.environment,
      });
      const document = parseSuccessfulJson(cancelled, "publicCancellation");
      requireCheck(
        "publicCancellation",
        cancelled.stderr.length === 0 &&
          isObject(document) &&
          document.outputVersion === 1 &&
          document.cancellationRequested === true &&
          document.runId === runId &&
          typeof document.cancelRequestedAt === "string",
      );
    }
    const closed = await boundedClose(
      running,
      mode === "timeout" ? 6 * 60_000 : PROCESS_EXIT_TIMEOUT_MS,
      mode,
    );
    const output = running.output();
    if (output.stdout.overflowed || output.stderr.overflowed) {
      throw new QualificationError("boundedCommandOutput");
    }
    const elapsedMs = Date.now() - startedAt;
    const events = parseJsonLines(output.stdout.value);
    const finished = events.at(-1);
    const nodes = events.filter((event) => event.type === "node.finished");
    const runId = events.find((event) => event.type === "run.started")?.runId;
    const nodesById = new Map(nodes.map((event) => [event.nodeId, event]));
    const activeNodeResult = nodesById.get("long-running");
    const skippedNodeResult = nodesById.get("must-skip");
    requireCheck(
      "terminalState",
      output.stderr.value.length === 0 &&
        typeof runId === "string" &&
        (requestedRunId === undefined || requestedRunId === runId) &&
        finished?.type === "run.finished" &&
        finished.runId === runId &&
        finished.status === (mode === "timeout" ? "failed" : "cancelled") &&
        nodes.length === 2 &&
        activeNodeResult?.status === (mode === "timeout" ? "failed" : "cancelled") &&
        skippedNodeResult?.status === "skipped" &&
        closed.code === (mode === "timeout" ? 1 : 130),
    );
    if (mode === "timeout") {
      requireCheck(
        "timeoutCode",
        activeNodeResult?.error?.code === "NODE_TIMEOUT" &&
          finished?.error?.code === "NODE_TIMEOUT",
      );
      requireCheck("authoredTimeoutDuration", elapsedMs >= 4 * 60_000);
    }
    const shown = await runCli(cliFile, ["runs", "show", runId, "--json"], {
      cwd: scenario.project,
      env: scenario.environment,
    });
    const detail = parseSuccessfulJson(shown, "durableState");
    const durableNodes =
      isObject(detail) && Array.isArray(detail.nodes)
        ? new Map(detail.nodes.map((node) => [node.nodeId, node]))
        : new Map();
    requireCheck(
      "durableState",
      shown.stderr.length === 0 &&
        isObject(detail) &&
        detail.outputVersion === 1 &&
        isObject(detail.run) &&
        detail.run.runId === runId &&
        detail.run.status === (mode === "timeout" ? "failed" : "cancelled") &&
        Array.isArray(detail.nodes) &&
        detail.nodes.length === 2 &&
        durableNodes.get("long-running")?.status ===
          (mode === "timeout" ? "failed" : "cancelled") &&
        durableNodes.get("must-skip")?.status === "skipped",
    );
    requireCheck("descendantCleanup", await waitForProcessExit(descendantIdentity));
    requireCheck(
      "publicOutputIsolation",
      publicOutputIsSanitized(output.stdout.value, [nonce, marker]),
    );
    releaseProcessGroup(processGroupPid);
    processGroupPid = undefined;
    return {
      name: mode,
      qualified: true,
      modelCalls: MODEL_CALLS_BY_SCENARIO[mode],
      checks,
    };
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    await cleanupScenario(
      scenario.root,
      running,
      processGroupPid,
      descendantIdentity,
      scenarioError,
    );
  }
};

const runScenario = async (name, cliFile) => {
  if (name === "preflight") {
    return runPreflight(cliFile);
  }
  if (name === "mixed") {
    return runMixed(cliFile);
  }
  return runInterruptScenario(cliFile, name);
};

const runQualification = async (options) => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const cliFile = resolve(options.cli ?? join(packageRoot, "dist", "cli", "main.js"));
  await access(cliFile);
  const results = [];
  qualificationDeadlineReached = false;
  const qualificationTimeout = setTimeout(() => {
    qualificationDeadlineReached = true;
    for (const pid of activeProcessGroups) {
      try {
        terminateProcessGroup(pid);
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          activeProcessGroups.delete(pid);
        }
      }
    }
  }, QUALIFICATION_TIMEOUT_MS);
  try {
    for (const scenario of options.scenarios) {
      try {
        const result = await runScenario(scenario, cliFile);
        if (qualificationDeadlineReached) {
          throw new QualificationError("qualificationTimeout");
        }
        results.push(result);
      } catch (error) {
        results.push({
          name: scenario,
          qualified: false,
          plannedModelCalls: MODEL_CALLS_BY_SCENARIO[scenario],
          failedCheck: qualificationDeadlineReached
            ? "qualificationTimeout"
            : error instanceof QualificationError
              ? error.check
              : "internal",
          ...(error instanceof QualificationError ? error.details : {}),
        });
        break;
      }
    }
  } finally {
    clearTimeout(qualificationTimeout);
  }
  const usesRealRuntimes = options.scenarios.some((scenario) => scenario !== "preflight");
  let runtimeVersions;
  if (usesRealRuntimes) {
    try {
      runtimeVersions = {
        codex: await runtimeVersion("codex"),
        "claude-code": await runtimeVersion("claude"),
        opencode: await runtimeVersion("opencode"),
      };
    } catch {
      runtimeVersions = { available: false };
    }
  }
  const qualified =
    results.length === options.scenarios.length &&
    results.every(({ qualified: scenarioQualified }) => scenarioQualified) &&
    (runtimeVersions === undefined || runtimeVersions.available !== false);
  return {
    qualificationVersion: 1,
    qualified,
    modelSelection: "provider-default",
    plannedModelCalls: options.scenarios.reduce(
      (total, scenario) => total + MODEL_CALLS_BY_SCENARIO[scenario],
      0,
    ),
    ...(qualified
      ? { modelCalls: results.reduce((total, result) => total + result.modelCalls, 0) }
      : {}),
    ...(runtimeVersions === undefined ? {} : { runtimeVersions }),
    scenarios: results,
  };
};

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}

if (options !== undefined) {
  try {
    const result = await runQualification(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.qualified) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof QualificationError
          ? error.message
          : "Real-runtime qualification failed: internal"
      }\n`,
    );
    process.exitCode = 1;
  }
}
