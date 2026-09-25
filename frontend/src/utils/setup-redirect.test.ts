/**
 * Tests for the first-run setup redirect helpers.
 *
 * @module utils/setup-redirect.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  needsHarnessSetup,
  isSetupRedirectAllowedFrom,
  isSetupSkipped,
  setSetupSkipped,
} from './setup-redirect';
import type { HarnessOverview, HarnessStatus } from '../types/harness.types';
import { SETUP_SKIP_STORAGE_KEY } from '../constants/harness.constants';

/**
 * Build a harness status.
 *
 * @param overrides - Fields to override
 * @returns Harness status
 */
function harness(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    version: '2.0.0',
    latestVersion: '2.0.0',
    updateAvailable: false,
    loginState: 'logged_in',
    loginSource: null,
    loginMethods: [],
    ...overrides,
  };
}

/**
 * Build an overview.
 *
 * @param h - Orc harness status
 * @param orcHarness - Orc id
 * @returns Overview
 */
function overview(h: HarnessStatus, orcHarness: HarnessOverview['orcHarness'] = 'claude-code'): HarnessOverview {
  return { harnesses: [h], orcHarness, systemTools: [] };
}

describe('needsHarnessSetup', () => {
  it('is true when no orc harness is chosen', () => {
    expect(needsHarnessSetup(overview(harness(), null))).toBe(true);
  });

  it('is true when the orc harness is not installed', () => {
    expect(needsHarnessSetup(overview(harness({ installed: false })))).toBe(true);
  });

  it('is false when the orc runs on a runtime outside the harness list', () => {
    expect(needsHarnessSetup(overview(harness(), 'crewly-agent' as never))).toBe(false);
  });

  it('is true when the orc harness is logged out', () => {
    expect(needsHarnessSetup(overview(harness({ loginState: 'logged_out' })))).toBe(true);
  });

  it('is false when logged in or login state is unknown', () => {
    expect(needsHarnessSetup(overview(harness()))).toBe(false);
    expect(needsHarnessSetup(overview(harness({ loginState: 'unknown' })))).toBe(false);
  });
});

describe('isSetupRedirectAllowedFrom', () => {
  it('blocks setup and auth pages', () => {
    expect(isSetupRedirectAllowedFrom('/setup')).toBe(false);
    expect(isSetupRedirectAllowedFrom('/auth')).toBe(false);
    expect(isSetupRedirectAllowedFrom('/auth/callback')).toBe(false);
  });

  it('allows app pages', () => {
    expect(isSetupRedirectAllowedFrom('/')).toBe(true);
    expect(isSetupRedirectAllowedFrom('/settings')).toBe(true);
    expect(isSetupRedirectAllowedFrom('/authors')).toBe(true);
  });
});

describe('skip flag', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('round-trips through localStorage', () => {
    expect(isSetupSkipped()).toBe(false);
    setSetupSkipped(true);
    expect(window.localStorage.getItem(SETUP_SKIP_STORAGE_KEY)).toBe('1');
    expect(isSetupSkipped()).toBe(true);
    setSetupSkipped(false);
    expect(isSetupSkipped()).toBe(false);
  });

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(isSetupSkipped()).toBe(false);
    expect(() => setSetupSkipped(true)).not.toThrow();
  });
});
