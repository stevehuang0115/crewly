/**
 * Tests for harness fixtures.
 *
 * @module test/harness.fixtures.test
 */

import { describe, it, expect } from 'vitest';
import { makeHarness, makeOverview, makeSession, CODEX, GEMINI } from './harness.fixtures';

describe('harness fixtures', () => {
  it('builds consistent defaults', () => {
    expect(makeHarness().id).toBe('claude-code');
    expect(CODEX.loginMethods.map((m) => m.id)).toEqual(['device', 'api_key']);
    expect(GEMINI.loginMethods).toEqual([]);
    expect(makeOverview().harnesses).toHaveLength(3);
    expect(makeSession({ state: 'verifying' }).state).toBe('verifying');
  });
});
