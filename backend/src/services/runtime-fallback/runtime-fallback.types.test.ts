/**
 * Tests for runtime-fallback settings validation and labels.
 */

import {
	RuntimeFallbackSettingsError,
	applySettingsPatch,
	defaultRuntimeFallbackSettings,
	isKnownRuntimeTarget,
	normalizeSettings,
	runtimeLabel,
	runtimeShortLabel,
} from './runtime-fallback.types.js';

describe('runtime fallback settings', () => {
	it('defaults to claude-code → crewly-agent → antigravity-cli', () => {
		expect(defaultRuntimeFallbackSettings()).toMatchObject({
			enabled: true,
			chain: ['claude-code', 'crewly-agent', 'antigravity-cli'],
			memberChains: {},
			orcFollows: true,
			crewlyAgentModel: 'deepseek/deepseek-chat',
			probeIntervalMinutes: 15,
		});
	});

	it('applies a valid patch and drops duplicate chain entries', () => {
		const next = applySettingsPatch(defaultRuntimeFallbackSettings(), {
			chain: ['codex-cli', 'antigravity-cli', 'codex-cli'],
			orcFollows: false,
			memberChains: { m1: ['antigravity-cli'], m2: [] },
			probeIntervalMinutes: 30,
		});
		expect(next.chain).toEqual(['codex-cli', 'antigravity-cli']);
		expect(next.orcFollows).toBe(false);
		expect(next.memberChains).toEqual({ m1: ['antigravity-cli'] });
		expect(next.probeIntervalMinutes).toBe(30);
	});

	it.each([
		[{ chain: ['claude-code', 'nope'] }],
		[{ chain: 'claude-code' }],
		[{ enabled: 'yes' }],
		[{ memberChains: { m1: ['bad'] } }],
		[{ crewlyAgentModel: 'deepseek chat' }],
		[{ probeIntervalMinutes: 1 }],
		[null],
		[['claude-code']],
	])('rejects an invalid patch %j', (patch) => {
		expect(() => applySettingsPatch(defaultRuntimeFallbackSettings(), patch)).toThrow(RuntimeFallbackSettingsError);
	});

	it('normalizes stored settings field by field, keeping defaults for bad fields', () => {
		const s = normalizeSettings({ chain: ['antigravity-cli'], probeIntervalMinutes: 'x', orcFollows: false });
		expect(s.chain).toEqual(['antigravity-cli']);
		expect(s.probeIntervalMinutes).toBe(15);
		expect(s.orcFollows).toBe(false);
		expect(normalizeSettings(undefined)).toEqual(defaultRuntimeFallbackSettings());
	});
});

describe('labels', () => {
	it('calls a DeepSeek Crewly Agent "DeepSeek"', () => {
		expect(runtimeLabel('crewly-agent', 'deepseek/deepseek-chat')).toBe('DeepSeek');
		expect(runtimeLabel('crewly-agent', 'google/gemini-3-flash-preview')).toBe('Crewly Agent');
		expect(runtimeLabel('claude-code')).toBe('Claude Code');
		expect(runtimeShortLabel('claude-code')).toBe('Claude');
		expect(runtimeLabel('mystery')).toBe('mystery');
	});
});

describe('Claude Code accounts in chains (#942)', () => {
	it('accepts claude-code@<name> entries and refuses other accounts', () => {
		expect(isKnownRuntimeTarget('claude-code@work')).toBe(true);
		expect(isKnownRuntimeTarget('codex-cli@work')).toBe(false);
		expect(isKnownRuntimeTarget('claude-code@../x')).toBe(false);
		const next = applySettingsPatch(defaultRuntimeFallbackSettings(), { chain: ['claude-code', 'claude-code@work', 'claude-code@work', 'crewly-agent'] });
		expect(next.chain).toEqual(['claude-code', 'claude-code@work', 'crewly-agent']);
		expect(() => applySettingsPatch(defaultRuntimeFallbackSettings(), { chain: ['claude-code@Bad Name'] })).toThrow(RuntimeFallbackSettingsError);
		expect(applySettingsPatch(defaultRuntimeFallbackSettings(), { memberChains: { m1: ['claude-code@b'] } }).memberChains).toEqual({ m1: ['claude-code@b'] });
	});

	it('labels an account', () => {
		expect(runtimeLabel('claude-code@work')).toBe('Claude Code (work)');
		expect(runtimeShortLabel('claude-code@work')).toBe('Claude (work)');
	});
});
