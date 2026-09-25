/**
 * Tests for the first-run checklist constants.
 *
 * @module constants/onboarding-checklist.constants.test
 */

import { describe, it, expect } from 'vitest';
import {
  CHECKLIST_STEP_HINTS,
  CHECKLIST_STEP_LABELS,
  ONBOARDING_API,
  SETUP_FLOW_STEPS,
  buildCloudSignInUrl,
  isSafeNextPath,
  setupStepPath,
} from './onboarding-checklist.constants';
import { CHECKLIST_STEP_IDS } from '../types/onboarding-checklist.types';

describe('onboarding checklist constants', () => {
  it('points at the checklist routes', () => {
    expect(ONBOARDING_API.CHECKLIST).toBe('/api/onboarding/checklist');
    expect(ONBOARDING_API.FIRST_TASK).toBe('/api/onboarding/first-task');
    expect(ONBOARDING_API.CLOUD_CONNECT).toBe('/api/cloud/connect');
  });

  it('has a label and a hint for every step', () => {
    for (const id of CHECKLIST_STEP_IDS) {
      expect(CHECKLIST_STEP_LABELS[id]).toBeTruthy();
      expect(CHECKLIST_STEP_HINTS[id]).toBeTruthy();
    }
    expect(SETUP_FLOW_STEPS).toHaveLength(8);
  });

  it('isSafeNextPath allows same-origin paths only', () => {
    expect(isSafeNextPath('/setup?step=cloud')).toBe(true);
    expect(isSafeNextPath('//evil.example')).toBe(false);
    expect(isSafeNextPath('https://evil.example')).toBe(false);
    expect(isSafeNextPath('/\\evil')).toBe(false);
    expect(isSafeNextPath(null)).toBe(false);
  });

  it('buildCloudSignInUrl returns to this origin with the next path', () => {
    const url = new URL(buildCloudSignInUrl('http://192.168.1.20:8787', '/setup?step=cloud'));
    expect(url.origin).toBe('https://api.crewlyai.com');
    expect(url.pathname).toBe('/api/cloud/google/start');
    const callback = new URL(url.searchParams.get('redirect')!);
    expect(callback.origin).toBe('http://192.168.1.20:8787');
    expect(callback.pathname).toBe('/auth/callback');
    expect(callback.searchParams.get('next')).toBe('/setup?step=cloud');
  });

  it('setupStepPath opens /setup at a step', () => {
    expect(setupStepPath('slack')).toBe('/setup?step=slack');
  });
});
