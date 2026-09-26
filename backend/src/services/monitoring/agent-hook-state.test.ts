/**
 * Tests for the agent hook state store (#815).
 */

import {
	clearHookSignal,
	getHookSignal,
	hookEventToSignal,
	recordHookEvent,
	resetHookState,
} from './agent-hook-state.js';
import { AGENT_STATUS_HOOK_CONSTANTS } from '../../constants.js';

describe('agent-hook-state', () => {
	beforeEach(() => resetHookState());

	describe('hookEventToSignal', () => {
		it.each([
			['PermissionRequest', undefined, { state: 'waiting', kind: 'permission' }],
			['Notification', 'permission_prompt', { state: 'waiting', kind: 'permission' }],
			['Notification', 'elicitation_dialog', { state: 'waiting', kind: 'menu' }],
			['Stop', undefined, { state: 'cleared' }],
			['UserPromptSubmit', undefined, { state: 'cleared' }],
			['PostToolUse', undefined, { state: 'cleared' }],
		])('%s/%s -> %j', (event, type, expected) => {
			expect(hookEventToSignal(event, type)).toEqual(expected);
		});

		it('says nothing for an idle prompt or an unknown event', () => {
			expect(hookEventToSignal('Notification', 'idle_prompt')).toBeNull();
			expect(hookEventToSignal('Notification')).toBeNull();
			expect(hookEventToSignal('SessionStart')).toBeNull();
		});
	});

	it('keeps the latest signal per session', () => {
		recordHookEvent('s1', 'Notification', 'permission_prompt', new Date('2026-09-26T10:00:00Z'));
		expect(getHookSignal('s1')).toMatchObject({ state: 'waiting', kind: 'permission', at: '2026-09-26T10:00:00.000Z' });
		recordHookEvent('s1', 'PostToolUse', undefined, new Date('2026-09-26T10:01:00Z'));
		expect(getHookSignal('s1')).toMatchObject({ state: 'cleared', event: 'PostToolUse' });
		expect(getHookSignal('s1')?.kind).toBeUndefined();
	});

	it('does not store an event that says nothing about waiting', () => {
		expect(recordHookEvent('s1', 'Notification', 'idle_prompt')).toBeNull();
		expect(getHookSignal('s1')).toBeUndefined();
	});

	it('forgets a session on clear', () => {
		recordHookEvent('s1', 'Stop');
		clearHookSignal('s1');
		expect(getHookSignal('s1')).toBeUndefined();
	});

	it('is bounded: the oldest session is dropped past the cap', () => {
		const cap = AGENT_STATUS_HOOK_CONSTANTS.MAX_TRACKED_SESSIONS;
		for (let i = 0; i <= cap; i += 1) recordHookEvent(`s${i}`, 'Stop');
		expect(getHookSignal('s0')).toBeUndefined();
		expect(getHookSignal(`s${cap}`)).toBeDefined();
		expect(getHookSignal('s1')).toBeDefined();
	});
});
