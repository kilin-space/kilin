import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";

export const supportedScopes = new Set(["repository", "workspace", "all-projects"]);
export const supportedProviders = new Set(["claude", "codex"]);
export const consentValue = "acknowledged-after-sanitized-history-egress-disclosure";

export const canonicalProject = async (projectPath) => {
  if (typeof projectPath !== "string" || !isAbsolute(projectPath)) {
    return undefined;
  }
  try {
    return await realpath(projectPath);
  } catch {
    return undefined;
  }
};

export const parseProviders = (value) => {
  const providers = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (providers.length === 0 || providers.some((provider) => !supportedProviders.has(provider))) {
    throw new Error("Choose codex, claude, or both for --providers.");
  }
  return providers;
};

export const parseScope = async (kind, configuredRoot) => {
  if (!supportedScopes.has(kind)) {
    throw new Error("--scope must be repository, workspace, or all-projects.");
  }
  if (kind === "all-projects") {
    if (configuredRoot !== undefined) {
      throw new Error("Do not provide --scope-root with --scope all-projects.");
    }
    return { kind };
  }
  if (configuredRoot === undefined) {
    throw new Error(`--scope-root is required with --scope ${kind}.`);
  }
  return { kind, root: await realpath(configuredRoot) };
};

export const isWithinScope = (projectPath, scope) => {
  if (!isAbsolute(projectPath)) {
    return false;
  }
  if (scope.kind === "all-projects") {
    return true;
  }
  if (scope.kind === "repository") {
    return projectPath === scope.root;
  }
  const pathFromRoot = relative(scope.root, projectPath);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
};

export const requireExpandedScopeConsent = (consent, activeProvider, providers, scopeKind) => {
  const expandedProviders = providers.length !== 1 || providers[0] !== activeProvider;
  const expandedProjects = scopeKind !== "repository";
  if ((expandedProviders || expandedProjects) && consent !== consentValue) {
    throw new Error(
      "Expanded scope requires explicit consent after sanitized-history egress disclosure.",
    );
  }
};

export const defaultProviderRoots = () => ({
  codex: join(homedir(), ".codex", "sessions"),
  claude: join(homedir(), ".claude", "projects"),
});
