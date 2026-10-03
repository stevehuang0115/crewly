/**
 * Tests for interrupted-turn persistence and resume.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildResumeMessage,
	buildResumeNote,
	planCommitmentNotes,
	workLabelOf,
	clearInterruptedTurns,
	interruptedTurnsPath,
	loadInterruptedTurns,
	resumeInterruptedTurns,
	saveInterruptedTurns,
	toInterruptedEntries,
	writeInterruptedTurns,
	type InterruptedTurnEntry,
	type ResumeDeps,
} from './interrupted-turns.js';
import type { InFlightTurn } from './in-flight-turn-tracker.service.js';
import { SAFE_RESTART } from '../../constants.js';

const NOW = Date.parse('2026-09-24T01:39:31Z');
const DELIVERED = Date.parse('2026-09-24T01:38:30Z');

/** Ella's DM, delivered through the message queue from Slack. */
const ellaTurn: InFlightTurn = {
	sessionName: 'ella',
	runtime: 'pty',
	since: DELIVERED,
	messages: [
		{
			deliveredAt: DELIVERED,
			text: '[CHAT:conv-1:abcd1234] check what is left in my To Do [SLACK:D1:111.2]',
			preview: 'check what is left in my To Do',
			messageId: 'msg-abcd1234',
			source: 'slack',
			conversationId: 'conv-1',
			originalContent: 'check what is left in my To Do',
			sourceMetadata: { channelId: 'D1', threadTs: '111.2' },
			systemEvent: false,
		},
	],
};

const orcTurn: InFlightTurn = {
	sessionName: 'crewly-orc',
	runtime: 'pty',
	since: DELIVERED,
	messages: [
		{ deliveredAt: DELIVERED, text: '\n[SYSTEM]\nstatus ping\n[/SYSTEM]\n', preview: '[SYSTEM] status ping [/SYSTEM]', systemEvent: true },
		{ deliveredAt: DELIVERED + 1, text: 'please plan the release', preview: 'please plan the release', systemEvent: false },
	],
};

describe('interrupted turns store', () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interrupted-'));
		file = interruptedTurnsPath(dir);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('uses the configured file name under CREWLY_HOME', () => {
		expect(file).toBe(path.join(dir, SAFE_RESTART.INTERRUPTED_TURNS_FILE));
	});

	it('flattens turns and drops [SYSTEM] pings', () => {
		const entries = toInterruptedEntries([ellaTurn, orcTurn]);
		expect(entries.map((e) => [e.sessionName, e.preview])).toEqual([
			['ella', 'check what is left in my To Do'],
			['crewly-orc', 'please plan the release'],
		]);
		expect(entries[0]).toMatchObject({ source: 'slack', conversationId: 'conv-1', sourceMetadata: { channelId: 'D1', threadTs: '111.2' } });
		expect(entries[1].source).toBeUndefined();
	});

	it('saves, loads, and clears', () => {
		expect(saveInterruptedTurns(file, [ellaTurn], 'SIGTERM: timed-out')).toBe(1);
		const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
		expect(onDisk.reason).toBe('SIGTERM: timed-out');
		const { fresh, dropped } = loadInterruptedTurns(file, NOW);
		expect(dropped).toBe(0);
		expect(fresh).toHaveLength(1);
		clearInterruptedTurns(file);
		expect(fs.existsSync(file)).toBe(false);
		clearInterruptedTurns(file);
	});

	it('persists a turn the runtime started on its own as one work entry, labelled with the last delivered ticket (2026-10-02, Eve)', () => {
		const eve: InFlightTurn = {
			sessionName: 'evership-eve',
			runtime: 'pty',
			since: DELIVERED,
			messages: [],
			origin: 'runtime',
			longRunning: true,
			lastDelivered: '[CHAT:c] [TICKET:TKT-194 9d34] write the plan',
		};
		const entries = toInterruptedEntries([eve]);
		expect(entries).toEqual([
			{
				kind: 'work',
				sessionName: 'evership-eve',
				deliveredAt: DELIVERED,
				text: '',
				preview: '(working: tool call or background task running)',
				workLabel: 'TKT-194',
			},
		]);
		expect(saveInterruptedTurns(file, [eve], 'SIGTERM: timed-out')).toBe(1);
		expect(loadInterruptedTurns(file, NOW).fresh).toEqual(entries);
	});

	it('writes nothing when every in-flight message is a system ping', () => {
		expect(saveInterruptedTurns(file, [{ ...orcTurn, messages: [orcTurn.messages[0]] }])).toBe(0);
		expect(fs.existsSync(file)).toBe(false);
	});

	it('merges with entries a previous boot has not resumed yet, without duplicates', () => {
		saveInterruptedTurns(file, [ellaTurn]);
		expect(saveInterruptedTurns(file, [ellaTurn, orcTurn])).toBe(2);
		expect(loadInterruptedTurns(file, NOW).fresh.map((e) => e.sessionName)).toEqual(['ella', 'crewly-orc']);
	});

	it('drops stale and malformed entries on load', () => {
		const stale: InterruptedTurnEntry = { sessionName: 'old', deliveredAt: NOW - SAFE_RESTART.INTERRUPTED_TURN_MAX_AGE_MS - 1, text: 'x', preview: 'x' };
		fs.writeFileSync(file, JSON.stringify({ version: 1, turns: [stale, { sessionName: '', text: 'y' }, ...toInterruptedEntries([ellaTurn])] }));
		const { fresh, dropped } = loadInterruptedTurns(file, NOW);
		expect(fresh.map((e) => e.sessionName)).toEqual(['ella']);
		expect(dropped).toBe(2);
	});

	it('treats a missing or corrupt file as empty', () => {
		expect(loadInterruptedTurns(file, NOW)).toEqual({ fresh: [], dropped: 0 });
		fs.writeFileSync(file, '{not json');
		expect(loadInterruptedTurns(file, NOW)).toEqual({ fresh: [], dropped: 0 });
	});

	it('writeInterruptedTurns removes the file when given nothing', () => {
		writeInterruptedTurns(file, toInterruptedEntries([ellaTurn]));
		expect(fs.existsSync(file)).toBe(true);
		writeInterruptedTurns(file, []);
		expect(fs.existsSync(file)).toBe(false);
	});
});

