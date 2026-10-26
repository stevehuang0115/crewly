/**
 * Tests for the Claude subscription window report.
 *
 * The fixtures are the two shapes Claude Code really writes: the flat
 * `quotaLimits` object, and the escaped JSON a refusal carries when it comes
 * back inside a tool result (captured 2026-10-11, claude-code 2.1.114).
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildClaudeWindowReport,
	findLastLimit,
	estimateWindowCapacity,
	findWindowsMap,
	parseLimitLine,
	readTranscriptTail,
	turnBillableTokens,
	type ClaudeWindowUsage,
} from './claude-window.service.js';

/** One assistant turn, as Claude Code writes it. */
function turn(id: string, timestamp: string, input = 100, output = 50, cacheRead = 9_000, cacheWrite = 20): string {
	return JSON.stringify({
		type: 'assistant',
		timestamp,
		message: {
			id,
			model: 'claude-opus-5',
			usage: {
				input_tokens: input,
				output_tokens: output,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: cacheWrite,
			},
		},
	});
}

/** A refusal with the flat `quotaLimits` block. */
function refusal(timestamp: string, resetsAtEpoch: number): string {
	return JSON.stringify({
		type: 'assistant',
		timestamp,
		isApiErrorMessage: true,
		apiError: 'usage_limit_reached',
		quotaLimits: {
			status: 'rejected',
			resetsAt: resetsAtEpoch,
			rateLimitType: 'five_hour',
			overageStatus: 'rejected',
		},
	});
}

/** A refusal whose window figures are escaped inside an error string. */
function nestedRefusal(timestamp: string, utilization: number): string {
	const inner = JSON.stringify({
		type: 'exceeded_limit',
		windows: {
			'5h': { status: 'exceeded_limit', resets_at: 1791758400, utilization, surpassed_threshold: 1.0 },
			'7d': { status: 'within_limit', resets_at: 1792324800, utilization: 0.13 },
		},
	});
	return JSON.stringify({ type: 'user', timestamp, message: { content: `429 ${inner}` } });
}

describe('turnBillableTokens', () => {
	it('leaves cache reads out: they are most of the tokens and little of the cost', () => {
		const tokens = turnBillableTokens({ messageId: 'a', timestamp: '', model: '', input: 100, output: 50, cacheRead: 900_000, cacheWrite: 20 });
		expect(tokens).toBe(170);
	});
});

describe('parseLimitLine', () => {
	it('reads the flat quotaLimits block', () => {
		const event = parseLimitLine(refusal('2026-10-11T19:00:00.000Z', 1791745200));
		expect(event).not.toBeNull();
		expect(event?.rateLimitType).toBe('five_hour');
		expect(event?.resetsAt).toBe(new Date(1791745200 * 1000).toISOString());
		expect(event?.overageStatus).toBe('rejected');
	});

	it('reads the utilisation escaped inside an error string', () => {
		const event = parseLimitLine(nestedRefusal('2026-10-11T19:05:00.000Z', 0.99));
		expect(event?.utilization['5h']).toBeCloseTo(0.99);
		expect(event?.utilization['7d']).toBeCloseTo(0.13);
	});

	it('ignores an ordinary turn', () => {
		expect(parseLimitLine(turn('m1', '2026-10-11T19:00:00.000Z'))).toBeNull();
	});

	it('ignores a line that merely mentions the word', () => {
		expect(parseLimitLine(JSON.stringify({ type: 'user', message: { content: 'under-utilization of subagents' } }))).toBeNull();
	});

	it('survives a truncated line', () => {
		expect(parseLimitLine('{"quotaLimits":{"rateLim')).toBeNull();
	});
});

describe('findWindowsMap', () => {
	it('returns nothing when there is no windows map', () => {
		expect(findWindowsMap('{"type":"assistant"}')).toEqual({});
	});
});

