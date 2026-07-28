import { KilinError } from "../domain/errors.js";

export type AgentSkillProviderId = "agents" | "claude";

export interface AgentSkillsLinkPreference {
  readonly askedAt: string;
  readonly providers: readonly AgentSkillProviderId[];
}

export interface SetupPreferences {
  readonly agentSkillsLink?: AgentSkillsLinkPreference;
}

export interface LinkAgentSkillsResult {
  readonly providers: readonly AgentSkillProviderId[];
  readonly installedCount: number;
  readonly createdCount: number;
}

export type AgentSkillLinkStatus = "missing" | "ok" | "wrong-target" | "broken" | "not-link";

export interface AgentSkillLinkInspection {
  readonly skillName: string;
  readonly path: string;
  readonly status: AgentSkillLinkStatus;
  readonly target?: string;
  readonly expectedTarget: string;
}

export interface AgentSkillProviderInspection {
  readonly provider: AgentSkillProviderId;
  readonly skillRoot: string;
  readonly skills: readonly AgentSkillLinkInspection[];
}

export interface AgentSkillLinksInspection {
  readonly providers: readonly AgentSkillProviderInspection[];
}

export interface AgentSkillsPorts {
  linkSkills(input: {
    readonly homeDirectory: string;
    readonly packageRoot: string;
    readonly providers: readonly AgentSkillProviderId[];
  }): Promise<LinkAgentSkillsResult>;
  inspectLinks(input: {
    readonly homeDirectory: string;
    readonly packageRoot: string;
  }): Promise<AgentSkillLinksInspection>;
  readPreferences(dataDirectory: string): Promise<SetupPreferences | undefined>;
  recordLinkPreference(
    providers: readonly AgentSkillProviderId[],
    dataDirectory: string,
  ): Promise<void>;
}

export interface AgentSkillsStatus {
  readonly preference: AgentSkillsLinkPreference | null;
  readonly providers: readonly AgentSkillProviderInspection[];
}

const normalizeProviders = (providers: readonly AgentSkillProviderId[]): AgentSkillProviderId[] => {
  const unique: AgentSkillProviderId[] = [];
  for (const provider of providers) {
    if (!unique.includes(provider)) {
      unique.push(provider);
    }
  }
  return unique;
};

export const parseAgentSkillProviderList = (value: string): AgentSkillProviderId[] => {
  const providers = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (providers.length === 0) {
    throw new Error('Flag "--providers" requires a comma-separated list such as "agents,claude".');
  }
  for (const provider of providers) {
    if (provider !== "agents" && provider !== "claude") {
      throw new Error(`Unknown provider "${provider}". Use "agents" and/or "claude".`);
    }
  }
  return normalizeProviders(providers as AgentSkillProviderId[]);
};

const linkingFailure = (error: unknown): KilinError =>
  error instanceof KilinError
    ? error
    : new KilinError(
        "INTERNAL_ERROR",
        `Agent skill linking failed. ${error instanceof Error ? error.message : "Check the skill paths and filesystem permissions, then try again."}`,
      );

export const applyAgentSkillsLinkSelection = async (
  input: {
    readonly providers: readonly AgentSkillProviderId[];
    readonly homeDirectory: string;
    readonly dataDirectory: string;
    readonly packageRoot: string;
  },
  ports: AgentSkillsPorts,
): Promise<{ readonly installedCount: number; readonly createdCount: number }> => {
  try {
    if (input.providers.length === 0) {
      await ports.recordLinkPreference([], input.dataDirectory);
      return { installedCount: 0, createdCount: 0 };
    }

    const result = await ports.linkSkills({
      homeDirectory: input.homeDirectory,
      packageRoot: input.packageRoot,
      providers: input.providers,
    });
    await ports.recordLinkPreference(input.providers, input.dataDirectory);
    return {
      installedCount: result.installedCount,
      createdCount: result.createdCount,
    };
  } catch (error: unknown) {
    throw linkingFailure(error);
  }
};

export const getAgentSkillsStatus = async (
  input: {
    readonly homeDirectory: string;
    readonly dataDirectory: string;
    readonly packageRoot: string;
  },
  ports: AgentSkillsPorts,
): Promise<AgentSkillsStatus> => {
  const [inspection, preferences] = await Promise.all([
    ports.inspectLinks({
      homeDirectory: input.homeDirectory,
      packageRoot: input.packageRoot,
    }),
    ports.readPreferences(input.dataDirectory),
  ]);
  return {
    preference: preferences?.agentSkillsLink ?? null,
    providers: inspection.providers,
  };
};

export const getAgentSkillsLinkPreference = async (
  dataDirectory: string,
  ports: AgentSkillsPorts,
): Promise<AgentSkillsLinkPreference | undefined> =>
  (await ports.readPreferences(dataDirectory))?.agentSkillsLink;
