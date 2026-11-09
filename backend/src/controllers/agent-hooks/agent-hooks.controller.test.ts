/**
 * Tests for POST /api/agent-hooks (#815).
 */

import type { Request, Response } from 'express';
import { receiveAgentHook } from './agent-hooks.controller.js';
import { getHookSignal, resetHookState } from '../../services/monitoring/agent-hook-state.js';
import * as recorder from '../../services/trace/trace-recorder.js';
import { AgentTurnStateService } from '../../services/monitoring/agent-turn-state.js';
import { CredentialGuardAlertService } from '../../services/monitoring/credential-guard-alerts.js';
import { ownerHookNoteFor } from '../../services/messaging/owner-hook-message.js';
import { WindDownService } from '../../services/system/wind-down.service.js';
import { BoardActivityTracker, getBoardActivity } from '../../services/board/board-activity.tracker.js';
import { setRuntimeFallbackHooks, type RuntimeFallbackHooks } from '../../services/runtime-fallback/effective-runtime.js';
import { markUsageLimited, resetUsageLimitState, usageLimitOf } from '../../services/runtime-fallback/usage-limit-state.js';
import { USAGE_LIMIT_STATE_CONSTANTS } from '../../constants.js';

// The owner-message note reads the real queue; stub that one lookup (the
// joining stays real).
jest.mock('../../services/messaging/owner-hook-message.js', () => ({
	...jest.requireActual('../../services/messaging/owner-hook-message.js'),
	ownerHookNoteFor: jest.fn(() => null),
}));
const ownerNote = ownerHookNoteFor as jest.MockedFunction<typeof ownerHookNoteFor>;

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

	it.each(['Stop', 'PostToolUse'])('a %s hook (the agent works again) lifts a usage-limit state', (event) => {
		const seen = Date.now() - USAGE_LIMIT_STATE_CONSTANTS.LIFT_GRACE_MS - 1;
		markUsageLimited({ sessionName: 'crewly-dev-1', runtime: 'claude-code', ruleId: 'claude.hit_your_limit', resetAt: Date.now() + 3_600_000, source: 'output' }, seen);
		try {
			call(SESSION, { event });
			expect(usageLimitOf('crewly-dev-1')).toBeNull();
		} finally {
			resetUsageLimitState();
		}
	});

	it('a hook other than Stop / PostToolUse leaves a usage-limit state alone', () => {
		const seen = Date.now() - USAGE_LIMIT_STATE_CONSTANTS.LIFT_GRACE_MS - 1;
		markUsageLimited({ sessionName: 'crewly-dev-1', runtime: 'claude-code', ruleId: 'claude.hit_your_limit', resetAt: Date.now() + 3_600_000, source: 'output' }, seen);
		try {
			call(SESSION, { event: 'Notification', notificationType: 'permission_prompt' });
			expect(usageLimitOf('crewly-dev-1')).not.toBeNull();
		} finally {
			resetUsageLimitState();
		}
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

	it('a PreToolUse tells the runtime fallback the session is working (only that event)', () => {
		const reportWorking = jest.fn();
		setRuntimeFallbackHooks({ reportWorking } as unknown as RuntimeFallbackHooks);
		try {
			call(SESSION, { event: 'UserPromptSubmit' });
			call(SESSION, { event: 'Stop' });
			expect(reportWorking).not.toHaveBeenCalled();
			call(SESSION, { event: 'PreToolUse', toolUseId: 'toolu_01XYZ' });
			expect(reportWorking).toHaveBeenCalledWith('crewly-dev-1');
		} finally {
			setRuntimeFallbackHooks(null);
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

describe('receiveAgentHook — team-lead execution nudge (crewly#1083)', () => {
	/** Run the handler and wait for its (possibly async) response. */
	function callAsync(headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
		return new Promise((resolve) => {
			const out = { status: 0, json: {} as Record<string, unknown> };
			const res = {
				status(code: number) { out.status = code; return this; },
				json(payload: Record<string, unknown>) { out.json = payload; resolve(out); return this; },
			} as unknown as Response;
			receiveAgentHook({ headers, body } as unknown as Request, res);
		});
	}

	let observe: jest.SpyInstance;

	beforeEach(async () => {
		resetHookState();
		AgentTurnStateService.resetInstance();
		const { TlDelegationService } = await import('../../services/tl-delegation/tl-delegation.service.js');
		observe = jest.spyOn(TlDelegationService.prototype, 'observeToolUse');
	});

	afterEach(() => observe.mockRestore());

	it('returns the nudge as additionalContext on a PostToolUse with a tool name', async () => {
		observe.mockResolvedValue('[CREWLY-NUDGE] delegate this');
		const r = await callAsync(SESSION, { event: 'PostToolUse', toolUseId: 'toolu_1', toolName: 'Edit' });
		expect(r.status).toBe(202);
		expect(r.json).toMatchObject({ success: true, additionalContext: '[CREWLY-NUDGE] delegate this' });
		expect(observe).toHaveBeenCalledWith('crewly-dev-1', 'Edit');
	});

	it('answers without a note when there is none, or when the check fails', async () => {
		observe.mockResolvedValue(null);
		expect((await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Write' })).json).not.toHaveProperty('additionalContext');
		observe.mockRejectedValue(new Error('boom'));
		const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Write' });
		expect(r.status).toBe(202);
		expect(r.json).not.toHaveProperty('additionalContext');
	});

	it('does not look for a nudge on other events or without a tool name', () => {
		expect(call(SESSION, { event: 'PostToolUse' }).status).toBe(202);
		expect(call(SESSION, { event: 'PreToolUse', toolName: 'Edit' }).status).toBe(202);
		expect(observe).not.toHaveBeenCalled();
	});

	describe('owner message at the tool boundary', () => {
		afterEach(() => ownerNote.mockReset().mockReturnValue(null));

		it('returns the waiting owner message as additionalContext', async () => {
			observe.mockResolvedValue(null);
			ownerNote.mockReturnValue('[OWNER MESSAGE] answer now\n\nowner: hi');
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolUseId: 'toolu_1', toolName: 'Bash' });
			expect(r.json).toMatchObject({ success: true, additionalContext: '[OWNER MESSAGE] answer now\n\nowner: hi' });
			// The owner note is given the room the other notes leave (it is fitted, never sliced).
			expect(ownerNote).toHaveBeenCalledWith('crewly-dev-1', expect.anything(), undefined, expect.any(Number));
			const room = (ownerNote.mock.calls[0] as unknown[])[3] as number;
			expect(room).toBeLessThan(6000);
			expect(room).toBeGreaterThan(5000);
		});

		it('puts the owner message ahead of the nudge', async () => {
			observe.mockResolvedValue('[CREWLY-NUDGE] delegate this');
			ownerNote.mockReturnValue('[OWNER MESSAGE] owner: hi');
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Edit' });
			expect(r.json.additionalContext).toBe('[OWNER MESSAGE] owner: hi\n\n[CREWLY-NUDGE] delegate this');
		});

		it("never hands it to a subagent's tool call", async () => {
			observe.mockResolvedValue(null);
			ownerNote.mockReturnValue('[OWNER MESSAGE] owner: hi');
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Bash', agentId: 'aec1310fcf3b9c9e3' });
			expect(r.json).not.toHaveProperty('additionalContext');
			expect(ownerNote).not.toHaveBeenCalled();
		});

		it('still answers (with the nudge only) when the owner lookup throws', async () => {
			observe.mockResolvedValue('[CREWLY-NUDGE] delegate this');
			ownerNote.mockImplementation(() => {
				throw new Error('store unreadable');
			});
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Edit' });
			expect(r.status).toBe(202);
			expect(r.json.additionalContext).toBe('[CREWLY-NUDGE] delegate this');
		});

		it('is not looked up without a tool name or on other events', () => {
			call(SESSION, { event: 'PostToolUse' });
			call(SESSION, { event: 'PreToolUse', toolName: 'Bash' });
			expect(ownerNote).not.toHaveBeenCalled();
		});
	});

	describe('wind-down note at the tool boundary', () => {
		afterEach(() => {
			WindDownService.setInstance(null);
			ownerNote.mockReset().mockReturnValue(null);
		});

		it('hands a busy agent the wind-down note, ahead of the owner message', async () => {
			observe.mockResolvedValue(null);
			ownerNote.mockReturnValue('[OWNER MESSAGE] owner: hi');
			WindDownService.setInstance({ noteForHook: jest.fn(() => '[Crewly wind-down] stop at a safe point') } as unknown as WindDownService);
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Bash' });
			expect(r.json.additionalContext).toBe('[Crewly wind-down] stop at a safe point\n\n[OWNER MESSAGE] owner: hi');
		});

		it('adds nothing when no wind-down is running', async () => {
			observe.mockResolvedValue(null);
			const r = await callAsync(SESSION, { event: 'PostToolUse', toolName: 'Bash' });
			expect(r.json).not.toHaveProperty('additionalContext');
		});
	});

	it('rejects a malformed tool name', () => {
		expect(call(SESSION, { event: 'PostToolUse', toolName: 'Edit; rm -rf /' })).toEqual({ status: 400, json: { success: false, error: 'invalid toolName' } });
	});
});

describe('receiveAgentHook — team roster after a compaction (specs/2026-10-10-team-roster.md)', () => {
	/** Run the handler and wait for its (possibly async) response. */
	function callAsync(headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
		return new Promise((resolve) => {
			const out = { status: 0, json: {} as Record<string, unknown> };
			const res = {
				status(code: number) { out.status = code; return this; },
				json(payload: Record<string, unknown>) { out.json = payload; resolve(out); return this; },
			} as unknown as Response;
			receiveAgentHook({ headers, body } as unknown as Request, res);
		});
	}

	const ORC = { 'x-agent-session': 'crewly-orc' };
	let render: jest.SpyInstance;

	beforeEach(async () => {
		resetHookState();
		AgentTurnStateService.resetInstance();
		const { TeamRosterService } = await import('../../services/team-roster/team-roster.service.js');
		render = jest.spyOn(TeamRosterService.prototype, 'renderForPrompt');
	});

	afterEach(() => render.mockRestore());

	it('hands the orchestrator the roster as additionalContext after a compact or a clear', async () => {
		render.mockResolvedValue('## Team Roster\n### CE');
		for (const source of ['compact', 'clear']) {
			const r = await callAsync(ORC, { event: 'SessionStart', source });
			expect(r.status).toBe(202);
			expect(r.json).toMatchObject({ success: true, additionalContext: '## Team Roster\n### CE' });
		}
	});

	it('does not hand it back on a fresh start or a resume, nor to any other agent', async () => {
		render.mockResolvedValue('## Team Roster');
		expect(call(ORC, { event: 'SessionStart', source: 'startup' }).json).not.toHaveProperty('additionalContext');
		expect(call(ORC, { event: 'SessionStart', source: 'resume' }).json).not.toHaveProperty('additionalContext');
		expect(call(SESSION, { event: 'SessionStart', source: 'compact' }).json).not.toHaveProperty('additionalContext');
		expect(render).not.toHaveBeenCalled();
	});

	it('answers without a note when the roster is empty or cannot be built', async () => {
		render.mockResolvedValue('');
		expect((await callAsync(ORC, { event: 'SessionStart', source: 'compact' })).json).not.toHaveProperty('additionalContext');
		render.mockRejectedValue(new Error('boom'));
		const r = await callAsync(ORC, { event: 'SessionStart', source: 'compact' });
		expect(r.status).toBe(202);
		expect(r.json).not.toHaveProperty('additionalContext');
	});

	describe('owner board activity (crewly#1247)', () => {
		beforeEach(() => BoardActivityTracker.resetInstance());

		it('a PreToolUse with a tool input slice becomes a redacted activity; the raw command is not kept', () => {
			const secret = 'sk-ant-api03-THISISAFAKEKEYFORTESTING0123456789abcdef';
			expect(
				call(SESSION, {
					event: 'PreToolUse',
					toolUseId: 'toolu_1',
					toolName: 'Bash',
					toolInput: { command: `git push --token ${secret}`, content: 'IGNORED', filePath: '/tmp/x.txt' },
				}).status,
			).toBe(202);
			const live = getBoardActivity().live('crewly-dev-1', true);
			expect(live.activity).toMatchObject({ type: 'command', detail: 'git push' });
			expect(JSON.stringify([live, getBoardActivity().timeline('crewly-dev-1'), getBoardActivity().peekUnsent()])).not.toMatch(/sk-ant|IGNORED/);
		});

		it('ignores a toolInput on other events and junk shapes', () => {
			call(SESSION, { event: 'PostToolUse', toolUseId: 'toolu_1', toolName: 'Bash', toolInput: { command: 'rm -rf /' } });
			call(SESSION, { event: 'PreToolUse', toolUseId: 'toolu_2', toolName: 'Edit', toolInput: 'not an object' });
			expect(getBoardActivity().live('crewly-dev-1', true).activity?.type).toBe('coding');
			expect(getBoardActivity().timeline('crewly-dev-1').map((e) => e.text)).toEqual(['Edited a file']);
		});

		it('Stop ends the activity and a permission prompt is a wait on the owner', () => {
			call(SESSION, { event: 'PreToolUse', toolUseId: 'toolu_1', toolName: 'Read', toolInput: { filePath: '/tmp/a.txt' } });
			call(SESSION, { event: 'Notification', notificationType: 'permission_prompt' });
			expect(getBoardActivity().live('crewly-dev-1', true).activity?.type).toBe('waiting_owner');
			call(SESSION, { event: 'Stop' });
			expect(getBoardActivity().live('crewly-dev-1', false).activity).toBeNull();
		});
	});
});
