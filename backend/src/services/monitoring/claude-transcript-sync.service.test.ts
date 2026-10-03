/**
 * Tests for ClaudeTranscriptSyncService.
 *
 * These lean on a real temp directory rather than a mocked fs: the whole point
 * of the service is byte-offset bookkeeping against a file that grows, and a
 * mocked fs would not exercise the part most likely to be wrong.
 *
 * @module services/monitoring/claude-transcript-sync.service.test
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockGetRegisteredSessionsMap = jest.fn();

jest.mock('../session/session-state-persistence.js', () => ({
	getSessionStatePersistence: () => ({
		getRegisteredSessionsMap: mockGetRegisteredSessionsMap,
	}),
}));

import { ClaudeTranscriptSyncService } from './claude-transcript-sync.service.js';
import { TokenUsageService } from './token-usage.service.js';
import { calculateCost } from './model-pricing.js';
import { encodeProjectSlug } from './claude-session-tokens.service.js';
import { setRuntimeFallbackHooks, type RuntimeFallbackHooks } from '../runtime-fallback/effective-runtime.js';
import { SpendLedger } from '../spend/spend-ledger.service.js';
import { SpendCapService } from '../spend/spend-cap.service.js';
import { MemorySpendCapStore } from '../spend/spend-cap.store.js';

/** Builds one assistant transcript line with the usage block Claude Code writes. */
function assistantLine(opts: {
	id: string;
	timestamp: string;
	model?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}): string {
	return JSON.stringify({
		type: 'assistant',
		timestamp: opts.timestamp,
		message: {
			id: opts.id,
			model: opts.model ?? 'claude-opus-5',
			usage: {
				input_tokens: opts.input ?? 100,
				output_tokens: opts.output ?? 50,
				cache_read_input_tokens: opts.cacheRead ?? 0,
				cache_creation_input_tokens: opts.cacheWrite ?? 0,
			},
		},
	});
}

