/**
 * Tests for the onboarding-mode skill allowlist.
 *
 * Guards:
 *   - The 6 expected skills are present.
 *   - Spawn-worker skills are NOT present (delegate-task / start-agent / stop-agent).
 *   - Helpers behave correctly for empty / unknown inputs.
 *
 * @module services/orchestrator/onboarding-mode.skill-allowlist.test
 */

import {
  ONBOARDING_SKILL_ALLOWLIST,
  isOnboardingSkillAllowed,
  filterAllowedOnboardingSkills,
} from './onboarding-mode.skill-allowlist.js';

describe('ONBOARDING_SKILL_ALLOWLIST', () => {
  it('contains exactly the seven expected skills', () => {
    // Order doesn't matter for this assertion — sort for stability.
    const sorted = [...ONBOARDING_SKILL_ALLOWLIST].sort();
    expect(sorted).toEqual(
      [
        'materialize-team',
        'recall',
        'recommend-team',
        'record-learning',
        'remember',
        'report-status',
        'synthesize-hierarchy',
      ].sort(),
    );
  });

  it('is frozen (cannot be mutated at runtime)', () => {
    expect(Object.isFrozen(ONBOARDING_SKILL_ALLOWLIST)).toBe(true);
  });

  it('does NOT include any spawn-worker skill', () => {
    for (const forbidden of ['delegate-task', 'start-agent', 'stop-agent']) {
      expect(ONBOARDING_SKILL_ALLOWLIST).not.toContain(forbidden);
    }
  });
});

describe('isOnboardingSkillAllowed()', () => {
  it('returns true for every allowed skill', () => {
    for (const skill of ONBOARDING_SKILL_ALLOWLIST) {
      expect(isOnboardingSkillAllowed(skill)).toBe(true);
    }
  });

  it('returns false for forbidden skills', () => {
    for (const forbidden of [
      'delegate-task',
      'start-agent',
      'stop-agent',
      'send-message',
      '',
      'unknown-skill',
    ]) {
      expect(isOnboardingSkillAllowed(forbidden)).toBe(false);
    }
  });

  it('is case-sensitive (matches by exact name)', () => {
    // Allowlist values are lower-kebab-case; uppercase variants must reject.
    expect(isOnboardingSkillAllowed('Recall')).toBe(false);
    expect(isOnboardingSkillAllowed('RECALL')).toBe(false);
  });
});

describe('filterAllowedOnboardingSkills()', () => {
  it('returns only allowed skills, preserving input order', () => {
    const input = [
      'delegate-task', // forbidden
      'recall',         // allowed
      'remember',       // allowed
      'start-agent',    // forbidden
      'materialize-team', // allowed
    ];
    expect(filterAllowedOnboardingSkills(input)).toEqual([
      'recall',
      'remember',
      'materialize-team',
    ]);
  });

  it('returns an empty array when nothing is allowed', () => {
    expect(filterAllowedOnboardingSkills(['delegate-task', 'start-agent'])).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(filterAllowedOnboardingSkills([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = ['recall', 'delegate-task'];
    const snapshot = [...input];
    filterAllowedOnboardingSkills(input);
    expect(input).toEqual(snapshot);
  });
});
