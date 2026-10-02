/**
 * Tests for the spend + spend-cap endpoints (changes are owner only).
 */
import express from 'express';
import request from 'supertest';
import { registerSpendRoutes, type SpendControllerDeps } from './spend.controller.js';
import { SpendCapError } from '../../services/spend/spend-cap.service.js';

function app(deps: SpendControllerDeps): express.Express {
	const a = express();
	a.use(express.json());
	const router = express.Router();
	registerSpendRoutes(router, deps);
	a.use('/api', router);
	return a;
}

describe('spend routes', () => {
	const caps = { defaultAgentCapUsd: null, totalCapUsd: null, agentCapsUsd: {} };
	const spend = {
		view: jest.fn(async (days: number) => ({ today: '2026-10-02', days: new Array(days).fill(null), agents: [] }) as never),
		getConfig: jest.fn(() => caps),
		setCaps: jest.fn(async () => ({ ...caps, defaultAgentCapUsd: 5 })),
		raiseToday: jest.fn(async (_s: string, usd: unknown) => Number(usd)),
	};
	const deps: SpendControllerDeps = { spend: () => spend };

	beforeEach(() => jest.clearAllMocks());

	it('GET /system/spend?days=7 returns the view for the window', async () => {
		const res = await request(app(deps)).get('/api/system/spend?days=7');
		expect(res.status).toBe(200);
		expect(spend.view).toHaveBeenCalledWith(7);
		expect(res.body.data.today).toBe('2026-10-02');
		await request(app(deps)).get('/api/system/spend?days=abc');
		expect(spend.view).toHaveBeenLastCalledWith(7);
	});

	it('GET is open to agents (read-only)', async () => {
		expect((await request(app(deps)).get('/api/system/spend').set('X-Agent-Session', 'dev-1')).status).toBe(200);
		expect((await request(app(deps)).get('/api/system/spend/caps').set('X-Agent-Session', 'dev-1')).status).toBe(200);
	});

	it('503 before wiring', async () => {
		expect((await request(app({ spend: () => null })).get('/api/system/spend')).status).toBe(503);
		expect((await request(app({ spend: () => null })).put('/api/system/spend/caps').send({})).status).toBe(503);
	});

	it('PUT /system/spend/caps is owner only', async () => {
		const ok = await request(app(deps)).put('/api/system/spend/caps').send({ defaultAgentCapUsd: 5 });
		expect(ok.status).toBe(200);
		expect(spend.setCaps).toHaveBeenCalledWith({ defaultAgentCapUsd: 5 });
		const refused = await request(app(deps)).put('/api/system/spend/caps').set('X-Agent-Session', 'crewly-orc').send({ defaultAgentCapUsd: 500 });
		expect(refused.status).toBe(403);
		expect(spend.setCaps).toHaveBeenCalledTimes(1);
	});

	it('POST /system/spend/raise is owner only and validates', async () => {
		const ok = await request(app(deps)).post('/api/system/spend/raise').send({ session: 'crewly-orc', capUsd: 10 });
		expect(ok.status).toBe(200);
		expect(ok.body.data).toEqual({ session: 'crewly-orc', capUsd: 10 });
		expect((await request(app(deps)).post('/api/system/spend/raise').set('X-Agent-Session', 'crewly-orc').send({ session: 'crewly-orc', capUsd: 99 })).status).toBe(403);
		expect((await request(app(deps)).post('/api/system/spend/raise').send({ capUsd: 10 })).status).toBe(400);
		expect(spend.raiseToday).toHaveBeenCalledTimes(1);
	});

	it('passes a validation error through as 400 with its message', async () => {
		spend.setCaps.mockRejectedValueOnce(new SpendCapError(400, 'defaultAgentCapUsd must be a positive amount in USD (e.g. 5) or null to turn it off'));
		const res = await request(app(deps)).put('/api/system/spend/caps').send({ defaultAgentCapUsd: -1 });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/positive amount/);
	});
});
