import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  AgentSkillProviderId,
  AgentSkillsLinkPreference,
  SetupPreferences,
} from "../application/agent-skills.js";

export const resolveDataDirectory = (): string =>
  process.env.KILIN_DATA_DIR ?? join(homedir(), ".kilin");

export const setupPreferencesPath = (dataDirectory: string = resolveDataDirectory()): string =>
  join(dataDirectory, "setup.json");

const isProviderId = (value: unknown): value is AgentSkillProviderId =>
  value === "agents" || value === "claude";

const parseAgentSkillsLink = (value: unknown, path: string): AgentSkillsLinkPreference => {
  if (value === null || typeof value !== "object") {
    throw new Error(
      `Invalid setup.json: "agentSkillsLink" must be an object. Fix or delete ${path}.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (typeof record.askedAt !== "string" || record.askedAt.trim().length === 0) {
    throw new Error(
      `Invalid setup.json: "agentSkillsLink.askedAt" must be a non-empty string. Fix or delete ${path}.`,
    );
  }
  if (!Array.isArray(record.providers) || !record.providers.every(isProviderId)) {
    throw new Error(
      `Invalid setup.json: "agentSkillsLink.providers" must be an array of "agents" and/or "claude". Fix or delete ${path}.`,
    );
  }
  const providers: AgentSkillProviderId[] = [];
  for (const provider of record.providers) {
    if (!providers.includes(provider)) {
      providers.push(provider);
    }
  }
  return {
    askedAt: record.askedAt,
    providers,
  };
};

export const readSetupPreferences = async (
  dataDirectory: string = resolveDataDirectory(),
): Promise<SetupPreferences | undefined> => {
  const path = setupPreferencesPath(dataDirectory);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid setup.json: file is not valid JSON. Fix or delete ${path}.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid setup.json: root value must be an object. Fix or delete ${path}.`);
  }

  const root = parsed as Record<string, unknown>;
  if (root.agentSkillsLink === undefined) {
    return {};
  }
  return {
    agentSkillsLink: parseAgentSkillsLink(root.agentSkillsLink, path),
  };
};

export const recordAgentSkillsLinkPreference = async (
  providers: readonly AgentSkillProviderId[],
  dataDirectory: string = resolveDataDirectory(),
): Promise<void> => {
  const path = setupPreferencesPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  const existing = (await readSetupPreferences(dataDirectory)) ?? {};
  const next: SetupPreferences = {
    ...existing,
    agentSkillsLink: {
      askedAt: new Date().toISOString(),
      providers: [...providers],
    },
  };
  await writeFile(path, `${JSON.stringify(next, undefined, 2)}\n`, "utf8");
};
