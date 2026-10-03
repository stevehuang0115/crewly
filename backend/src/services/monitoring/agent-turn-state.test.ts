/**
 * Tests for AgentTurnStateService (runtime turn state).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTurnStateService } from './agent-turn-state.js';
import { resetTranscriptTurnCache } from './claude-transcript-turn.js';
import { TURN_STATE_CONSTANTS } from '../../constants.js';

const T0 = Date.parse('2026-10-02T04:37:30Z');
const S = 'evership-eve-398f05df';

describe('AgentTurnStateService', () => {
	let turns: AgentTurnStateService;

	beforeEach(() => {
		AgentTurnStateService.resetInstance();
		resetTranscriptTurnCache();
		turns = AgentTurnStateService.getInstance();
	});

	it('is a singleton and knows nothing about a silent session', () => {
		expect(AgentTurnStateService.getInstance()).toBe(turns);
		expect(turns.getVerdict(S, T0)).toEqual({ state: 'unknown', longRunning: false, since: null, source: 'none' });
		expect(turns.lastHookEventAt(S)).toBeNull();
	});

	it("follows Eve's turn: busy through silence, background after Stop, busy again when the subagent returns", () => {
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.recordHook(S, 'PreToolUse', { toolUseId: 'toolu_a' }, T0 + 51_000);
		turns.recordHook(S, 'SubagentStart', { agentId: 'a1d4d935dea1c5443' }, T0 + 51_100);
		turns.recordHook(S, 'PostToolUse', { toolUseId: 'toolu_a' }, T0 + 51_200);
		// Ninety silent seconds while the model writes a long tool input.
		expect(turns.getVerdict(S, T0 + 141_000)).toEqual({ state: 'turn', longRunning: true, since: T0, source: 'hooks' });

		// 04:40:28 — Stop with the subagent still running.
		turns.recordHook(S, 'Stop', {}, T0 + 178_000);
		expect(turns.getVerdict(S, T0 + 180_000)).toMatchObject({ state: 'background', longRunning: true, since: T0 + 51_100 });
		expect(turns.hasBackgroundWork(S, T0 + 180_000)).toBe(true);

		// 04:41:11 — the subagent finishes and Claude Code resumes the parent by itself.
		turns.recordHook(S, 'SubagentStop', { agentId: 'a1d4d935dea1c5443' }, T0 + 221_000);
		expect(turns.getVerdict(S, T0 + 260_000)).toMatchObject({ state: 'turn', longRunning: false, since: T0 + 221_000 });
		expect(turns.hasBackgroundWork(S, T0 + 260_000)).toBe(false);

		turns.recordHook(S, 'Stop', {}, T0 + 400_000);
		expect(turns.getVerdict(S, T0 + 401_000)).toMatchObject({ state: 'idle', longRunning: false });
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
		// …but an open call expires eventually.
		expect(turns.hookVerdict(S, T0 + TURN_STATE_CONSTANTS.OPEN_WORK_MAX_MS + 1).state).toBe('unknown');
	});

	it('counts subagents that report no id', () => {
		turns.recordHook(S, 'SubagentStart', {}, T0);
		turns.recordHook(S, 'Stop', {}, T0 + 1);
		expect(turns.hookVerdict(S, T0 + 2).state).toBe('background');
		turns.recordHook(S, 'SubagentStop', {}, T0 + 3);
		turns.recordHook(S, 'Stop', {}, T0 + 4);
		expect(turns.hookVerdict(S, T0 + 5).state).toBe('idle');
	});

	it('forgets a session', () => {
		turns.recordHook(S, 'UserPromptSubmit', {}, T0);
		turns.forget(S);
		expect(turns.knownSessions()).toEqual([]);
	});

	describe('transcript fallback', () => {
		let dir: string;
		let file: string;
		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-state-'));
			file = path.join(dir, 'db6cd3e6.jsonl');
		});
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

		const write = (entries: Array<Record<string, unknown>>): void => {
			fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
		};

		it('reports a fresh mid-turn transcript as a turn when the hooks are silent', () => {
			write([{ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'tool_use', content: [] } }]);
			turns.setTranscriptLocator((s) => (s === S ? file : null));
			const now = Date.now();
			expect(turns.getVerdict(S, now)).toMatchObject({ state: 'turn', source: 'transcript' });
			// A stale mid-turn transcript proves nothing.
			expect(turns.getVerdict(S, now + TURN_STATE_CONSTANTS.TRANSCRIPT_FRESH_MS + 60_000).state).toBe('unknown');
			expect(turns.getVerdict('other', now).state).toBe('unknown');
		});

		it('catches a background shell the hooks cannot see', () => {
			const at = new Date().toISOString();
			write([
				{ type: 'assistant', timestamp: at, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_bg', input: { run_in_background: true } }] } },
				{ type: 'assistant', timestamp: at, message: { stop_reason: 'end_turn', content: [] } },
			]);
			turns.recordHook(S, 'Stop', {}, Date.now());
			turns.setTranscriptLocator(() => file);
			expect(turns.getVerdict(S)).toMatchObject({ state: 'background', longRunning: true, source: 'transcript' });
		});

		it('never throws when the locator does', () => {
			turns.setTranscriptLocator(() => {
				throw new Error('no meta');
			});
			expect(turns.getVerdict(S).state).toBe('unknown');
		});
	});
});
