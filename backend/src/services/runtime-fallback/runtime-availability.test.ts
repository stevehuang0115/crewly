/**
 * Tests for fallback runtime availability.
 */

import { computeRuntimeAvailability } from './runtime-availability.js';

describe('computeRuntimeAvailability', () => {
	const harnesses = [
		{ id: 'claude-code', installed: true, loginState: 'logged_in' as const },
		{ id: 'codex-cli', installed: true, loginState: 'logged_out' as const },
		{ id: 'antigravity-cli', installed: false, loginState: 'logged_out' as const },
	];

	it('marks installed + signed-in harnesses selectable and gives a reason for the others', () => {
		const list = computeRuntimeAvailability({ harnesses, crewlyAgentModel: 'deepseek/deepseek-chat', hasProviderKey: () => true });
		const by = Object.fromEntries(list.map((a) => [a.runtime, a]));
		expect(by['claude-code']).toEqual({ runtime: 'claude-code', label: 'Claude Code', selectable: true });
		expect(by['codex-cli']).toMatchObject({ selectable: false, reason: 'Not signed in' });
		expect(by['antigravity-cli']).toMatchObject({ selectable: false, reason: 'Not installed' });
		expect(by['gemini-cli']).toMatchObject({ selectable: false, reason: 'Retired (enterprise only)' });
		expect(by['opencode-cli']).toMatchObject({ selectable: false });
		expect(by['crewly-agent']).toEqual({ runtime: 'crewly-agent', label: 'DeepSeek', selectable: true });
	});

	it('needs an API key for the Crewly Agent model provider', () => {
		const list = computeRuntimeAvailability({ harnesses, crewlyAgentModel: 'deepseek/deepseek-chat', hasProviderKey: () => false });
		expect(list.find((a) => a.runtime === 'crewly-agent')).toMatchObject({
			selectable: false,
			reason: 'No DeepSeek API key (Settings → API Keys)',
		});
	});

	it('treats an unknown sign-in state as not selectable', () => {
		const list = computeRuntimeAvailability({
			harnesses: [{ id: 'claude-code', installed: true, loginState: 'unknown' }],
			crewlyAgentModel: 'deepseek/deepseek-chat',
			hasProviderKey: () => true,
		});
		expect(list.find((a) => a.runtime === 'claude-code')).toMatchObject({ selectable: false, reason: "Sign-in couldn't be checked" });
	});

	it('skips a signed-in runtime whose Terms are not accepted, with the reason', () => {
		const list = computeRuntimeAvailability({
			harnesses: [{ id: 'antigravity-cli', installed: true, loginState: 'logged_in' }],
			crewlyAgentModel: 'deepseek/deepseek-chat',
			hasProviderKey: () => true,
			termsBlocked: (r) => (r === 'antigravity-cli' ? "Terms not accepted: You chose Don't agree" : null),
		});
		expect(list.find((a) => a.runtime === 'antigravity-cli')).toEqual({
			runtime: 'antigravity-cli',
			label: expect.any(String),
			selectable: false,
			reason: "Terms not accepted: You chose Don't agree",
			termsBlocked: true,
		});
	});
});

describe('Claude Code accounts (#942)', () => {
	const base = { crewlyAgentModel: 'deepseek/deepseek-chat', hasProviderKey: () => false };

	it('lists each account after the runtimes: ready when signed in, else why not', () => {
		const list = computeRuntimeAvailability({
			...base,
			harnesses: [{ id: 'claude-code', installed: true, loginState: 'logged_in' }],
			claudeAccounts: [
				{ name: 'b', signedIn: true },
				{ name: 'c', signedIn: false },
			],
		});
		expect(list.slice(-2)).toEqual([
			{ runtime: 'claude-code@b', label: 'Claude Code (b)', selectable: true },
			{ runtime: 'claude-code@c', label: 'Claude Code (c)', selectable: false, reason: 'Not signed in (reply `login claude c` in Slack)' },
		]);
	});

	it('needs Claude Code installed', () => {
		const list = computeRuntimeAvailability({ ...base, harnesses: [], claudeAccounts: [{ name: 'b', signedIn: true }] });
		expect(list.find((a) => a.runtime === 'claude-code@b')).toMatchObject({ selectable: false, reason: 'Not installed' });
	});
});
