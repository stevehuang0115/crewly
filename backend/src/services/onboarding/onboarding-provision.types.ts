/**
 * Onboarding Provision Types
 *
 * Interface contract between the Onboarding Agent (Strategy) and the
 * Template Engine (Product). Defines the JSON handoff format that bridges
 * Ethan's Onboarding Agent Framework v1.1 discovery output to our
 * TemplateService.createTeamFromTemplate() provisioning pipeline.
 *
 * Ref: docs/onboarding-agent-framework-v1.1.md (Section 5 — Ingestion Format)
 *
 * @module services/onboarding/onboarding-provision.types
 */

// =============================================================================
// Enums — Closed sets matching the Onboarding Agent questionnaire
// =============================================================================

/** Business vertical selected during discovery (Section 2, Pillar 1). */
export type OnboardingVertical =
  | 'Content/Marketing'
  | 'E-commerce/Sales'
  | 'Software/Tech'
  | 'Insurance'
  | 'Property Management';

/** Primary goal selected during discovery (Section 2, Pillar 3). */
export type OnboardingGoal = 'Scale' | 'Time';

/** Monthly budget tier for tier matching (Section 2, Pillar 4). */
export type OnboardingBudgetTier =
  | 'starter'     // < $500/mo → OSS self-serve
  | 'pro'         // $500–$2000/mo → Pro tier
  | 'managed';    // > $2000/mo → Managed/Enterprise

/** Urgency level (Section 2, Pillar 5). */
export type OnboardingUrgency = 'immediate' | 'this_week' | 'this_month' | 'exploring';

/** Team size bracket (Section 2, Pillar 2). */
export type OnboardingTeamSize = 'solo' | 'small' | 'medium' | 'large';

// =============================================================================
// Vertical-Specific Probe Fields (Section 3.2)
// =============================================================================

/** Content/Marketing vertical deep-dive fields. */
export interface ContentProbeData {
  /** Monthly content output volume. */
  contentVolume?: string;
  /** Priority social/content platforms. */
  priorityPlatforms?: string[];
}

/** E-commerce/Sales vertical deep-dive fields. */
export interface EcomProbeData {
  /** Primary sales channel. */
  salesChannel?: string;
  /** Biggest operational bottleneck. */
  opsBottleneck?: string;
}

/** Software/Tech vertical deep-dive fields. */
export interface DevProbeData {
  /** Primary tech stack. */
  techStack?: string;
  /** Development focus area. */
  devFocus?: string;
}

/** Insurance vertical deep-dive fields. */
export interface InsuranceProbeData {
  /** Agency management system used. */
  ams?: string;
}

/** Property Management vertical deep-dive fields. */
export interface PropertyProbeData {
  /** Number of units managed. */
  unitCount?: number;
}

/** Union of all vertical probe data. */
export type VerticalProbeData =
  | ContentProbeData
  | EcomProbeData
  | DevProbeData
  | InsuranceProbeData
  | PropertyProbeData;

// =============================================================================
// Request — Onboarding Agent → Template Engine
// =============================================================================

/**
 * The JSON payload sent by the Onboarding Agent after completing the
 * discovery questionnaire. This is the "handoff" to the Template Engine.
 *
 * Maps to v1.1 Section 5 "Ingestion Format" with additional fields
 * for vertical-specific probing (Section 3.2) and stack mapping (Section 4).
 */
export interface OnboardingProvisionRequest {
  /** Customer identity and qualification data. */
  customer: {
    identity: {
      /** Business or company name. */
      name: string;
      /** Selected vertical from discovery. */
      vertical: OnboardingVertical;
      /** Team size bracket. */
      size: OnboardingTeamSize;
    };
    strategy: {
      /** Primary goal: Scale operations or Save time. */
      goal: OnboardingGoal;
      /** Monthly automation budget tier. */
      budget: OnboardingBudgetTier;
      /** Deployment urgency. */
      urgency: OnboardingUrgency;
    };
  };

  /** Vertical-specific probe answers (Section 3.2). */
  verticalProbe?: VerticalProbeData;

  /** Stack mapping answers (Section 4 — STACK_MAPPING node). */
  stackMapping?: {
    /** Current CRM tool (e.g. HubSpot, Salesforce, none). */
    crmTool?: string;
    /** Current chat/communication tool (e.g. Slack, Discord, Teams). */
    chatTool?: string;
    /** The "nightmare task" — highest-pain task for skill mapping. */
    nightmareTask?: string;
  };

  /** Optional: existing onboarding session ID to link to. */
  onboardingSessionId?: string;
}

// =============================================================================
// Vertical → Template Mapping
// =============================================================================

/**
 * Static mapping from vertical + goal to the best-match template ID.
 *
 * This is the core resolution logic: given a customer's vertical and goal,
 * which template should we provision?
 *
 * Keys: `${vertical}::${goal}` — fallback to vertical-only if goal doesn't
 * narrow the match.
 */
export const VERTICAL_TEMPLATE_MAP: Record<string, string> = {
  // Content/Marketing
  'Content/Marketing::Scale': 'growth-marketing-team',
  'Content/Marketing::Time': 'ai-video-social-team',

  // E-commerce/Sales
  'E-commerce/Sales::Scale': 'growth-marketing-team',
  'E-commerce/Sales::Time': 'customer-ops-team',

  // Software/Tech
  'Software/Tech::Scale': 'web-dev-team',
  'Software/Tech::Time': 'web-dev-team',

  // Insurance
  'Insurance::Scale': 'broker-squad-v1',
  'Insurance::Time': 'broker-squad-v1',

  // Property Management
  'Property Management::Scale': 'prop-manager-v1',
  'Property Management::Time': 'prop-manager-v1',
} as const;

