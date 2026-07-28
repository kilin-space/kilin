import { isCancel, multiselect } from "@clack/prompts";

import type { AgentSkillProviderId } from "../application/agent-skills.js";

export type ProviderSkillsPromptResult =
  | { readonly kind: "cancel" }
  | { readonly kind: "selected"; readonly providers: readonly AgentSkillProviderId[] };

export type ProviderSkillsPrompt = () => Promise<ProviderSkillsPromptResult>;

export const promptProviderSkillsLink: ProviderSkillsPrompt = async () => {
  const selected = await multiselect({
    message: "Link Kilin agent skills to which providers?",
    options: [
      { value: "agents" as const, label: "Codex / Agents", hint: "~/.agents/skills" },
      { value: "claude" as const, label: "Claude Code", hint: "~/.claude/skills" },
    ],
    initialValues: ["agents", "claude"],
    required: false,
  });

  if (isCancel(selected)) {
    return { kind: "cancel" };
  }

  const providers = selected.filter(
    (value): value is AgentSkillProviderId => value === "agents" || value === "claude",
  );
  return {
    kind: "selected",
    providers,
  };
};
