/**
 * Tests for model-tier.utils (crewly#1173).
 */

import { describe, it, expect } from '@jest/globals';
import { isModelTier, parseTierModels, resolveTierModel, tierMapFor, tierRank } from './model-tier.utils.js';

describe('isModelTier / tierRank', () => {
  it('knows the three tiers', () => {
    expect(isModelTier('strong')).toBe(true);
    expect(isModelTier('mid')).toBe(true);
    expect(isModelTier('weak')).toBe(true);
    expect(isModelTier('super')).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
  });
  it('ranks strong above mid above weak', () => {
    expect(tierRank('strong')).toBeGreaterThan(tierRank('mid'));
    expect(tierRank('mid')).toBeGreaterThan(tierRank('weak'));
  });
});

describe('resolveTierModel', () => {
  it('maps Claude Code to opus / sonnet / haiku', () => {
    expect(resolveTierModel('claude-code', 'strong')).toBe('opus');
    expect(resolveTierModel('claude-code', 'mid')).toBe('sonnet');
    expect(resolveTierModel('claude-code', 'weak')).toBe('haiku');
  });
  it('uses mid for a runtime without a weak model', () => {
    expect(resolveTierModel('codex-cli', 'weak')).toBe('gpt-5.4');
    expect(resolveTierModel('gemini-cli', 'weak')).toBe('gemini-2.5-flash');
  });
  it('maps Antigravity to its own slugs', () => {
    expect(resolveTierModel('antigravity-cli', 'strong')).toBe('gemini-3.1-pro-high');
    expect(resolveTierModel('antigravity-cli', 'weak')).toBe('gemini-3.8-flash-medium');
  });
  it('leaves unmapped runtimes on their own default', () => {
    expect(resolveTierModel('crewly-agent', 'strong')).toBeUndefined();
    expect(resolveTierModel('opencode-cli', 'weak')).toBeUndefined();
    expect(resolveTierModel('claude-code', undefined)).toBeUndefined();
  });
  it('takes team overrides, ignoring unsafe ones', () => {
    expect(resolveTierModel('claude-code', 'weak', { 'claude-code': { weak: 'claude-haiku-5-5' } })).toBe('claude-haiku-5-5');
    expect(resolveTierModel('claude-code', 'weak', { 'claude-code': { weak: 'haiku; rm -rf /' } })).toBe('haiku');
    expect(resolveTierModel('crewly-agent', 'mid', { 'crewly-agent': { mid: 'deepseek/deepseek-chat' } })).toBe('deepseek/deepseek-chat');
  });
  it('tierMapFor merges the override over the global map', () => {
    expect(tierMapFor('codex-cli', { 'codex-cli': { weak: 'gpt-5-mini' } })).toEqual({ strong: 'gpt-5.6-sol', mid: 'gpt-5.4', weak: 'gpt-5-mini' });
  });
});

describe('parseTierModels', () => {
  it('accepts a valid map and drops empty values', () => {
    expect(parseTierModels({ 'claude-code': { weak: 'haiku', mid: '' } })).toEqual({ ok: true, value: { 'claude-code': { weak: 'haiku' } } });
    expect(parseTierModels(undefined)).toEqual({ ok: true, value: {} });
  });
  it('refuses unknown tiers, bad models and bad shapes', () => {
    expect(parseTierModels({ 'claude-code': { super: 'fable' } }).ok).toBe(false);
    expect(parseTierModels({ 'claude-code': { weak: 'a b' } }).ok).toBe(false);
    expect(parseTierModels([]).ok).toBe(false);
    expect(parseTierModels({ 'claude-code': 'haiku' }).ok).toBe(false);
  });
});