describe('ClaudeTranscriptSyncService', () => {
	let tmpRoot: string;
	let projectDir: string;
	let transcriptDir: string;
	let transcriptPath: string;
	let cursorFile: string;
	let service: ClaudeTranscriptSyncService;

	const SESSION = 'think-tank-atlas-b4e166f6';
	const CONVO_ID = '0d7819e4-c359-4ce4-b429-838b38d9642e';

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-transcript-'));
		projectDir = path.join(tmpRoot, 'work', 'project');
		await fs.mkdir(projectDir, { recursive: true });

		// The service resolves <home>/.claude/projects/<slug>/<id>.jsonl against
		// an injected home directory, so point it at the temp tree.
		transcriptDir = path.join(tmpRoot, '.claude', 'projects', encodeProjectSlug(projectDir));
		await fs.mkdir(transcriptDir, { recursive: true });
		transcriptPath = path.join(transcriptDir, `${CONVO_ID}.jsonl`);

		cursorFile = path.join(tmpRoot, 'cursors.json');
		service = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);

		TokenUsageService.resetInstance();
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
		);
	});

	afterEach(async () => {
		service.stop();
		TokenUsageService.resetInstance();
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	it('records a turn against the Crewly session name, not the conversation id', async () => {
		// The old sync keyed on the conversation UUID, which made the dashboard
		// unreadable — you could not tell which agent a row belonged to.
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');

		const result = await service.sync();

		expect(result.turnsCounted).toBe(1);
		const sessions = TokenUsageService.getInstance().getUsageBySessions();
		expect(sessions.map((s) => s.sessionName)).toContain(SESSION);
	});

	it('counts only the turns appended since the previous pass', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();

		await fs.appendFile(transcriptPath, assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' }) + '\n');
		const second = await service.sync();

		expect(second.turnsCounted).toBe(1);
	});

	it('counts nothing when the transcript has not grown', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();

		expect((await service.sync()).turnsCounted).toBe(0);
	});

	it('does not count a message id twice when Claude Code rewrites the line', async () => {
		// A streamed turn can be written once and then finalised under the same
		// message id; the byte offset alone would count it twice.
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();

		await fs.appendFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:01.000Z', output: 900 }) + '\n',
		);
		expect((await service.sync()).turnsCounted).toBe(0);
	});

	it('leaves a half-written trailing line for the next pass', async () => {
		const whole = assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n';
		const partial = assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' }).slice(0, 40);
		await fs.writeFile(transcriptPath, whole + partial);

		expect((await service.sync()).turnsCounted).toBe(1);

		// Completing the line makes it countable.
		await fs.writeFile(
			transcriptPath,
			whole + assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' }) + '\n',
		);
		expect((await service.sync()).turnsCounted).toBe(1);
	});

	it('stamps the event with the turn timestamp, not the time it was imported', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();

		const record = TokenUsageService.getInstance()
			.getUsageBySessions()
			.find((s) => s.sessionName === SESSION);
		expect(record).toBeDefined();
		const events = (TokenUsageService.getInstance() as unknown as {
			sessions: Map<string, { events: Array<{ timestamp: string }> }>;
		}).sessions.get(SESSION)!.events;
		expect(events[0].timestamp).toBe('2026-09-21T10:00:00.000Z');
	});

	it('separates fresh input from cached input so the cost is cache-aware', async () => {
		await fs.writeFile(
			transcriptPath,
			assistantLine({
				id: 'm1',
				timestamp: '2026-09-21T10:00:00.000Z',
				input: 500,
				output: 200,
				cacheRead: 690_000,
				cacheWrite: 10_000,
			}) + '\n',
		);
		await service.sync();

		const svc = TokenUsageService.getInstance() as unknown as {
			sessions: Map<string, { totalInput: number; totalCachedInput?: number }>;
		};
		const record = svc.sessions.get(SESSION)!;
		expect(record.totalInput).toBe(500);
		expect(record.totalCachedInput).toBe(700_000);
	});

	it('survives a restart without re-counting the history', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();
		service.stop();

		// A second instance reads the cursors the first one persisted.
		const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
		const result = await revived.sync();
		revived.stop();

		expect(result.turnsCounted).toBe(0);
	});

	it('records the transcript message id on each ledger event (for later dedupe)', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'msg_abc', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();
		const ids: Array<string | undefined> = [];
		TokenUsageService.getInstance().forEachEvent((_s, e) => ids.push(e.messageId));
		expect(ids).toEqual(['msg_abc']);
	});

	it('a corrupt cursor file is copied aside, and the re-read skips turns the ledger already holds (no double count)', async () => {
		await fs.writeFile(
			transcriptPath,
			[assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }), assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' })].join('\n') + '\n',
		);
		await service.sync();
		service.stop();
		expect(TokenUsageService.getInstance().getUsageByAgent(SESSION).eventCount).toBe(2);

		// The cursor file gets truncated (a full disk); a new turn arrives.
		await fs.writeFile(cursorFile, '{"think-tank-atl');
		await fs.appendFile(transcriptPath, assistantLine({ id: 'm3', timestamp: '2026-09-21T10:02:00.000Z' }) + '\n');

		const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
		const result = await revived.sync();
		revived.stop();

		expect(result.turnsCounted).toBe(3);
		expect(TokenUsageService.getInstance().getUsageByAgent(SESSION).eventCount).toBe(3);
		const aside = (await fs.readdir(tmpRoot)).filter((f) => f.startsWith('cursors.json.corrupt-'));
		expect(aside).toHaveLength(1);
		expect(JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION].offset).toBeGreaterThan(0);
	});

	it('stops checking the ledger once a full pass after a lost cursor file has caught up', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await fs.writeFile(cursorFile, '{"broken');
		await service.sync();
		const ledger = TokenUsageService.getInstance();
		const scan = jest.spyOn(ledger, 'forEachEvent');
		await fs.appendFile(transcriptPath, assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' }) + '\n');
		expect((await service.sync()).turnsCounted).toBe(1);
		expect(scan).not.toHaveBeenCalled();
		scan.mockRestore();
	});

	it('a corrupt cursor file that cannot be copied aside is left alone and nothing is counted', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await fs.writeFile(cursorFile, '{"broken');
		const spy = jest.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
		try {
			const result = await service.sync();
			expect(result.turnsCounted).toBe(0);
			expect(await fs.readFile(cursorFile, 'utf-8')).toBe('{"broken');
		} finally {
			spy.mockRestore();
		}
		// Space again: the next pass sets it aside and counts.
		expect((await service.sync()).turnsCounted).toBe(1);
	});

	it('lists the transcripts it attributed, with the offset it consumed', async () => {
		const line = assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n';
		await fs.writeFile(transcriptPath, line);
		await service.sync();
		expect(await service.attributedTranscripts()).toEqual([
			{ sessionName: SESSION, filePath: transcriptPath, offset: Buffer.byteLength(line, 'utf-8') },
		]);
	});

	it('recounts, once, a cost written before the shared-cwd guard, from the agent\'s own transcript', async () => {
		// Several agents' cursors once pointed at one foreign transcript and
		// each banked all of it: Atlas and Max each showed about $300.
		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 1_000_000, output: 0 }) + '\n',
		);
		const expected = calculateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').cost;
		await fs.writeFile(
			cursorFile,
			JSON.stringify({ [SESSION]: { filePath: transcriptPath, offset: 999_999, seenMessageIds: ['m1'], cost: 304.73 } }),
		);

		const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
		await revived.sync();
		revived.stop();

		const saved = JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION];
		expect(saved.cost).toBeCloseTo(expected, 6);
		expect(saved.costBasis).toBe(2);

		// Already recounted: a later load leaves it alone.
		saved.cost = 1.23;
		await fs.writeFile(cursorFile, JSON.stringify({ [SESSION]: saved }));
		const again = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
		await again.sync();
		again.stop();
		expect(JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION].cost).toBeCloseTo(1.23, 6);
	});

	it('after a recount, counts only lines added later, never the recounted ones again (#972)', async () => {
		const first = assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 1_000_000, output: 0 }) + '\n';
		await fs.writeFile(transcriptPath, first);
		const one = calculateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'claude-opus-5').cost;
		// A legacy cursor: offset taken from another agent's, larger transcript.
		await fs.writeFile(
			cursorFile,
			JSON.stringify({ [SESSION]: { filePath: transcriptPath, offset: 5_000_000, seenMessageIds: [], cost: 304.73 } }),
		);

		const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
		await revived.sync();
		const afterRecount = JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION];
		expect(afterRecount.cost).toBeCloseTo(one, 6);
		expect(afterRecount.offset).toBe(Buffer.byteLength(first, 'utf-8'));

		await fs.appendFile(
			transcriptPath,
			assistantLine({ id: 'm2', timestamp: '2026-09-21T10:05:00.000Z', input: 1_000_000, output: 0 }) + '\n',
		);
		await revived.sync();
		revived.stop();

		expect(JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION].cost).toBeCloseTo(2 * one, 6);
	});

	describe('#990: repair of cursors double-counted by the recount bug (costBasis 3)', () => {
		const T1 = '2026-09-30T10:00:00.000Z';
		const T2 = '2026-09-30T10:05:00.000Z';
		// A long-lived agent's turn: large cached context, so a few dollars each.
		const turn = { input: 8_000, output: 12_000, cacheRead: 900_000, cacheWrite: 60_000, model: 'claude-opus-4-6' };
		const turnCost = calculateCost(
			{ input: turn.input, output: turn.output, cacheRead: turn.cacheRead, cacheWrite: turn.cacheWrite },
			turn.model,
		).cost;

		/** A transcript with two turns, and their two ledger events exactly as the sync booked them. */
		async function seed(cursorCost: number, costBasis: number | undefined = 2): Promise<void> {
			const text = [T1, T2].map((timestamp, i) => assistantLine({ id: `msg_${i}`, timestamp, ...turn })).join('\n') + '\n';
			await fs.writeFile(transcriptPath, text);
			for (const timestamp of [T1, T2]) {
				TokenUsageService.getInstance().recordUsage(SESSION, SESSION, turn.input, turn.output, turn.model, undefined, {
					cachedInput: turn.cacheRead + turn.cacheWrite,
					cacheWrite: turn.cacheWrite,
					timestamp,
				});
			}
			await fs.writeFile(cursorFile, JSON.stringify({
				[SESSION]: {
					filePath: transcriptPath,
					offset: Buffer.byteLength(text, 'utf-8'),
					seenMessageIds: ['msg_0', 'msg_1'],
					cost: cursorCost,
					...(costBasis !== undefined ? { costBasis } : {}),
				},
			}));
		}

		const savedCursor = async () => JSON.parse(await fs.readFile(cursorFile, 'utf-8'))[SESSION];

		it('lowers a doubled cursor to its ledger cost, marks it 3 and books nothing new', async () => {
			await seed(4 * turnCost); // two turns counted twice
			const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
			const result = await revived.sync();
			revived.stop();

			expect(result.turnsCounted).toBe(0);
			const saved = await savedCursor();
			expect(saved.cost).toBeCloseTo(2 * turnCost, 6);
			expect(saved.costBasis).toBe(3);
			expect(TokenUsageService.getInstance().getUsageBySessions().find((u) => u.sessionName === SESSION)?.eventCount).toBe(2);
		});

		it('is idempotent: a second start changes nothing', async () => {
			await seed(4 * turnCost);
			const first = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
			await first.sync();
			first.stop();
			const afterFirst = await fs.readFile(cursorFile, 'utf-8');

			const second = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
			await second.sync();
			const plan = await second.repairDoubleCountedCosts();
			second.stop();
			expect(plan).toEqual({ changes: [], verified: [], skipped: [] });
			expect(await fs.readFile(cursorFile, 'utf-8')).toBe(afterFirst);
		});

		it('never lowers a correct cursor; marks it checked', async () => {
			await seed(2 * turnCost * 1.004); // price drift only
			const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
			await revived.sync();
			revived.stop();
			const saved = await savedCursor();
			expect(saved.cost).toBeCloseTo(2 * turnCost * 1.004, 6);
			expect(saved.costBasis).toBe(3);
		});

		it('leaves the cursor alone and unmarked when the ledger is behind the transcript', async () => {
			await seed(4 * turnCost);
			// The ledger lost its newest event (e.g. restored from an older copy).
			const svc = TokenUsageService.getInstance() as unknown as { sessions: Map<string, { events: unknown[] }> };
			svc.sessions.get(SESSION)!.events.pop();

			const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
			await revived.sync();
			revived.stop();
			const saved = await savedCursor();
			expect(saved.cost).toBeCloseTo(4 * turnCost, 6);
			expect(saved.costBasis).toBe(2);
		});

		it('dry run (CREWLY_COST_REPAIR_DRY_RUN=1) reports the change but writes nothing', async () => {
			await seed(4 * turnCost);
			const before = await fs.readFile(cursorFile, 'utf-8');
			process.env.CREWLY_COST_REPAIR_DRY_RUN = '1';
			try {
				const revived = new ClaudeTranscriptSyncService(cursorFile, tmpRoot);
				await revived.sync();
				const plan = await revived.repairDoubleCountedCosts({ dryRun: true });
				revived.stop();
				expect(plan.changes).toEqual([
					expect.objectContaining({ sessionName: SESSION, now: expect.closeTo(2 * turnCost, 6) }),
				]);
				expect(revived.getCursor(SESSION)!.cost).toBeCloseTo(4 * turnCost, 6);
			} finally {
				delete process.env.CREWLY_COST_REPAIR_DRY_RUN;
			}
			expect(await fs.readFile(cursorFile, 'utf-8')).toBe(before);
		});

		it('new cursors start at costBasis 3 and are never repaired', async () => {
			await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: T1 }) + '\n');
			await service.sync();
			expect(service.getCursor(SESSION)!.costBasis).toBe(3);
		});
	});

	it('keeps cache writes apart from cache reads in the ledger', async () => {
		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', cacheRead: 200_000, cacheWrite: 50_000 }) + '\n',
		);
		await service.sync();
		const events = (TokenUsageService.getInstance() as unknown as {
			sessions: Map<string, { events: Array<{ cachedInput?: number; cacheWrite?: number }> }>;
		}).sessions.get(SESSION)!.events;
		expect(events[0]).toMatchObject({ cachedInput: 250_000, cacheWrite: 50_000 });
	});

	it('re-reads from the top when the transcript shrinks', async () => {
		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) +
				'\n' +
				assistantLine({ id: 'm2', timestamp: '2026-09-21T10:01:00.000Z' }) +
				'\n',
		);
		await service.sync();

		// Truncated by a rotation: a stale offset would seek past the end and
		// the session would silently stop being counted forever.
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm3', timestamp: '2026-09-21T11:00:00.000Z' }) + '\n');
		expect((await service.sync()).turnsCounted).toBe(1);
		expect(service.getCursor(SESSION)!.offset).toBeGreaterThan(0);
	});

	it('reports the latest turn context size to observers', async () => {
		const readings: Array<{ sessionName: string; contextTokens: number }> = [];
		service.onContextReading((r) => readings.push(r));

		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 100, cacheRead: 1_000 }) +
				'\n' +
				assistantLine({
					id: 'm2',
					timestamp: '2026-09-21T10:01:00.000Z',
					input: 500,
					cacheRead: 690_000,
					cacheWrite: 10_000,
				}) +
				'\n',
		);
		await service.sync();

		expect(readings).toHaveLength(1);
		expect(readings[0].sessionName).toBe(SESSION);
		expect(readings[0].contextTokens).toBe(700_500);
	});

	it('ignores the all-zero synthetic entries Claude Code interleaves', async () => {
		// These are cancellations and tool bookkeeping, not model round-trips.
		// One landing last made Atlas report a context of 0 while it was in
		// fact holding 726k tokens.
		const readings: number[] = [];
		service.onContextReading((r) => readings.push(r.contextTokens));

		await fs.writeFile(
			transcriptPath,
			[
				assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 32, cacheRead: 723_561, cacheWrite: 2_882, output: 2_749 }),
				JSON.stringify({
					type: 'assistant',
					timestamp: '2026-09-21T10:01:00.000Z',
					message: { id: 's1', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
				}),
			].join('\n') + '\n',
		);

		const result = await service.sync();

		expect(result.turnsCounted).toBe(1);
		expect(readings).toEqual([726_475]);
	});

	it('re-announces the last known context when a pass finds no new turns', async () => {
		// Session restore is staggered over a minute after boot, so the context
		// monitor may not have been watching when the first reading went out.
		// An idle agent produces no turns but is still holding the context.
		const readings: number[] = [];
		service.onContextReading((r) => readings.push(r.contextTokens));

		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 500, cacheRead: 700_000 }) + '\n',
		);
		await service.sync();
		expect(readings).toEqual([700_500]);

		await service.sync();
		expect(readings).toEqual([700_500, 700_500]);
	});

	it('re-asserts the cache-aware cost when a pass finds no new turns', async () => {
		// The override is in-memory only. After a restart, an agent that has
		// not taken a turn since would show a cost computed without the cache
		// split, which for a long-lived agent is wrong by an order of
		// magnitude.
		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 500, cacheRead: 700_000 }) + '\n',
		);
		await service.sync();
		const cost = service.getCursor(SESSION)!.cost;
		expect(cost).toBeGreaterThan(0);

		// A fresh TokenUsageService stands in for the post-restart state.
		TokenUsageService.resetInstance();
		await service.sync();

		const { getSessionCostOverride } = await import('./token-usage.service.js');
		expect(getSessionCostOverride(SESSION)).toBeCloseTo(cost, 10);
	});

	it('says nothing about a session it has never read a turn for', async () => {
		const readings: number[] = [];
		service.onContextReading((r) => readings.push(r.contextTokens));

		await fs.writeFile(transcriptPath, '');
		await service.sync();

		expect(readings).toEqual([]);
	});

	it('keeps syncing when one observer throws', async () => {
		service.onContextReading(() => {
			throw new Error('observer blew up');
		});
		const seen: number[] = [];
		service.onContextReading((r) => seen.push(r.contextTokens));

		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await expect(service.sync()).resolves.toMatchObject({ turnsCounted: 1 });
		expect(seen).toHaveLength(1);
	});

	it('skips sessions on a runtime that writes no transcript', async () => {
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([['orc', { cwd: projectDir, runtimeType: 'codex-cli', claudeSessionId: CONVO_ID }]]),
		);
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');

		expect((await service.sync()).turnsCounted).toBe(0);
	});

	it('reports sessions whose transcript cannot be located', async () => {
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([['ghost', { cwd: path.join(tmpRoot, 'nowhere'), runtimeType: 'claude-code' }]]),
		);

		expect((await service.sync()).sessionsWithoutTranscript).toBe(1);
	});

	it('never guesses a transcript when several agents share a directory', async () => {
		// Agents in one repo share a slug directory. Newest-wins would hand
		// every one of them the busiest agent's transcript and attribute its
		// turns and its context size to all of them — four agents were
		// observed each reporting the same 726,475 tokens, which belonged to
		// one of them.
		await fs.writeFile(
			transcriptPath,
			assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 500, cacheRead: 726_000 }) + '\n',
		);
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([
				// Only the first has its conversation id recorded.
				[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }],
				['colleague-a', { cwd: projectDir, runtimeType: 'claude-code' }],
				['colleague-b', { cwd: projectDir, runtimeType: 'claude-code' }],
			]),
		);

		const readings: Array<{ sessionName: string; contextTokens: number }> = [];
		service.onContextReading((r) => readings.push(r));
		const result = await service.sync();

		// The one agent we can identify is counted; the other two are reported
		// as unresolvable rather than handed someone else's numbers.
		expect(result.turnsCounted).toBe(1);
		expect(result.sessionsWithoutTranscript).toBe(2);
		expect(readings.map((r) => r.sessionName)).toEqual([SESSION]);
	});

	it('falls back to the newest transcript when the recorded id has no file', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: 'not-a-real-id' }]]),
		);

		expect((await service.sync()).turnsCounted).toBe(1);
	});

	it('ignores non-assistant entries and unparseable lines', async () => {
		await fs.writeFile(
			transcriptPath,
			[
				JSON.stringify({ type: 'user', timestamp: '2026-09-21T10:00:00.000Z', message: { content: 'hi' } }),
				'{ not json',
				JSON.stringify({ type: 'assistant', timestamp: '2026-09-21T10:00:01.000Z', message: { id: 'x' } }),
				assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:02.000Z' }),
			].join('\n') + '\n',
		);

		expect((await service.sync()).turnsCounted).toBe(1);
	});

	it('starts a fresh cursor but keeps lifetime cost when the agent gets a new conversation', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		await service.sync();
		const costAfterFirst = service.getCursor(SESSION)!.cost;
		expect(costAfterFirst).toBeGreaterThan(0);

		const newConvo = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		await fs.writeFile(
			path.join(transcriptDir, `${newConvo}.jsonl`),
			assistantLine({ id: 'n1', timestamp: '2026-09-21T12:00:00.000Z' }) + '\n',
		);
		mockGetRegisteredSessionsMap.mockReturnValue(
			new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: newConvo }]]),
		);

		const result = await service.sync();
		expect(result.turnsCounted).toBe(1);
		expect(service.getCursor(SESSION)!.cost).toBeGreaterThan(costAfterFirst);
	});

	it('drops an overlapping pass instead of queueing it', async () => {
		await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n');
		const [a, b] = await Promise.all([service.sync(), service.sync()]);
		expect(a.turnsCounted + b.turnsCounted).toBe(1);
	});

	describe('cwd reached through a symlink (#938)', () => {
		// macOS: an agent in /tmp/proj has its transcript filed by Claude Code
		// under the resolved /private/tmp/proj slug. Reproduce that with a
		// real symlink so the lookup has to resolve it.
		let linkedCwd: string;
		let resolvedTranscriptDir: string;

		beforeEach(async () => {
			const realParent = path.join(tmpRoot, 'private-real');
			await fs.mkdir(path.join(realParent, 'proj'), { recursive: true });
			await fs.symlink(realParent, path.join(tmpRoot, 'linked'), 'dir');
			linkedCwd = path.join(tmpRoot, 'linked', 'proj');

			const resolvedSlug = encodeProjectSlug(await fs.realpath(linkedCwd));
			expect(resolvedSlug).not.toBe(encodeProjectSlug(linkedCwd));
			resolvedTranscriptDir = path.join(tmpRoot, '.claude', 'projects', resolvedSlug);
			await fs.mkdir(resolvedTranscriptDir, { recursive: true });
		});

		it('finds the transcript under the resolved slug by conversation id and counts its spend', async () => {
			await fs.writeFile(
				path.join(resolvedTranscriptDir, `${CONVO_ID}.jsonl`),
				assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z', input: 1000, output: 500 }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: linkedCwd, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);

			const result = await service.sync();

			expect(result.sessionsWithoutTranscript).toBe(0);
			expect(result.turnsCounted).toBe(1);
			expect(service.getCursor(SESSION)?.cost).toBeGreaterThan(0);
			expect(
				TokenUsageService.getInstance().getUsageBySessions().map((s) => s.sessionName),
			).toContain(SESSION);
		});

		it('finds the newest transcript under the resolved slug when no id is recorded', async () => {
			await fs.writeFile(
				path.join(resolvedTranscriptDir, `${CONVO_ID}.jsonl`),
				assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: linkedCwd, runtimeType: 'claude-code' }]]),
			);

			const result = await service.sync();

			expect(result.sessionsWithoutTranscript).toBe(0);
			expect(result.turnsCounted).toBe(1);
		});

		it('still finds a transcript left under the raw slug', async () => {
			const rawDir = path.join(tmpRoot, '.claude', 'projects', encodeProjectSlug(linkedCwd));
			await fs.mkdir(rawDir, { recursive: true });
			await fs.writeFile(
				path.join(rawDir, `${CONVO_ID}.jsonl`),
				assistantLine({ id: 'm1', timestamp: '2026-09-21T10:00:00.000Z' }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: linkedCwd, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);

			expect((await service.sync()).turnsCounted).toBe(1);
		});
	});
	describe('a session on another of the owner\'s Claude Code accounts (#942)', () => {
		// claude-code@b runs with CLAUDE_CONFIG_DIR = the account's config dir,
		// so Claude Code files its transcripts under <config dir>/projects/.
		const ACCOUNT_CONVO = '11111111-2222-3333-4444-555555555555';
		let accountDir: string;
		let accountTranscriptDir: string;
		let accountService: ClaudeTranscriptSyncService;
		let account: string | null;

		/** Hooks reporting `account` for SESSION, like RuntimeFallbackService does. */
		function hooks(): RuntimeFallbackHooks {
			return {
				overrideFor: () => null,
				accountFor: (session) => (session === SESSION ? account : null),
				reportLoginExpiry: () => false,
				resolveLaunch: async (input) => ({ runtime: input.configured, overridden: false }),
				beforeDelivery: () => 'deliver',
				reportOutput: () => false,
				takeKickoffNote: () => null,
			};
		}

		/** Today, so the spend cap (which counts since local midnight) sees it. */
		const today = (minute: number): string => {
			const d = new Date();
			d.setHours(0, minute, 0, 0);
			return d.toISOString();
		};

		beforeEach(async () => {
			accountDir = path.join(tmpRoot, 'claude-accounts', 'b');
			accountTranscriptDir = path.join(accountDir, 'projects', encodeProjectSlug(projectDir));
			await fs.mkdir(accountTranscriptDir, { recursive: true });
			account = 'b';
			setRuntimeFallbackHooks(hooks());
			accountService = new ClaudeTranscriptSyncService(cursorFile, tmpRoot, (name) => path.join(tmpRoot, 'claude-accounts', name));
		});

		afterEach(() => {
			accountService.stop();
			setRuntimeFallbackHooks(null);
		});

		it('counts its spend from the account\'s config dir, and its daily cap fires', async () => {
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(1), input: 600_000, output: 500_000 }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: ACCOUNT_CONVO }]]),
			);

			const result = await accountService.sync();
			expect(result.sessionsWithoutTranscript).toBe(0);
			expect(result.turnsCounted).toBe(1);

			const caps = new SpendCapService({
				store: new MemorySpendCapStore(),
				ledger: new SpendLedger(TokenUsageService.getInstance()),
				notifyOwner: async () => true,
			});
			await caps.setCaps({ agents: { [SESSION]: '1M' } });
			await caps.evaluate();
			expect(caps.stopOf(SESSION)).toMatchObject({ scope: 'agent', capTokens: 1_000_000 });
			expect(caps.stopOf(SESSION)!.usedTokens).toBeGreaterThanOrEqual(1_100_000);
		});

		it('a session on the default login is not given an account dir', async () => {
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(1) }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: ACCOUNT_CONVO }]]),
			);
			account = null;

			const result = await accountService.sync();
			expect(result.turnsCounted).toBe(0);
			expect(result.sessionsWithoutTranscript).toBe(1);
		});

		it('finds the newest transcript in the account dir when no id is recorded', async () => {
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(1) }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code' }]]));

			expect((await accountService.sync()).turnsCounted).toBe(1);
		});

		it('switching accounts mid-day counts every turn in both dirs exactly once', async () => {
			// Morning: default login, conversation CONVO_ID under ~/.claude.
			account = null;
			await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: today(1) }) + '\n');
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);
			expect((await accountService.sync()).turnsCounted).toBe(1);

			// A last turn lands in the default transcript, then the agent moves
			// to account b with a new conversation before the next pass.
			await fs.appendFile(transcriptPath, assistantLine({ id: 'm2', timestamp: today(2) }) + '\n');
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(3) }) + '\n',
			);
			account = 'b';
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: ACCOUNT_CONVO }]]),
			);
			// m2 (left behind in ~/.claude) and b1 (account dir).
			expect((await accountService.sync()).turnsCounted).toBe(2);
			expect((await accountService.sync()).turnsCounted).toBe(0);

			// Back on the default login and its old conversation: nothing is
			// counted again, only what is new.
			account = null;
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);
			expect((await accountService.sync()).turnsCounted).toBe(0);
			await fs.appendFile(transcriptPath, assistantLine({ id: 'm3', timestamp: today(4) }) + '\n');
			expect((await accountService.sync()).turnsCounted).toBe(1);

			const usage = TokenUsageService.getInstance().getUsageBySessions().find((u) => u.sessionName === SESSION);
			// m1, m2, b1, m3 — 100 in + 50 out each.
			expect(usage).toMatchObject({ totalInput: 400, totalOutput: 200, eventCount: 4 });
		});

		it('remembers the offsets across a restart', async () => {
			account = null;
			await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: today(1) }) + '\n');
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);
			await accountService.sync();
			account = 'b';
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(2) }) + '\n',
			);
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: ACCOUNT_CONVO }]]),
			);
			await accountService.sync();
			expect(accountService.getCursor(SESSION)!.fileOffsets).toEqual({ [transcriptPath]: expect.any(Number) });

			const restarted = new ClaudeTranscriptSyncService(cursorFile, tmpRoot, (name) => path.join(tmpRoot, 'claude-accounts', name));
			account = null;
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);
			expect((await restarted.sync()).turnsCounted).toBe(0);
			restarted.stop();
		});

		it('does not drain a transcript another session now owns', async () => {
			account = null;
			await fs.writeFile(transcriptPath, assistantLine({ id: 'm1', timestamp: today(1) }) + '\n');
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: CONVO_ID }]]),
			);
			await accountService.sync();

			// SESSION moves on; another agent now holds CONVO_ID and writes to it.
			await fs.appendFile(transcriptPath, assistantLine({ id: 'other-1', timestamp: today(2) }) + '\n');
			await fs.writeFile(
				path.join(accountTranscriptDir, `${ACCOUNT_CONVO}.jsonl`),
				assistantLine({ id: 'b1', timestamp: today(3) }) + '\n',
			);
			account = 'b';
			mockGetRegisteredSessionsMap.mockReturnValue(
				new Map([
					[SESSION, { cwd: projectDir, runtimeType: 'claude-code', claudeSessionId: ACCOUNT_CONVO }],
					['other-agent', { cwd: path.join(tmpRoot, 'elsewhere'), runtimeType: 'claude-code', claudeSessionId: CONVO_ID }],
				]),
			);
			await accountService.sync();
			const usage = TokenUsageService.getInstance().getUsageBySessions().find((u) => u.sessionName === SESSION);
			// m1 and b1 only.
			expect(usage).toMatchObject({ totalInput: 200, totalOutput: 100, eventCount: 2 });
		});
	});
});
