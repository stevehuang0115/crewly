/**
 * Tests for the trace analysis service: whole-trace reads across pages, the
 * metrics cache, timeline, summary and list embedding.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TraceStore } from './trace-store.js';
import { TraceContext } from './trace-context.service.js';
import { TraceAnalysisService, getTraceAnalysis, setTraceAnalysisForTesting } from './trace-analysis.service.js';
import { TRACE_CONSTANTS } from '../../constants.js';

describe('TraceAnalysisService', () => {
	let dir: string;
	let store: TraceStore;
	let ctx: TraceContext;
	let clock: number;
	let svc: TraceAnalysisService;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-analysis-'));
		clock = Date.parse('2026-10-03T10:00:00Z');
		store = new TraceStore({ dir, indexFlushDelayMs: 5, now: () => new Date(clock) });
		ctx = new TraceContext(() => store, () => clock);
		svc = new TraceAnalysisService(() => store, () => clock);
	});

	afterEach(async () => {
		await store.idle();
		store.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const startTrace = (): string => ctx.startTrace({ kind: 'goal', summary: 'Grow traffic', actor: { kind: 'owner' } })!;

	it('reads every page of a long trace', async () => {
		const id = startTrace();
		const n = TRACE_CONSTANTS.MAX_PAGE_SIZE + 25;
		for (let i = 0; i < n; i++) ctx.record({ traceId: id, type: 'skill.call', actor: { kind: 'agent', session: 'ella' }, summary: `call ${i}` });
		const full = await svc.readAll(id);
		expect(full?.events).toHaveLength(n + 1);
		expect(full?.root.traceId).toBe(id);
		expect(await svc.readAll('tr-20261003-deadbeef')).toBeNull();
	});

	it('caches metrics until the trace changes or the TTL passes', async () => {
		const id = startTrace();
		ctx.record({ traceId: id, type: 'skill.call', actor: { kind: 'agent', session: 'ella' }, summary: 'a' });
		const readSpy = jest.spyOn(store, 'read');
		const first = await svc.metrics(id);
		const second = await svc.metrics(id);
		expect(second).toBe(first);
		expect(readSpy).toHaveBeenCalledTimes(1);

		// A new event: recomputed.
		clock += 1000;
		ctx.record({ traceId: id, type: 'skill.call', actor: { kind: 'agent', session: 'ella' }, summary: 'b' });
		const third = await svc.metrics(id);
		expect(third).not.toBe(first);
		expect(third?.eventCount).toBe(2);

		// Another threshold: recomputed.
		expect((await svc.metrics(id, 10))?.stalls.thresholdMinutes).toBe(10);

		// TTL.
		const beforeTtl = readSpy.mock.calls.length;
		await svc.metrics(id, 10);
		expect(readSpy.mock.calls.length).toBe(beforeTtl);
		clock += TRACE_CONSTANTS.METRICS_CACHE_TTL_MS + 1;
		await svc.metrics(id, 10);
		expect(readSpy.mock.calls.length).toBe(beforeTtl + 1);

		expect(await svc.metrics('tr-20261003-deadbeef')).toBeNull();
	});

	it('builds the timeline and the summary', async () => {
		const id = startTrace();
		ctx.record({ traceId: id, type: 'turn.delivered', actor: { kind: 'owner' }, summary: 'Owner message delivered to ella: hi', refs: { session: 'ella' }, data: { kind: 'owner_message' } });
		ctx.record({ traceId: id, type: 'skill.call', actor: { kind: 'agent', session: 'ella' }, summary: 'ella called POST /x' });
		const tl = await svc.timeline(id);
		expect(tl?.groups.map((g) => g.title)).toEqual(['Owner → ella']);
		expect(tl?.metrics.eventCount).toBe(2);
		const sum = await svc.summary(id, 1000);
		expect(sum?.text.length).toBeLessThanOrEqual(1000);
		expect(sum?.links.ui).toBe(`/tickets/traces/${id}`);
		expect(await svc.timeline('tr-20261003-deadbeef')).toBeNull();
		expect(await svc.summary('tr-20261003-deadbeef')).toBeNull();
	});

	it('embeds metrics summaries in list rows', async () => {
		const id = startTrace();
		const rows = await svc.withMetrics(store.list());
		expect(rows).toEqual([expect.objectContaining({ traceId: id, metrics: expect.objectContaining({ wallMs: 0, state: 'no_open_work' }) })]);
	});

	it('keeps one process-wide instance, replaceable in tests', () => {
		setTraceAnalysisForTesting(svc);
		expect(getTraceAnalysis()).toBe(svc);
		setTraceAnalysisForTesting(null);
		expect(getTraceAnalysis()).not.toBe(svc);
		setTraceAnalysisForTesting(null);
	});
});
