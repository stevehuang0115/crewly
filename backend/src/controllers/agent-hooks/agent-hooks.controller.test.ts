/**
 * Tests for POST /api/agent-hooks (#815).
 */

import type { Request, Response } from 'express';
import { receiveAgentHook } from './agent-hooks.controller.js';
import { getHookSignal, resetHookState } from '../../services/monitoring/agent-hook-state.js';
import * as recorder from '../../services/trace/trace-recorder.js';
import { AgentTurnStateService } from '../../services/monitoring/agent-turn-state.js';
import { CredentialGuardAlertService } from '../../services/monitoring/credential-guard-alerts.js';

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
	beforeEach(() => {
		resetHookState();
		AgentTurnStateService.resetInstance();
	});

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
		[SESSION, { event: 'SessionEnd' }, 'event the hook is not registered for'],
		[SESSION, { event: 'PreToolUse', toolUseId: '../../etc/passwd' }, 'malformed tool-use id'],
		[SESSION, { event: 'SubagentStart', agentId: { x: 1 } }, 'non-string subagent id'],
		[SESSION, { event: 'SessionStart', source: 'reboot-the-world' }, 'unknown SessionStart source'],
		[SESSION, { event: 42 }, 'non-string event'],
		[SESSION, { event: 'Notification', notificationType: 'something_new' }, 'unknown notification type'],
		[SESSION, { event: 'Notification', notificationType: { x: 1 } }, 'non-string notification type'],
	] as Array<[Record<string, string>, unknown, string]>)('rejects %j %j (%s) with 400 and records nothing', (headers, body, _why) => {
		expect(_why).toBeTruthy();
		expect(call(headers, body).status).toBe(400);
		expect(getHookSignal('crewly-dev-1')).toBeUndefined();
	});

	it('records a credential-guard block: rule + runtime only, owner told through the alert service', () => {
		const record = jest.spyOn(CredentialGuardAlertService.getInstance(), 'record').mockReturnValue({ notified: true });
		const r = call(SESSION, { event: 'CredentialAccessBlocked', rule: 'cloud-config', runtime: 'antigravity', command: 'jq .token secret' });
		expect(r.status).toBe(202);
		expect(r.json).toMatchObject({ recorded: true, notified: true });
		expect(record).toHaveBeenCalledWith({ sessionName: 'crewly-dev-1', rule: 'cloud-config', runtime: 'antigravity' });
		expect(call(SESSION, { event: 'CredentialAccessBlocked', rule: 'bad rule!' }).status).toBe(400);
		expect(call({}, { event: 'CredentialAccessBlocked', rule: 'api-token' }).status).toBe(400);
		record.mockRestore();
	});

	it('records a subagent send-back in the run trace only (#984)', () => {
		const spy = jest.spyOn(recorder, 'traceSubagentSendBack').mockReturnValue(true);
		try {
			expect(call(SESSION, { event: 'SubagentSendBack' })).toEqual({ status: 202, json: { success: true, recorded: true } });
			expect(spy).toHaveBeenCalledWith('crewly-dev-1');
			expect(getHookSignal('crewly-dev-1')).toBeUndefined();
			expect(call({}, { event: 'SubagentSendBack' }).status).toBe(400);
		} finally {
			spy.mockRestore();
		}
	});

	it('feeds the runtime turn state: a long tool call keeps the agent mid-turn', () => {
		const turns = AgentTurnStateService.getInstance();
		expect(call(SESSION, { event: 'UserPromptSubmit' })).toEqual({ status: 202, json: { success: true, recorded: true } });
		expect(call(SESSION, { event: 'PreToolUse', toolUseId: 'toolu_01ABC' })).toEqual({ status: 202, json: { success: true, recorded: true } });
		expect(turns.hookVerdict('crewly-dev-1')).toMatchObject({ state: 'turn', longRunning: true });
		call(SESSION, { event: 'PostToolUse', toolUseId: 'toolu_01ABC' });
		call(SESSION, { event: 'Stop' });
		expect(turns.hookVerdict('crewly-dev-1').state).toBe('idle');
	});

	it('tracks subagents across the end of the turn (held until the transcript confirms them)', () => {
		const turns = AgentTurnStateService.getInstance();
		call(SESSION, { event: 'UserPromptSubmit' });
		call(SESSION, { event: 'SubagentStart', agentId: 'a1d4d935dea1c5443' });
		call(SESSION, { event: 'Stop' });
		expect(turns.hookVerdict('crewly-dev-1')).toMatchObject({ state: 'background', longRunning: true });
		call(SESSION, { event: 'SubagentStop', agentId: 'a1d4d935dea1c5443' });
		expect(turns.hookVerdict('crewly-dev-1').state).toBe('turn');
	});

	it('SessionStart from a new process resets the turn state', () => {
		const turns = AgentTurnStateService.getInstance();
		call(SESSION, { event: 'UserPromptSubmit' });
		expect(call(SESSION, { event: 'SessionStart', source: 'startup' })).toEqual({ status: 202, json: { success: true, recorded: true } });
		expect(turns.hookVerdict('crewly-dev-1').state).toBe('unknown');
	});

	it('stores only identifiers: extra body fields are never kept', () => {
		call(SESSION, { event: 'PermissionRequest', tool_input: { command: 'sk-ant-secret' }, message: 'sk-ant-secret' });
		expect(JSON.stringify(getHookSignal('crewly-dev-1'))).not.toContain('sk-ant');
	});
});
