#!/usr/bin/env node

import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const skillNames = ["discover-kilin-workflows", "generate-kilin-workflow", "run-kilin-workflow"];
const providerSkillRoots = {
  agents: ".agents/skills",
  claude: ".claude/skills",
};

const fail = (message) => {
  throw new Error(message);
};

const parseArguments = (arguments_) => {
  let homeDirectory = homedir();
  let providers;

  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === "--home") {
      const value = arguments_[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        fail('Flag "--home" requires a directory value.');
      }
      homeDirectory = resolve(value);
      index += 1;
      continue;
    }
    if (option === "--providers") {
      const value = arguments_[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        fail('Flag "--providers" requires a comma-separated list such as "agents,claude".');
      }
      providers = value;
      index += 1;
      continue;
    }
    fail("Use link-agent-skills.mjs with optional --home <directory> and --providers <list>.");
  }

  return { homeDirectory, providers };
};

const parseProviders = (value) => {
  if (value === undefined) {
    return Object.keys(providerSkillRoots);
  }
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (providers.length === 0) {
    fail('Flag "--providers" requires a comma-separated list such as "agents,claude".');
  }
  for (const provider of providers) {
    if (!(provider in providerSkillRoots)) {
      fail(`Unknown provider "${provider}". Use "agents" and/or "claude".`);
    }
  }
  return [...new Set(providers)];
};

const isErrorCode = (error, code) =>
  error instanceof Error && "code" in error && error.code === code;

const existingTarget = async (linkPath) => {
  let status;
  try {
    status = await lstat(linkPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { kind: "missing" };
    }
    throw error;
  }
  if (!status.isSymbolicLink()) {
    return { kind: "not-link" };
  }
  try {
    return { kind: "link", target: await realpath(linkPath) };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { kind: "broken" };
    }
    throw error;
  }
};

const installLinks = async ({ homeDirectory, providers }) => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const sourceRoot = join(packageRoot, "agent-skills");
  const createdLinks = [];
  let installedCount = 0;

  try {
    for (const provider of providers) {
      const destinationRoot = join(homeDirectory, ...providerSkillRoots[provider].split("/"));
      await mkdir(destinationRoot, { recursive: true });
      for (const skillName of skillNames) {
        const source = await realpath(join(sourceRoot, skillName));
        const destination = join(destinationRoot, skillName);
        const existing = await existingTarget(destination);
        if (existing.kind === "link" && existing.target === source) {
          installedCount += 1;
          continue;
        }
        if (existing.kind === "not-link") {
          fail(
            `Refusing to replace an existing non-link path: ${destination}. Remove or rename it, then run "kilin skills link" again.`,
          );
        }
        if (existing.kind === "link") {
          fail(
            `Refusing to replace a link to another target: ${destination}. Remove it, then run "kilin skills link" again.`,
          );
        }
        if (existing.kind === "broken") {
          await rm(destination);
        }
        await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
        createdLinks.push(destination);
        installedCount += 1;
      }
    }
  } catch (error) {
    await Promise.allSettled(createdLinks.map(async (linkPath) => rm(linkPath)));
    throw error;
  }
  return installedCount;
};

try {
  const { homeDirectory, providers: providersOption } = parseArguments(process.argv.slice(2));
  const installedCount = await installLinks({
    homeDirectory,
    providers: parseProviders(providersOption),
  });
  process.stdout.write(`${String(installedCount)} Kilin skill links are installed.\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Kilin skill linking failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
