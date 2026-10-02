/**
 * Tests for the runtime Terms consent endpoints (owner only).
 */
import express from 'express';
import request from 'supertest';
import { registerRuntimeTermsRoutes, type RuntimeTermsControllerDeps } from './runtime-terms.controller.js';

function app(deps: RuntimeTermsControllerDeps): express.Express {
	const a = express();
	a.use(express.json());
	const router = express.Router();
	registerRuntimeTermsRoutes(router, deps);
	a.use('/api', router);
	return a;
}

describe('runtime-terms routes', () => {
	const record = { runtime: 'antigravity-cli', status: 'pending', updatedAt: 'now', decisionId: 'D-1' };
	const terms = {
		list: jest.fn(() => [{ ...record, label: 'Antigravity CLI', blockedReason: 'Waiting', choices: [] }] as never),
		requestConsent: jest.fn(async () => record as never),
		answer: jest.fn(async (_r: string, choice: string) => ({ ...record, status: choice === 'decline' ? 'declined' : 'accepting' }) as never),
		supports: (r: string) => r === 'antigravity-cli',
		probe: jest.fn(async () => ({ outcome: 'terms', record, screen: '' }) as never),
	};
	const deps: RuntimeTermsControllerDeps = { terms: () => terms };

	beforeEach(() => jest.clearAllMocks());

	it('lists runtimes with a Terms flow', async () => {
		const res = await request(app(deps)).get('/api/system/runtime-terms');
		expect(res.status).toBe(200);
		expect(res.body.data[0]).toMatchObject({ runtime: 'antigravity-cli', status: 'pending' });
	});

	it('503 before wiring', async () => {
		expect((await request(app({ terms: () => null })).get('/api/system/runtime-terms')).status).toBe(503);
	});

	it('Accept terms… posts the card', async () => {
		const res = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/request');
		expect(res.status).toBe(200);
		expect(terms.requestConsent).toHaveBeenCalledWith('antigravity-cli');
		expect((await request(app(deps)).post('/api/system/runtime-terms/claude-code/request')).status).toBe(404);
	});

	it('probe reads the first screen (owner only)', async () => {
		const res = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/probe');
		expect(res.status).toBe(200);
		expect(res.body.data.outcome).toBe('terms');
		expect((await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/probe').set('X-Agent-Session', 'dev-1')).status).toBe(403);
	});

	it('answers inline with one of the three choices', async () => {
		const res = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/answer').send({ choice: 'agree_no_data' });
		expect(res.status).toBe(200);
		expect(terms.answer).toHaveBeenCalledWith('antigravity-cli', 'agree_no_data');
		const bad = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/answer').send({ choice: 'yes' });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toMatch(/agree_no_data \| agree_share_data \| decline/);
	});

	it('refuses agents: they never accept Terms', async () => {
		const res = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/answer').set('X-Agent-Session', 'dev-1').send({ choice: 'agree_share_data' });
		expect(res.status).toBe(403);
		expect(terms.answer).not.toHaveBeenCalled();
		expect((await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/request').set('X-Agent-Session', 'crewly-orc')).status).toBe(403);
	});

	it('409 when it cannot take the answer now', async () => {
		terms.answer.mockRejectedValueOnce(new Error('Crewly is already accepting these Terms; wait for it to finish'));
		const res = await request(app(deps)).post('/api/system/runtime-terms/antigravity-cli/answer').send({ choice: 'decline' });
		expect(res.status).toBe(409);
	});
});
