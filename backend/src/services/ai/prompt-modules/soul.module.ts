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
 * Resolution chain (P0-1 Phase 2):
 *   0. **TL overlay** — when `canDelegate=true`, layer the team-leader
 *      archetype (`config/souls/team-leader.md`) as the primary soul and
 *      append the agent's original-role soul as a Capability Specialty.
 *      A per-member soul still wins over the overlay (explicit > default).
 *   1. Per-member soul (~/.crewly/teams/{teamId}/members/{memberId}/soul.md)
 *   2. Role default soul (config/roles/{role}/soul.md)
 *   3. Reusable archetype (config/souls/{role}.md)
 *   4. Hardcoded minimal fallback
 *
 * Sources: Path A Step 5, Path B Section 9, Soul System Design (Section 6),
 * P0-1 Team-Leader Soul spec.
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
		// 1. Per-member soul (highest precedence — explicit override always wins,
		//    even over the TL overlay below — same precedence rule as CSS specificity)
		if (config.teamId && config.memberId) {
			const memberSoulPath = this.getMemberSoulPath(config.teamId, config.memberId);
			const content = this.readFileIfExists(memberSoulPath);
			if (content) {
				return this.formatSoul(content, 'member');
			}
		}

		// 2. TL overlay (P0-1 Phase 2): when canDelegate=true, the team-leader
		//    archetype becomes the primary soul, with the original role's soul
		//    appended as a Capability Specialty. Falls through silently to the
		//    legacy cascade if `config/souls/team-leader.md` is missing — this
		//    is intentional so deployments without the markdown asset don't
		//    regress (the team-leader.md file ships in P0-1 Phase 1, PR #414).
		if (config.canDelegate === true) {
			const tlPath = path.join(config.projectRoot, 'config', 'souls', 'team-leader.md');
			const tlContent = this.readFileIfExists(tlPath);
			if (tlContent) {
				const specialty = this.resolveSpecialtySoul(config);
				return this.formatTLOverlay(tlContent, specialty, config.role);
			}
		}

		// 3. Role default soul (config/roles/{role}/soul.md)
		if (config.role) {
			const roleSoulPath = path.join(config.projectRoot, 'config', 'roles', config.role, 'soul.md');
			const content = this.readFileIfExists(roleSoulPath);
			if (content) {
				return this.formatSoul(content, 'role');
			}
		}

		// 4. Reusable archetype (config/souls/{role}.md as fallback archetype)
		if (config.role) {
			const archetypePath = path.join(config.projectRoot, 'config', 'souls', `${config.role}.md`);
			const content = this.readFileIfExists(archetypePath);
			if (content) {
				return this.formatSoul(content, 'archetype');
			}
		}

		// 5. Hardcoded minimal fallback
		return DEFAULT_SOUL;
	}

	/**
	 * Resolve the agent's specialty soul for the TL overlay layer.
	 *
	 * Reuses steps 3 & 4 of the legacy cascade (role default → archetype) but
	 * deliberately skips the per-member soul (already checked in step 1 above)
	 * and the team-leader archetype (which would cause infinite recursion when
	 * `role === 'team-leader'`).
	 *
	 * @param config - Module configuration
	 * @returns Specialty soul content, or null when no role-specific soul exists
	 *          OR when the role IS team-leader (no specialty to layer).
	 */
	private resolveSpecialtySoul(config: ModuleConfig): string | null {
		if (!config.role || config.role === 'team-leader') return null;
		const roleSoul = this.readFileIfExists(
			path.join(config.projectRoot, 'config', 'roles', config.role, 'soul.md'),
		);
		if (roleSoul) return roleSoul;
		return this.readFileIfExists(
			path.join(config.projectRoot, 'config', 'souls', `${config.role}.md`),
		);
	}

	/**
	 * Format the TL overlay layout: team-leader archetype as the primary soul,
	 * with the original-role specialty appended as Capability Specialty.
	 *
	 * The Capability Specialty section is what the agent draws on when applying
	 * the Self-Implementation Exception Rule from `team-leader.md` (TL leans on
	 * IC instincts when self-implementing under specific conditions).
	 *
	 * @param tlContent - Raw team-leader.md content
	 * @param specialty - Specialty soul content (null when no role specialty exists)
	 * @param role - The agent's original role (used in the specialty header)
	 * @returns Formatted TL overlay markdown
	 */
	private formatTLOverlay(tlContent: string, specialty: string | null, role: string | undefined): string {
		const primary = `## Your Soul\n_Source: team-leader overlay (canDelegate=true)_\n\n${tlContent}`;
		if (!specialty) return primary;
		const roleLabel = role ?? 'IC';
		return (
			`${primary}\n\n` +
			`## Capability Specialty\n` +
			`_IC background as ${roleLabel} — apply when self-implementing per the Self-Implementation Exception Rule._\n\n` +
			specialty
		);
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
