/**
 * Tests for the effective-runtime hooks.
 */

import {
	effectiveClaudeAccount,
	effectiveRuntimeType,
	reportRuntimeLoginExpiry,
	reportRuntimeOutput,
	resolveLaunchRuntime,
	runtimeFallbackBeforeDelivery,
	setRuntimeFallbackHooks,
	takeRuntimeSwitchKickoffNote,
	type RuntimeFallbackHooks,
} from './effective-runtime.js';

describe('effective-runtime hooks', () => {
	afterEach(() => setRuntimeFallbackHooks(null));

	it('is a no-op without hooks', async () => {
		expect(effectiveRuntimeType('dev-1', 'claude-code')).toBe('claude-code');
		await expect(resolveLaunchRuntime({ sessionName: 'dev-1', configured: 'claude-code', isOrchestrator: false })).resolves.toEqual({
			runtime: 'claude-code',
			overridden: false,
		});
		expect(runtimeFallbackBeforeDelivery('dev-1', 'claude-code')).toBe('deliver');
		expect(reportRuntimeOutput('dev-1', 'claude-code', 'x', 'output')).toBe(false);
		expect(takeRuntimeSwitchKickoffNote('dev-1')).toBeNull();
		expect(effectiveClaudeAccount('dev-1')).toBeNull();
		expect(reportRuntimeLoginExpiry('dev-1')).toBe(false);
	});

	it('routes to the registered hooks', async () => {
		const h: RuntimeFallbackHooks = {
			overrideFor: (s) => (s === 'dev-1' ? 'crewly-agent' : null),
			resolveLaunch: async (i) => ({ runtime: 'antigravity-cli', overridden: i.configured !== 'antigravity-cli' }),
			beforeDelivery: () => 'queue',
			reportOutput: () => true,
			takeKickoffNote: () => 'note',
			accountFor: (s) => (s === 'dev-3' ? 'work' : null),
			reportLoginExpiry: (s) => s === 'dev-3',
		};
		setRuntimeFallbackHooks(h);
		expect(effectiveRuntimeType('dev-1', 'claude-code')).toBe('crewly-agent');
		expect(effectiveRuntimeType('dev-2', 'claude-code')).toBe('claude-code');
		expect(effectiveRuntimeType(undefined, 'claude-code')).toBe('claude-code');
		await expect(resolveLaunchRuntime({ sessionName: 'dev-1', configured: 'claude-code', isOrchestrator: false })).resolves.toEqual({
			runtime: 'antigravity-cli',
			overridden: true,
		});
		expect(runtimeFallbackBeforeDelivery('dev-1', 'claude-code')).toBe('queue');
		expect(reportRuntimeOutput('dev-1', 'claude-code', 'x', 'output')).toBe(true);
		expect(takeRuntimeSwitchKickoffNote('dev-1')).toBe('note');
		expect(effectiveClaudeAccount('dev-3')).toBe('work');
		expect(effectiveClaudeAccount('dev-1')).toBeNull();
		expect(effectiveClaudeAccount(null)).toBeNull();
		expect(reportRuntimeLoginExpiry('dev-3')).toBe(true);
		expect(reportRuntimeLoginExpiry('dev-1')).toBe(false);
	});

	it('falls back to the configured runtime when a hook throws', async () => {
		setRuntimeFallbackHooks({
			overrideFor: () => {
				throw new Error('boom');
			},
			resolveLaunch: async () => {
				throw new Error('boom');
			},
			beforeDelivery: () => {
				throw new Error('boom');
			},
			reportOutput: () => {
				throw new Error('boom');
			},
			takeKickoffNote: () => {
				throw new Error('boom');
			},
			accountFor: () => {
				throw new Error('boom');
			},
			reportLoginExpiry: () => {
				throw new Error('boom');
			},
		});
		expect(effectiveRuntimeType('dev-1', 'claude-code')).toBe('claude-code');
		await expect(resolveLaunchRuntime({ sessionName: 'dev-1', configured: 'codex-cli', isOrchestrator: false })).resolves.toEqual({
			runtime: 'codex-cli',
			overridden: false,
		});
		expect(runtimeFallbackBeforeDelivery('dev-1', 'claude-code')).toBe('deliver');
		expect(reportRuntimeOutput('dev-1', 'claude-code', 'x', 'output')).toBe(false);
		expect(takeRuntimeSwitchKickoffNote('dev-1')).toBeNull();
		expect(effectiveClaudeAccount('dev-1')).toBeNull();
		expect(reportRuntimeLoginExpiry('dev-1')).toBe(false);
	});
});
