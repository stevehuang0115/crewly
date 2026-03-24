import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Skills reference module — tells the agent how to discover and use skills.
 *
 * Consolidates skill references, role-based capability descriptions,
 * and catalog location into a single module. Capabilities are scoped
 * per-role to avoid blanket authorization (#225).
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
	 * role-scoped capabilities, and memory tool instructions.
	 *
	 * @param config - Module configuration with skill paths and role
	 * @returns Formatted markdown skills reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const coreSkills = this.buildCoreSkills(config);
		const capabilities = this.buildCapabilities(config);
		const communication = this.buildCommunication(config);

		return `${coreSkills}\n\n${capabilities}\n\n${communication}`;
	}

	/**
	 * Build the core skills list — available to all roles.
	 */
	private buildCoreSkills(config: ModuleConfig): string {
		const lines = [
			'## Available Skills',
			'',
			`Bash skills at \`${config.agentSkillsPath}/\`:`,
			'- `core/recall` — retrieve relevant knowledge from memory',
			'- `core/remember` — store knowledge for future reference',
			'- `core/record-learning` — record learnings while working',
			'- `core/report-status` — report status to team leader or orchestrator',
		];

		// Orchestrators and TLs get additional coordination skills
		if (config.role === 'orchestrator') {
			lines.push(
				'- `core/send-message` — send messages to agents',
				'- `core/get-sops` — request relevant SOPs',
				'- Orchestrator skills at `config/skills/orchestrator/`:',
				'  - `schedule-check` — schedule future check-in reminders',
				'  - `subscribe-event` — subscribe to agent lifecycle events',
				'  - `reply-slack` / `reply-chat` — respond to user messages',
				'  - `send-to-remote` / `reply-remote` — send/reply to other Crewly machines',
				'  - `list-devices` — discover connected Crewly devices',
				'  - `delegate-task` — assign work to agents',
				'  - `get-team-status` / `get-agent-status` — monitor team state',
			);
		} else if (config.canDelegate) {
			lines.push(
				'- `core/send-message` — communicate with subordinates and orchestrator',
				'- `core/get-sops` — request relevant SOPs',
				`- Team leader skills at \`${config.tlSkillsPath}/\`:`,
				'  - `delegate-task` — assign tasks to subordinates',
				'  - `verify-output` — check completed work quality',
				'  - `schedule-check` — schedule follow-up reminders',
			);
		} else {
			lines.push(
				'- `core/send-message` — communicate with team leader',
				'- `core/get-sops` — request relevant SOPs for current situation',
			);
		}

		lines.push('', 'Skills catalog: `~/.crewly/skills/AGENT_SKILLS_CATALOG.md`');

		return lines.join('\n');
	}

	/**
	 * Build role-scoped capabilities section (#225).
	 * Workers get narrow read+execute scope; orchestrators get broader coordination scope.
	 */
	private buildCapabilities(config: ModuleConfig): string {
		const lines = ['## Available Capabilities', ''];

		if (config.role === 'orchestrator') {
			lines.push(
				'This session has access to:',
				'- **Read** project files for status awareness (not for implementation)',
				'- **Execute** orchestrator skill scripts for team coordination',
				'- **Execute** agent skill scripts (`core/` memory and status tools)',
				'- **Browser automation** via Playwright MCP server (when enabled)',
				'',
				'Implementation work (editing code, creating files) should be delegated to agents.',
			);
		} else if (config.canDelegate) {
			lines.push(
				'This session has access to:',
				`- **Read/Write** files within the project directory`,
				`- **Execute** bash scripts in \`${config.agentSkillsPath}/\` (agent core skills)`,
				`- **Execute** bash scripts in \`${config.tlSkillsPath}/\` (team leader skills)`,
				'- **Browser automation** via Playwright MCP server (when enabled)',
			);
		} else {
			lines.push(
				'This session has access to:',
				`- **Read/Write** files within the project directory`,
				`- **Execute** bash scripts in \`${config.agentSkillsPath}/\` (agent core skills)`,
				'- **Browser automation** via Playwright MCP server (when enabled)',
			);
		}

		return lines.join('\n');
	}

	/**
	 * Build communication and memory tool instructions.
	 */
	private buildCommunication(config: ModuleConfig): string {
		return `## Communication

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
