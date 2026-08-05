#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// Bounds this process and any descendant it spawns, so a failed run leaves no residue.
const fixtureLifetimeMs = 60_000;

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "supported";
const logPath = process.env.FAKE_CLAUDE_LOG;

if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  if (scenario === "version-timeout") {
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }
  const versions = {
    "version-2.1.214": "2.1.214",
    "version-2.1.216": "2.1.216",
    "version-prerelease": "2.1.215-beta.1",
    "version-build": "2.1.215+build.1",
    "version-leading-zero": "02.01.215",
    "version-invalid": "invalid output",
  };
  process.stdout.write(`${versions[scenario] ?? "2.1.215"}\n`);
  process.exit(0);
}

if (args.length === 1 && args[0] === "--help") {
  if (scenario === "help-failure") {
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
    process.exit(2);
  }
  if (scenario === "help-output-limit") {
    process.stdout.write("CAPABILITY_SECRET_FROM_PROVIDER".repeat(4_096));
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }
  if (scenario === "pinned-help") {
    process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_HELP_PATH, "utf8"));
    process.exit(0);
  }

  const capabilities = [
    "  -p",
    "  --input-format <FORMAT>",
    "  --output-format <FORMAT>",
    "  --no-session-persistence",
    '  --permission-mode <MODE> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
    "  --settings <JSON>",
    "  --safe-mode",
    "  --model <MODEL>",
    "  auth",
    "  --verbose",
  ];
  if (scenario === "missing-short-p") {
    capabilities[0] = "                                        Use -p to print.";
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }
  if (scenario === "missing-safe-mode") {
    capabilities[6] = "                                        Use --safe-mode for safe execution.";
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }
  if (scenario === "missing-dontAsk") {
    capabilities[4] = capabilities[4].replace(', "dontAsk"', "");
  }
  if (scenario === "missing-acceptEdits") {
    capabilities[4] = capabilities[4].replace('"acceptEdits", ', "");
  }
  if (scenario === "missing-auth-command") {
    capabilities[8] = "                                        Run auth before use.";
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }
  if (scenario === "missing-verbose") {
    capabilities[9] = "                                        Use --verbose for detailed output.";
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }
  process.stdout.write(`${capabilities.join("\n")}\n`);
  process.exit(0);
}

if (args.length === 2 && args[0] === "auth" && args[1] === "status") {
  if (scenario === "auth-required") {
    process.stderr.write("AUTH_SECRET_FROM_PROVIDER\n");
    process.exit(1);
  }
  if (scenario === "auth-output-limit") {
    process.stdout.write("AUTH_SECRET_FROM_PROVIDER".repeat(4_096));
    await new Promise(() => {
      setTimeout(() => process.exit(0), fixtureLifetimeMs);
    });
  }
  process.stdout.write("Authenticated as FAKE_ACCOUNT_SECRET\n");
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk.toString();
}

const recordPath = process.env.FAKE_CLAUDE_RECORD;
if (recordPath !== undefined) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      prompt,
    }),
  );
}

process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: process.env.FAKE_CLAUDE_RESULT ?? `result:${prompt}`,
  })}\n`,
);
