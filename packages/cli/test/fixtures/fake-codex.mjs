#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// A fixture process must never outlive the suite that spawned it. Scenarios that block
// indefinitely, and the TERM-resistant descendants they spawn, give up after this bound so a
// failed or interrupted test run leaves no residue on the host.
const fixtureLifetimeMs = 60_000;

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "supported";
const logPath = process.env.FAKE_CODEX_LOG;

const promptEntryMap = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};

const matchingPromptEntry = (entries, prompt) => {
  const candidates = Object.entries(entries);
  return (
    candidates.find(([candidate]) => prompt === candidate) ??
    candidates.find(([candidate]) => prompt.startsWith(`${candidate}\n\nKILIN_RETRY_FEEDBACK_V1\n`))
  );
};

if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  if (scenario === "version-descendant-timeout") {
    const descendantReadyStatement =
      process.env.FAKE_CODEX_DESCENDANT_READY === undefined
        ? ""
        : `require("node:fs").writeFileSync(${JSON.stringify(process.env.FAKE_CODEX_DESCENDANT_READY)},"ready");`;
    const descendant = spawn(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM",()=>require("node:fs").writeFileSync(${JSON.stringify(process.env.FAKE_CODEX_SIGNAL_MARKER)},"SIGTERM"));${descendantReadyStatement}setTimeout(()=>process.exit(0),8000)`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    writeFileSync(process.env.FAKE_CODEX_DESCENDANT_PID, String(descendant.pid));
    process.exit(0);
  }

  if (scenario === "version-timeout") {
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }

  if (scenario === "version-failure") {
    process.stderr.write("VERSION_SECRET_FROM_PROVIDER\n");
    process.exit(2);
  }

  let version = "0.144.6";
  if (scenario === "unsupported-version") {
    version = "0.143.9";
  }
  if (scenario === "newer-version") {
    version = "0.145.0";
  }
  if (scenario === "prerelease-version") {
    version = "0.144.6-beta.1";
  }
  process.stdout.write(`codex-cli ${version}\n`);
  process.exit(0);
}

if (args.length === 1 && args[0] === "--help") {
  const flags = ["--ask-for-approval <POLICY>", "--config <key=value>"];
  if (scenario === "missing-ask-for-approval") {
    flags.splice(flags.indexOf("--ask-for-approval <POLICY>"), 1);
  }
  if (scenario === "missing-config") {
    flags.splice(flags.indexOf("--config <key=value>"), 1);
  }
  process.stdout.write(`${flags.join("\n")}\n`);
  process.exit(0);
}

if (args.length === 2 && args[0] === "exec" && args[1] === "--help") {
  if (scenario === "capability-output-limit") {
    await new Promise((resolve) => {
      process.stdout.write("OUTPUT_SECRET_FROM_PROVIDER".repeat(4_096), resolve);
    });
  }

  const flags = [
    "--config <key=value>",
    "--json",
    "--sandbox <SANDBOX>",
    "--ignore-user-config",
    "--ignore-rules",
    "-C, --cd <DIR>",
    "--output-last-message <FILE>",
    "--model <MODEL>",
    "--skip-git-repo-check",
    "--ephemeral",
  ];

  if (scenario === "long-cwd-only") {
    flags[flags.indexOf("-C, --cd <DIR>")] = "--cd <DIR>";
  }

  if (scenario === "missing-capability") {
    flags.splice(flags.indexOf("--ephemeral"), 1);
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }

  if (scenario === "missing-ignore-user-config") {
    flags.splice(flags.indexOf("--ignore-user-config"), 1);
  }

  if (scenario === "missing-ignore-rules") {
    flags.splice(flags.indexOf("--ignore-rules"), 1);
  }

  process.stdout.write(`${flags.join("\n")}\n`);
  process.exit(0);
}

if (args.length === 2 && args[0] === "login" && args[1] === "status") {
  if (scenario === "auth-required") {
    process.stderr.write("AUTH_SECRET_FROM_PROVIDER\n");
    process.exit(1);
  }

  process.stdout.write("Logged in with FAKE_ACCOUNT_SECRET\n");
  process.exit(0);
}

