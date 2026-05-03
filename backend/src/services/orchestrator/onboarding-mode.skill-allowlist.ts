/**
 * Onboarding-Mode Skill Allowlist
 *
 * When the orchestrator is in `'onboarding'` mode, only the skills in
 * {@link ONBOARDING_SKILL_ALLOWLIST} are callable. The runtime gate that
 * enforces this lives in Leo's mcp-tool-definitions / skill-registry
 * filter; this file is the single source of truth for the allow set.
 *
 * Matching is **by skill name** (e.g. `"recall"`), not by file path. The
 * runtime walks the registry, takes each tool's logical name, and keeps
 * the entry only if the name appears here.
 *
 * Why an allowlist (not a denylist):
 *   - Onboarding is a tightly-scoped 5-min flow.
 *   - Spawning workers (delegate-task / start-agent / stop-agent) before
 *     the team is materialized would create orphan agents.
 *   - Future skills get added to Crewly without thinking about
 *     onboarding; default-deny keeps onboarding hermetic.
 *
 * @module services/orchestrator/onboarding-mode.skill-allowlist
 */

/**
 * The exhaustive list of skills callable while orc is in onboarding mode.
 *
 * Keep this list in sync with the SKILL ACCESS section of
 * {@link ./prompts/onboarding-mode.prompt.ts}; the prompt test asserts
 * each name appears in the prompt, so divergence is caught at test time.
 *
 * Imported by:
 *   - The orchestrator runtime / skill-registry filter (Leo).
 *   - The allowlist test in this directory.
 */
export const ONBOARDING_SKILL_ALLOWLIST: readonly string[] = Object.freeze([
  // Memory — orc must be able to recall + remember during the chat.
  'recall',
  'remember',
  'record-learning',

  // Onboarding-only skills — turn discovery answers into a real team.
  'recommend-team',
  'materialize-team',

  // Escalation — surface to TL on blocker.
  'report-status',
]);

/**
 * Type-narrowed alias of an allowlisted skill name. Useful for callers
 * that want compile-time guarantees (e.g. tests, registry filters).
 */
export type OnboardingAllowedSkill = (typeof ONBOARDING_SKILL_ALLOWLIST)[number];

/**
 * Predicate: is the named skill callable in onboarding mode?
 *
 * @param skillName - Skill logical name (e.g. `"delegate-task"`).
 * @returns `true` iff the skill is on the allowlist.
 *
 * @example
 * ```ts
 * if (isOnboardingSkillAllowed(tool.name)) registry.register(tool);
 * ```
 */
export function isOnboardingSkillAllowed(skillName: string): boolean {
  return ONBOARDING_SKILL_ALLOWLIST.includes(skillName);
}

/**
 * Filter helper: given a list of skill names, return only those allowed
 * in onboarding mode, preserving the input order.
 *
 * @param skillNames - Candidate skill names.
 * @returns Subset of skillNames that are on the allowlist.
 */
export function filterAllowedOnboardingSkills(
  skillNames: readonly string[],
): string[] {
  return skillNames.filter(isOnboardingSkillAllowed);
}
