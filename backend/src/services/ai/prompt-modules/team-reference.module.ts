import { readFile, access } from 'fs/promises';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Team reference module — provides team hierarchy, TL duties, and norms references.
 *
 * Wraps the existing `buildTeamLeadSection` and `buildTeamNormsSection` logic
 * from PromptBuilderService. The TL addon is conditionally loaded only when
 * the agent has `canDelegate=true` and subordinates.
 *
 * Sources: Path A Step 7, Path B Sections 4+5.
 */
export class TeamReferenceModule implements PromptModule {
	name = 'team_references';
	priority = 6;
	maxTokens = 8000;
	compactable = false; // TL core is not compactable

	/**
	 * Include when agent has a team (teamId set) or has subordinates.
	 */
	shouldInclude(config: ModuleConfig): boolean {
		return !!(config.teamId || (config.canDelegate && config.subordinates && config.subordinates.length > 0));
	}

	/**
	 * Build team reference section. Includes TL addon if agent can delegate,
	 * and team norms if available.
	 *
	 * @param config - Module configuration with team and subordinate details
	 * @returns Formatted markdown team reference section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const sections: string[] = [];

		// Build TL section if agent can delegate
		if (config.canDelegate && config.subordinates && config.subordinates.length > 0) {
			const tlSection = await this.buildTeamLeadSection(config);
			if (tlSection) {
				sections.push(tlSection);
			}
		}

		// Build team norms section if team exists
		if (config.teamId) {
			const normsSection = await this.buildTeamNormsSection(config.teamId, config.role);
			if (normsSection) {
				sections.push(normsSection);
			}
		}

		return sections.join('\n\n---\n\n');
	}

	/**
	 * Build Team Lead section by loading tl-addon.md and resolving variables.
	 * Falls back to inline section if addon file not found.
	 *
	 * @param config - Module configuration with subordinate details
	 * @returns Formatted TL section or empty string
	 */
	private async buildTeamLeadSection(config: ModuleConfig): Promise<string> {
		if (!config.subordinates || config.subordinates.length === 0) {
			return '';
		}

		const workerList = config.subordinates
			.map((sub) => `- **${sub.name}** (session: \`${sub.sessionName}\`, memberId: \`${sub.memberId}\`) — ${sub.role}`)
			.join('\n');

		// Try loading the comprehensive TL addon from file
		const addonPath = path.join(config.projectRoot, 'config', 'roles', 'team-leader', 'tl-addon.md');
		try {
			await access(addonPath);
			let addonContent = await readFile(addonPath, 'utf8');

			// Resolve template variables
			const variables: Record<string, string> = {
				WORKER_LIST: workerList,
				TL_SKILLS_PATH: config.tlSkillsPath,
				TEAM_ID: config.teamId || '',
				MEMBER_ID: config.memberId || '',
				PROJECT_PATH: config.projectPath || '',
				AGENT_SKILLS_PATH: config.agentSkillsPath,
			};

			for (const [key, value] of Object.entries(variables)) {
				addonContent = addonContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
			}

			return addonContent.trim();
		} catch {
			// Fallback to minimal inline section
			return this.buildInlineTeamLeadSection(workerList, config.subordinates.length);
		}
	}

	/**
	 * Build minimal inline TL section as fallback when tl-addon.md is not found.
	 *
	 * @param workerList - Pre-formatted worker list
	 * @param subordinateCount - Number of subordinates
	 * @returns Formatted inline TL section
	 */
	private buildInlineTeamLeadSection(workerList: string, subordinateCount: number): string {
		return `## Team Lead Responsibilities

You manage ${subordinateCount} subordinate(s):

${workerList}

### Your TL Duties

1. **Task Decomposition** — Break down large tasks into actionable sub-tasks
2. **Delegation** — Assign sub-tasks to subordinates using \`send-message\`
3. **Quality Review** — Review subordinates' work before reporting completion
4. **Progress Reporting** — Report progress to the orchestrator via \`report-status\`
5. **Unblocking** — Help subordinates when they are stuck`;
	}

	/**
	 * Build team norms section by loading norms files from team directory.
	 * Only includes norms whose role list matches the agent's role or '*'.
	 *
	 * @param teamId - Team ID to load norms for
	 * @param role - Agent's role for filtering
	 * @returns Formatted norms markdown or empty string
	 */
	private async buildTeamNormsSection(teamId: string, role: string): Promise<string> {
		if (!teamId) return '';

		try {
			const { existsSync, readdirSync, readFileSync } = await import('fs');

			const crewlyHome = path.join(process.env['HOME'] || '/tmp', '.crewly');
			const normsDir = path.join(crewlyHome, 'teams', teamId, 'norms');

			if (!existsSync(normsDir)) return '';

			const normFiles = readdirSync(normsDir).filter((f: string) => f.endsWith('.md'));
			if (normFiles.length === 0) return '';

			const normalizedRole = role.toLowerCase().replace(/\s+/g, '-');
			const sections: string[] = ['## Team Norms'];

			for (const file of normFiles) {
				const content = readFileSync(path.join(normsDir, file), 'utf8');
				// Check if norm applies to this role (roles: line at top)
				const rolesMatch = content.match(/^roles:\s*(.+)$/m);
				if (rolesMatch) {
					const roles = rolesMatch[1].split(',').map((r: string) => r.trim().toLowerCase());
					if (!roles.includes('*') && !roles.includes(normalizedRole)) {
						continue;
					}
				}
				sections.push(content.trim());
			}

			return sections.length > 1 ? sections.join('\n\n') : '';
		} catch {
			return '';
		}
	}
}
