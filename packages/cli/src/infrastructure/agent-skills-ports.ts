import type { AgentSkillsPorts } from "../application/agent-skills.js";

import { inspectAgentSkillLinks, linkAgentSkills } from "./agent-skills-link.js";
import { readSetupPreferences, recordAgentSkillsLinkPreference } from "./setup-preferences.js";

export const nodeAgentSkillsPorts: AgentSkillsPorts = {
  inspectLinks: inspectAgentSkillLinks,
  linkSkills: linkAgentSkills,
  readPreferences: readSetupPreferences,
  recordLinkPreference: recordAgentSkillsLinkPreference,
};
