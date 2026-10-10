/**
 * Tests for AgentTurnStateService (runtime turn state).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTurnStateService } from './agent-turn-state.js';
import { resetTranscriptTurnCache } from './claude-transcript-turn.js';
import { TURN_STATE_CONSTANTS } from '../../constants.js';

const S = 'evership-eve-398f05df';
/** A start time a little in the past, so transcript files (written now) are fresh. */
const T0 = Date.now() - 30 * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

describe('AgentTurnStateService', () => {
	let turns: AgentTurnStateService;
	let dir: string;
	let file: string;

	/**
	 * Write the transcript.
	 *
	 * @param entries - JSONL entries
	 */
	const write = (entries: Array<Record<string, unknown>>): void => {
		fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
		resetTranscriptTurnCache();
	};
	const toolCall = (at: number, input: Record<string, unknown> = {}, id = `toolu_${at}`) => ({
		type: 'assistant',
		timestamp: iso(at),
		message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, input }] },
	});
	const endTurn = (at: number) => ({ type: 'assistant', timestamp: iso(at), message: { stop_reason: 'end_turn', content: [] } });
	const turnDuration = (at: number, pending: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: iso(at), pendingBackgroundAgentCount: pending });

	beforeEach(() => {
		AgentTurnStateService.resetInstance();
		resetTranscriptTurnCache();
		turns = AgentTurnStateService.getInstance();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-state-'));
		file = path.join(dir, 'db6cd3e6.jsonl');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('is a singleton and knows nothing about a silent session', () => {
		expect(AgentTurnStateService.getInstance()).toBe(turns);
		expect(turns.getVerdict(S, T0)).toEqual({ state: 'unknown', longRunning: false, since: null, source: 'none' });
		expect(turns.lastHookEventAt(S)).toBeNull();
	});

	it("follows Eve's turn: busy through silence, background after Stop while Claude Code agrees, busy again, idle", () => {
		turns.setTranscriptLocator(() => file);
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'PreToolUse', { toolUseId: 'toolu_a' }, T0 + 51_000);
		turns.recordHook(S, 'SubagentStart', { agentId: 'a1d4d935dea1c5443' }, T0 + 51_100);
		turns.recordHook(S, 'PostToolUse', { toolUseId: 'toolu_a' }, T0 + 51_200);
		write([toolCall(T0 + 51_000)]);
		// Ninety silent seconds while the model writes a long tool input.
		expect(turns.getVerdict(S, T0 + 141_000)).toEqual({ state: 'turn', longRunning: true, since: T0, source: 'hooks' });

		// 04:40:28 — Stop with the subagent still running; Claude Code counts it pending.
		turns.recordHook(S, 'Stop', {}, T0 + 178_000);
		write([toolCall(T0 + 51_000), endTurn(T0 + 168_000), turnDuration(T0 + 178_000, 1)]);
		expect(turns.getVerdict(S, T0 + 180_000)).toMatchObject({ state: 'background', longRunning: true, since: T0 + 51_100 });
		expect(turns.hasBackgroundWork(S, T0 + 180_000)).toBe(true);

		// 04:41:11 — the subagent finishes and Claude Code resumes the parent by itself.
		turns.recordHook(S, 'SubagentStop', { agentId: 'a1d4d935dea1c5443' }, T0 + 221_000);
		expect(turns.getVerdict(S, T0 + 260_000)).toMatchObject({ state: 'turn', longRunning: false, since: T0 + 221_000 });

		turns.recordHook(S, 'Stop', {}, T0 + 400_000);
		write([toolCall(T0 + 300_000), endTurn(T0 + 395_000), turnDuration(T0 + 400_000, 0)]);
		expect(turns.getVerdict(S, T0 + 401_000)).toMatchObject({ state: 'idle', longRunning: false });
	});

	it('Stop clears subagents unless Claude Code still counts them pending', () => {
		turns.setTranscriptLocator(() => file);
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'SubagentStart', { agentId: 'stale' }, T0 + 1);
		turns.recordHook(S, 'Stop', {}, T0 + 10_000);
		write([endTurn(T0 + 9_000), turnDuration(T0 + 10_000, 0)]);
		expect(turns.getVerdict(S, T0 + 11_000).state).toBe('idle');
		expect(turns.hookVerdict(S, T0 + 11_000).state).toBe('idle'); // dropped for good

		// No transcript to agree: Stop clears them too.
		turns.setTranscriptLocator(null);
		turns.recordHook(S, 'UserPromptSubmit', {}, T0 + 20_000);
		turns.recordHook(S, 'SubagentStart', { agentId: 'x' }, T0 + 20_001);
		turns.recordHook(S, 'Stop', {}, T0 + 30_000);
		expect(turns.getVerdict(S, T0 + 31_000).state).toBe('idle');
	});

	it('a transcript-only background never blocks (finished shell whose notice was queued, or no hooks at all)', () => {
		turns.setTranscriptLocator(() => file);
		// A background shell with no completion notice anywhere: the transcript alone says "background".
		write([toolCall(T0, { run_in_background: true }, 'toolu_bg'), endTurn(T0 + 1_000)]);
		expect(turns.getVerdict(S, T0 + 2_000)).toMatchObject({ state: 'idle', source: 'transcript' });
		turns.recordHook(S, 'Stop', {}, T0 + 1_000);
		expect(turns.getVerdict(S, T0 + 2_000).state).toBe('idle');
	});

	it('Esc / API error / usage limit: a transcript turn end newer than the last hook ends a hook turn', () => {
		turns.setTranscriptLocator(() => file);
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'PreToolUse', { toolUseId: 't1' }, T0 + 1_000);
		write([toolCall(T0 + 1_000)]);
		expect(turns.getVerdict(S, T0 + 5_000).state).toBe('turn');
		write([
			toolCall(T0 + 1_000),
			{ type: 'assistant', isApiErrorMessage: true, timestamp: iso(T0 + 6_000), message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: "You've hit your session limit" }] } },
		]);
		expect(turns.getVerdict(S, T0 + 7_000).state).toBe('idle');

		turns.recordHook(S, 'UserPromptSubmit', {}, T0 + 10_000);
		write([{ type: 'user', timestamp: iso(T0 + 12_000), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }]);
		expect(turns.getVerdict(S, T0 + 13_000).state).toBe('idle');
	});

	it('a turn the hooks missed but the transcript shows (newer than the last hook) is a turn', () => {
		turns.setTranscriptLocator(() => file);
		turns.recordHook(S, 'Stop', {}, T0);
		write([toolCall(T0 + 5_000)]);
		expect(turns.getVerdict(S, T0 + 6_000)).toMatchObject({ state: 'turn', source: 'transcript' });
	});

	it('SessionStart (startup/resume) starts clean and ignores background launched by the old process', () => {
		turns.setTranscriptLocator(() => file);
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'SubagentStart', { agentId: 'old' }, T0 + 1);
		write([toolCall(T0, { run_in_background: true }, 'toolu_old'), endTurn(T0 + 1_000), turnDuration(T0 + 1_000, 1)]);
		turns.recordHook(S, 'SessionStart', { source: 'resume' }, T0 + 60_000);
		expect(turns.hookVerdict(S, T0 + 61_000).state).toBe('unknown');
		expect(turns.getVerdict(S, T0 + 61_000).state).toBe('idle');
		// compact / clear: same process, state kept.
		turns.recordHook(S, 'UserPromptSubmit', {}, T0 + 70_000);
		turns.recordHook(S, 'SessionStart', { source: 'compact' }, T0 + 71_000);
		expect(turns.hookVerdict(S, T0 + 72_000).state).toBe('turn');
	});

	it('noteRuntimeStart and forget drop stale state', () => {
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.noteRuntimeStart(S, T0 + 1_000);
		expect(turns.hookVerdict(S, T0 + 2_000).state).toBe('unknown');
		turns.recordHook(S, 'UserPromptSubmit', {}, T0 + 3_000);
		turns.forget(S);
		expect(turns.knownSessions()).toEqual([]);
	});

	it('ignores events that say nothing about turns', () => {
		expect(turns.recordHook(S, 'Notification', {}, T0)).toBe(false);
		expect(turns.knownSessions()).toEqual([]);
		expect(turns.recordHook(S, 'Stop', {}, T0)).toBe(true);
		expect(turns.knownSessions()).toEqual([S]);
	});

	it('stops trusting an active turn after a long hook silence, unless a tool call is open', () => {
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		expect(turns.hookVerdict(S, T0 + TURN_STATE_CONSTANTS.HOOK_SILENCE_MS - 1).state).toBe('turn');
		expect(turns.hookVerdict(S, T0 + TURN_STATE_CONSTANTS.HOOK_SILENCE_MS + 1).state).toBe('unknown');

		turns.recordHook(S, 'PreToolUse', { toolUseId: 'toolu_long' }, T0);
		expect(turns.hookVerdict(S, T0 + TURN_STATE_CONSTANTS.HOOK_SILENCE_MS + 1)).toMatchObject({ state: 'turn', longRunning: true });
		expect(turns.hookVerdict(S, T0 + TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS + 1).state).toBe('unknown');
	});

	it('counts subagents that report no id', () => {
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'SubagentStart', {}, T0);
		turns.recordHook(S, 'SubagentStart', {}, T0);
		expect(turns.hookVerdict(S, T0 + 1)).toMatchObject({ state: 'turn', longRunning: true });
		turns.recordHook(S, 'SubagentStop', {}, T0 + 2);
		turns.recordHook(S, 'SubagentStop', {}, T0 + 3);
		expect(turns.hookVerdict(S, T0 + 4)).toMatchObject({ state: 'turn', longRunning: false });
	});

	it('reports a fresh mid-turn transcript as a turn when there are no hooks; a stale one proves nothing', () => {
		write([{ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [] } }]);
		turns.setTranscriptLocator((s) => (s === S ? file : null));
		const now = Date.now();
		expect(turns.getVerdict(S, now)).toMatchObject({ state: 'turn', source: 'transcript' });
		expect(turns.getVerdict(S, now + TURN_STATE_CONSTANTS.TRANSCRIPT_FRESH_MS + 60_000).state).toBe('unknown');
		expect(turns.getVerdict('other', now).state).toBe('unknown');
	});

	it('never throws when the locator does', () => {
		turns.setTranscriptLocator(() => {
			throw new Error('no meta');
		});
		expect(turns.getVerdict(S).state).toBe('unknown');
	});

	describe('tool starts (follow-through guard)', () => {
		it('counts PreToolUse events after a time, and is null without hooks', () => {
			expect(turns.toolStartsSince(S, T0)).toBeNull();
			turns.recordHook(S, 'UserPromptSubmit', {}, T0 + 1000);
			turns.recordHook(S, 'PreToolUse', { toolUseId: 'a' }, T0 + 2000);
			turns.recordHook(S, 'PostToolUse', { toolUseId: 'a' }, T0 + 2500);
			turns.recordHook(S, 'PreToolUse', { toolUseId: 'b' }, T0 + 5000);
			expect(turns.toolStartsSince(S, T0)).toBe(2);
			expect(turns.toolStartsSince(S, T0 + 2000)).toBe(1);
			expect(turns.toolStartsSince(S, T0 + 5000)).toBe(0);
		});

		it('a runtime restart forgets them and records when the runtime started', () => {
			turns.recordHook(S, 'PreToolUse', { toolUseId: 'a' }, T0 + 2000);
			turns.noteRuntimeStart(S, T0 + 9000);
			expect(turns.toolStartsSince(S, T0)).toBeNull();
			expect(turns.runtimeStartedAt(S)).toBe(T0 + 9000);
		});
	});
});
