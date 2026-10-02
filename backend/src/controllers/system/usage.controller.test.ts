/**
 * Tests for the usage stats / token cap / boost endpoints (changes are owner only).
 */
import express from 'express';
import request from 'supertest';
import { registerUsageRoutes, type UsageControllerDeps } from './usage.controller.js';
import { SpendCapError } from '../../services/spend/spend-cap.service.js';

function app(deps: UsageControllerDeps): express.Express {
	const a = express();
	a.use(express.json());
	const router = express.Router();
	registerUsageRoutes(router, deps);
	a.use('/api', router);
	return a;
}

describe('usage routes', () => {
	const config = { defaultAgentCapTokens: null, totalCapTokens: null, agentCapsTokens: {}, teamCapsTokens: {} };
	const caps = {
		view: jest.fn(async (days: number) => ({ today: '2026-10-02', days: new Array(days).fill(null), agents: [], teams: [] }) as never),
		getConfig: jest.fn(() => config),
		setCaps: jest.fn(async () => ({ ...config, defaultAgentCapTokens: 5_000_000 })),
		boost: jest.fn(async (b: object) => ({ id: 'b1', target: 'team:t', ...b }) as never),
		removeBoost: jest.fn(async (id: string) => id === 'b1'),
	};
	const stats = { query: jest.fn(async (days: number, groupBy: string[]) => ({ days, groupBy, rows: [] }) as never) };
	const deps: UsageControllerDeps = { caps: () => caps, stats: () => stats };

	beforeEach(() => jest.clearAllMocks());

	it('GET /system/usage aggregates with days and groupBy (open to agents, read-only)', async () => {
		const res = await request(app(deps)).get('/api/system/usage?days=30&groupBy=team,workItem').set('X-Agent-Session', 'dev-1');
		expect(res.status).toBe(200);
		expect(stats.query).toHaveBeenCalledWith(30, ['team', 'workItem']);
		await request(app(deps)).get('/api/system/usage?days=abc');
		expect(stats.query).toHaveBeenLastCalledWith(7, ['agent']);
	});

	it('GET /system/usage/caps and the legacy GET /system/spend return the caps view', async () => {
		expect((await request(app(deps)).get('/api/system/usage/caps?days=1')).body.data.days).toHaveLength(1);
		expect((await request(app(deps)).get('/api/system/spend')).body.data.today).toBe('2026-10-02');
		expect((await request(app(deps)).get('/api/system/spend/caps')).body.data).toEqual(config);
	});

	it('503 while starting', async () => {
		const off = app({ caps: () => null, stats: () => null });
		expect((await request(off).get('/api/system/usage')).status).toBe(503);
		expect((await request(off).put('/api/system/usage/caps').send({})).status).toBe(503);
		expect((await request(off).post('/api/system/usage/boost').send({ scope: 'all', unlimited: true })).status).toBe(503);
	});

	it('PUT /system/usage/caps is owner only', async () => {
		const ok = await request(app(deps)).put('/api/system/usage/caps').send({ teams: { t: '50M' } });
		expect(ok.status).toBe(200);
		expect(caps.setCaps).toHaveBeenCalledWith({ teams: { t: '50M' } });
		const refused = await request(app(deps)).put('/api/system/usage/caps').set('X-Agent-Session', 'crewly-orc').send({ totalCapTokens: null });
		expect(refused.status).toBe(403);
		expect((await request(app(deps)).put('/api/system/spend/caps').set('X-Agent-Session', 'ella').send({})).status).toBe(403);
	});

	it('POST /system/usage/boost is owner only and passes scope / id / amount / until', async () => {
		const ok = await request(app(deps)).post('/api/system/usage/boost').send({ scope: 'team', id: 'CE', extraTokens: '20M' });
		expect(ok.status).toBe(200);
		expect(caps.boost).toHaveBeenCalledWith({ scope: 'team', id: 'CE', extraTokens: '20M', unlimited: false, until: undefined, by: 'owner' });
		await request(app(deps)).post('/api/system/usage/boost').send({ scope: 'all', unlimited: true, until: '2026-10-03T04:00:00Z' });
		expect(caps.boost).toHaveBeenLastCalledWith({ scope: 'all', id: undefined, extraTokens: undefined, unlimited: true, until: '2026-10-03T04:00:00Z', by: 'owner' });
		const refused = await request(app(deps)).post('/api/system/usage/boost').set('X-Agent-Session', 'ce-owen').send({ scope: 'all', unlimited: true });
		expect(refused.status).toBe(403);
		expect(caps.boost).toHaveBeenCalledTimes(2);
	});

	it('DELETE /system/usage/boost/:id ends a boost (owner only)', async () => {
		expect((await request(app(deps)).delete('/api/system/usage/boost/b1')).status).toBe(200);
		expect((await request(app(deps)).delete('/api/system/usage/boost/nope')).status).toBe(404);
		expect((await request(app(deps)).delete('/api/system/usage/boost/b1').set('X-Agent-Session', 'x')).status).toBe(403);
	});

	it('passes validation errors through with their status', async () => {
		caps.boost.mockRejectedValueOnce(new SpendCapError(404, 'No team called "zz"'));
		const res = await request(app(deps)).post('/api/system/usage/boost').send({ scope: 'team', id: 'zz', unlimited: true });
		expect(res.status).toBe(404);
		expect(res.body.error).toBe('No team called "zz"');
	});

	it('the old raise endpoint is gone (410), still owner only', async () => {
		expect((await request(app(deps)).post('/api/system/spend/raise').send({ session: 'x', capUsd: 5 })).status).toBe(410);
		expect((await request(app(deps)).post('/api/system/spend/raise').set('X-Agent-Session', 'x').send({})).status).toBe(403);
	});
});
