/**
 * Unit tests for {@link OnboardingService}.
 *
 * Exercises the lifecycle methods consumed by `/api/onboarding/*` routes,
 * the singleton pattern, and the protective behaviour of `updateSession`
 * (identity fields cannot be overwritten).
 *
 * @module services/onboarding/onboarding.service.test
 */

import { OnboardingService } from './onboarding.service.js';
import type {
  DiscoveryAnswers,
  OnboardingPrefillData,
} from './onboarding.types.js';

describe('OnboardingService', () => {
  let svc: OnboardingService;

  beforeEach(() => {
    OnboardingService.resetInstance();
    svc = OnboardingService.getInstance();
  });

  afterEach(() => {
    OnboardingService.resetInstance();
  });

  describe('singleton', () => {
    it('returns the same instance across getInstance() calls', () => {
      const a = OnboardingService.getInstance();
      const b = OnboardingService.getInstance();
      expect(a).toBe(b);
    });

    it('constructs a fresh instance after resetInstance()', () => {
      const a = OnboardingService.getInstance();
      OnboardingService.resetInstance();
      const b = OnboardingService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('createSession', () => {
    it('creates a session with status="created" and a UUID id', () => {
      const s = svc.createSession();
      expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(s.status).toBe('created');
      expect(s.createdAt).toBe(s.updatedAt);
      expect(s.websiteUrl).toBeUndefined();
    });

    it('persists the optional websiteUrl when provided', () => {
      const s = svc.createSession('https://acme.com');
      expect(s.websiteUrl).toBe('https://acme.com');
    });

    it('generates distinct ids for sequential sessions', () => {
      const a = svc.createSession();
      const b = svc.createSession();
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('listSessions', () => {
    it('returns an empty array when no sessions exist', () => {
      expect(svc.listSessions()).toEqual([]);
    });

    it('returns all created sessions in insertion order', () => {
      const a = svc.createSession('https://a.com');
      const b = svc.createSession('https://b.com');
      const list = svc.listSessions();
      expect(list).toHaveLength(2);
      expect(list[0]?.id).toBe(a.id);
      expect(list[1]?.id).toBe(b.id);
    });
  });

  describe('getSession', () => {
    it('returns the session for an existing id', () => {
      const s = svc.createSession();
      expect(svc.getSession(s.id)).toEqual(s);
    });

    it('returns null for a missing id', () => {
      expect(svc.getSession('does-not-exist')).toBeNull();
    });
  });

  describe('updateSession', () => {
    it('merges partial fields and refreshes updatedAt', async () => {
      const s = svc.createSession();
      // Force a measurable timestamp delta.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const updated = svc.updateSession(s.id, { websiteUrl: 'https://later.com' });
      expect(updated).not.toBeNull();
      expect(updated!.websiteUrl).toBe('https://later.com');
      expect(updated!.updatedAt > s.updatedAt).toBe(true);
    });

    it('returns null for a missing id', () => {
      expect(svc.updateSession('nope', { websiteUrl: 'x' })).toBeNull();
    });

    it('protects id and createdAt from mutation', () => {
      const s = svc.createSession();
      const updated = svc.updateSession(s.id, {
        id: 'tampered',
        createdAt: '1970-01-01T00:00:00Z',
        websiteUrl: 'https://ok.com',
      } as Partial<typeof s>);
      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(s.id);
      expect(updated!.createdAt).toBe(s.createdAt);
      expect(updated!.websiteUrl).toBe('https://ok.com');
    });

    it('does not auto-advance status — callers must set it explicitly', () => {
      const s = svc.createSession();
      const updated = svc.updateSession(s.id, { websiteUrl: 'https://x.com' });
      expect(updated!.status).toBe('created');
    });
  });

  describe('setPrefillData', () => {
    const prefill: OnboardingPrefillData = {
      businessName: 'Acme',
      industry: 'Software/Tech',
      confidence: 'high',
      extractedAt: '2026-04-27T00:00:00Z',
      missingFields: ['platforms'],
    };

    it('stores the prefill payload and advances status to "prefilled"', () => {
      const s = svc.createSession();
      const updated = svc.setPrefillData(s.id, prefill);
      expect(updated).not.toBeNull();
      expect(updated!.prefillData).toEqual(prefill);
      expect(updated!.status).toBe('prefilled');
    });

    it('replaces an existing prefill payload (idempotent overwrite)', () => {
      const s = svc.createSession();
      svc.setPrefillData(s.id, prefill);
      const second: OnboardingPrefillData = { businessName: 'Acme v2', confidence: 'medium' };
      const updated = svc.setPrefillData(s.id, second);
      expect(updated!.prefillData).toEqual(second);
    });

    it('returns null for a missing id', () => {
      expect(svc.setPrefillData('nope', prefill)).toBeNull();
    });
  });

  describe('approveProfile', () => {
    const answers: DiscoveryAnswers = {
      identity: { name: 'Acme', vertical: 'Software/Tech', size: 'small' },
      strategy: { goal: 'Scale', budget: 'pro', urgency: 'this_week' },
    };

    it('records the answers and advances status to "approved"', () => {
      const s = svc.createSession();
      const updated = svc.approveProfile(s.id, answers);
      expect(updated).not.toBeNull();
      expect(updated!.discoveryAnswers).toEqual(answers);
      expect(updated!.status).toBe('approved');
    });

    it('returns null for a missing id', () => {
      expect(svc.approveProfile('nope', answers)).toBeNull();
    });

    it('preserves prior prefillData when approving', () => {
      const s = svc.createSession();
      svc.setPrefillData(s.id, { businessName: 'Acme', confidence: 'high' });
      const updated = svc.approveProfile(s.id, answers);
      expect(updated!.prefillData?.businessName).toBe('Acme');
      expect(updated!.discoveryAnswers).toEqual(answers);
    });
  });
});
