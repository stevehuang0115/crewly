/**
 * Tests for OnboardingProvisionService.
 *
 * Covers: validation, budget gate, template resolution per vertical,
 * nightmareTask → leadAgentFocus, integration collection, and fallback.
 */

import {
  provisionFromOnboarding,
  generateTeamName,
  collectIntegrations,
} from './onboarding-provision.service.js';
import { DEFAULT_TEMPLATE_ID } from './onboarding-provision.types.js';

// ---------------------------------------------------------------------------
// Mock Services — avoid filesystem / real template loading
// ---------------------------------------------------------------------------

const mockCreateTeamFromTemplate = jest.fn();
const mockSaveTeam = jest.fn().mockResolvedValue(undefined);

jest.mock('../template/template.service.js', () => ({
  TemplateService: {
    getInstance: jest.fn(() => ({
      createTeamFromTemplate: mockCreateTeamFromTemplate,
    })),
  },
}));

jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: jest.fn(() => ({
      saveTeam: mockSaveTeam,
    })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid request payload with optional overrides. */
function makeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    customer: {
      identity: {
        name: 'Acme Corp',
        vertical: 'Content/Marketing',
        size: 'small',
      },
      strategy: {
        goal: 'Scale',
        budget: 'pro',
        urgency: 'immediate',
      },
    },
    stackMapping: {
      crmTool: 'HubSpot',
      chatTool: 'Slack',
      nightmareTask: 'Creating weekly social media posts',
    },
    onboardingSessionId: 'sess-123',
    ...overrides,
  };
  return base;
}

