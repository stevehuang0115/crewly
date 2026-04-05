/**
 * Default Policy Templates
 *
 * Pre-configured MissionPolicy templates for common use cases.
 * These are re-exported from the types layer for convenience,
 * with additional factory helpers for creating policies from templates.
 *
 * @module services/policy/default-policies
 */

import type { MissionPolicy, UpdatePolicyInput } from '../../types/v2/index.js';
import {
  CONSERVATIVE_POLICY,
  MODERATE_POLICY,
  AUTONOMOUS_POLICY,
  createMissionPolicy,
} from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Template Names
// ---------------------------------------------------------------------------

/** Available policy template names. */
export type PolicyTemplateName = 'conservative' | 'moderate' | 'autonomous';

/** All valid template names. */
export const POLICY_TEMPLATE_NAMES: readonly PolicyTemplateName[] = [
  'conservative',
  'moderate',
  'autonomous',
] as const;

/**
 * Checks whether a string is a valid policy template name.
 *
 * @param value - The string to check
 * @returns True if value is a valid PolicyTemplateName
 */
export function isValidPolicyTemplateName(value: string): value is PolicyTemplateName {
  return (POLICY_TEMPLATE_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Template Descriptions (for UI/API)
// ---------------------------------------------------------------------------

/**
 * Human-readable descriptions of each policy template.
 */
export const POLICY_TEMPLATE_DESCRIPTIONS: Record<PolicyTemplateName, string> = {
  conservative: 'All capabilities disabled. Every action requires human approval. Best for new or high-risk missions.',
  moderate: 'Can create, reprioritize, and close tasks. No deploy or spending. Good for established teams with clear scope.',
  autonomous: 'Most capabilities enabled except production deploy and UI changes without review. For trusted teams with guardrails.',
};

// ---------------------------------------------------------------------------
// Factory Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a policy from a template name, optionally applying overrides.
 *
 * @param missionId - The mission this policy belongs to
 * @param template - Template name
 * @param overrides - Optional field overrides
 * @returns A fully populated MissionPolicy
 *
 * @example
 * ```typescript
 * const policy = createPolicyFromTemplate('mission-1', 'moderate', {
 *   canDeployToStaging: true,
 *   maxParallelExecutions: 5,
 * });
 * ```
 */
export function createPolicyFromTemplate(
  missionId: string,
  template: PolicyTemplateName,
  overrides?: UpdatePolicyInput,
): MissionPolicy {
  const base = createMissionPolicy(missionId, template);

  if (!overrides) return base;

  return {
    ...base,
    ...overrides,
    missionId, // Ensure missionId is never overridden
    escalationRules: overrides.escalationRules ?? base.escalationRules,
  };
}

/**
 * Applies partial updates to an existing policy.
 * Preserves missionId and any fields not in the update.
 *
 * @param existing - The current policy
 * @param updates - Fields to update
 * @returns Updated policy (new object, doesn't mutate)
 */
export function applyPolicyUpdate(
  existing: MissionPolicy,
  updates: UpdatePolicyInput,
): MissionPolicy {
  return {
    ...existing,
    ...updates,
    missionId: existing.missionId, // Never overwrite missionId
    escalationRules: updates.escalationRules ?? existing.escalationRules,
  };
}

/**
 * Returns a summary of what a policy allows/blocks, for display purposes.
 *
 * @param policy - The policy to summarize
 * @returns Object with allowed and blocked action lists
 */
export function summarizePolicy(policy: MissionPolicy): {
  allowed: string[];
  blocked: string[];
  maxParallel: number;
  escalationCount: number;
} {
  const gates: Array<[string, boolean]> = [
    ['Create tasks', policy.canCreateTasks],
    ['Reprioritize tasks', policy.canReprioritizeTasks],
    ['Close tasks', policy.canCloseTasks],
    ['Deploy to staging', policy.canDeployToStaging],
    ['Deploy to production', policy.canDeployToProd],
    ['Spend money', policy.canSpendMoney],
    ['Change user-visible behavior', policy.canChangeUserVisibleBehaviorWithoutReview],
  ];

  return {
    allowed: gates.filter(([, v]) => v).map(([k]) => k),
    blocked: gates.filter(([, v]) => !v).map(([k]) => k),
    maxParallel: policy.maxParallelExecutions,
    escalationCount: policy.escalationRules.length,
  };
}

// Re-export template constants for convenience
export { CONSERVATIVE_POLICY, MODERATE_POLICY, AUTONOMOUS_POLICY };
