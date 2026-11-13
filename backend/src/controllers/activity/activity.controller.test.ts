/**
 * Tests for GET /api/activity (crewly#881) and POST /api/activity/external.
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseActivityQuery, parseExternalActivity, registerActivityRoutes } from './activity.controller.js';
import { ActivityLogService } from '../../services/activity/activity-log.service.js';
import type { ComponentLogger } from '../../services/core/logger.service.js';

// The owner gate is the middleware's business; here an `x-test-agent` header stands for a non-owner.
jest.mock('../../middleware/caller-identity.middleware.js', () => ({
	requireOwner: (req: { headers: Record<string, string> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
		req.headers['x-test-agent'] ? res.status(403).json({ success: false, error: 'owner only' }) : next(),
	getCallerIdentity: () => ({ kind: 'owner', via: 'api-token' }),
}));

const quiet = (): ComponentLogger => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as ComponentLogger;

function app(log: ActivityLogService): express.Express {
	const a = express();
	a.use(express.json());
	const router = express.Router();
	registerActivityRoutes(router, () => log);
	a.use('/api', router);
	return a;
}

describe('GET /api/activity', () => {
	let dir: string;
	let log: ActivityLogService;
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-api-'));
		let t = Date.parse('2026-10-24T08:00:00Z');
		log = new ActivityLogService({ dir, now: () => new Date((t += 3600_000)), logger: quiet() });
		log.record({ actor: { type: 'owner', via: 'owner-session' }, action: 'team.member.updated', target: { type: 'member', id: 'm1', name: 'Ella' }, before: { role: 'dev' }, after: { role: 'lead' } });
		log.record({ actor: { type: 'agent', id: 'dev-ann' }, action: 'decision.asked', target: { type: 'decision', id: 'd1' } });
		log.record({ actor: { type: 'owner', id: 'U1', via: 'button' }, action: 'decision.resolved', target: { type: 'decision', id: 'd1' }, note: 'Send Monday' });
		await log.flush();
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('returns entries newest first with the count and limit', async () => {
		const res = await request(app(log)).get('/api/activity');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.count).toBe(3);
		expect(res.body.data.limit).toBe(100);
		expect(res.body.data.entries.map((e: { action: string }) => e.action)).toEqual(['decision.resolved', 'decision.asked', 'team.member.updated']);
		expect(res.body.data.entries[2]).toMatchObject({ actor: { type: 'owner' }, before: { role: 'dev' }, after: { role: 'lead' } });
	});

	it('filters by actor, action prefix, target, dates and limit', async () => {
		const a = app(log);
		expect((await a_get(a, '/api/activity?actorType=agent')).map((e) => e.action)).toEqual(['decision.asked']);
		expect((await a_get(a, '/api/activity?action=decision.')).map((e) => e.action)).toEqual(['decision.resolved', 'decision.asked']);
		expect((await a_get(a, '/api/activity?targetType=member&targetId=m1')).map((e) => e.action)).toEqual(['team.member.updated']);
		expect((await a_get(a, '/api/activity?since=2026-10-24T10:00:00Z')).map((e) => e.action)).toEqual(['decision.resolved', 'decision.asked']);
		// A bare until date reaches the end of that day.
		expect((await a_get(a, '/api/activity?until=2026-10-24')).map((e) => e.action)).toEqual(['decision.resolved', 'decision.asked', 'team.member.updated']);
		expect((await a_get(a, '/api/activity?limit=1')).map((e) => e.action)).toEqual(['decision.resolved']);
	});

	it('rejects a bad actor type, date or limit with 400 and non-owners with 403', async () => {
		const a = app(log);
		expect((await request(a).get('/api/activity?actorType=robot')).status).toBe(400);
		expect((await request(a).get('/api/activity?since=yesterday')).status).toBe(400);
		expect((await request(a).get('/api/activity?limit=0')).status).toBe(400);
		expect((await request(a).get('/api/activity?limit=abc')).status).toBe(400);
		expect((await request(a).get('/api/activity').set('x-test-agent', 'dev-ann')).status).toBe(403);
	});

	it('answers 500 when the log cannot be read', async () => {
		const broken = { list: async () => Promise.reject(new Error('boom')) } as unknown as ActivityLogService;
		const res = await request(app(broken)).get('/api/activity');
		expect(res.status).toBe(500);
		expect(res.body).toEqual({ success: false, error: 'boom' });
	});
});

describe('parseActivityQuery', () => {
	it('trims strings, caps the limit and drops empty values', () => {
		expect(parseActivityQuery({ actorId: ' dev-ann ', action: '', limit: '5000' })).toEqual({ actorId: 'dev-ann', limit: 1000 });
		expect(parseActivityQuery({})).toEqual({});
		expect(parseActivityQuery({ since: '2026-10-01', until: '2026-10-02' })).toEqual({ since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T23:59:59.999Z' });
	});
});

/**
 * GET the route and return the entries.
 *
 * @param a - App
 * @param url - URL with query
 * @returns Entries
 */
async function a_get(a: express.Express, url: string): Promise<Array<{ action: string }>> {
	const res = await request(a).get(url);
	expect(res.status).toBe(200);
	return res.body.data.entries;
}