/** Stub a successful createTeamFromTemplate return. */
function stubTemplateSuccess(templateId = 'growth-marketing-team') {
  mockCreateTeamFromTemplate.mockReturnValue({
    team: { id: 'team-abc', members: [] },
    templateId,
    memberCount: 4,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('onboarding-provision.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // Unit helpers
  // =========================================================================

  describe('generateTeamName', () => {
    it('should use category label for known templates', async () => {
      expect(generateTeamName('Acme', 'growth-marketing-team')).toBe('Acme Growth Team');
      expect(generateTeamName('Acme', 'ai-video-social-team')).toBe('Acme Content Team');
      expect(generateTeamName('Acme', 'customer-ops-team')).toBe('Acme Operations Team');
      expect(generateTeamName('Acme', 'web-dev-team')).toBe('Acme Engineering Team');
      expect(generateTeamName('Acme', 'startup-team')).toBe('Acme Startup Team');
    });

    it('should fall back to "AI" for unknown template IDs', async () => {
      expect(generateTeamName('Acme', 'unknown-template')).toBe('Acme AI Team');
    });
  });

  describe('collectIntegrations', () => {
    it('should collect CRM and chat tools', async () => {
      expect(
        collectIntegrations({ crmTool: 'HubSpot', chatTool: 'Slack' }),
      ).toEqual(['HubSpot', 'Slack']);
    });

    it('should filter out "none" (case-insensitive)', async () => {
      expect(
        collectIntegrations({ crmTool: 'none', chatTool: 'Discord' }),
      ).toEqual(['Discord']);
      expect(
        collectIntegrations({ crmTool: 'None', chatTool: 'NONE' }),
      ).toEqual([]);
    });

    it('should skip undefined tools', async () => {
      expect(collectIntegrations({ crmTool: 'Salesforce' })).toEqual(['Salesforce']);
      expect(collectIntegrations({})).toEqual([]);
    });

    it('should return empty array when stackMapping is undefined', async () => {
      expect(collectIntegrations(undefined)).toEqual([]);
    });
  });

  // =========================================================================
  // provisionFromOnboarding — validation
  // =========================================================================

  describe('provisionFromOnboarding — validation errors', () => {
    it('should reject null body', async () => {
      const res = await provisionFromOnboarding(null);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Validation failed');
    });

    it('should reject missing customer', async () => {
      const res = await provisionFromOnboarding({});
      expect(res.success).toBe(false);
      expect(res.error).toContain('customer is required');
    });

    it('should reject missing customer.identity.name', async () => {
      const req = makeRequest();
      (req['customer'] as Record<string, unknown>)['identity'] = {
        vertical: 'Content/Marketing',
        size: 'small',
      };
      const res = await provisionFromOnboarding(req);
      expect(res.success).toBe(false);
      expect(res.error).toContain('customer.identity.name');
    });

    it('should reject invalid vertical', async () => {
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['identity'] as Record<string, unknown>)['vertical'] = 'Invalid';
      const res = await provisionFromOnboarding(req);
      expect(res.success).toBe(false);
      expect(res.error).toContain('vertical');
    });

    it('should reject invalid goal', async () => {
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['goal'] = 'Profit';
      const res = await provisionFromOnboarding(req);
      expect(res.success).toBe(false);
      expect(res.error).toContain('goal');
    });
  });

  // =========================================================================
  // provisionFromOnboarding — budget gate
  // =========================================================================

  describe('provisionFromOnboarding — starter budget rejection', () => {
    it('should reject starter budget with OSS suggestion', async () => {
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['budget'] = 'starter';
      const res = await provisionFromOnboarding(req);
      expect(res.success).toBe(false);
      expect(res.error).toContain('Starter budget');
      expect(res.error).toContain('OSS self-serve');
    });
  });

  // =========================================================================
  // provisionFromOnboarding — successful provision per vertical
  // =========================================================================

  describe('provisionFromOnboarding — successful provision', () => {
    it('should provision Content/Marketing + Scale → growth-marketing-team', async () => {
      stubTemplateSuccess('growth-marketing-team');
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.success).toBe(true);
      expect(res.data).toBeDefined();
      expect(res.data!.templateId).toBe('growth-marketing-team');
      expect(res.data!.teamName).toBe('Acme Corp Growth Team');
      expect(res.data!.memberCount).toBe(4);
      expect(res.data!.matchedTier).toBe('pro');
      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith(
        'growth-marketing-team',
        'Acme Corp Growth Team',
      );
      expect(mockSaveTeam).toHaveBeenCalledWith(expect.objectContaining({
        id: 'team-abc',
      }));
    });

    it('should provision Content/Marketing + Time → ai-video-social-team', async () => {
      stubTemplateSuccess('ai-video-social-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['goal'] = 'Time';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.templateId).toBe('ai-video-social-team');
      expect(mockCreateTeamFromTemplate).toHaveBeenCalledWith(
        'ai-video-social-team',
        'Acme Corp Content Team',
      );
    });

    it('should provision E-commerce/Sales + Scale → growth-marketing-team', async () => {
      stubTemplateSuccess('growth-marketing-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['identity'] as Record<string, unknown>)['vertical'] = 'E-commerce/Sales';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.templateId).toBe('growth-marketing-team');
    });

    it('should provision E-commerce/Sales + Time → customer-ops-team', async () => {
      stubTemplateSuccess('customer-ops-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['identity'] as Record<string, unknown>)['vertical'] = 'E-commerce/Sales';
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['goal'] = 'Time';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.templateId).toBe('customer-ops-team');
    });

    it('should provision Software/Tech + Scale → web-dev-team', async () => {
      stubTemplateSuccess('web-dev-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['identity'] as Record<string, unknown>)['vertical'] = 'Software/Tech';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.templateId).toBe('web-dev-team');
    });

    it('should provision Software/Tech + Time → web-dev-team', async () => {
      stubTemplateSuccess('web-dev-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['identity'] as Record<string, unknown>)['vertical'] = 'Software/Tech';
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['goal'] = 'Time';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.templateId).toBe('web-dev-team');
    });

    it('should provision with managed budget tier', async () => {
      stubTemplateSuccess('growth-marketing-team');
      const req = makeRequest();
      ((req['customer'] as Record<string, unknown>)['strategy'] as Record<string, unknown>)['budget'] = 'managed';
      const res = await provisionFromOnboarding(req);

      expect(res.success).toBe(true);
      expect(res.data!.matchedTier).toBe('managed');
    });
  });

  // =========================================================================
  // provisionFromOnboarding — nightmareTask → leadAgentFocus
  // =========================================================================

  describe('provisionFromOnboarding — nightmareTask flows to leadAgentFocus', () => {
    it('should set leadAgentFocus from nightmareTask', async () => {
      stubTemplateSuccess();
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.data!.leadAgentFocus).toBe('Creating weekly social media posts');
    });

    it('should omit leadAgentFocus when nightmareTask is absent', async () => {
      stubTemplateSuccess();
      const req = makeRequest({ stackMapping: { crmTool: 'HubSpot' } });
      const res = await provisionFromOnboarding(req);

      expect(res.data!.leadAgentFocus).toBeUndefined();
    });

    it('should omit leadAgentFocus when stackMapping is absent', async () => {
      stubTemplateSuccess();
      const req = makeRequest();
      delete req['stackMapping'];
      const res = await provisionFromOnboarding(req);

      expect(res.data!.leadAgentFocus).toBeUndefined();
    });
  });

  // =========================================================================
  // provisionFromOnboarding — integrations collection
  // =========================================================================

  describe('provisionFromOnboarding — integrations collection', () => {
    it('should collect crmTool and chatTool into pendingIntegrations', async () => {
      stubTemplateSuccess();
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.data!.pendingIntegrations).toEqual(['HubSpot', 'Slack']);
    });

    it('should return empty array when no stack mapping', async () => {
      stubTemplateSuccess();
      const req = makeRequest();
      delete req['stackMapping'];
      const res = await provisionFromOnboarding(req);

      expect(res.data!.pendingIntegrations).toEqual([]);
    });
  });

  // =========================================================================
  // provisionFromOnboarding — template fallback
  // =========================================================================

  describe('provisionFromOnboarding — template fallback', () => {
    it('should return error when resolved template is not found', async () => {
      mockCreateTeamFromTemplate.mockReturnValue(null);
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });

    it('should pass onboardingSessionId through to response', async () => {
      stubTemplateSuccess();
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.data!.onboardingSessionId).toBe('sess-123');
    });

    it('should omit onboardingSessionId when not provided', async () => {
      stubTemplateSuccess();
      const req = makeRequest();
      delete req['onboardingSessionId'];
      const res = await provisionFromOnboarding(req);

      expect(res.data!.onboardingSessionId).toBeUndefined();
    });
  });

  // =========================================================================
  // Tenant attribution (N1b — Phase E pre-beta)
  //
  // The provision flow must stamp the authenticated principal as the team
  // owner (`Team.ownerUserId`) so cross-tenant attribution is impossible.
  // The owner is sourced ONLY from the route's `ownerIdFor(req)` call,
  // never from the request body — even a body that carries an
  // `ownerUserId` field must NOT influence the saved team.
  // =========================================================================

  describe('provisionFromOnboarding — tenant attribution (N1b)', () => {
    it('stamps the authenticated principal onto Team.ownerUserId', async () => {
      stubTemplateSuccess('growth-marketing-team');
      const res = await provisionFromOnboarding(makeRequest(), 'user-aaa');

      expect(res.success).toBe(true);
      expect(mockSaveTeam).toHaveBeenCalledWith(
        expect.objectContaining({ ownerUserId: 'user-aaa' }),
      );
    });

    it('persists distinct owners for distinct callers', async () => {
      stubTemplateSuccess('growth-marketing-team');
      await provisionFromOnboarding(makeRequest(), 'user-aaa');
      stubTemplateSuccess('growth-marketing-team');
      await provisionFromOnboarding(makeRequest(), 'user-bbb');

      const calls = mockSaveTeam.mock.calls.map((args) => args[0] as { ownerUserId?: string });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.ownerUserId).toBe('user-aaa');
      expect(calls[1]?.ownerUserId).toBe('user-bbb');
    });

    it('leaves Team.ownerUserId undefined when no principal is provided (OSS legacy)', async () => {
      stubTemplateSuccess('growth-marketing-team');
      const res = await provisionFromOnboarding(makeRequest());

      expect(res.success).toBe(true);
      const savedTeam = mockSaveTeam.mock.calls[0]?.[0] as { ownerUserId?: string };
      expect(savedTeam?.ownerUserId).toBeUndefined();
    });

    it('IGNORES any ownerUserId field on the request body (no body-derived attribution)', async () => {
      stubTemplateSuccess('growth-marketing-team');
      // Body carries a forged owner — defense in depth: the service must
      // NOT trust it. Only the principal arg can set ownership.
      const forged = { ...makeRequest(), ownerUserId: 'attacker-id' } as Record<string, unknown>;
      await provisionFromOnboarding(forged, 'user-aaa');

      const savedTeam = mockSaveTeam.mock.calls[0]?.[0] as { ownerUserId?: string };
      expect(savedTeam?.ownerUserId).toBe('user-aaa');
      expect(savedTeam?.ownerUserId).not.toBe('attacker-id');
    });

    it('does NOT stamp ownerUserId when validation fails (no half-attributed teams)', async () => {
      const res = await provisionFromOnboarding({} as unknown, 'user-aaa');
      expect(res.success).toBe(false);
      expect(mockSaveTeam).not.toHaveBeenCalled();
    });

    it('does NOT stamp ownerUserId when budget gate trips (starter tier short-circuits)', async () => {
      const req = makeRequest() as { customer: { strategy: { budget: string } } };
      req.customer.strategy.budget = 'starter';
      const res = await provisionFromOnboarding(req, 'user-aaa');

      expect(res.success).toBe(false);
      expect(mockSaveTeam).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DEFAULT_TEMPLATE_ID constant is exported correctly
  // =========================================================================

  describe('DEFAULT_TEMPLATE_ID', () => {
    it('should be "startup-team"', async () => {
      expect(DEFAULT_TEMPLATE_ID).toBe('startup-team');
    });
  });
});
