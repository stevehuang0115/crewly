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

  // ---------------------------------------------------------------------------
  // completeSession (KR3 magic-moment terminal step)
  // ---------------------------------------------------------------------------
  describe('completeSession', () => {
    it('marks the session "completed" and stamps completedAt + updatedAt', () => {
      const s = svc.createSession();
      const before = s.updatedAt;
      // Ensure a non-zero clock delta so the after-stamp is strictly later.
      const updated = svc.completeSession(s.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.completedAt).toBe(updated!.updatedAt);
      expect(new Date(updated!.updatedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(before).getTime());
    });

    it('persists the optional teamKnowledgeDir hint when provided', () => {
      const s = svc.createSession();
      const updated = svc.completeSession(s.id, undefined, {
        teamKnowledgeDir: '.crewly/knowledge',
      });
      expect(updated!.teamKnowledgeDir).toBe('.crewly/knowledge');
    });

    it('omits teamKnowledgeDir when the hint is not provided', () => {
      const s = svc.createSession();
      const updated = svc.completeSession(s.id);
      expect(updated!.teamKnowledgeDir).toBeUndefined();
    });

    it('returns null for a missing id', () => {
      expect(svc.completeSession('nope')).toBeNull();
    });

    it('is idempotent — second call refreshes timestamps but stays terminal', () => {
      const s = svc.createSession();
      const first = svc.completeSession(s.id);
      const second = svc.completeSession(s.id);
      expect(second!.status).toBe('completed');
      expect(second!.completedAt).toBeDefined();
      // Both stamps are valid ISO strings; ordering monotonic.
      expect(new Date(second!.completedAt!).getTime())
        .toBeGreaterThanOrEqual(new Date(first!.completedAt!).getTime());
    });

    it('returns null for cross-tenant calls (no enumeration leak)', () => {
      const s = svc.createSession('https://a.com', 'user-aaa');
      // Foreign caller gets the same null shape as a missing id.
      expect(svc.completeSession(s.id, 'user-bbb')).toBeNull();
      // Underlying record is untouched — owner can still complete it.
      const owner = svc.completeSession(s.id, 'user-aaa');
      expect(owner!.status).toBe('completed');
      expect(owner!.ownerUserId).toBe('user-aaa');
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant scoping (N1 — Phase E pre-beta)
  //
  // Every read and mutation must respect the optional `ownerUserId` scope so
  // Cloud Portal multi-tenant mode does not leak sessions across users. Each
  // method's "missing or not owned" cases must collapse to the same `null`
  // return so cross-tenant id enumeration cannot probe for existence.
  // ---------------------------------------------------------------------------
  describe('tenant scoping', () => {
    const USER_A = 'user-aaa';
    const USER_B = 'user-bbb';

    const samplePrefill: OnboardingPrefillData = {
      businessName: 'Acme',
      confidence: 'high',
    };
    const sampleAnswers: DiscoveryAnswers = {
      identity: { name: 'Acme', vertical: 'Software/Tech', size: 'small' },
    };

    it('createSession persists ownerUserId on the session record', () => {
      const s = svc.createSession('https://a.com', USER_A);
      expect(s.ownerUserId).toBe(USER_A);
    });

    it('createSession leaves ownerUserId undefined when not provided (OSS legacy mode)', () => {
      const s = svc.createSession('https://a.com');
      expect(s.ownerUserId).toBeUndefined();
    });

    it('listSessions(ownerUserId) returns only that user\'s sessions', () => {
      svc.createSession('https://a.com', USER_A);
      svc.createSession('https://a2.com', USER_A);
      svc.createSession('https://b.com', USER_B);

      const aList = svc.listSessions(USER_A);
      const bList = svc.listSessions(USER_B);

      expect(aList).toHaveLength(2);
      expect(aList.every((s) => s.ownerUserId === USER_A)).toBe(true);
      expect(bList).toHaveLength(1);
      expect(bList[0]?.ownerUserId).toBe(USER_B);
    });

    it('listSessions() with no scope returns ALL sessions (admin/legacy access)', () => {
      svc.createSession('https://a.com', USER_A);
      svc.createSession('https://b.com', USER_B);
      svc.createSession('https://c.com');

      expect(svc.listSessions()).toHaveLength(3);
    });

    it('listSessions(ownerUserId) excludes unscoped (ownerUserId-undefined) sessions', () => {
      svc.createSession('https://a.com', USER_A);
      svc.createSession('https://legacy.com'); // no owner

      const aList = svc.listSessions(USER_A);
      expect(aList).toHaveLength(1);
      expect(aList[0]?.websiteUrl).toBe('https://a.com');
    });

    it('getSession returns null when scope does not match (no enumeration leak)', () => {
      const s = svc.createSession('https://a.com', USER_A);
      // user A can read it
      expect(svc.getSession(s.id, USER_A)).not.toBeNull();
      // user B sees the same null shape as a missing id
      expect(svc.getSession(s.id, USER_B)).toBeNull();
      expect(svc.getSession('does-not-exist', USER_B)).toBeNull();
    });

    it('getSession with no scope returns the session regardless of owner (admin/legacy)', () => {
      const s = svc.createSession('https://a.com', USER_A);
      expect(svc.getSession(s.id)).not.toBeNull();
    });

    it('updateSession returns null and does NOT mutate when scope mismatches', () => {
      const s = svc.createSession('https://a.com', USER_A);
      const before = svc.getSession(s.id);
      const result = svc.updateSession(s.id, { websiteUrl: 'https://hacked.com' }, USER_B);
      expect(result).toBeNull();
      // Verify nothing was mutated under the hood
      expect(svc.getSession(s.id)?.websiteUrl).toBe('https://a.com');
      expect(svc.getSession(s.id)?.updatedAt).toBe(before?.updatedAt);
    });

    it('updateSession strips ownerUserId from the update payload (no re-targeting)', () => {
      const s = svc.createSession('https://a.com', USER_A);
      const updated = svc.updateSession(
        s.id,
        { ownerUserId: USER_B, websiteUrl: 'https://still-a.com' } as Partial<typeof s>,
        USER_A,
      );
      expect(updated).not.toBeNull();
      expect(updated!.ownerUserId).toBe(USER_A);
      expect(updated!.websiteUrl).toBe('https://still-a.com');
    });

    it('setPrefillData returns null and does NOT mutate when scope mismatches', () => {
      const s = svc.createSession('https://a.com', USER_A);
      const result = svc.setPrefillData(s.id, samplePrefill, USER_B);
      expect(result).toBeNull();
      expect(svc.getSession(s.id)?.prefillData).toBeUndefined();
      expect(svc.getSession(s.id)?.status).toBe('created');
    });

    it('approveProfile returns null and does NOT mutate when scope mismatches', () => {
      const s = svc.createSession('https://a.com', USER_A);
      const result = svc.approveProfile(s.id, sampleAnswers, USER_B);
      expect(result).toBeNull();
      expect(svc.getSession(s.id)?.discoveryAnswers).toBeUndefined();
      expect(svc.getSession(s.id)?.status).toBe('created');
    });

    it('the owner can still mutate their own session after a foreign attempt', () => {
      const s = svc.createSession('https://a.com', USER_A);
      // Foreign attempt is rejected silently
      svc.updateSession(s.id, { websiteUrl: 'https://hacked.com' }, USER_B);
      // Owner mutation still works
      const updated = svc.updateSession(s.id, { websiteUrl: 'https://updated.com' }, USER_A);
      expect(updated).not.toBeNull();
      expect(updated!.websiteUrl).toBe('https://updated.com');
    });
  });
});
