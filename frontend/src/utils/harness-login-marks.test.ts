/**
 * Tests for harness login marks.
 *
 * @module utils/harness-login-marks.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getHarnessLoggedInAt,
  isPendingLoginResolved,
  markHarnessLoggedIn,
  recordHarnessLoginStates,
} from './harness-login-marks';

describe('harness-login-marks', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stores and reads a login mark', () => {
    expect(getHarnessLoggedInAt('codex-cli')).toBeNull();
    markHarnessLoggedIn('codex-cli', new Date('2026-09-28T10:00:00.000Z'));
    expect(getHarnessLoggedInAt('codex-cli')).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
  });

  it('marks only a logged-out → logged-in transition, not a first sighting', () => {
    expect(recordHarnessLoginStates({ 'codex-cli': 'logged_in' })).toEqual([]);
    expect(getHarnessLoggedInAt('codex-cli')).toBeNull();

    recordHarnessLoginStates({ 'claude-code': 'logged_out' });
    expect(recordHarnessLoginStates({ 'claude-code': 'logged_in' })).toEqual(['claude-code']);
    expect(getHarnessLoggedInAt('claude-code')).not.toBeNull();
  });

  it('resolves a pending sign-in only when the harness is logged in and logged in after detection', () => {
    markHarnessLoggedIn('codex-cli', new Date('2026-09-28T10:05:00.000Z'));
    expect(isPendingLoginResolved('codex-cli', '2026-09-28T10:00:00.000Z', 'logged_in')).toBe(true);
    // Detected after the login: a new, real sign-in.
    expect(isPendingLoginResolved('codex-cli', '2026-09-28T10:10:00.000Z', 'logged_in')).toBe(false);
    // Harness not logged in now.
    expect(isPendingLoginResolved('codex-cli', '2026-09-28T10:00:00.000Z', 'logged_out')).toBe(false);
    // Unknown runtime / no mark / bad date.
    expect(isPendingLoginResolved(null, '2026-09-28T10:00:00.000Z', 'logged_in')).toBe(false);
    expect(isPendingLoginResolved('claude-code', '2026-09-28T10:00:00.000Z', 'logged_in')).toBe(false);
    expect(isPendingLoginResolved('codex-cli', 'not-a-date', 'logged_in')).toBe(false);
  });

  it('degrades to "no mark" when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => markHarnessLoggedIn('codex-cli')).not.toThrow();
    expect(getHarnessLoggedInAt('codex-cli')).toBeNull();
    spy.mockRestore();
    setSpy.mockRestore();
  });
});
