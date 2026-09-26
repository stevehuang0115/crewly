/**
 * Tests for the harness registry.
 */

import {
	HARNESS_DEFINITIONS,
	describeInstallCommand,
	getBrokerLoginMethod,
	getHarnessDefinition,
	getLoginMethod,
	isRetiredHarness,
	listHarnessDefinitions,
	resolveHarnessAlias,
	toPublicLoginMethods,
} from './harness-registry.js';

describe('harness registry', () => {
	it('lists Claude Code first (the default), then Codex, Antigravity CLI and the retired Gemini CLI', () => {
		expect(listHarnessDefinitions().map((d) => d.id)).toEqual(['claude-code', 'codex-cli', 'antigravity-cli', 'gemini-cli']);
		expect(listHarnessDefinitions()).toBe(HARNESS_DEFINITIONS);
	});

	it('names the install method and binaries', () => {
		expect(getHarnessDefinition('claude-code')).toMatchObject({
			command: 'claude',
			install: { kind: 'npm', npmPackage: '@anthropic-ai/claude-code' },
			versionArgs: ['--version'],
		});
		expect(getHarnessDefinition('codex-cli')).toMatchObject({ command: 'codex', install: { kind: 'npm', npmPackage: '@openai/codex' } });
		expect(getHarnessDefinition('gemini-cli')).toMatchObject({ command: 'gemini', install: { kind: 'npm', npmPackage: '@google/gemini-cli' } });
		expect(getHarnessDefinition('nope')).toBeUndefined();
	});

	it('installs Antigravity CLI with the official script from antigravity.google (no npm package exists)', () => {
		const def = getHarnessDefinition('antigravity-cli')!;
		expect(def).toMatchObject({ displayName: 'Antigravity CLI', command: 'agy', versionArgs: ['--version'] });
		expect(def.install).toEqual({ kind: 'script', scriptUrl: 'https://antigravity.google/cli/install.sh', updateArgs: ['update'] });
		expect(describeInstallCommand(def)).toBe('curl -fsSL https://antigravity.google/cli/install.sh | bash');
		expect(describeInstallCommand(getHarnessDefinition('codex-cli')!)).toBe('npm install -g @openai/codex');
	});

	it('Antigravity CLI takes a Gemini API key only — no broker (OAuth) login, by policy', () => {
		expect(toPublicLoginMethods(getHarnessDefinition('antigravity-cli')!)).toEqual([{ id: 'api_key', label: 'Gemini API key', kind: 'api_key' }]);
		expect(getBrokerLoginMethod('antigravity-cli')).toBeUndefined();
		expect(getLoginMethod('antigravity-cli', 'subscription')).toBeUndefined();
		expect(getLoginMethod('antigravity-cli', 'device')).toBeUndefined();
	});

	it('marks only Gemini CLI as retired', () => {
		expect(isRetiredHarness('gemini-cli')).toBe(true);
		expect(isRetiredHarness('antigravity-cli')).toBe(false);
		expect(isRetiredHarness('claude-code')).toBe(false);
		expect(isRetiredHarness('nope')).toBe(false);
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
		expect(resolveHarnessAlias('antigravity')).toBe('antigravity-cli');
		expect(resolveHarnessAlias('AGY')).toBe('antigravity-cli');
		expect(resolveHarnessAlias('antigravity-cli')).toBe('antigravity-cli');
		expect(resolveHarnessAlias('codex-cli')).toBe('codex-cli');
		expect(resolveHarnessAlias(' claude-code ')).toBe('claude-code');
		expect(resolveHarnessAlias('opencode')).toBeNull();
		expect(resolveHarnessAlias('')).toBeNull();
		expect(resolveHarnessAlias(undefined)).toBeNull();
	});
});
