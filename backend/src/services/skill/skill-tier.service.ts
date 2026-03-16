/**
 * Skill Tier Service
 *
 * Handles paid skill tier checking and graceful degradation.
 * Resolves which skills an agent can access based on their cloud tier,
 * substituting premium skills with free fallbacks when the user's tier
 * is insufficient.
 *
 * Tier hierarchy: free < pro < enterprise
 *
 * @module services/skill/skill-tier.service
 */

import { CloudTier, CLOUD_CONSTANTS } from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';

/**
 * Numeric weight for each tier, used for comparison.
 * Higher number = higher tier.
 */
const TIER_HIERARCHY: Record<string, number> = {
	[CLOUD_CONSTANTS.TIERS.FREE]: 0,
	[CLOUD_CONSTANTS.TIERS.PRO]: 1,
	[CLOUD_CONSTANTS.TIERS.ENTERPRISE]: 2,
};

/**
 * Metadata about a skill's tier requirements and fallback.
 * Mirrors the optional fields added to skill.json.
 */
export interface SkillTierInfo {
	/** Skill identifier */
	id: string;

	/** Minimum tier required to use this skill. Defaults to 'free' if omitted. */
	requiredTier?: CloudTier;

	/** Skill ID to use as a free-tier fallback when tier is insufficient */
	fallbackSkill?: string;
}

/**
 * A skill that was successfully resolved (either direct access or via fallback).
 */
export interface ResolvedSkill {
	/** The skill ID that should actually be used */
	id: string;

	/** How this skill was resolved */
	source: 'direct' | 'degraded';
}

/**
 * A skill that could not be used at the user's current tier.
 */
export interface DegradedSkill {
	/** The original premium skill ID */
	original: string;

	/** The fallback skill ID, or null if no fallback exists */
	fallback: string | null;

	/** The tier required for the original skill */
	requiredTier: CloudTier;
}

/**
 * Result of resolving a set of skills against a user's tier.
 */
export interface ResolvedSkillSet {
	/** Skills the agent can use (direct + degraded-with-fallback) */
	skills: ResolvedSkill[];

	/** Skills that were downgraded or removed due to insufficient tier */
	degraded: DegradedSkill[];
}

/**
 * Service for checking skill tier requirements and performing graceful degradation.
 *
 * When an agent's assigned skills include premium skills that exceed the user's
 * cloud tier, this service substitutes them with free-tier fallbacks (if available)
 * or removes them entirely, producing a degradation notice for the agent prompt.
 */
export class SkillTierService {
	private static instance: SkillTierService | null = null;
	private readonly logger: ComponentLogger;

	private constructor() {
		this.logger = LoggerService.getInstance().createComponentLogger('SkillTierService');
	}

	/**
	 * Get the singleton instance of SkillTierService.
	 *
	 * @returns The SkillTierService singleton
	 */
	static getInstance(): SkillTierService {
		if (!SkillTierService.instance) {
			SkillTierService.instance = new SkillTierService();
		}
		return SkillTierService.instance;
	}

	/**
	 * Reset the singleton instance (for testing).
	 */
	static resetInstance(): void {
		SkillTierService.instance = null;
	}

	/**
	 * Check whether a user's tier is sufficient for a required tier.
	 *
	 * @param userTier - The user's current cloud tier
	 * @param requiredTier - The minimum tier required
	 * @returns true if userTier >= requiredTier in the hierarchy
	 */
	isTierSufficient(userTier: CloudTier, requiredTier: CloudTier): boolean {
		const userLevel = TIER_HIERARCHY[userTier] ?? 0;
		const requiredLevel = TIER_HIERARCHY[requiredTier] ?? 0;
		return userLevel >= requiredLevel;
	}

	/**
	 * Resolve a set of assigned skills against the user's tier.
	 *
	 * For each skill:
	 * - If no requiredTier or requiredTier <= userTier → included as 'direct'
	 * - If requiredTier > userTier and fallbackSkill exists → replaced with fallback as 'degraded'
	 * - If requiredTier > userTier and no fallback → excluded and listed in degraded
	 *
	 * @param assignedSkills - Array of skill tier info objects
	 * @param userTier - The user's current cloud tier
	 * @returns Resolved skill set with accessible skills and degradation info
	 */
	resolveSkills(assignedSkills: SkillTierInfo[], userTier: CloudTier): ResolvedSkillSet {
		const skills: ResolvedSkill[] = [];
		const degraded: DegradedSkill[] = [];

		for (const skill of assignedSkills) {
			const requiredTier = skill.requiredTier || CLOUD_CONSTANTS.TIERS.FREE;

			if (this.isTierSufficient(userTier, requiredTier as CloudTier)) {
				skills.push({ id: skill.id, source: 'direct' });
			} else {
				const degradedEntry: DegradedSkill = {
					original: skill.id,
					fallback: skill.fallbackSkill || null,
					requiredTier: requiredTier as CloudTier,
				};
				degraded.push(degradedEntry);

				if (skill.fallbackSkill) {
					skills.push({ id: skill.fallbackSkill, source: 'degraded' });
				}
			}
		}

		if (degraded.length > 0) {
			this.logger.info('Skills degraded due to insufficient tier', {
				userTier,
				degradedCount: degraded.length,
				degraded: degraded.map(d => ({
					original: d.original,
					fallback: d.fallback,
					requiredTier: d.requiredTier,
				})),
			});
		}

		return { skills, degraded };
	}

	/**
	 * Build a human-readable degradation notice for injection into agent prompts.
	 *
	 * @param degraded - Array of degraded skills from resolveSkills()
	 * @param userTier - The user's current tier (for display)
	 * @returns Markdown-formatted notice string, or empty string if no degradations
	 */
	buildDegradationNotice(degraded: DegradedSkill[], userTier: CloudTier): string {
		if (degraded.length === 0) {
			return '';
		}

		const lines: string[] = [
			'## Premium Skills Notice',
			'',
			`Your team template includes the following premium skills but current account is **${userTier}** tier:`,
			'',
		];

		for (const d of degraded) {
			if (d.fallback) {
				lines.push(`- **${d.original}** → downgraded to \`${d.fallback}\` (requires ${d.requiredTier})`);
			} else {
				lines.push(`- **${d.original}** → not available (requires ${d.requiredTier})`);
			}
		}

		lines.push('');
		lines.push('Upgrade at https://crewlyai.com/pricing');

		return lines.join('\n');
	}
}

/**
 * Get the singleton SkillTierService instance.
 *
 * @returns The SkillTierService singleton
 */
export function getSkillTierService(): SkillTierService {
	return SkillTierService.getInstance();
}

/**
 * Reset the SkillTierService singleton (for testing).
 */
export function resetSkillTierService(): void {
	SkillTierService.resetInstance();
}