/** The note every resumed agent gets for a message with no ticket. */
const NOTE = 'Crewly restarted while you were working on this request. Continue where you left off and deliver.';
/** Header between the note and the original message. */
const HEADER = SAFE_RESTART.RESUME_ORIGINAL_HEADER;

describe('buildResumeMessage', () => {
	it('prefixes the note once, even for a message resumed twice', () => {
		const once = buildResumeMessage('check my To Do');
		expect(once).toBe(`${NOTE}\n${HEADER}\ncheck my To Do`);
		expect(buildResumeMessage(once)).toBe(once);
	});

	it('names the ticket the message is about', () => {
		const msg = '[CHAT:c] <U1@#evership> [TICKET:TKT-194 9d34e756] (Creator) write the plan';
		expect(workLabelOf(msg)).toBe('TKT-194');
		expect(buildResumeMessage(msg).split('\n')[0]).toBe(
			'Crewly restarted while you were working on TKT-194. Continue where you left off and deliver.',
		);
	});
});

describe('buildResumeNote / planCommitmentNotes', () => {
	it('uses "this request" when no ticket is known', () => {
		expect(buildResumeNote()).toBe(NOTE);
		expect(buildResumeNote('TKT-7')).toBe('Crewly restarted while you were working on TKT-7. Continue where you left off and deliver.');
	});

	it('gives each restored promise-holder one note quoting the promise, skipping interrupted agents and agents not running', () => {
		const notes = planCommitmentNotes(
			[
				{ sessionName: 'eve', ticket: 'TKT-194', text: '大约 20–30 分钟后把方案文档发到这里。' },
				{ sessionName: 'eve', ticket: 'TKT-195', text: 'I will send the numbers  after lunch' },
				{ sessionName: 'ella', ticket: 'TKT-1', text: 'tomorrow' },
				{ sessionName: 'down', text: 'later' },
			],
			[{ sessionName: 'ella', deliveredAt: NOW, text: 'x', preview: 'x' }],
			(s) => s !== 'down',
		);
		expect(notes).toEqual([
			{
				sessionName: 'eve',
				text: [
					'Crewly restarted while you were working on TKT-194, TKT-195. Continue where you left off and deliver.',
					'You promised the owner:',
					'- TKT-194: "大约 20–30 分钟后把方案文档发到这里。"',
					'- TKT-195: "I will send the numbers after lunch"',
				].join('\n'),
			},
		]);
	});
});

