/**
 * Onboarding Provision Service
 *
 * Bridges the Onboarding Agent's discovery output to the Template Engine.
 * Validates the handoff payload, resolves the best-match template, and
 * provisions a fully configured team via TemplateService.
 *
 * @module services/onboarding/onboarding-provision.service
 */

import { TemplateService } from '../template/template.service.js';
import { StorageService } from '../core/storage.service.js';
import {
  type OnboardingProvisionRequest,
  type OnboardingProvisionResponse,
  type OnboardingVertical,
  type OnboardingGoal,
  validateProvisionRequest,
  resolveTemplateId,
  DEFAULT_TEMPLATE_ID,
} from './onboarding-provision.types.js';

// =============================================================================
// Constants
// =============================================================================

/** Category labels for human-readable team names, keyed by template ID. */
const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  'growth-marketing-team': 'Growth',
  'ai-video-social-team': 'Content',
  'customer-ops-team': 'Operations',
  'web-dev-team': 'Engineering',
  'startup-team': 'Startup',
  'broker-squad-v1': 'Insurance',
  'prop-manager-v1': 'Resident',
};

/** Fallback label when template ID has no explicit mapping. */
const DEFAULT_CATEGORY_LABEL = 'AI';

// =============================================================================
// Service
// =============================================================================

/**
 * Generate a human-readable team name from the customer name and template category.
 *
 * @param customerName - Business or company name from the discovery payload
 * @param templateId - Resolved template ID
 * @returns A team name like "Acme Corp Growth Team"
 */
export function generateTeamName(customerName: string, templateId: string): string {
  const category = TEMPLATE_CATEGORY_LABELS[templateId] ?? DEFAULT_CATEGORY_LABEL;
  return `${customerName} ${category} Team`;
}

/**
 * Collect pending integrations from the stack mapping answers.
 *
 * Filters out empty/falsy values and the literal "none" string.
 *
 * @param stackMapping - Stack mapping section from the provision request
 * @returns Array of integration tool names queued for setup
 */
export function collectIntegrations(
  stackMapping?: OnboardingProvisionRequest['stackMapping'],
): string[] {
  if (!stackMapping) return [];

  const integrations: string[] = [];
  const tools = [stackMapping.crmTool, stackMapping.chatTool];

  for (const tool of tools) {
    if (tool && tool.toLowerCase() !== 'none') {
      integrations.push(tool);
    }
  }

  return integrations;
}

/**
 * Provision a team from an onboarding discovery payload.
 *
 * Validates the request, resolves the matching template, gates on budget tier,
 * creates the team via TemplateService, attributes the team to the
 * authenticated principal (`ownerUserId` — N1b, Phase E pre-beta), persists
 * via StorageService, and returns a structured response with team details,
 * lead agent focus, and pending integrations.
 *
 * The owner attribution is sourced *only* from the authenticated principal
 * (passed in by the route layer), never from the request body — this closes
 * the cross-tenant team-attribution leak Arch flagged on PR #350. When
 * `ownerUserId` is omitted, the team is created without an owner (OSS
 * single-user / legacy callers); the field stays undefined and read-side
 * scoping (separate ticket) treats those teams as unscoped.
 *
 * @param request - The onboarding handoff payload from the Onboarding Agent
 * @param ownerUserId - Authenticated principal id (`req.user.userId`)
 * @returns Structured response indicating success or failure with details
 *
 * @example
 * ```typescript
 * const response = await provisionFromOnboarding({
 *   customer: {
 *     identity: { name: 'Acme Corp', vertical: 'Content/Marketing', size: 'small' },
 *     strategy: { goal: 'Scale', budget: 'pro', urgency: 'immediate' },
 *   },
 * }, 'user-aaa');
 * // response.success === true
 * // response.data.teamName === 'Acme Corp Growth Team'
 * // (the persisted team carries ownerUserId === 'user-aaa')
 * ```
 */
export async function provisionFromOnboarding(
  request: unknown,
  ownerUserId?: string,
): Promise<OnboardingProvisionResponse> {
  // Step a: Validate request
  const validation = validateProvisionRequest(request);
  if (!validation.valid) {
    return {
      success: false,
      error: `Validation failed: ${validation.errors.join('; ')}`,
    };
  }

  const req = request as OnboardingProvisionRequest;
  const { customer, stackMapping } = req;
  const { vertical, name } = customer.identity;
  const { goal, budget } = customer.strategy;

  // Step b: Resolve template
  const templateId = resolveTemplateId(
    vertical as OnboardingVertical,
    goal as OnboardingGoal,
  );

  // Step c: Budget gate — starter tier should use OSS self-serve
  if (budget === 'starter') {
    return {
      success: false,
      error:
        'Starter budget (< $500/mo) is best served by our free OSS self-serve tier. ' +
        'Visit https://github.com/crewly/crewly to get started.',
    };
  }

  // Step d: Generate team name
  const teamName = generateTeamName(name, templateId);

  // Step e: Create team from template
  const templateService = TemplateService.getInstance();
  const result = templateService.createTeamFromTemplate(templateId, teamName);

  if (!result) {
    return {
      success: false,
      error: `Template "${templateId}" not found. Falling back is not possible — please check template registry.`,
    };
  }

  // Step e.1: Attribute the team to the authenticated principal (N1b).
  //
  // The owner is sourced ONLY from the route's `ownerIdFor(req)` call,
  // never from the request body. Even if `request` happened to carry an
  // `ownerUserId` field, we ignore it — body-derived attribution would
  // re-open the cross-tenant leak Arch flagged on PR #350. Undefined
  // `ownerUserId` (OSS single-user mode) leaves the field unset; the team
  // is treated as legacy/unscoped by consumers.
  if (ownerUserId !== undefined) {
    result.team.ownerUserId = ownerUserId;
  }

  // Step e.2: Persist the created team to storage
  // This ensures the team is visible in the dashboard and to other agents.
  const storage = StorageService.getInstance();
  await storage.saveTeam(result.team);

  // Step f: Extract lead agent focus from nightmareTask
  const leadAgentFocus = stackMapping?.nightmareTask ?? undefined;

  // Step g: Collect integrations
  const pendingIntegrations = collectIntegrations(stackMapping);

  // Step h: Build and return response
  return {
    success: true,
    data: {
      teamId: result.team.id,
      templateId: result.templateId,
      teamName,
      memberCount: result.memberCount,
      matchedTier: budget,
      leadAgentFocus,
      pendingIntegrations,
      onboardingSessionId: req.onboardingSessionId,
    },
  };
}
