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
  harnessDisplayName,
  visibleHarnesses,
  API_KEY_PLACEHOLDERS,
} from './harness.constants';
import { ANTIGRAVITY, CODEX, GEMINI, makeHarness } from '../test/harness.fixtures';

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

  it('orders Antigravity CLI before the retired Gemini CLI and labels its key login', () => {
    expect(HARNESS_ORDER).toEqual(['claude-code', 'codex-cli', 'antigravity-cli', 'gemini-cli']);
    expect(loginMethodLabel('antigravity-cli', 'api_key', 'Gemini API key')).toBe('使用 Gemini API Key');
    expect(API_KEY_CONSOLE_URLS['antigravity-cli']?.url).toBe('https://aistudio.google.com/apikey');
    expect(API_KEY_PLACEHOLDERS['antigravity-cli']).toBe('AIza…');
  });

  it('shows a retired harness only when it is installed or the orc harness', () => {
    const all = [makeHarness(), CODEX, ANTIGRAVITY, GEMINI];
    expect(visibleHarnesses(all, 'claude-code').map((h) => h.id)).toEqual(['claude-code', 'codex-cli', 'antigravity-cli']);
    expect(visibleHarnesses(all, 'gemini-cli').map((h) => h.id)).toContain('gemini-cli');
    expect(visibleHarnesses([...all.slice(0, 3), { ...GEMINI, installed: true }], null).map((h) => h.id)).toContain('gemini-cli');
    expect(harnessDisplayName(GEMINI)).toBe('Gemini CLI (enterprise only)');
    expect(harnessDisplayName(ANTIGRAVITY)).toBe('Antigravity CLI');
  });
});
