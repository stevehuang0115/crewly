/**
 * Tests for harness type helpers.
 *
 * @module types/harness.types.test
 */

import { describe, it, expect } from 'vitest';
import { isTerminalLoginState, isUnrecognizedScreen, TERMINAL_LOGIN_STATES } from './harness.types';
import type { LoginSession } from './harness.types';

/**
 * Build a login session with overrides.
 *
 * @param overrides - Fields to override
 * @returns Login session
 */
function session(overrides: Partial<LoginSession> = {}): LoginSession {
  return {
    id: 's1',
    harnessId: 'claude-code',
    method: 'subscription',
    state: 'awaiting_user',
    url: null,
    userCode: null,
    needsInput: false,
    message: null,
    screen: 'some screen',
    startedAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
    ...overrides,
  };
}

describe('harness.types', () => {
  it('treats succeeded / failed / timed_out / cancelled as terminal', () => {
    expect(TERMINAL_LOGIN_STATES.size).toBe(4);
    for (const s of ['succeeded', 'failed', 'timed_out', 'cancelled'] as const) {
      expect(isTerminalLoginState(s)).toBe(true);
    }
    for (const s of ['starting', 'awaiting_user', 'verifying'] as const) {
      expect(isTerminalLoginState(s)).toBe(false);
    }
  });

  it('detects an unrecognised awaiting_user screen', () => {
    expect(isUnrecognizedScreen(session())).toBe(true);
  });

  it('is not unrecognised when any actionable field is present or the state differs', () => {
    expect(isUnrecognizedScreen(session({ url: 'https://x' }))).toBe(false);
    expect(isUnrecognizedScreen(session({ userCode: 'ABCD' }))).toBe(false);
    expect(isUnrecognizedScreen(session({ needsInput: true }))).toBe(false);
    expect(isUnrecognizedScreen(session({ state: 'starting' }))).toBe(false);
  });
});
