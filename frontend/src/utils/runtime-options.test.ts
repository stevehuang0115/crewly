/**
 * Tests for the runtime picker options.
 *
 * @module utils/runtime-options.test
 */

import { describe, it, expect } from 'vitest';
import {
  MEMBER_RUNTIME_LABELS,
  RUNTIME_PICKER_ORDER,
  getSelectableRuntimes,
  isRetiredRuntime,
  runtimeOptionLabel,
} from './runtime-options';
import { AI_RUNTIMES, AI_RUNTIME_DISPLAY_NAMES } from '../types/settings.types';

describe('runtime-options', () => {
  it('covers every runtime exactly once', () => {
    expect([...RUNTIME_PICKER_ORDER].sort()).toEqual([...AI_RUNTIMES].sort());
    expect(Object.keys(MEMBER_RUNTIME_LABELS).sort()).toEqual([...AI_RUNTIMES].sort());
  });

  it('offers Antigravity CLI and not Gemini CLI to new choices', () => {
    const offered = getSelectableRuntimes('claude-code');
    expect(offered).toContain('antigravity-cli');
    expect(offered).not.toContain('gemini-cli');
    expect(getSelectableRuntimes()).not.toContain('gemini-cli');
    expect(getSelectableRuntimes(null)).not.toContain('gemini-cli');
  });

  it('keeps Gemini CLI for a member that already uses it', () => {
    expect(getSelectableRuntimes('gemini-cli')).toEqual([
      'claude-code',
      'codex-cli',
      'antigravity-cli',
      'opencode-cli',
      'crewly-agent',
      'gemini-cli',
    ]);
  });

  it('labels only retired runtimes "(enterprise only)"', () => {
    expect(isRetiredRuntime('gemini-cli')).toBe(true);
    expect(isRetiredRuntime('antigravity-cli')).toBe(false);
    expect(isRetiredRuntime(undefined)).toBe(false);
    expect(runtimeOptionLabel('gemini-cli')).toBe('Gemini CLI (enterprise only)');
    expect(runtimeOptionLabel('antigravity-cli')).toBe('Antigravity CLI');
    expect(runtimeOptionLabel('claude-code', AI_RUNTIME_DISPLAY_NAMES)).toBe('Claude Code');
    expect(runtimeOptionLabel('gemini-cli', AI_RUNTIME_DISPLAY_NAMES)).toBe('Gemini CLI (enterprise only)');
  });
});
