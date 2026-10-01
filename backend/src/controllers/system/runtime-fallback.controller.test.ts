/**
 * Tests for the runtime-fallback / smoke-test endpoints.
 */

import express from 'express';
import request from 'supertest';
import { registerRuntimeFallbackRoutes, type RuntimeFallbackControllerDeps } from './runtime-fallback.controller.js';
import { RuntimeFallbackSettingsError } from '../../services/runtime-fallback/runtime-fallback.types.js';

function app(deps: RuntimeFallbackControllerDeps): express.Express {
	const a = express();
	a.use(express.json());
	const router = express.Router();
	registerRuntimeFallbackRoutes(router, deps);
	a.use('/api', router);
	return a;
}

const snapshot = { settings: { chain: ['claude-code'] }, runtimes: [], exhausted: [], overrides: [] };

describe('runtime-fallback routes', () => {
	const fallback = {
		snapshot: jest.fn(async () => snapshot as never),
		updateSettings: jest.fn((patch: unknown) => {
			if ((patch as { chain?: unknown }).chain === 'bad') throw new RuntimeFallbackSettingsError('chain must be a list of runtimes');
			return snapshot.settings as never;
		}),
	};
	const job = { jobId: 'smoke-1', runtime: 'crewly-agent', state: 'running' as const, startedAt: 'now' };
	const result = { runtime: 'crewly-agent', passed: true, steps: [], durationMs: 1 };
	const smoke = {
		start: jest.fn((runtime: string) => {
			if (runtime !== 'crewly-agent') throw new Error(`Unknown runtime: ${runtime}`);
			return { job, done: Promise.resolve(result) };
		}),
		get: jest.fn((id: string) => (id === 'smoke-1' ? { ...job, state: 'done' as const, result } : null)),
	};
	const deps: RuntimeFallbackControllerDeps = { fallback: () => fallback, smoke: () => smoke };

	it('GET /system/runtime-fallback returns the snapshot', async () => {
		const res = await request(app(deps)).get('/api/system/runtime-fallback');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: snapshot });
	});

	it('returns 503 before the service is wired', async () => {
		const res = await request(app({ ...deps, fallback: () => null })).get('/api/system/runtime-fallback');
		expect(res.status).toBe(503);
	});

	it('PUT /system/runtime-fallback/settings validates', async () => {
		expect((await request(app(deps)).put('/api/system/runtime-fallback/settings').send({ chain: ['claude-code'] })).status).toBe(200);
		const bad = await request(app(deps)).put('/api/system/runtime-fallback/settings').send({ chain: 'bad' });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toBe('chain must be a list of runtimes');
	});

	it('POST /system/runtime-smoke-test starts a job, or waits for it', async () => {
		const started = await request(app(deps)).post('/api/system/runtime-smoke-test').send({ runtime: 'crewly-agent' });
		expect(started.status).toBe(202);
		expect(started.body.data.jobId).toBe('smoke-1');
		const waited = await request(app(deps)).post('/api/system/runtime-smoke-test?wait=1').send({ runtime: 'crewly-agent' });
		expect(waited.body.data).toMatchObject({ state: 'done', result: { passed: true } });
		const bad = await request(app(deps)).post('/api/system/runtime-smoke-test').send({ runtime: 'nope' });
		expect(bad.status).toBe(400);
	});

	it('GET /system/runtime-smoke-test/:jobId reads a job', async () => {
		expect((await request(app(deps)).get('/api/system/runtime-smoke-test/smoke-1')).body.data.result.passed).toBe(true);
		expect((await request(app(deps)).get('/api/system/runtime-smoke-test/nope')).status).toBe(404);
	});
});
