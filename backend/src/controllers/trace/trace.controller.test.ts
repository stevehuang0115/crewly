/**
 * Tests for the run traces API.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { TraceStore, setTraceStoreForTesting } from '../../services/trace/trace-store.js';
import { ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';
import { TicketAutopilotService } from '../../services/project-tickets/ticket-autopilot.service.js';
import { getTraceContext, setTraceContextForTesting } from '../../services/trace/trace-context.service.js';
import { setTraceAnalysisForTesting } from '../../services/trace/trace-analysis.service.js';
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
		setTraceAnalysisForTesting(null);
		app = express();
		app.use(express.json());
		app.use('/api/traces', createTraceRouter());
	});

	afterEach(async () => {
		await store.idle();
		setTraceStoreForTesting(null);
		setTraceContextForTesting(null);
		setTraceAnalysisForTesting(null);
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

	it('filters by autopilot project, day and label, for callers who may read the project (specs/2026-10-03-autopilot-experiments.md)', async () => {
		const owned = express();
		owned.use(ownerUnlessAgentForTests);
		owned.use(express.json());
		owned.use('/api/traces', createTraceRouter());
		const check = jest.fn(async (_p: string, caller: { session?: string }) => {
			if (caller.session === 'dev-ann') throw Object.assign(new Error('Only the owner, the orchestrator or a team lead'), { status: 403 });
		});
		TicketAutopilotService.setInstance({ assertProjectReader: check } as unknown as TicketAutopilotService);
		try {
			const a = start('request', 'TKT-001');
			const b = start('goal', 'Grow traffic');
			const plain = start('goal', 'Untagged');
			store.tag(a, { autopilot: { projectId: 'p-ce', day: '2026-10-03' }, labels: ['feed'] });
			store.tag(b, { autopilot: { projectId: 'p-ce', day: '2026-10-02' } });
			const ids = async (qs: string, who?: string) => {
				const r = request(owned).get(`/api/traces?metrics=0&${qs}`);
				if (who) r.set('X-Agent-Session', who);
				return (await r.expect(200)).body.data.traces.map((t: { traceId: string }) => t.traceId).sort();
			};
			expect(await ids('autopilotProject=p-ce')).toEqual([a, b].sort());
			expect(await ids('autopilotProject=p-ce&day=2026-10-02', 'tl-sam')).toEqual([b]);
			expect(await ids('label=feed')).toEqual([a]);
			expect(await ids('label=feed', 'crewly-orc')).toEqual([a]);
			await request(owned).get('/api/traces?label=feed').set('X-Agent-Session', 'tl-sam').expect(403);
			await request(owned).get('/api/traces?autopilotProject=p-ce').set('X-Agent-Session', 'dev-ann').expect(403);
			await request(owned).get('/api/traces?day=10-02').expect(400);
			await request(owned).get('/api/traces?type=autopilot').expect(200);
			// One trace: tagged ones are gated, untagged ones are unchanged.
			await request(owned).get(`/api/traces/${a}`).set('X-Agent-Session', 'dev-ann').expect(403);
			await request(owned).get(`/api/traces/${a}/summary`).set('X-Agent-Session', 'dev-ann').expect(403);
			await request(owned).get(`/api/traces/${a}/timeline`).set('X-Agent-Session', 'tl-sam').expect(200);
			await request(owned).get(`/api/traces/${plain}`).set('X-Agent-Session', 'dev-ann').expect(200);
			await request(app).get(`/api/traces/${a}/metrics`).expect(401); // no credential at all
			await request(app).get(`/api/traces/${plain}/metrics`).expect(200);
			expect(check).toHaveBeenCalledWith('p-ce', { session: 'tl-sam' });
		} finally {
			TicketAutopilotService.setInstance(null);
		}
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

	describe('autonomy metrics (#984)', () => {
		/** A trace: owner ask, a decision open for 60 min, then the answer. */
		const seed = (): string => {
			const id = start('request', 'TKT-002');
			const ctx = getTraceContext();
			const t0 = Date.now() - 120 * 60_000;
			const at = (m: number): Date => new Date(t0 + m * 60_000);
			ctx.record({ traceId: id, type: 'turn.delivered', actor: { kind: 'owner' }, summary: 'Owner message delivered to ella: fix it', refs: { session: 'ella' }, data: { kind: 'owner_message' }, at: at(0) });
			ctx.record({ traceId: id, type: 'decision.created', actor: { kind: 'agent', session: 'ella' }, summary: 'Decision D-1 asked: ok?', refs: { decisionId: 'D-1', session: 'ella' }, at: at(5) });
			ctx.record({ traceId: id, type: 'decision.status', actor: { kind: 'owner' }, summary: 'Decision D-1 open → resolved', refs: { decisionId: 'D-1' }, data: { from: 'open', to: 'resolved' }, at: at(65) });
			ctx.record({ traceId: id, type: 'guard.block', actor: { kind: 'agent', session: 'ella' }, summary: 'ella was refused POST /x', outcome: 'blocked', at: at(66) });
			return id;
		};

		it('GET /:id/metrics returns the metrics, honouring stallMinutes', async () => {
			const id = seed();
			const res = await request(app).get(`/api/traces/${id}/metrics`).expect(200);
			expect(res.body.data).toMatchObject({
				traceId: id,
				ownerTouches: { answered: 1, total: 1 },
				interventions: { guardBlocks: 1 },
				stalls: { thresholdMinutes: 30, count: 1, byCause: { waiting_on_owner: 1 } },
			});
			const tight = await request(app).get(`/api/traces/${id}/metrics?stallMinutes=90`).expect(200);
			expect(tight.body.data.stalls).toMatchObject({ thresholdMinutes: 90, count: 0 });
			await request(app).get(`/api/traces/${id}/metrics?stallMinutes=-3`).expect(400);
			await request(app).get(`/api/traces/${id}/metrics?stallMinutes=abc`).expect(400);
			await request(app).get('/api/traces/not-a-trace/metrics').expect(400);
			await request(app).get('/api/traces/tr-20261003-deadbeef/metrics').expect(404);
		});

		it('GET /:id/timeline returns groups with the stall', async () => {
			const id = seed();
			const res = await request(app).get(`/api/traces/${id}/timeline`).expect(200);
			expect(res.body.data.root.traceId).toBe(id);
			expect(res.body.data.metrics.traceId).toBe(id);
			expect(res.body.data.groups.map((g: { kind: string }) => g.kind)).toEqual(['turn', 'stall', 'owner', 'turn']);
			expect(res.body.data.truncated).toBe(false);
			await request(app).get('/api/traces/tr-20261003-deadbeef/timeline').expect(404);
		});

		it('GET /:id/summary returns bounded text', async () => {
			const id = seed();
			const res = await request(app).get(`/api/traces/${id}/summary?maxChars=700`).expect(200);
			expect(res.body.data.text.length).toBeLessThanOrEqual(700);
			expect(res.body.data.text).toContain(`Trace ${id}`);
			expect(res.body.data.links.ui).toBe(`/tickets/traces/${id}`);
			expect(res.body.data.metrics.traceId).toBe(id);
			await request(app).get('/api/traces/tr-20261003-deadbeef/summary').expect(404);
		});

		it('embeds a metrics summary in the list unless metrics=0', async () => {
			const id = seed();
			const res = await request(app).get('/api/traces').expect(200);
			expect(res.body.data.traces[0]).toMatchObject({ traceId: id, metrics: { ownerTouches: 1, interventions: 1, stalls: 1 } });
			const bare = await request(app).get('/api/traces?metrics=0').expect(200);
			expect(bare.body.data.traces[0].metrics).toBeUndefined();
			await request(app).get('/api/traces?stallMinutes=0').expect(400);
		});
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