describe('parseExternalActivity', () => {
	const ok = { actor: { type: 'support', id: 'ops@crewlyai.com', via: 'ops-sidecar' }, action: 'ops.read', target: { type: 'ops-read', id: '/conversations' }, note: 'Read the conversation list.', after: { agent: 'support-ella', status: 200 } };

	it('accepts a sidecar read and fixes the actor and target types itself', () => {
		expect(parseExternalActivity(ok)).toEqual({
			actor: { type: 'support', id: 'ops@crewlyai.com', via: 'ops-sidecar' },
			action: 'ops.read',
			target: { type: 'ops-read', id: '/conversations' },
			after: { agent: 'support-ella', status: 200 },
			note: 'Read the conversation list.',
		});
		expect(parseExternalActivity({ actor: { id: ' ops@crewlyai.com ' }, action: 'ops.refused', target: { id: '/settings' } })).toEqual({
			actor: { type: 'support', id: 'ops@crewlyai.com', via: 'ops-sidecar' },
			action: 'ops.refused',
			target: { type: 'ops-read', id: '/settings' },
		});
	});

	it('refuses any other actor, via, action or target type', () => {
		expect(parseExternalActivity({ ...ok, actor: { ...ok.actor, type: 'owner' } })).toEqual({ error: 'actor.type must be support' });
		expect(parseExternalActivity({ ...ok, actor: { ...ok.actor, via: 'owner-session' } })).toEqual({ error: 'actor.via must be ops-sidecar' });
		expect(parseExternalActivity({ ...ok, action: 'team.member.updated' })).toEqual({ error: 'action must be one of ops.read, ops.refused' });
		expect(parseExternalActivity({ ...ok, target: { type: 'team', id: 't1' } })).toEqual({ error: 'target.type must be ops-read' });
	});

	it('refuses a missing or overlong asker and path, and a note that is not text', () => {
		expect(parseExternalActivity({ ...ok, actor: { type: 'support' } })).toHaveProperty('error');
		expect(parseExternalActivity({ ...ok, actor: { id: 'a'.repeat(255) } })).toHaveProperty('error');
		expect(parseExternalActivity({ ...ok, target: { id: '' } })).toHaveProperty('error');
		expect(parseExternalActivity({ ...ok, target: { id: '/'.padEnd(257, 'x') } })).toHaveProperty('error');
		expect(parseExternalActivity({ ...ok, note: 5 })).toEqual({ error: 'note must be a string' });
		for (const body of [null, undefined, 'x', [], 7]) expect(parseExternalActivity(body)).toHaveProperty('error');
	});

	it('keeps only the agent name and status of `after`, and cuts a long note', () => {
		const got = parseExternalActivity({ ...ok, note: 'n'.repeat(500), after: { agent: 7, status: 'ok', before: 'x', token: 'secret' } });
		expect(got).not.toHaveProperty('after');
		expect((got as { note: string }).note).toHaveLength(300);
		expect(parseExternalActivity({ ...ok, after: { status: 404, extra: true } })).toMatchObject({ after: { status: 404 } });
		expect(parseExternalActivity({ ...ok, after: { status: 99 } })).not.toHaveProperty('after');
	});
});

describe('POST /api/activity/external', () => {
	let dir: string;
	let log: ActivityLogService;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-ext-'));
		log = new ActivityLogService({ dir, now: () => new Date('2026-11-12T09:00:00Z'), logger: quiet() });
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('records a sidecar read that GET /api/activity then returns', async () => {
		const a = app(log);
		const res = await request(a)
			.post('/api/activity/external')
			.send({ actor: { type: 'support', id: 'ops@crewlyai.com', via: 'ops-sidecar' }, action: 'ops.read', target: { type: 'ops-read', id: '/agents' }, note: 'Read the agent list.', after: { agent: null, status: 200 } });
		expect(res.status).toBe(201);
		expect(res.body).toEqual({ success: true, data: { id: expect.any(String) } });
		const listed = await request(a).get('/api/activity?actorType=support');
		expect(listed.body.data.entries).toEqual([
			expect.objectContaining({ id: res.body.data.id, actor: { type: 'support', id: 'ops@crewlyai.com', via: 'ops-sidecar' }, action: 'ops.read', target: { type: 'ops-read', id: '/agents' }, after: { status: 200 }, note: 'Read the agent list.' }),
		]);
	});

	it('answers 400 for a body that is not a sidecar read and writes nothing', async () => {
		const a = app(log);
		const res = await request(a).post('/api/activity/external').send({ actor: { type: 'owner', id: 'me' }, action: 'decision.resolved', target: { type: 'decision', id: 'd1' } });
		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
		expect((await request(a).get('/api/activity')).body.data.count).toBe(0);
	});

	it('is owner only', async () => {
		const res = await request(app(log)).post('/api/activity/external').set('x-test-agent', '1').send({ actor: { id: 'ops@crewlyai.com' }, action: 'ops.read', target: { id: '/agents' } });
		expect(res.status).toBe(403);
		expect(await log.list()).toEqual([]);
	});
});