describe('readTranscriptTail', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-window-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('stops at the first turn older than the window', async () => {
		const file = path.join(dir, 'session.jsonl');
		await fs.writeFile(
			file,
			[
				turn('old', '2026-10-01T00:00:00.000Z'),
				turn('fresh-1', '2026-10-11T18:00:00.000Z'),
				turn('fresh-2', '2026-10-11T18:30:00.000Z'),
			].join('\n') + '\n',
		);

		const slice = await readTranscriptTail(file, new Date('2026-10-11T17:00:00.000Z'), new Set());
		expect(slice.turns.map((t) => t.messageId)).toEqual(['fresh-1', 'fresh-2']);
		expect(slice.truncated).toBe(false);
	});

	it('counts a message id only once across files', async () => {
		const file = path.join(dir, 'session.jsonl');
		await fs.writeFile(file, turn('dup', '2026-10-11T18:00:00.000Z') + '\n');
		const seen = new Set<string>();

		expect((await readTranscriptTail(file, new Date('2026-10-11T17:00:00.000Z'), seen)).turns).toHaveLength(1);
		expect((await readTranscriptTail(file, new Date('2026-10-11T17:00:00.000Z'), seen)).turns).toHaveLength(0);
	});

	it('joins a line split across two backward reads', async () => {
		const file = path.join(dir, 'session.jsonl');
		// Padding pushes the first turn across a chunk boundary of the reader.
		const padding = Array.from({ length: 400 }, (_, i) => turn(`pad-${i}`, '2026-10-11T18:00:00.000Z', 1, 1, 0, 0)).join('\n');
		await fs.writeFile(file, `${padding}\n${turn('tail', '2026-10-11T18:59:00.000Z')}\n`);

		const slice = await readTranscriptTail(file, new Date('2026-10-11T17:00:00.000Z'), new Set());
		expect(slice.turns.some((t) => t.messageId === 'tail')).toBe(true);
		expect(slice.turns).toHaveLength(401);
	});

	it('returns an empty slice for a file it cannot open', async () => {
		const slice = await readTranscriptTail(path.join(dir, 'missing.jsonl'), new Date(0), new Set());
		expect(slice).toEqual({ turns: [], limit: null, truncated: false, oldestCovered: null });
	});

	it('keeps the newest refusal in the file', async () => {
		const file = path.join(dir, 'session.jsonl');
		await fs.writeFile(file, [refusal('2026-10-11T18:00:00.000Z', 1791745200), turn('after', '2026-10-11T18:10:00.000Z')].join('\n') + '\n');

		const slice = await readTranscriptTail(file, new Date('2026-10-11T17:00:00.000Z'), new Set());
		expect(slice.limit?.rateLimitType).toBe('five_hour');
	});
});

describe('findLastLimit', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-limit-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('returns the newest refusal across files', async () => {
		const a = path.join(dir, 'a.jsonl');
		const b = path.join(dir, 'b.jsonl');
		await fs.writeFile(a, refusal('2026-10-10T10:00:00.000Z', 1791745200) + '\n');
		await fs.writeFile(b, refusal('2026-10-11T10:00:00.000Z', 1791745200) + '\n');

		expect((await findLastLimit([a, b]))?.at).toBe('2026-10-11T10:00:00.000Z');
	});

	it('is null when nothing was ever refused', async () => {
		const file = path.join(dir, 'a.jsonl');
		await fs.writeFile(file, turn('t', '2026-10-11T10:00:00.000Z') + '\n');
		expect(await findLastLimit([file])).toBeNull();
	});

	it('skips a file it cannot open', async () => {
		expect(await findLastLimit([path.join(dir, 'missing.jsonl')])).toBeNull();
	});
});

describe('estimateWindowCapacity', () => {
	const window = (billable: number, startedAt: string): ClaudeWindowUsage => ({
		id: 'five_hour',
		label: '5-hour window',
		startedAt,
		turns: 1,
		partial: false,
		input: 0,
		cachedInput: 0,
		cacheWrite: 0,
		output: 0,
		billable,
	});

	it('divides the measured tokens by the utilisation Anthropic reported', () => {
		const capacity = estimateWindowCapacity([window(120_000, '2026-10-11T15:00:00.000Z')], {
			at: '2026-10-11T19:00:00.000Z',
			rateLimitType: 'five_hour',
			resetsAt: null,
			utilization: { '5h': 0.99 },
			overageStatus: null,
		});
		expect(capacity).toBe(121_212);
	});

	it('refuses a refusal older than the window just measured', () => {
		const capacity = estimateWindowCapacity([window(120_000, '2026-10-11T15:00:00.000Z')], {
			at: '2026-10-10T19:00:00.000Z',
			rateLimitType: 'five_hour',
			resetsAt: null,
			utilization: { '5h': 0.99 },
			overageStatus: null,
		});
		expect(capacity).toBeNull();
	});

	it('is null without a refusal, or without a utilisation figure', () => {
		expect(estimateWindowCapacity([window(1, '2026-10-11T15:00:00.000Z')], null)).toBeNull();
		expect(
			estimateWindowCapacity([window(1, '2026-10-11T15:00:00.000Z')], {
				at: '2026-10-11T19:00:00.000Z',
				rateLimitType: 'five_hour',
				resetsAt: null,
				utilization: {},
				overageStatus: null,
			}),
		).toBeNull();
	});
});

