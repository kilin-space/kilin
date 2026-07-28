import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentSkillLinkInspection,
  AgentSkillLinksInspection,
  AgentSkillLinkStatus,
  AgentSkillProviderId,
  AgentSkillProviderInspection,
  LinkAgentSkillsResult,
} from "../application/agent-skills.js";

export const agentSkillNames = [
  "discover-kilin-workflows",
  "generate-kilin-workflow",
  "run-kilin-workflow",
] as const;

export const agentSkillProviderDefinitions: Readonly<
  Record<AgentSkillProviderId, { readonly id: AgentSkillProviderId; readonly skillRoot: string }>
> = {
  agents: {
    id: "agents",
    skillRoot: ".agents/skills",
  },
  claude: {
    id: "claude",
    skillRoot: ".claude/skills",
  },
};

export const agentSkillProviderIds = Object.keys(
  agentSkillProviderDefinitions,
) as AgentSkillProviderId[];

type ExistingTarget =
  | { readonly kind: "missing" }
  | { readonly kind: "not-link" }
  | { readonly kind: "broken" }
  | { readonly kind: "link"; readonly target: string };

interface PlannedAgentSkillLink {
  readonly destinationRoot: string;
  readonly destination: string;
  readonly source: string;
  readonly existing: ExistingTarget;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const existingTarget = async (linkPath: string): Promise<ExistingTarget> => {
  let status;
  try {
    status = await lstat(linkPath);
  } catch (error: unknown) {
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
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      return { kind: "broken" };
    }
    throw error;
  }
};

const normalizeProviders = (providers: readonly AgentSkillProviderId[]): AgentSkillProviderId[] => {
  if (providers.length === 0) {
    fail('Providers must be a non-empty list of "agents" and/or "claude".');
  }
  const unique: AgentSkillProviderId[] = [];
  for (const provider of providers) {
    if (!(provider in agentSkillProviderDefinitions)) {
      fail(`Unknown provider "${provider}". Use "agents" and/or "claude".`);
    }
    if (!unique.includes(provider)) {
      unique.push(provider);
    }
  }
  return unique;
};

/** Package root for both `src/infrastructure/` and `dist/infrastructure/` layouts. */
export const resolvePackageRoot = (): string =>
  dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const linkAgentSkills = async (input: {
  readonly homeDirectory: string;
  readonly packageRoot: string;
  readonly providers: readonly AgentSkillProviderId[];
}): Promise<LinkAgentSkillsResult> => {
  const selectedProviders = normalizeProviders(input.providers);
  const sourceRoot = join(input.packageRoot, "agent-skills");
  const plannedLinks: PlannedAgentSkillLink[] = [];
  const createdLinks: string[] = [];
  let installedCount = 0;

  for (const providerId of selectedProviders) {
    const destinationRoot = join(
      input.homeDirectory,
      ...agentSkillProviderDefinitions[providerId].skillRoot.split("/"),
    );
    for (const skillName of agentSkillNames) {
      const source = await realpath(join(sourceRoot, skillName));
      const destination = join(destinationRoot, skillName);
      const existing = await existingTarget(destination);
      if (existing.kind === "not-link") {
        fail(
          `Refusing to replace an existing non-link path: ${destination}. Remove or rename it, then run "kilin skills link" again.`,
        );
      }
      if (existing.kind === "link" && existing.target !== source) {
        fail(
          `Refusing to replace a link to another target: ${destination}. Remove it, then run "kilin skills link" again.`,
        );
      }
      plannedLinks.push({ destinationRoot, destination, source, existing });
    }
  }

  try {
    for (const link of plannedLinks) {
      if (link.existing.kind === "link") {
        installedCount += 1;
        continue;
      }
      await mkdir(link.destinationRoot, { recursive: true });
      if (link.existing.kind === "broken") {
        await rm(link.destination);
      }
      await symlink(
        link.source,
        link.destination,
        process.platform === "win32" ? "junction" : "dir",
      );
      createdLinks.push(link.destination);
      installedCount += 1;
    }
  } catch (error: unknown) {
    await Promise.allSettled(createdLinks.map(async (linkPath) => rm(linkPath)));
    throw error;
  }

  return {
    providers: selectedProviders,
    installedCount,
    createdCount: createdLinks.length,
  };
};

export const inspectAgentSkillLinks = async (input: {
  readonly homeDirectory: string;
  readonly packageRoot: string;
}): Promise<AgentSkillLinksInspection> => {
  const sourceRoot = join(input.packageRoot, "agent-skills");
  const providers: AgentSkillProviderInspection[] = [];

  for (const providerId of agentSkillProviderIds) {
    const skillRoot = agentSkillProviderDefinitions[providerId].skillRoot;
    const destinationRoot = join(input.homeDirectory, ...skillRoot.split("/"));
    const skills: AgentSkillLinkInspection[] = [];
    for (const skillName of agentSkillNames) {
      const expectedTarget = await realpath(join(sourceRoot, skillName));
      const destination = join(destinationRoot, skillName);
      const existing = await existingTarget(destination);
      let status: AgentSkillLinkStatus = "missing";
      let target: string | undefined;
      if (existing.kind === "not-link") {
        status = "not-link";
      } else if (existing.kind === "broken") {
        status = "broken";
      } else if (existing.kind === "link") {
        target = existing.target;
        status = existing.target === expectedTarget ? "ok" : "wrong-target";
      }
      skills.push({
        skillName,
        path: destination,
        status,
        ...(target === undefined ? {} : { target }),
        expectedTarget,
      });
    }
    providers.push({
      provider: providerId,
      skillRoot,
      skills,
    });
  }

  return { providers };
};