describe('resumeInterruptedTurns', () => {
	/**
	 * Build resume deps with jest fakes.
	 *
	 * @param overrides - Per-test overrides
	 * @returns deps
	 */
	function deps(overrides: Partial<ResumeDeps> = {}): ResumeDeps & {
		enqueue: jest.Mock;
		sendMessageToAgent: jest.Mock;
	} {
		return {
			orchestratorSession: 'crewly-orc',
			isSessionRunning: () => true,
			enqueue: jest.fn(),
			sendMessageToAgent: jest.fn(async () => ({ success: true })),
			waitForOrchestratorActive: jest.fn(async () => true),
			logger: { info: jest.fn(), warn: jest.fn() },
			...overrides,
		} as ResumeDeps & { enqueue: jest.Mock; sendMessageToAgent: jest.Mock };
	}

	it('re-enqueues a queue-delivered message with its original Slack source and target', async () => {
		const d = deps();
		const summary = await resumeInterruptedTurns(toInterruptedEntries([ellaTurn]), d);
		expect(summary).toEqual({ redelivered: 1, skipped: 0, failed: 0 });
		expect(d.enqueue).toHaveBeenCalledWith({
			content: `${NOTE}\n${HEADER}\ncheck what is left in my To Do`,
			conversationId: 'conv-1',
			source: 'slack',
			sourceMetadata: { channelId: 'D1', threadTs: '111.2' },
			targetSession: 'ella',
		});
		expect(d.sendMessageToAgent).not.toHaveBeenCalled();
	});

	it('omits targetSession for the orchestrator (the queue default)', async () => {
		const d = deps();
		const entry: InterruptedTurnEntry = { ...toInterruptedEntries([ellaTurn])[0], sessionName: 'crewly-orc' };
		await resumeInterruptedTurns([entry], d);
		expect(d.enqueue.mock.calls[0][0].targetSession).toBeUndefined();
	});

	it('sends raw deliveries directly, waiting for the orchestrator first', async () => {
		const d = deps();
		const summary = await resumeInterruptedTurns(toInterruptedEntries([orcTurn]), d);
		expect(summary.redelivered).toBe(1);
		expect(d.waitForOrchestratorActive).toHaveBeenCalledTimes(1);
		expect(d.sendMessageToAgent).toHaveBeenCalledWith('crewly-orc', `${NOTE}\n${HEADER}\nplease plan the release`);
	});

	it('fails orchestrator entries when it never becomes active', async () => {
		const d = deps({ waitForOrchestratorActive: jest.fn(async () => false) });
		const summary = await resumeInterruptedTurns(toInterruptedEntries([orcTurn]), d);
		expect(summary).toEqual({ redelivered: 0, skipped: 0, failed: 1 });
		expect(d.sendMessageToAgent).not.toHaveBeenCalled();
	});

	it('skips agents that are not running after the restart', async () => {
		const d = deps({ isSessionRunning: () => false });
		const summary = await resumeInterruptedTurns(toInterruptedEntries([ellaTurn]), d);
		expect(summary).toEqual({ redelivered: 0, skipped: 1, failed: 0 });
		expect(d.enqueue).not.toHaveBeenCalled();
	});

	it('restores an interrupted agent with the resume note naming its ticket (2026-10-02, Eve)', async () => {
		const d = deps();
		const work: InterruptedTurnEntry = { kind: 'work', sessionName: 'evership-eve', deliveredAt: NOW, text: '', preview: '(working)', workLabel: 'TKT-194' };
		const summary = await resumeInterruptedTurns([work, { ...work, deliveredAt: NOW + 1 }], d);
		expect(summary).toEqual({ redelivered: 1, skipped: 1, failed: 0 });
		expect(d.sendMessageToAgent).toHaveBeenCalledTimes(1);
		expect(d.sendMessageToAgent).toHaveBeenCalledWith(
			'evership-eve',
			'Crewly restarted while you were working on TKT-194. Continue where you left off and deliver.',
		);
		expect(d.enqueue).not.toHaveBeenCalled();
	});

	it('sends no separate work note to an agent whose message is resumed', async () => {
		const d = deps();
		const work: InterruptedTurnEntry = { kind: 'work', sessionName: 'ella', deliveredAt: NOW, text: '', preview: '(working)' };
		const summary = await resumeInterruptedTurns([...toInterruptedEntries([ellaTurn]), work], d);
		expect(summary).toEqual({ redelivered: 1, skipped: 1, failed: 0 });
		expect(d.enqueue).toHaveBeenCalledTimes(1);
		expect(d.sendMessageToAgent).not.toHaveBeenCalled();
	});

	it('counts failed and throwing deliveries and keeps going', async () => {
		const raw: InterruptedTurnEntry[] = [
			{ sessionName: 'a', deliveredAt: NOW, text: 'one', preview: 'one' },
			{ sessionName: 'b', deliveredAt: NOW, text: 'two', preview: 'two' },
			{ sessionName: 'c', deliveredAt: NOW, text: 'three', preview: 'three' },
		];
		const send = jest
			.fn<Promise<{ success: boolean; error?: string }>, [string, string]>()
			.mockResolvedValueOnce({ success: false, error: 'no session' })
			.mockRejectedValueOnce(new Error('boom'))
			.mockResolvedValueOnce({ success: true });
		const handled: string[][] = [];
		const summary = await resumeInterruptedTurns(raw, deps({
			sendMessageToAgent: send,
			onEntryHandled: (_e, remaining) => handled.push(remaining.map((r) => r.sessionName)),
		}));
		expect(summary).toEqual({ redelivered: 1, skipped: 0, failed: 2 });
		expect(handled).toEqual([['b', 'c'], ['c'], []]);
	});
});
