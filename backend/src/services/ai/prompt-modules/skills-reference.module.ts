import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Skills reference module — tells the agent how to discover and use skills.
 *
 * Consolidates skill authorization, communication skill references,
 * and catalog location into a single module.
 *
 * Sources: Path A Step 1+6, Path B Section 8, Path C skill instructions.
 */
export class SkillsReferenceModule implements PromptModule {
	name = 'skills_references';
	priority = 5;
	maxTokens = 500;
	compactable = true;

	/**
	 * Always included — agents need to know how to use skills.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the skills reference section with catalog location,
	 * commonly-used skills, and memory tool instructions.
	 *
	 * @param config - Module configuration with skill paths
	 * @returns Formatted markdown skills reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		return `## Available Skills

Bash skills at \`${config.agentSkillsPath}/\`:
- \`core/recall\` — retrieve relevant knowledge from memory
- \`core/remember\` — store knowledge for future reference
- \`core/record-learning\` — record learnings while working
- \`core/report-status\` — report status to orchestrator
- \`core/send-message\` — communicate with other agents
- \`core/get-sops\` — request relevant SOPs for current situation

Skills catalog: \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\`

## Authorized Operations

The following operations are pre-approved for this session:
- Execute bash scripts in \`${config.agentSkillsPath}/\` and \`${config.tlSkillsPath}/\`
- Read and write files within the project directory
- Use browser automation skills when available (e.g., remote-browser)

## Communication

Use bash skills at \`${config.agentSkillsPath}/\` for all team communication. Read \`~/.crewly/skills/AGENT_SKILLS_CATALOG.md\` for a full reference.
- \`send-message\` to communicate with other agents
- \`report-progress\` to update on task status
- \`remember\` to store important learnings (always pass your \`agentId\` and \`projectPath\`)
- \`recall\` to retrieve relevant knowledge (always pass your \`agentId\` and \`projectPath\`)
- \`record-learning\` to record learnings (always pass your \`agentId\` and \`projectPath\`)
- \`get-sops\` to request relevant SOPs for your current situation

**IMPORTANT for memory tools:** When calling \`remember\`, \`recall\`, or \`record-learning\`, you MUST pass:
- \`agentId\`: Your **Session Name** from the Identity section above
- \`projectPath\`: Your **Project Path** from the Identity section above
This ensures your knowledge is stored under your identity and in the correct project.

**IMPORTANT for recall:** Before answering questions about the project, deployment, architecture, or past decisions, ALWAYS call \`recall\` first to check your stored knowledge.`;
	}
}
