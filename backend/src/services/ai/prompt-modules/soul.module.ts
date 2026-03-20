import * as fs from 'fs';
import * as path from 'path';
import { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Default minimal soul fallback when no soul file is found.
 */
const DEFAULT_SOUL = `## Your Soul

You are a professional, reliable team member. Communicate clearly, ask when uncertain, and report blockers promptly.`;

/**
 * Soul module — provides the agent's personality, tone, and working style.
 *
 * Loads the agent's "soul" from the resolution chain:
 * 1. Per-member soul (~/.crewly/teams/{teamId}/members/{memberId}/soul.md)
 * 2. Role default soul (config/roles/{role}/soul.md)
 * 3. Reusable archetype (config/souls/{archetype}.md)
 * 4. Hardcoded minimal fallback
 *
 * Sources: Path A Step 5, Path B Section 9, Soul System Design (Section 6).
 */
export class SoulModule implements PromptModule {
	name = 'soul';
	priority = 2;
	maxTokens = 830;
	compactable = false;

	/**
	 * Always included — every agent benefits from personality definition.
	 */
	shouldInclude(_config: ModuleConfig): boolean {
		return true;
	}

	/**
	 * Build the soul section by resolving the soul file from the resolution chain.
	 * If self-improvement data exists, appends a Self-Awareness section.
	 *
	 * @param config - Module configuration with role and project details
	 * @returns Formatted markdown soul section
	 */
	async build(config: ModuleConfig): Promise<string> {
		const soul = await this.resolveSoul(config);
		const selfAwareness = this.buildSelfAwareness(config.sessionName);
		return selfAwareness ? `${soul}\n\n${selfAwareness}` : soul;
	}

	/**
	 * Resolve the soul content by checking each level of the resolution chain.
	 *
	 * @param config - Module configuration
	 * @returns Soul content string
	 */
	private async resolveSoul(config: ModuleConfig): Promise<string> {
		// 1. Per-member soul
		if (config.teamId && config.memberId) {
			const memberSoulPath = this.getMemberSoulPath(config.teamId, config.memberId);
			const content = this.readFileIfExists(memberSoulPath);
			if (content) {
				return this.formatSoul(content, 'member');
			}
		}

		// 2. Role default soul (config/roles/{role}/soul.md)
		if (config.role) {
			const roleSoulPath = path.join(config.projectRoot, 'config', 'roles', config.role, 'soul.md');
			const content = this.readFileIfExists(roleSoulPath);
			if (content) {
				return this.formatSoul(content, 'role');
			}
		}

		// 3. Reusable archetype (config/souls/{role}.md as fallback archetype)
		if (config.role) {
			const archetypePath = path.join(config.projectRoot, 'config', 'souls', `${config.role}.md`);
			const content = this.readFileIfExists(archetypePath);
			if (content) {
				return this.formatSoul(content, 'archetype');
			}
		}

		// 4. Hardcoded minimal fallback
		return DEFAULT_SOUL;
	}

	/**
	 * Get the path to a member's personal soul file.
	 *
	 * @param teamId - Team ID
	 * @param memberId - Member ID
	 * @returns Absolute path to the member soul file
	 */
	private getMemberSoulPath(teamId: string, memberId: string): string {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		return path.join(homeDir, '.crewly', 'teams', teamId, 'members', memberId, 'soul.md');
	}

	/**
	 * Read a file if it exists, returning its content or null.
	 *
	 * @param filePath - Path to the file
	 * @returns File content string or null if not found
	 */
	private readFileIfExists(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, 'utf-8').trim();
		} catch {
			return null;
		}
	}

	/**
	 * Format the soul content with a source annotation.
	 *
	 * @param content - Raw soul file content
	 * @param source - Where the soul was resolved from
	 * @returns Formatted soul section
	 */
	private formatSoul(content: string, source: 'member' | 'role' | 'archetype'): string {
		const sourceLabel = source === 'member' ? 'personal' : source === 'role' ? 'role default' : 'archetype';
		return `## Your Soul\n_Source: ${sourceLabel}_\n\n${content}`;
	}

	/**
	 * Build the Self-Awareness section from self-improvement data.
	 * Reads growth areas, self-model (blind spots), and prediction calibration.
	 * Kept under ~200 tokens.
	 *
	 * @param sessionName - Agent session name
	 * @returns Self-awareness markdown section, or null if no data exists
	 */
	private buildSelfAwareness(sessionName: string): string | null {
		const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
		const agentDir = path.join(homeDir, '.crewly', 'agents', sessionName);

		const lines: string[] = [];

		// Growth areas — top 3
		try {
			const raw = fs.readFileSync(path.join(agentDir, 'growth-areas.json'), 'utf-8');
			const data = JSON.parse(raw);
			if (data.areas && data.areas.length > 0) {
				const top3 = data.areas.slice(0, 3);
				lines.push('**Growth Areas:**');
				for (const area of top3) {
					lines.push(`- ${area.area} (${area.progress})`);
				}
			}
		} catch { /* no growth areas data */ }

		// Blind spots — top 2
		try {
			const raw = fs.readFileSync(path.join(agentDir, 'self-model.json'), 'utf-8');
			const data = JSON.parse(raw);
			if (data.blindSpots && data.blindSpots.length > 0) {
				const top2 = data.blindSpots.slice(0, 2);
				lines.push('**Blind Spots:**');
				for (const spot of top2) {
					lines.push(`- ${spot.description}`);
				}
			}
		} catch { /* no self-model data */ }

		// Prediction calibration score
		try {
			const raw = fs.readFileSync(path.join(agentDir, 'predictions.json'), 'utf-8');
			const data = JSON.parse(raw);
			if (data.calibrationScore > 0) {
				lines.push(`**Prediction Calibration:** ${Math.round(data.calibrationScore * 100)}%`);
			}
		} catch { /* no predictions data */ }

		if (lines.length === 0) {
			return null;
		}

		return `## Self-Awareness\n${lines.join('\n')}`;
	}
}
