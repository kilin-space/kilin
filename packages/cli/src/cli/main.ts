#!/usr/bin/env node

import { homedir } from "node:os";

import { nodeAgentSkillsPorts } from "../infrastructure/agent-skills-ports.js";
import { resolvePackageRoot } from "../infrastructure/agent-skills-link.js";
import { resolveDataDirectory } from "../infrastructure/setup-preferences.js";

import { OptionError, wantsJsonOutput } from "./arguments.js";
import { renderError } from "./render.js";
import {
  runRerunCommand,
  runResumeCommand,
  runRetryCommand,
  runRunCommand,
  runRunsCommand,
  runTriggerCommand,
} from "./run-commands.js";
import { maybeOfferAgentSkillsLinkSetup, runSkillsCommand } from "./skills-commands.js";
import { runUiCommand } from "./ui-command.js";
import { runWorkflowCommand } from "./workflow-commands.js";
import packageManifest from "../../package.json" with { type: "json" };

const skillsDependencies = {
  ports: nodeAgentSkillsPorts,
  homeDirectory: homedir(),
  dataDirectory: resolveDataDirectory(),
  packageRoot: resolvePackageRoot(),
};

const help = `Kilin runs reusable local AI-agent workflows.

Usage:
  kilin <command> [options]

Commands:
  kilin workflow init <name> --scope <project|user> --name <display-name> --description <text> [--project-root <directory>] [--json]
      Create a project- or user-scoped workflow package.
  kilin workflow list [--cwd <directory>] [--json]
      List workflow packages visible from a working directory.
  kilin workflow validate <name> [--scope <project|user>] [--cwd <directory>] [--json]
      Validate a workflow package without executing it.
  kilin run <name> --cwd <directory> [--param <name=value>]... [--node-timeout <duration>] [--approval-timeout <duration>] [--max-output-bytes <bytes>] [--max-parallel <count>] [--json]
      Execute a workflow and stream its lifecycle.
  kilin trigger --request <absolute-file> [--json]
      Execute a strict request supplied by a host scheduler.
  kilin rerun <run-id> [--max-parallel <count>] [--json]
      Re-execute the complete stored workflow revision.
  kilin retry <run-id> [--node <node-id>] [--json]
      Retry a failed node frontier in a continuation run.
  kilin resume <run-id> [--json]
      Resume the recoverable frontier of an interrupted or failed run.
  kilin runs list [--limit <count>] [--status <status>] [--json]
      List durable run history.
  kilin runs show <run-id> [--json]
      Show durable run, node, attempt, and output details.
  kilin runs wait <run-id> [--json]
      Wait until a run needs approval or reaches a terminal state.
  kilin runs cancel <run-id> [--json]
      Request cancellation of an active run.
  kilin runs approve <run-id> <node-id> --actor <agent|human> [--note <text>] [--json]
      Approve an eligible waiting node.
  kilin runs reject <run-id> <node-id> --actor <agent|human> [--note <text>] [--json]
      Reject an eligible waiting node.
  kilin ui <name> --cwd <directory> [--no-open] [--json]
      Open the local workflow viewer.
  kilin skills link [--providers agents|claude[,...]] [--home <directory>]
      Link packaged agent skills into provider skill directories.
  kilin skills status [--home <directory>] [--json]
      Show provider skill link status and setup preference.

Global options:
  -h, --help
      Show this help and exit.
  --version
      Print the installed version and exit.
`;

const run = async (arguments_: string[]): Promise<number> => {
  if (arguments_.length === 1 && (arguments_[0] === "-h" || arguments_[0] === "--help")) {
    process.stdout.write(help);
    return 0;
  }
  if (arguments_.length === 1 && arguments_[0] === "--version") {
    process.stdout.write(`${packageManifest.version}\n`);
    return 0;
  }

  const json = wantsJsonOutput(arguments_);
  const wantsHelp = arguments_.some((argument) => argument === "-h" || argument === "--help");
  try {
    const command = arguments_[0];
    if (process.env.KILIN_SKIP_SETUP_PROMPT !== "true" && !wantsHelp) {
      await maybeOfferAgentSkillsLinkSetup({ command, json, dependencies: skillsDependencies });
    }

    if (command === "workflow") {
      await runWorkflowCommand(arguments_.slice(1));
      return 0;
    }
    if (command === "run") {
      return await runRunCommand(arguments_.slice(1));
    }
    if (command === "trigger") {
      return await runTriggerCommand(arguments_.slice(1));
    }
    if (command === "rerun") {
      return await runRerunCommand(arguments_.slice(1));
    }
    if (command === "retry") {
      return await runRetryCommand(arguments_.slice(1));
    }
    if (command === "resume") {
      return await runResumeCommand(arguments_.slice(1));
    }
    if (command === "runs") {
      return await runRunsCommand(arguments_.slice(1));
    }
    if (command === "ui") {
      return await runUiCommand(arguments_.slice(1));
    }
    if (command === "skills") {
      return await runSkillsCommand(arguments_.slice(1), skillsDependencies);
    }

    let message = 'A command is required. Run "kilin --help" for usage.';
    if (command !== undefined) {
      message = `Unknown command "${command}". Run "kilin --help" for usage.`;
    }
    throw new OptionError(message);
  } catch (error: unknown) {
    renderError(error, json);
    return 2;
  }
};

process.exitCode = await run(process.argv.slice(2));
