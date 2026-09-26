/**
 * Test fixtures for the harness setup / login UI.
 *
 * @module test/harness.fixtures
 */

import type { HarnessOverview, HarnessStatus, LoginSession } from '../types/harness.types';

/**
 * Build a harness status (Claude Code, installed, logged in by default).
 *
 * @param overrides - Fields to override
 * @returns Harness status
 */
export function makeHarness(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    version: '2.0.0',
    latestVersion: '2.0.0',
    updateAvailable: false,
    loginState: 'logged_in',
    loginSource: null,
    loginMethods: [
      { id: 'subscription', label: 'Claude subscription', kind: 'broker' },
      { id: 'api_key', label: 'API key', kind: 'api_key' },
    ],
    ...overrides,
  };
}

/** Codex, installed and logged out, with device + API-key methods. */
export const CODEX = makeHarness({
  id: 'codex-cli',
  displayName: 'Codex',
  loginState: 'logged_out',
  loginMethods: [
    { id: 'device', label: 'ChatGPT', kind: 'broker' },
    { id: 'api_key', label: 'OpenAI API key', kind: 'api_key' },
  ],
});

/** Antigravity CLI, not installed, Gemini API key login only. */
export const ANTIGRAVITY = makeHarness({
  id: 'antigravity-cli',
  displayName: 'Antigravity CLI',
  installed: false,
  version: null,
  latestVersion: null,
  loginState: 'logged_out',
  loginMethods: [{ id: 'api_key', label: 'Gemini API key', kind: 'api_key' }],
});

/** Gemini CLI, not installed, no login methods (detect-only), retired for new users. */
export const GEMINI = makeHarness({
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  installed: false,
  version: null,
  loginState: 'unknown',
  loginMethods: [],
  retired: true,
});

/**
 * Build an overview with all four harnesses.
 *
 * @param overrides - Fields to override
 * @returns Overview
 */
export function makeOverview(overrides: Partial<HarnessOverview> = {}): HarnessOverview {
  return {
    harnesses: [makeHarness(), CODEX, ANTIGRAVITY, GEMINI],
    orcHarness: 'claude-code',
    systemTools: [{ id: 'jq', installed: true, installHint: 'brew install jq' }],
    ...overrides,
  };
}

/**
 * Build a login session.
 *
 * @param overrides - Fields to override
 * @returns Session
 */
export function makeSession(overrides: Partial<LoginSession> = {}): LoginSession {
  return {
    id: 'sess-1',
    harnessId: 'claude-code',
    method: 'subscription',
    state: 'awaiting_user',
    url: null,
    userCode: null,
    needsInput: false,
    message: null,
    screen: null,
    startedAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
    ...overrides,
  };
}
