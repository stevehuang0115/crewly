/**
 * Tests for GET /api/activity (crewly#881).
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseActivityQuery, registerActivityRoutes } from './activity.controller.js';
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
