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
import { encodeProjectSlug } from './claude-session-tokens.service.js';

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
});
