/**
 * Tests for Onboarding Provision Types
 *
 * Validates type guards, template resolution, and request validation
 * for the Onboarding Agent → Template Engine handoff contract.
 *
 * @module services/onboarding/onboarding-provision.types.test
 */

import {
  resolveTemplateId,
  isValidVertical,
  isValidGoal,
  isValidBudgetTier,
  validateProvisionRequest,
  VERTICAL_TEMPLATE_MAP,
  DEFAULT_TEMPLATE_ID,
  type OnboardingProvisionRequest,
  type OnboardingVertical,
  type OnboardingGoal,
} from './onboarding-provision.types.js';

// =============================================================================
// resolveTemplateId
// =============================================================================

describe('resolveTemplateId', () => {
  it('maps Content/Marketing + Scale to growth-marketing-team', () => {
    expect(resolveTemplateId('Content/Marketing', 'Scale')).toBe('growth-marketing-team');
  });

  it('maps Content/Marketing + Time to ai-video-social-team', () => {
    expect(resolveTemplateId('Content/Marketing', 'Time')).toBe('ai-video-social-team');
  });

  it('maps E-commerce/Sales + Scale to growth-marketing-team', () => {
    expect(resolveTemplateId('E-commerce/Sales', 'Scale')).toBe('growth-marketing-team');
  });

  it('maps E-commerce/Sales + Time to customer-ops-team', () => {
    expect(resolveTemplateId('E-commerce/Sales', 'Time')).toBe('customer-ops-team');
  });

  it('maps Software/Tech + Scale to web-dev-team', () => {
    expect(resolveTemplateId('Software/Tech', 'Scale')).toBe('web-dev-team');
  });

  it('maps Software/Tech + Time to web-dev-team', () => {
    expect(resolveTemplateId('Software/Tech', 'Time')).toBe('web-dev-team');
  });

  it('covers all entries in VERTICAL_TEMPLATE_MAP', () => {
    const entries = Object.entries(VERTICAL_TEMPLATE_MAP);
    expect(entries.length).toBeGreaterThanOrEqual(6);

    for (const [key, expectedTemplateId] of entries) {
      const [vertical, goal] = key.split('::') as [OnboardingVertical, OnboardingGoal];
      expect(resolveTemplateId(vertical, goal)).toBe(expectedTemplateId);
    }
  });
});

// =============================================================================
// Type Guards
// =============================================================================

describe('isValidVertical', () => {
  it('accepts valid verticals', () => {
    expect(isValidVertical('Content/Marketing')).toBe(true);
    expect(isValidVertical('E-commerce/Sales')).toBe(true);
    expect(isValidVertical('Software/Tech')).toBe(true);
  });

  it('rejects invalid verticals', () => {
    expect(isValidVertical('Finance')).toBe(false);
    expect(isValidVertical('')).toBe(false);
    expect(isValidVertical(null)).toBe(false);
    expect(isValidVertical(42)).toBe(false);
  });
});

describe('isValidGoal', () => {
  it('accepts Scale and Time', () => {
    expect(isValidGoal('Scale')).toBe(true);
    expect(isValidGoal('Time')).toBe(true);
  });

  it('rejects invalid goals', () => {
    expect(isValidGoal('Profit')).toBe(false);
    expect(isValidGoal('scale')).toBe(false);
    expect(isValidGoal(undefined)).toBe(false);
  });
});

describe('isValidBudgetTier', () => {
  it('accepts valid tiers', () => {
    expect(isValidBudgetTier('starter')).toBe(true);
    expect(isValidBudgetTier('pro')).toBe(true);
    expect(isValidBudgetTier('managed')).toBe(true);
  });

  it('rejects invalid tiers', () => {
    expect(isValidBudgetTier('free')).toBe(false);
    expect(isValidBudgetTier('enterprise')).toBe(false);
    expect(isValidBudgetTier(0)).toBe(false);
  });
});

// =============================================================================
// validateProvisionRequest
// =============================================================================

describe('validateProvisionRequest', () => {
  const validRequest: OnboardingProvisionRequest = {
    customer: {
      identity: {
        name: 'Acme Corp',
        vertical: 'Software/Tech',
        size: 'small',
      },
      strategy: {
        goal: 'Scale',
        budget: 'pro',
        urgency: 'this_week',
      },
    },
  };

  it('accepts a valid minimal request', () => {
    const result = validateProvisionRequest(validRequest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a valid request with optional fields', () => {
    const full: OnboardingProvisionRequest = {
      ...validRequest,
      verticalProbe: { techStack: 'Node', devFocus: 'QA' },
      stackMapping: {
        crmTool: 'HubSpot',
        chatTool: 'Slack',
        nightmareTask: 'Manual deployment every Friday',
      },
      onboardingSessionId: 'sess-123',
    };
    const result = validateProvisionRequest(full);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null body', () => {
    const result = validateProvisionRequest(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('non-null object');
  });

  it('rejects missing customer', () => {
    const result = validateProvisionRequest({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('customer is required and must be an object');
  });

  it('rejects missing customer.identity', () => {
    const result = validateProvisionRequest({ customer: { strategy: validRequest.customer.strategy } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('identity'))).toBe(true);
  });

  it('rejects missing customer.identity.name', () => {
    const bad = {
      customer: {
        identity: { vertical: 'Software/Tech', size: 'small' },
        strategy: validRequest.customer.strategy,
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('name'))).toBe(true);
  });

  it('rejects invalid vertical', () => {
    const bad = {
      customer: {
        identity: { name: 'Test', vertical: 'Finance', size: 'small' },
        strategy: validRequest.customer.strategy,
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('vertical'))).toBe(true);
  });

  it('rejects invalid goal', () => {
    const bad = {
      customer: {
        identity: validRequest.customer.identity,
        strategy: { goal: 'Profit', budget: 'pro', urgency: 'this_week' },
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('goal'))).toBe(true);
  });

  it('rejects invalid budget tier', () => {
    const bad = {
      customer: {
        identity: validRequest.customer.identity,
        strategy: { goal: 'Scale', budget: 'free', urgency: 'this_week' },
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('budget'))).toBe(true);
  });

  it('rejects invalid urgency', () => {
    const bad = {
      customer: {
        identity: validRequest.customer.identity,
        strategy: { goal: 'Scale', budget: 'pro', urgency: 'never' },
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('urgency'))).toBe(true);
  });

  it('collects multiple errors at once', () => {
    const bad = {
      customer: {
        identity: { name: '', vertical: 'Bad', size: 'huge' },
        strategy: { goal: 'Bad', budget: 'Bad', urgency: 'Bad' },
      },
    };
    const result = validateProvisionRequest(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

// =============================================================================
// DEFAULT_TEMPLATE_ID
// =============================================================================

describe('DEFAULT_TEMPLATE_ID', () => {
  it('is startup-team', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('startup-team');
  });
});
