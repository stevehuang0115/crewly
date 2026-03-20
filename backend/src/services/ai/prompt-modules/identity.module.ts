import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Identity module — provides the agent's core identification.
 *
 * Assembles session name, member ID, role, team, and project path
 * into a structured identity section. This is the highest-priority
 * module and is never truncated.
 *
 * Sources: Path A Step 2+10, Path B Section 6, Path C header.
 */
export class IdentityModule implements PromptModule {
	name = 'identity';
	priority = 1;
	maxTokens = 150;
	compactable = false;

	/**
	 * Always included — every agent needs an identity.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the identity section with all available fields.
	 *
	 * @param config - Module configuration with agent details
	 * @returns Formatted markdown identity section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const lines: string[] = ['## Your Identity'];

		if (config.sessionName) {
			lines.push(`- **Session Name:** ${config.sessionName}`);
		}
		if (config.memberId) {
			lines.push(`- **Member ID:** ${config.memberId}`);
		}
		if (config.role) {
			lines.push(`- **Role:** ${config.role}`);
		}
		if (config.teamId) {
			lines.push(`- **Team:** ${config.teamId}`);
		}
		if (config.projectPath) {
			lines.push(`- **Project Path:** ${config.projectPath}`);
		}

		return lines.join('\n');
	}
}
