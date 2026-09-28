/**
 * Tests for POST /api/agent-hooks (#815).
 */

import type { Request, Response } from 'express';
import { receiveAgentHook } from './agent-hooks.controller.js';
import { getHookSignal, resetHookState } from '../../services/monitoring/agent-hook-state.js';

/**
 * Build a request/response pair and run the handler.
 *
 * @param headers - Request headers
 * @param body - Request body
 * @returns The status and JSON the handler sent
 */
function call(headers: Record<string, string>, body: unknown): { status: number; json: Record<string, unknown> } {
	const out = { status: 0, json: {} as Record<string, unknown> };
	const res = {
		status(code: number) { out.status = code; return this; },
		json(payload: Record<string, unknown>) { out.json = payload; return this; },
	} as unknown as Response;
	receiveAgentHook({ headers, body } as unknown as Request, res);
	return out;
}

const SESSION = { 'x-agent-session': 'crewly-dev-1' };

describe('receiveAgentHook', () => {
	beforeEach(() => resetHookState());

	it('records a permission prompt as waiting', () => {
		const r = call(SESSION, { event: 'Notification', notificationType: 'permission_prompt' });
		expect(r).toEqual({ status: 202, json: { success: true, recorded: true } });
		expect(getHookSignal('crewly-dev-1')).toMatchObject({ state: 'waiting', kind: 'permission' });
	});

	it('records a cleared signal after the prompt is answered', () => {
		call(SESSION, { event: 'PermissionRequest' });
		call(SESSION, { event: 'PostToolUse' });
		expect(getHookSignal('crewly-dev-1')?.state).toBe('cleared');
	});

	it('accepts an idle prompt without recording anything', () => {
		expect(call(SESSION, { event: 'Notification', notificationType: 'idle_prompt' })).toEqual({
			status: 202, json: { success: true, recorded: false },
		});
		expect(getHookSignal('crewly-dev-1')).toBeUndefined();
	});

	it.each([
		[{}, { event: 'Stop' }, 'missing session'],
		[{ 'x-agent-session': 'bad name; rm -rf' }, { event: 'Stop' }, 'malformed session'],
		[SESSION, { event: 'PreToolUse' }, 'event the hook is not registered for'],
		[SESSION, { event: 42 }, 'non-string event'],
		[SESSION, { event: 'Notification', notificationType: 'something_new' }, 'unknown notification type'],
		[SESSION, { event: 'Notification', notificationType: { x: 1 } }, 'non-string notification type'],
	] as Array<[Record<string, string>, unknown, string]>)('rejects %j %j (%s) with 400 and records nothing', (headers, body, _why) => {
		expect(_why).toBeTruthy();
		expect(call(headers, body).status).toBe(400);
		expect(getHookSignal('crewly-dev-1')).toBeUndefined();
	});

	it('stores only identifiers: extra body fields are never kept', () => {
		call(SESSION, { event: 'PermissionRequest', tool_input: { command: 'sk-ant-secret' }, message: 'sk-ant-secret' });
		expect(JSON.stringify(getHookSignal('crewly-dev-1'))).not.toContain('sk-ant');
	});
});
