#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_OPENCODE_SCENARIO ?? "supported";
const logPath = process.env.FAKE_OPENCODE_LOG;

if (logPath !== undefined) {
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);
}

if (args.length === 1 && args[0] === "--version") {
  if (scenario === "version-timeout") {
    await new Promise(() => {
      setInterval(() => undefined, 60_000);
    });
  }
  const versions = {
    "version-1.18.3": "1.18.3",
    "version-1.18.5": "1.18.5",
    "version-prerelease": "1.18.4-beta.1",
    "version-build": "1.18.4+build.1",
    "version-incidental": "warning: compatibility data 1.18.4",
    "version-ambiguous": "1.18.4\n1.18.5",
    "version-invalid": "invalid output",
  };
  process.stdout.write(`${versions[scenario] ?? "1.18.4"}\n`);
  process.exit(0);
}

if (args.length === 2 && args[0] === "run" && args[1] === "--help") {
  if (scenario === "help-failure") {
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
    process.exit(2);
  }
  if (scenario === "help-output-limit") {
    process.stdout.write("CAPABILITY_SECRET_FROM_PROVIDER".repeat(4_096));
    await new Promise(() => {
      setInterval(() => undefined, 60_000);
    });
  }
  if (scenario === "pinned-help") {
    process.stdout.write(readFileSync(process.env.FAKE_OPENCODE_HELP_PATH, "utf8"));
    process.exit(0);
  }

  const capabilities = [
    "      --pure",
    '      --format [choices: "default", "json"]',
    "      --dir <directory>",
    "  -m, --model <model>",
  ];
  const missing = {
    "missing-pure": 0,
    "missing-format": 1,
    "missing-dir": 2,
    "missing-model": 3,
  };
  const missingIndex = missing[scenario];
  if (missingIndex !== undefined) {
    capabilities[missingIndex] =
      `                                        See ${capabilities[missingIndex].trim()} above.`;
    process.stderr.write("CAPABILITY_SECRET_FROM_PROVIDER\n");
  }
  if (scenario === "missing-json") {
    capabilities[1] =
      '      --format format: "json" is unavailable\n                                        [choices: "default"]';
  }
  process.stdout.write(`${capabilities.join("\n")}\n`);
  process.exit(0);
}

let prompt = "";
for await (const chunk of process.stdin) {
  prompt += chunk.toString();
}

const recordPath = process.env.FAKE_OPENCODE_RECORD;
if (recordPath !== undefined) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      permission: process.env.OPENCODE_PERMISSION,
      prompt,
      sentinel: process.env.SENTINEL,
    }),
  );
}

process.stdout.write(
  `${JSON.stringify({
    type: "step_start",
    timestamp: 1,
    sessionID: "session-1",
    part: { type: "step-start", sessionID: "session-1" },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    type: "text",
    timestamp: 2,
    sessionID: "session-1",
    part: {
      type: "text",
      sessionID: "session-1",
      text: process.env.FAKE_OPENCODE_RESULT ?? `result:${prompt}`,
      time: { start: 1, end: 2 },
    },
  })}\n`,
);
