/**
 * Tests for the run traces API.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { TraceStore, setTraceStoreForTesting } from '../../services/trace/trace-store.js';
import { getTraceContext, setTraceContextForTesting } from '../../services/trace/trace-context.service.js';
import { createTraceRouter } from './trace.controller.js';

describe('trace.controller', () => {
	let dir: string;
	let store: TraceStore;
	let app: Express;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-api-'));
		store = new TraceStore({ dir, indexFlushDelayMs: 5 });
		setTraceStoreForTesting(store);
		setTraceContextForTesting(null);
		app = express();
		app.use(express.json());
		app.use('/api/traces', createTraceRouter());
	});

	afterEach(async () => {
		await store.idle();
		setTraceStoreForTesting(null);
		setTraceContextForTesting(null);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const start = (kind: 'request' | 'goal', summary: string) => getTraceContext().startTrace({ kind, summary, actor: { kind: 'owner' } })!;

	it('lists traces with since and type filters', async () => {
		const a = start('request', 'TKT-001');
		const b = start('goal', 'Grow traffic');
		const all = await request(app).get('/api/traces').expect(200);
		expect(all.body.data.writeFailures).toBe(0);
		expect(all.body.data.traces.map((t: { traceId: string }) => t.traceId).sort()).toEqual([a, b].sort());
		const goals = await request(app).get('/api/traces?type=goal').expect(200);
		expect(goals.body.data.traces.map((t: { traceId: string }) => t.traceId)).toEqual([b]);
		const later = await request(app).get('/api/traces?since=2999-01-01T00:00:00Z').expect(200);
		expect(later.body.data.traces).toEqual([]);
		await request(app).get('/api/traces?type=cron').expect(400);
		await request(app).get('/api/traces?since=yesterday').expect(400);
	});

	it('returns a trace with its root and paginated events', async () => {
		const id = start('request', 'TKT-001');
		for (let i = 0; i < 4; i++) {
			getTraceContext().record({ traceId: id, type: 'skill.call', actor: { kind: 'agent', session: 'dev-1' }, summary: `call ${i}` });
		}
		const res = await request(app).get(`/api/traces/${id}?offset=1&limit=2`).expect(200);
		expect(res.body.data.root).toMatchObject({ traceId: id, kind: 'request', summary: 'TKT-001' });
		expect(res.body.data.total).toBe(5);
		expect(res.body.data.events.map((e: { summary: string }) => e.summary)).toEqual(['call 0', 'call 1']);
		expect(res.body.data.truncated).toBe(false);
	});

	it('rejects malformed ids and 404s unknown ones', async () => {
		await request(app).get('/api/traces/..%2F..%2Fetc').expect(400);
		await request(app).get('/api/traces/tr-20261003-deadbeef').expect(404);
	});

	it('resolves a trace from a work item, ticket, request or decision', async () => {
		const id = start('request', 'TKT-001');
		store.linkRef('workItem', 'wi-1', id);
		store.linkRef('ticket', 'CE-7', id);
		store.linkRef('request', 'req-1', id);
		store.linkRef('decision', 'D-3', id);
		store.linkRef('experiment', 'EXP-4', id);
		for (const q of ['workItemId=wi-1', 'ticketId=CE-7', 'requestId=req-1', 'decisionId=D-3', 'experimentId=EXP-4']) {
			const res = await request(app).get(`/api/traces/by-ref?${q}`).expect(200);
			expect(res.body.data).toMatchObject({ traceId: id, root: { kind: 'request' } });
		}
		await request(app).get('/api/traces/by-ref?workItemId=nope').expect(404);
		await request(app).get('/api/traces/by-ref').expect(400);
	});

	it('starts goal and experiment traces, bound to an agent caller', async () => {
		const res = await request(app)
			.post('/api/traces')
			.set('X-Agent-Session', 'seo-lead')
			.send({ kind: 'experiment', summary: 'Rewrite titles → CTR 2% to 3%', refs: { ticketId: 'CE-9', bogus: 1 } })
			.expect(201);
		const id = res.body.data.traceId as string;
		expect(store.getEntry(id)?.root).toMatchObject({ kind: 'experiment', actor: { kind: 'agent', session: 'seo-lead' }, refs: { ticketId: 'CE-9' } });
		expect(getTraceContext().currentTrace('seo-lead')).toBe(id);
		await request(app).post('/api/traces').send({ kind: 'request', summary: 'x' }).expect(400);
		await request(app).post('/api/traces').send({ kind: 'goal' }).expect(400);
	});
});