if (
  args[0] === "--ask-for-approval" &&
  args[1] === "never" &&
  args[2] === "--config" &&
  ['default_permissions=":read-only"', 'default_permissions=":workspace"'].includes(args[3]) &&
  args[4] === "--config" &&
  args[5] === `projects.${JSON.stringify(process.cwd())}.trust_level="untrusted"` &&
  args[6] === "exec" &&
  args[7] === "--ignore-user-config" &&
  args[8] === "--ignore-rules"
) {
  const outputFlagIndex = args.indexOf("--output-last-message");
  const resultPath = args[outputFlagIndex + 1];
  if (outputFlagIndex === -1 || resultPath === undefined) {
    process.stderr.write("Fake Codex did not receive a result path\n");
    process.exit(65);
  }

  let resolvedInputsAtStart;
  try {
    resolvedInputsAtStart = readFileSync(join(dirname(resultPath), "resolved-inputs.json"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  let prompt = "";
  for await (const chunk of process.stdin) {
    prompt += chunk.toString();
  }

  const executionLogPath = process.env.FAKE_CODEX_EXEC_LOG;
  if (executionLogPath !== undefined) {
    appendFileSync(
      executionLogPath,
      `${JSON.stringify({
        args,
        cwd: process.cwd(),
        prompt,
        ...(resolvedInputsAtStart === undefined ? {} : { resolvedInputsAtStart }),
      })}\n`,
    );
  }
  const sideEffectPath = process.env.FAKE_CODEX_SIDE_EFFECT;
  if (sideEffectPath !== undefined) {
    appendFileSync(sideEffectPath, `${prompt}\n`);
  }
  const workspaceFile = process.env.FAKE_CODEX_WORKSPACE_FILE;
  if (workspaceFile !== undefined) {
    const workingDirectory = process.cwd();
    const workspacePath = resolve(workingDirectory, workspaceFile);
    const relativeWorkspacePath = relative(workingDirectory, workspacePath);
    if (
      isAbsolute(workspaceFile) ||
      relativeWorkspacePath === ".." ||
      relativeWorkspacePath.startsWith(`..${sep}`) ||
      isAbsolute(relativeWorkspacePath)
    ) {
      throw new Error("Fake Codex workspace file must remain inside the working directory");
    }
    writeFileSync(workspacePath, `${prompt}\n`);
  }

  // Deterministic barriers: announce this execution by prompt digest, then optionally block until
  // the test releases it. Tests wait on file existence, never on elapsed time.
  const promptDigest = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 32);
  if (process.env.FAKE_CODEX_STARTED_DIR !== undefined) {
    writeFileSync(join(process.env.FAKE_CODEX_STARTED_DIR, promptDigest), "started");
  }
  if (process.env.FAKE_CODEX_RELEASE_DIR !== undefined) {
    const releasePath = join(process.env.FAKE_CODEX_RELEASE_DIR, promptDigest);
    while (!existsSync(releasePath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  let behaviors = {};
  if (process.env.FAKE_CODEX_BEHAVIORS !== undefined) {
    behaviors = JSON.parse(process.env.FAKE_CODEX_BEHAVIORS);
  }
  let behavior = behaviors[prompt] ?? process.env.FAKE_CODEX_BEHAVIOR ?? "success";
  if (process.env.FAKE_CODEX_BEHAVIOR_SEQUENCES !== undefined && executionLogPath !== undefined) {
    const sequences = promptEntryMap(JSON.parse(process.env.FAKE_CODEX_BEHAVIOR_SEQUENCES));
    const matchedSequence = matchingPromptEntry(sequences, prompt);
    const sequence = matchedSequence?.[1];
    if (Array.isArray(sequence) && sequence.length > 0) {
      const basePrompt = matchedSequence[0];
      const invocationIndex =
        readFileSync(executionLogPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter(
            (entry) =>
              entry.prompt === basePrompt ||
              entry.prompt.startsWith(`${basePrompt}\n\nKILIN_RETRY_FEEDBACK_V1\n`),
          ).length - 1;
      behavior = sequence[Math.min(invocationIndex, sequence.length - 1)];
    }
  }
  const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS ?? "0");

  if (behavior === "nonzero") {
    process.stdout.write("provider partial stdout\n");
    process.stderr.write("provider partial stderr\n");
    process.exit(23);
  }

  if (behavior === "wait" || behavior === "cancel-child") {
    if (behavior === "cancel-child") {
      if (process.env.FAKE_CODEX_DESCENDANT_PID === undefined) {
        process.exit(64);
      }
      spawn(
        process.execPath,
        [
          "-e",
          [
            'const { renameSync, writeFileSync } = require("node:fs");',
            "process.on('SIGTERM',()=>{});",
            "const pidPath = process.env.FAKE_CODEX_DESCENDANT_PID;",
            'const pendingPidPath = pidPath + ".pending";',
            "writeFileSync(pendingPidPath, String(process.pid));",
            "renameSync(pendingPidPath, pidPath);",
            "setTimeout(()=>process.exit(0),60000);",
          ].join(""),
        ],
        { stdio: "ignore" },
      );
    }
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }

  if (behavior === "overflow") {
    process.stdout.write("provider-output".repeat(16_384));
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }

  if (behavior === "stream") {
    const streamDelayMs = Number(process.env.FAKE_CODEX_STREAM_DELAY_MS ?? "3000");
    process.stdout.write(
      `${JSON.stringify({
        type: "item.completed",
        item: { id: "stream_0", type: "agent_message", text: "FIRST_STREAM_MESSAGE" },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
    writeFileSync(resultPath, "streamed result");
    await new Promise((resolve) => {
      process.stdout.write(
        `${JSON.stringify({
          type: "item.completed",
          item: { id: "stream_1", type: "agent_message", text: "SECOND_STREAM_MESSAGE" },
        })}\n`,
        resolve,
      );
    });
    process.exit(0);
  }

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  process.stdout.write(`${JSON.stringify({ type: "provider.event", prompt })}\n`);
  process.stderr.write("provider diagnostic\n");
  if (behavior === "missing-result") {
    unlinkSync(resultPath);
    process.exit(0);
  }
  let result = process.env.FAKE_CODEX_RESULT ?? `result:${prompt}`;
  if (process.env.FAKE_CODEX_RESULTS !== undefined) {
    const results = promptEntryMap(JSON.parse(process.env.FAKE_CODEX_RESULTS));
    const matchedResult = matchingPromptEntry(results, prompt);
    if (matchedResult !== undefined) {
      result = matchedResult[1];
    }
  }
  writeFileSync(resultPath, result);
  process.exit(0);
}

process.stderr.write("Unexpected fake Codex invocation\n");
process.exit(64);