/** Default fallback template when no mapping matches. */
export const DEFAULT_TEMPLATE_ID = 'startup-team';

/**
 * Resolve the best template ID for a given vertical and goal.
 *
 * @param vertical - Customer's business vertical
 * @param goal - Customer's primary goal (Scale or Time)
 * @returns The matched template ID
 */
export function resolveTemplateId(
  vertical: OnboardingVertical,
  goal: OnboardingGoal,
): string {
  const key = `${vertical}::${goal}`;
  return VERTICAL_TEMPLATE_MAP[key] ?? DEFAULT_TEMPLATE_ID;
}

// =============================================================================
// Response — Template Engine → Onboarding Agent / Frontend
// =============================================================================

/**
 * Result returned after the Template Engine provisions a team from
 * the onboarding discovery data.
 */
export interface OnboardingProvisionResponse {
  /** Whether provisioning succeeded. */
  success: boolean;

  /** Provisioned team details (present on success). */
  data?: {
    /** Created team ID. */
    teamId: string;
    /** Template ID that was used. */
    templateId: string;
    /** Human-readable team name. */
    teamName: string;
    /** Number of agents provisioned. */
    memberCount: number;
    /** Budget tier the customer was matched to. */
    matchedTier: OnboardingBudgetTier;
    /** The lead agent's focus area (derived from nightmareTask). */
    leadAgentFocus?: string;
    /** Integrations queued for setup. */
    pendingIntegrations: string[];
    /** Linked onboarding session ID, if any. */
    onboardingSessionId?: string;
  };

  /** Error details (present on failure). */
  error?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

const VALID_VERTICALS: ReadonlySet<string> = new Set([
  'Content/Marketing',
  'E-commerce/Sales',
  'Software/Tech',
  'Insurance',
  'Property Management',
]);

const VALID_GOALS: ReadonlySet<string> = new Set(['Scale', 'Time']);

const VALID_BUDGET_TIERS: ReadonlySet<string> = new Set([
  'starter',
  'pro',
  'managed',
]);

const VALID_URGENCY: ReadonlySet<string> = new Set([
  'immediate',
  'this_week',
  'this_month',
  'exploring',
]);

const VALID_TEAM_SIZES: ReadonlySet<string> = new Set([
  'solo',
  'small',
  'medium',
  'large',
]);

/**
 * Validate whether a value is a valid OnboardingVertical.
 *
 * @param value - Value to check
 * @returns True if value is a valid vertical
 */
export function isValidVertical(value: unknown): value is OnboardingVertical {
  return typeof value === 'string' && VALID_VERTICALS.has(value);
}

/**
 * Validate whether a value is a valid OnboardingGoal.
 *
 * @param value - Value to check
 * @returns True if value is a valid goal
 */
export function isValidGoal(value: unknown): value is OnboardingGoal {
  return typeof value === 'string' && VALID_GOALS.has(value);
}

/**
 * Validate whether a value is a valid OnboardingBudgetTier.
 *
 * @param value - Value to check
 * @returns True if value is a valid budget tier
 */
export function isValidBudgetTier(value: unknown): value is OnboardingBudgetTier {
  return typeof value === 'string' && VALID_BUDGET_TIERS.has(value);
}

/**
 * Validate an OnboardingProvisionRequest payload.
 * Checks required fields and enum validity.
 *
 * @param value - Value to validate
 * @returns Object with `valid` flag and optional `errors` array
 */
export function validateProvisionRequest(
  value: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null) {
    return { valid: false, errors: ['Request body must be a non-null object'] };
  }

  const req = value as Record<string, unknown>;

  // customer.identity
  const customer = req['customer'] as Record<string, unknown> | undefined;
  if (!customer || typeof customer !== 'object') {
    errors.push('customer is required and must be an object');
  } else {
    const identity = customer['identity'] as Record<string, unknown> | undefined;
    if (!identity || typeof identity !== 'object') {
      errors.push('customer.identity is required');
    } else {
      if (!identity['name'] || typeof identity['name'] !== 'string') {
        errors.push('customer.identity.name is required (string)');
      }
      if (!isValidVertical(identity['vertical'])) {
        errors.push(`customer.identity.vertical must be one of: ${[...VALID_VERTICALS].join(', ')}`);
      }
      if (!VALID_TEAM_SIZES.has(identity['size'] as string)) {
        errors.push(`customer.identity.size must be one of: ${[...VALID_TEAM_SIZES].join(', ')}`);
      }
    }

    // customer.strategy
    const strategy = customer['strategy'] as Record<string, unknown> | undefined;
    if (!strategy || typeof strategy !== 'object') {
      errors.push('customer.strategy is required');
    } else {
      if (!isValidGoal(strategy['goal'])) {
        errors.push(`customer.strategy.goal must be one of: ${[...VALID_GOALS].join(', ')}`);
      }
      if (!isValidBudgetTier(strategy['budget'])) {
        errors.push(`customer.strategy.budget must be one of: ${[...VALID_BUDGET_TIERS].join(', ')}`);
      }
      if (!VALID_URGENCY.has(strategy['urgency'] as string)) {
        errors.push(`customer.strategy.urgency must be one of: ${[...VALID_URGENCY].join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
