/**
 * Tests for the Claude Code transcript turn reader.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeTranscriptTurnState, parseClaudeTranscriptTurn, resetTranscriptTurnCache } from './claude-transcript-turn.js';

/**
 * One JSONL line.
 *
 * @param entry - Transcript entry
 * @returns JSON line
 */
const line = (entry: Record<string, unknown>): string => JSON.stringify(entry);

const t = (hhmmss: string): string => `2026-10-02T${hhmmss}Z`;

/** Eve's transcript, 04:37:30 → 04:42:32 (shapes copied from the real file, content trimmed). */
const PROMPT = line({ type: 'user', isSidechain: false, timestamp: t('04:37:30.573'), message: { role: 'user', content: '[CHAT:x] [TICKET:TKT-194 y] write the plan' } });
const LAUNCH = line({
	type: 'assistant',
	isSidechain: false,
	timestamp: t('04:38:21.564'),
	message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_01DCgEGybopgPqvXvaCDeSsY', name: 'Agent', input: { subagent_type: 'Explore' } }] },
});
const LAUNCHED = line({
	type: 'user',
	isSidechain: false,
	timestamp: t('04:38:21.677'),
	message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01DCgEGybopgPqvXvaCDeSsY', content: [{ type: 'text', text: 'Async agent launched successfully. (This tool result …)' }] }] },
});
const SIDECHAIN = line({ type: 'assistant', isSidechain: true, timestamp: t('04:39:00.000'), message: { role: 'assistant', stop_reason: 'end_turn', content: [] } });
const END_TURN = line({ type: 'assistant', isSidechain: false, timestamp: t('04:40:18.454'), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Policy section done; the inventory is still running in the background.' }] } });
const TURN_DURATION = line({ type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: t('04:40:28.250'), pendingBackgroundAgentCount: 1 });
const QUEUE = line({ type: 'queue-operation', operation: 'enqueue', timestamp: t('04:41:11.318') });
const NOTIFICATION = line({
	type: 'user',
	isSidechain: false,
	timestamp: t('04:41:11.338'),
	message: { role: 'user', content: '<task-notification>\n<task-id>a1d4d935dea1c5443</task-id>\n<tool-use-id>toolu_01DCgEGybopgPqvXvaCDeSsY</tool-use-id>\n<status>completed</status>\n</task-notification>' },
});
const TOOL_CALL = line({
	type: 'assistant',
	isSidechain: false,
	timestamp: t('04:42:32.439'),
	message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_x', name: 'mcp__claude_ai_Claude_Docs__update', input: {} }] },
});

describe('parseClaudeTranscriptTurn', () => {
	it('is mid-turn while the last main-chain entry is a tool call or a prompt', () => {
		expect(parseClaudeTranscriptTurn([PROMPT].join('\n')).verdict).toBe('turn');
		expect(parseClaudeTranscriptTurn([PROMPT, LAUNCH].join('\n')).verdict).toBe('turn');
		expect(parseClaudeTranscriptTurn([PROMPT, LAUNCH, LAUNCHED].join('\n')).verdict).toBe('turn');
	});

	it('ends with background work pending when a subagent is still running (Eve, 04:40:28)', () => {
		const s = parseClaudeTranscriptTurn([PROMPT, LAUNCH, LAUNCHED, SIDECHAIN, END_TURN, TURN_DURATION].join('\n'));
		expect(s.verdict).toBe('background');
		expect(s.pendingBackground).toBe(1);
		expect(s.oldestPendingAt).toBe(Date.parse(t('04:38:21.677')));
	});

	it('is mid-turn again once the notification starts a turn by itself (Eve, 04:41:11 → 04:42:32)', () => {
		const s = parseClaudeTranscriptTurn([PROMPT, LAUNCH, LAUNCHED, END_TURN, TURN_DURATION, QUEUE, NOTIFICATION, TOOL_CALL].join('\n'));
		expect(s.verdict).toBe('turn');
		expect(s.pendingBackground).toBe(0);
		expect(s.lastEntryAt).toBe(Date.parse(t('04:42:32.439')));
	});

	it('is idle after the turn ends with nothing pending', () => {
		const done = line({ type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: t('04:50:00.000'), pendingBackgroundAgentCount: 0 });
		expect(parseClaudeTranscriptTurn([PROMPT, END_TURN, done].join('\n')).verdict).toBe('idle');
	});

	it('tracks run_in_background shells until their notification', () => {
		const bg = line({
			type: 'assistant',
			timestamp: t('05:00:00.000'),
			message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] },
		});
		const end = line({ type: 'assistant', timestamp: t('05:00:05.000'), message: { stop_reason: 'end_turn', content: [] } });
		expect(parseClaudeTranscriptTurn([bg, end].join('\n')).verdict).toBe('background');
		const done = line({ type: 'user', timestamp: t('05:03:00.000'), message: { content: '<task-notification><tool-use-id>toolu_bg</tool-use-id></task-notification>' } });
		const end2 = line({ type: 'assistant', timestamp: t('05:03:09.000'), message: { stop_reason: 'end_turn', content: [] } });
		expect(parseClaudeTranscriptTurn([bg, end, done, end2].join('\n')).verdict).toBe('idle');
	});

	it('ignores a partial first line, junk, sidechain and meta entries', () => {
		const meta = line({ type: 'user', isMeta: true, timestamp: t('04:51:00.000'), message: { content: 'Caveat: local command' } });
		const done = line({ type: 'system', subtype: 'stop_hook_summary', timestamp: t('04:50:00.000') });
		expect(parseClaudeTranscriptTurn(['{"type":"user","mess', PROMPT, 'not json', done, SIDECHAIN, meta].join('\n')).verdict).toBe('idle');
		expect(parseClaudeTranscriptTurn('').verdict).toBe('unknown');
	});

	it('treats a user interrupt as the end of the turn', () => {
		const stop = line({ type: 'user', timestamp: t('04:51:00.000'), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
		expect(parseClaudeTranscriptTurn([PROMPT, LAUNCH, stop].join('\n')).verdict).toBe('idle');
	});
});

describe('claudeTranscriptTurnState', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-turn-'));
		resetTranscriptTurnCache();
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('reads the file, reflects appends, and returns null for a missing file', () => {
		const file = path.join(dir, 'abc.jsonl');
		expect(claudeTranscriptTurnState(file)).toBeNull();
		fs.writeFileSync(file, `${[PROMPT, END_TURN, TURN_DURATION].join('\n')}\n`);
		expect(claudeTranscriptTurnState(file)?.verdict).toBe('background');
		fs.appendFileSync(file, `${[NOTIFICATION, TOOL_CALL].join('\n')}\n`);
		expect(claudeTranscriptTurnState(file)?.verdict).toBe('turn');
	});
});
