/**
 * Tests for harness constants.
 *
 * @module constants/harness.constants.test
 */

import { describe, it, expect } from 'vitest';
import {
  HARNESS_API,
  HARNESS_TIMING,
  DEFAULT_ORC_HARNESS,
  HARNESS_ORDER,
  SETUP_REDIRECT_EXEMPT_PREFIXES,
  API_KEY_CONSOLE_URLS,
  loginMethodLabel,
  LOGIN_STATE_BADGES,
  LOGIN_SESSION_STATE_LABELS,
} from './harness.constants';

describe('harness.constants', () => {
  it('builds the contract endpoints', () => {
    expect(HARNESS_API.STATUS).toBe('/api/harness');
    expect(HARNESS_API.ORC).toBe('/api/harness/orc');
    expect(HARNESS_API.install('claude-code')).toBe('/api/harness/claude-code/install');
    expect(HARNESS_API.installJob('j1')).toBe('/api/harness/install/j1');
    expect(HARNESS_API.login('codex-cli')).toBe('/api/harness/codex-cli/login');
    expect(HARNESS_API.loginSession('s1')).toBe('/api/harness/login/s1');
    expect(HARNESS_API.loginInput('s1')).toBe('/api/harness/login/s1/input');
    expect(HARNESS_API.loginCancel('s1')).toBe('/api/harness/login/s1/cancel');
    expect(HARNESS_API.apiKey('claude-code')).toBe('/api/harness/claude-code/api-key');
  });

  it('encodes path segments', () => {
    expect(HARNESS_API.installJob('a/b')).toBe('/api/harness/install/a%2Fb');
  });

  it('uses the contract poll intervals', () => {
    expect(HARNESS_TIMING.INSTALL_POLL_MS).toBe(1000);
    expect(HARNESS_TIMING.LOGIN_POLL_MS).toBe(1500);
  });

  it('defaults the orc harness to Claude Code and lists it first', () => {
    expect(DEFAULT_ORC_HARNESS).toBe('claude-code');
    expect(HARNESS_ORDER[0]).toBe('claude-code');
  });

  it('exempts setup and auth pages from the redirect', () => {
    expect(SETUP_REDIRECT_EXEMPT_PREFIXES).toContain('/setup');
    expect(SETUP_REDIRECT_EXEMPT_PREFIXES).toContain('/auth');
  });

  it('links the Anthropic key console', () => {
    expect(API_KEY_CONSOLE_URLS['claude-code']?.url).toBe('https://console.anthropic.com/settings/keys');
  });

  it('prefers Chinese method labels and falls back to the backend label', () => {
    expect(loginMethodLabel('claude-code', 'subscription', 'x')).toBe('用 Claude 订阅登录');
    expect(loginMethodLabel('codex-cli', 'device', 'x')).toBe('用 ChatGPT 账号登录');
    expect(loginMethodLabel('gemini-cli', 'device', 'Backend label')).toBe('Backend label');
  });

  it('has a badge for every login state and a label for every session state', () => {
    expect(Object.keys(LOGIN_STATE_BADGES).sort()).toEqual(['logged_in', 'logged_out', 'unknown']);
    expect(Object.keys(LOGIN_SESSION_STATE_LABELS)).toHaveLength(7);
  });
});