describe('buildClaudeWindowReport', () => {
	let dataDir: string;
	const now = new Date('2026-10-11T20:00:00.000Z');

	beforeEach(async () => {
		dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-home-'));
		await fs.mkdir(path.join(dataDir, 'projects', 'repo-a'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dataDir, { recursive: true, force: true });
	});

	it('splits the same turns into the 5-hour and 7-day windows', async () => {
		await fs.writeFile(
			path.join(dataDir, 'projects', 'repo-a', 's.jsonl'),
			[
				turn('inside-5h', '2026-10-11T19:00:00.000Z', 100, 50, 9_000, 20),
				turn('inside-7d', '2026-10-09T10:00:00.000Z', 200, 70, 1_000, 30),
			].join('\n') + '\n',
		);

		const report = await buildClaudeWindowReport({ dataDir, now: () => now, windows: ['five_hour', 'seven_day'] });
		const fiveHour = report.windows.find((w) => w.id === 'five_hour');
		const sevenDay = report.windows.find((w) => w.id === 'seven_day');

		expect(fiveHour?.turns).toBe(1);
		expect(fiveHour?.billable).toBe(170);
		expect(fiveHour?.cachedInput).toBe(9_000);
		expect(sevenDay?.turns).toBe(2);
		expect(sevenDay?.billable).toBe(470);
	});

	it('leaves out a turn older than every window', async () => {
		await fs.writeFile(path.join(dataDir, 'projects', 'repo-a', 's.jsonl'), turn('ancient', '2026-09-01T10:00:00.000Z') + '\n');

		const report = await buildClaudeWindowReport({ dataDir, now: () => now, windows: ['five_hour', 'seven_day'] });
		expect(report.windows.every((w) => w.turns === 0)).toBe(true);
	});

	it('reports the newest refusal across transcripts and the capacity it implies', async () => {
		await fs.writeFile(
			path.join(dataDir, 'projects', 'repo-a', 'a.jsonl'),
			[turn('t1', '2026-10-11T19:00:00.000Z', 120_000, 0, 0, 0), nestedRefusal('2026-10-11T19:30:00.000Z', 0.99)].join('\n') + '\n',
		);
		await fs.writeFile(path.join(dataDir, 'projects', 'repo-a', 'b.jsonl'), refusal('2026-10-11T18:00:00.000Z', 1791745200) + '\n');

		const report = await buildClaudeWindowReport({ dataDir, now: () => now });
		expect(report.lastLimit?.at).toBe('2026-10-11T19:30:00.000Z');
		expect(report.estimatedFiveHourCapacity).toBe(121_212);
	});

	it('measures only the 5-hour window unless asked for more', async () => {
		await fs.writeFile(path.join(dataDir, 'projects', 'repo-a', 's.jsonl'), turn('t', '2026-10-11T19:00:00.000Z') + '\n');

		const byDefault = await buildClaudeWindowReport({ dataDir, now: () => now });
		expect(byDefault.windows.map((w) => w.id)).toEqual(['five_hour']);

		const both = await buildClaudeWindowReport({ dataDir, now: () => now, windows: ['five_hour', 'seven_day'] });
		expect(both.windows.map((w) => w.id)).toEqual(['five_hour', 'seven_day']);
	});

	it('finds a refusal older than every measured window', async () => {
		// Outside the 5-hour window, so only the dedicated scan can see it.
		await fs.writeFile(
			path.join(dataDir, 'projects', 'repo-a', 's.jsonl'),
			[refusal('2026-10-11T04:00:00.000Z', 1791745200), turn('t', '2026-10-11T19:00:00.000Z')].join('\n') + '\n',
		);

		const report = await buildClaudeWindowReport({ dataDir, now: () => now });
		expect(report.windows[0].turns).toBe(1);
		expect(report.lastLimit?.at).toBe('2026-10-11T04:00:00.000Z');
	});

	it('is empty, not broken, when Claude Code has never run here', async () => {
		const report = await buildClaudeWindowReport({ dataDir: path.join(dataDir, 'nope'), now: () => now });
		expect(report.filesScanned).toBe(0);
		expect(report.windows).toHaveLength(1);
		expect(report.lastLimit).toBeNull();
	});
});
