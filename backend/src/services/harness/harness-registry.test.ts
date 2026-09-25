/**
 * Tests for the harness registry.
 */

import {
	HARNESS_DEFINITIONS,
	getBrokerLoginMethod,
	getHarnessDefinition,
	getLoginMethod,
	listHarnessDefinitions,
	resolveHarnessAlias,
	toPublicLoginMethods,
} from './harness-registry.js';

describe('harness registry', () => {
	it('lists Claude Code first (the default), then Codex and Gemini CLI', () => {
		expect(listHarnessDefinitions().map((d) => d.id)).toEqual(['claude-code', 'codex-cli', 'gemini-cli']);
		expect(listHarnessDefinitions()).toBe(HARNESS_DEFINITIONS);
	});

	it('names the npm packages and binaries', () => {
		expect(getHarnessDefinition('claude-code')).toMatchObject({ command: 'claude', npmPackage: '@anthropic-ai/claude-code', versionArgs: ['--version'] });
		expect(getHarnessDefinition('codex-cli')).toMatchObject({ command: 'codex', npmPackage: '@openai/codex' });
		expect(getHarnessDefinition('gemini-cli')).toMatchObject({ command: 'gemini', npmPackage: '@google/gemini-cli' });
		expect(getHarnessDefinition('nope')).toBeUndefined();
	});

	it('Claude offers subscription (setup-token broker) and API key', () => {
		expect(getLoginMethod('claude-code', 'subscription')?.broker).toEqual({ command: 'claude', args: ['setup-token'] });
		expect(getLoginMethod('claude-code', 'api_key')?.kind).toBe('api_key');
		expect(getBrokerLoginMethod('claude-code')?.id).toBe('subscription');
	});

	it('Codex offers device-code (broker) and API key', () => {
		expect(getLoginMethod('codex-cli', 'device')?.broker).toEqual({ command: 'codex', args: ['login', '--device-auth'] });
		expect(getLoginMethod('codex-cli', 'api_key')?.kind).toBe('api_key');
		expect(getBrokerLoginMethod('codex-cli')?.id).toBe('device');
	});

	it('Gemini CLI is detect-only', () => {
		expect(getHarnessDefinition('gemini-cli')?.loginMethods).toEqual([]);
		expect(getBrokerLoginMethod('gemini-cli')).toBeUndefined();
		expect(getLoginMethod('gemini-cli', 'api_key')).toBeUndefined();
	});

	it('public login methods carry no commands', () => {
		expect(toPublicLoginMethods(getHarnessDefinition('claude-code')!)).toEqual([
			{ id: 'subscription', label: 'Claude subscription (Pro / Max)', kind: 'broker' },
			{ id: 'api_key', label: 'Anthropic API key', kind: 'api_key' },
		]);
	});

	it('resolves CLI aliases', () => {
		expect(resolveHarnessAlias('claude')).toBe('claude-code');
		expect(resolveHarnessAlias('Codex')).toBe('codex-cli');
		expect(resolveHarnessAlias('gemini')).toBe('gemini-cli');
		expect(resolveHarnessAlias('codex-cli')).toBe('codex-cli');
		expect(resolveHarnessAlias(' claude-code ')).toBe('claude-code');
		expect(resolveHarnessAlias('opencode')).toBeNull();
		expect(resolveHarnessAlias('')).toBeNull();
		expect(resolveHarnessAlias(undefined)).toBeNull();
	});
});
