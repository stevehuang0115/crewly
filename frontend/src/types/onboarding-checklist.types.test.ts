/**
 * Tests for the first-run checklist type helpers.
 *
 * @module types/onboarding-checklist.types.test
 */

import { describe, it, expect } from 'vitest';
import { CHECKLIST_STEP_IDS, findStep, isChecklistStepId, type OnboardingChecklist } from './onboarding-checklist.types';

const CHECKLIST: OnboardingChecklist = {
  steps: [
    { id: 'harness', done: true, detail: { orcHarness: 'claude-code', installed: true, loginState: 'logged_in' } },
    { id: 'cloud', done: false, detail: { connected: false, tier: null, tokenPageSignInUrl: 'https://x' } },
  ],
  doneCount: 1,
  total: 5,
  allDone: false,
  dismissed: false,
  dismissedAt: null,
};

describe('onboarding checklist types', () => {
  it('lists the five steps in order', () => {
    expect(CHECKLIST_STEP_IDS).toEqual(['harness', 'team', 'first_task', 'cloud', 'slack']);
  });

  it('isChecklistStepId accepts known ids only', () => {
    expect(isChecklistStepId('cloud')).toBe(true);
    expect(isChecklistStepId('first_task')).toBe(true);
    expect(isChecklistStepId('login')).toBe(false);
    expect(isChecklistStepId(null)).toBe(false);
  });

  it('findStep returns the typed step', () => {
    expect(findStep(CHECKLIST, 'cloud')?.detail.tokenPageSignInUrl).toBe('https://x');
    expect(findStep(CHECKLIST, 'slack')).toBeUndefined();
    expect(findStep(null, 'harness')).toBeUndefined();
  });
});
