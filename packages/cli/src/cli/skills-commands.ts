import { resolve } from "node:path";

import {
  applyAgentSkillsLinkSelection,
  getAgentSkillsLinkPreference,
  getAgentSkillsStatus,
  parseAgentSkillProviderList,
  type AgentSkillProviderId,
  type AgentSkillsPorts,
} from "../application/agent-skills.js";
import { KilinError } from "../domain/errors.js";

import { OptionError, parseOptions } from "./arguments.js";
import { type ProviderSkillsPrompt, promptProviderSkillsLink } from "./provider-skills-prompt.js";
import { renderJson, terminalSafeText, type SkillsStatusDocument } from "./render.js";

export interface SkillsLinkDependencies {
  readonly ports: AgentSkillsPorts;
  readonly homeDirectory: string;
  readonly dataDirectory: string;
  readonly packageRoot: string;
  readonly prompt?: ProviderSkillsPrompt;
  readonly stdinIsTty?: boolean;
  readonly stdoutIsTty?: boolean;
}

const rethrowLinkFailure = (error: unknown): never => {
  if (error instanceof OptionError || error instanceof KilinError) {
    throw error;
  }
  if (error instanceof Error) {
    throw new OptionError(error.message);
  }
  throw error;
};

const readTtyFlag = (override: boolean | undefined, fallback: boolean | undefined): boolean =>
  (override ?? fallback) === true;

const isInteractive = (dependencies: SkillsLinkDependencies): boolean =>
  readTtyFlag(dependencies.stdinIsTty, process.stdin.isTTY) &&
  readTtyFlag(dependencies.stdoutIsTty, process.stdout.isTTY);

const resolveHomeDirectory = (
  option: string | undefined,
  dependencies: SkillsLinkDependencies,
): string => {
  if (option !== undefined) {
    return resolve(option);
  }
  return dependencies.homeDirectory;
};

export const runSkillsLinkCommand = async (
  arguments_: string[],
  dependencies: SkillsLinkDependencies,
): Promise<number> => {
  const options = parseOptions(arguments_, new Set(["--providers", "--home"]), new Set());
  const homeDirectory = resolveHomeDirectory(options.values.get("--home"), dependencies);
  const providersOption = options.values.get("--providers");

  let providers: readonly AgentSkillProviderId[];
  if (providersOption !== undefined) {
    try {
      providers = parseAgentSkillProviderList(providersOption);
    } catch (error: unknown) {
      return rethrowLinkFailure(error);
    }
  } else if (isInteractive(dependencies)) {
    const prompt = dependencies.prompt ?? promptProviderSkillsLink;
    const selection = await prompt();
    if (selection.kind === "cancel") {
      process.stderr.write("Skill linking cancelled.\n");
      return 1;
    }
    providers = selection.providers;
  } else {
    throw new OptionError(
      'Non-interactive skill linking requires "--providers agents", "--providers claude", or "--providers agents,claude".',
    );
  }

  let result: { readonly installedCount: number; readonly createdCount: number };
  try {
    result = await applyAgentSkillsLinkSelection(
      {
        providers,
        homeDirectory,
        dataDirectory: dependencies.dataDirectory,
        packageRoot: dependencies.packageRoot,
      },
      dependencies.ports,
    );
  } catch (error: unknown) {
    return rethrowLinkFailure(error);
  }

  if (providers.length === 0) {
    process.stdout.write("No provider skill directories were linked.\n");
    return 0;
  }

  process.stdout.write(
    `Linked Kilin skills for ${providers.join(", ")} (${String(result.installedCount)} links).\n`,
  );
  return 0;
};

export const runSkillsStatusCommand = async (
  arguments_: string[],
  dependencies: SkillsLinkDependencies,
): Promise<number> => {
  const options = parseOptions(arguments_, new Set(["--home"]));
  const homeDirectory = resolveHomeDirectory(options.values.get("--home"), dependencies);
  const status = await getAgentSkillsStatus(
    {
      homeDirectory,
      dataDirectory: dependencies.dataDirectory,
      packageRoot: dependencies.packageRoot,
    },
    dependencies.ports,
  );
  const document: SkillsStatusDocument = {
    outputVersion: 1,
    homeDirectory,
    dataDirectory: dependencies.dataDirectory,
    preference: status.preference,
    providers: status.providers,
  };

  if (options.flags.has("--json")) {
    renderJson(document);
    return 0;
  }

  const preference = document.preference;
  if (preference === null) {
    process.stdout.write("Setup preference: not recorded\n");
  } else {
    const selected = preference.providers.length === 0 ? "none" : preference.providers.join(", ");
    process.stdout.write(`Setup preference: asked ${preference.askedAt}; providers ${selected}\n`);
  }

  for (const provider of status.providers) {
    process.stdout.write(`\n${provider.provider} (${provider.skillRoot})\n`);
    for (const skill of provider.skills) {
      process.stdout.write(`  ${skill.skillName}: ${skill.status}\n`);
    }
  }
  return 0;
};

export const runSkillsCommand = async (
  arguments_: string[],
  dependencies: SkillsLinkDependencies,
): Promise<number> => {
  const action = arguments_[0];
  if (action === "link") {
    return runSkillsLinkCommand(arguments_.slice(1), dependencies);
  }
  if (action === "status") {
    return runSkillsStatusCommand(arguments_.slice(1), dependencies);
  }
  throw new OptionError('Unknown skills action. Use "kilin skills link" or "kilin skills status".');
};

export const maybeOfferAgentSkillsLinkSetup = async (input: {
  readonly command: string | undefined;
  readonly json: boolean;
  readonly dependencies: SkillsLinkDependencies;
}): Promise<void> => {
  if (input.command === "skills" || input.command === undefined) {
    return;
  }

  const { dependencies } = input;
  try {
    const preference = await getAgentSkillsLinkPreference(
      dependencies.dataDirectory,
      dependencies.ports,
    );
    if (preference !== undefined) {
      return;
    }

    if (input.json || !isInteractive(dependencies)) {
      process.stderr.write("Agent skills are not linked yet. Run: kilin skills link\n");
      return;
    }

    const prompt = dependencies.prompt ?? promptProviderSkillsLink;
    const selection = await prompt();
    if (selection.kind === "cancel") {
      return;
    }

    const result = await applyAgentSkillsLinkSelection(
      {
        providers: selection.providers,
        homeDirectory: dependencies.homeDirectory,
        dataDirectory: dependencies.dataDirectory,
        packageRoot: dependencies.packageRoot,
      },
      dependencies.ports,
    );

    if (selection.providers.length === 0) {
      process.stderr.write("Skipped linking Kilin agent skills.\n");
      return;
    }

    process.stderr.write(
      `Linked Kilin skills for ${selection.providers.join(", ")} (${String(result.installedCount)} links).\n`,
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "an unknown failure";
    process.stderr.write(`Skipped agent skill setup: ${terminalSafeText(reason)}\n`);
  }
};
