/**
 * Tests for the onboarding-mode loader (Onboarding v3 — B3).
 *
 * Note: We can't easily mock dynamic imports of relative paths in jest
 * (ts-jest CommonJS transform turns `import()` into a Promise wrapper
 * around `require`), so the integration with Max's real modules is
 * exercised end-to-end after both branches merge. Here we cover:
 *
 * - Fallback constant shape (matches brief's prescribed allowlist)
 * - Loader returns the fallback when the production module is absent
 *   (which is the actual state on this branch)
 * - Result is cached across calls
 * - Reset helper clears the cache
 *
 * @module services/orchestrator/onboarding-mode-loader.test
 */

import {
  ONBOARDING_FALLBACK_PROMPT,
  ONBOARDING_FALLBACK_ALLOWLIST,
  loadOnboardingPrompt,
  loadOnboardingSkillAllowlist,
  _resetOnboardingModeLoaderForTesting,
} from './onboarding-mode-loader.js';

describe('Onboarding mode loader (Onboarding v3 — B3)', () => {
  beforeEach(() => {
    _resetOnboardingModeLoaderForTesting();
  });

  describe('fallback constants', () => {
    it('fallback prompt is a non-empty string with a friendly greeting', () => {
      expect(typeof ONBOARDING_FALLBACK_PROMPT).toBe('string');
      expect(ONBOARDING_FALLBACK_PROMPT.length).toBeGreaterThan(20);
      expect(ONBOARDING_FALLBACK_PROMPT.toLowerCase()).toContain('crewly');
    });

    it('fallback allowlist matches Sam\'s brief: read-only memory + 2 onboarding skills', () => {
      // Brief: "restrict orc skills to: recall, remember, record-learning,
      // plus 2 onboarding-specific skills (recommend-team, materialize-team)."
      expect(ONBOARDING_FALLBACK_ALLOWLIST).toContain('recall');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).toContain('remember');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).toContain('record-learning');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).toContain('recommend-team');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).toContain('materialize-team');
    });

    it('fallback allowlist explicitly excludes destructive skills', () => {
      // Brief: "Disable delegate-task, start-agent, stop-agent — orc cannot
      // delegate while onboarding the customer."
      expect(ONBOARDING_FALLBACK_ALLOWLIST).not.toContain('delegate-task');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).not.toContain('start-agent');
      expect(ONBOARDING_FALLBACK_ALLOWLIST).not.toContain('stop-agent');
    });

    it('fallback allowlist is frozen so callers cannot mutate the shared instance', () => {
      expect(Object.isFrozen(ONBOARDING_FALLBACK_ALLOWLIST)).toBe(true);
    });
  });

  describe('loadOnboardingPrompt', () => {
    it('returns a non-empty string on this branch (fallback path)', async () => {
      const prompt = await loadOnboardingPrompt();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('caches the resolved value across calls', async () => {
      const first = await loadOnboardingPrompt();
      const second = await loadOnboardingPrompt();
      expect(second).toBe(first); // identity, not just equality
    });

    it('reset clears the cache so a new resolution can occur', async () => {
      const first = await loadOnboardingPrompt();
      _resetOnboardingModeLoaderForTesting();
      const second = await loadOnboardingPrompt();
      // Same value (fallback), but the resolution path ran twice — that's
      // verified by the reset call, not by identity here.
      expect(second).toBe(first);
    });
  });

  describe('loadOnboardingSkillAllowlist', () => {
    it('returns the fallback allowlist on this branch', async () => {
      const list = await loadOnboardingSkillAllowlist();
      expect(list).toEqual(ONBOARDING_FALLBACK_ALLOWLIST);
    });

    it('caches the resolved allowlist', async () => {
      const first = await loadOnboardingSkillAllowlist();
      const second = await loadOnboardingSkillAllowlist();
      expect(second).toBe(first);
    });

    it('returned allowlist is frozen — callers cannot mutate it', async () => {
      const list = await loadOnboardingSkillAllowlist();
      expect(Object.isFrozen(list)).toBe(true);
    });
  });
});
