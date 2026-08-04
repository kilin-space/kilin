#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Bounds this process and any descendant it spawns, so a failed run leaves no residue.
const fixtureLifetimeMs = 60_000;

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const scenario = valueAfter("--scenario") ?? "success";
const resultPath = valueAfter("--result");
const recordPath = process.env.FAKE_PROCESS_RECORD;

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  stdin += chunk;
}

if (recordPath !== undefined) {
  await writeFile(
    recordPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      stdin,
      visibleEnvironment: process.env.FAKE_VISIBLE,
      absentEnvironmentPresent: process.env.FAKE_ABSENT !== undefined,
    }),
  );
}

if (scenario === "success") {
  process.stdout.write("stdout exact\n");
  process.stderr.write("stderr exact\n");
  if (resultPath !== undefined) {
    await appendFile(resultPath, "result exact\n");
  }
  process.exit(0);
}

if (scenario === "nonzero") {
  process.stdout.write("partial stdout\n");
  process.stderr.write("partial stderr\n");
  process.exit(23);
}

if (scenario === "output-limit") {
  if (resultPath !== undefined) {
    await appendFile(resultPath, "r".repeat(2_048));
  }
  process.stdout.write("o".repeat(2_048));
  process.stderr.write("e".repeat(2_048));
  await new Promise(() => setTimeout(() => process.exit(0), fixtureLifetimeMs));
}

if (scenario === "wait") {
  await new Promise(() => setTimeout(() => process.exit(0), fixtureLifetimeMs));
}

if (scenario === "descendant" || scenario === "detached-descendant") {
  const pidPath = valueAfter("--pid-file");
  if (pidPath === undefined) {
    process.exit(64);
  }
  spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { renameSync, writeFileSync } from "node:fs";',
        "process.on('SIGTERM', () => {});",
        "const pidPath = process.env.FAKE_PID_PATH;",
        'const pendingPidPath = pidPath + ".pending";',
        "writeFileSync(pendingPidPath, String(process.pid));",
        "renameSync(pendingPidPath, pidPath);",
        `setTimeout(() => process.exit(0), ${String(fixtureLifetimeMs)});`,
      ].join(" "),
    ],
    {
      detached: scenario === "detached-descendant",
      env: { ...process.env, FAKE_PID_PATH: pidPath },
      stdio: "ignore",
    },
  );
  await new Promise(() => setTimeout(() => process.exit(0), fixtureLifetimeMs));
}

if (scenario === "signal-counting-descendant") {
  const pidPath = valueAfter("--pid-file");
  const signalPath = valueAfter("--signal-file");
  if (pidPath === undefined || signalPath === undefined) {
    process.exit(64);
  }
  let terminationScheduled = false;
  process.on("SIGTERM", () => {
    appendFileSync(signalPath, "leader\n");
    if (!terminationScheduled) {
      terminationScheduled = true;
      setTimeout(() => process.exit(0), 100);
    }
  });
  spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        "const signalPath = process.env.FAKE_SIGNAL_PATH;",
        "const pidPath = process.env.FAKE_PID_PATH;",
        "let terminationScheduled = false;",
        'process.on("SIGTERM", () => {',
        '  appendFileSync(signalPath, "descendant\\n");',
        "  if (!terminationScheduled) {",
        "    terminationScheduled = true;",
        "    setTimeout(() => process.exit(0), 10);",
        "  }",
        "});",
        "writeFileSync(pidPath, String(process.pid));",
        `setTimeout(() => process.exit(0), ${String(fixtureLifetimeMs)});`,
      ].join(" "),
    ],
    {
      env: {
        ...process.env,
        FAKE_PID_PATH: pidPath,
        FAKE_SIGNAL_PATH: signalPath,
      },
      stdio: "ignore",
    },
  );
  await new Promise(() => setTimeout(() => process.exit(0), fixtureLifetimeMs));
}

if (scenario === "retained-pipes") {
  const pidPath = valueAfter("--pid-file");
  const descendant = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), ${String(fixtureLifetimeMs)})`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (pidPath !== undefined && descendant.pid !== undefined) {
    await writeFile(pidPath, String(descendant.pid));
  }
  process.exit(0);
}

process.stderr.write(`Unknown scenario: ${scenario}\n`);
process.exit(64);
