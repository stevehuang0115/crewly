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
		expect(res.body).toEqual({ success: true, data: { ...snapshot, claudeAccounts: [] } });
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

	it('asks about Terms again when the owner re-adds a runtime they did not agree to', async () => {
		let settings = { chain: ['claude-code'], memberChains: {} as Record<string, string[]> };
		const fb = {
			snapshot: jest.fn(async () => snapshot as never),
			getSettings: jest.fn(() => settings as never),
			updateSettings: jest.fn((patch: { chain: string[] }) => {
				settings = { ...settings, chain: patch.chain };
				return settings as never;
			}),
		};
		const terms = {
			supports: (r: string) => r === 'antigravity-cli',
			blockedReason: (r: string) => (r === 'antigravity-cli' ? "Terms not accepted: You chose Don't agree" : null),
			reportTermsScreen: jest.fn(async () => null),
		};
		const a = app({ ...deps, fallback: () => fb, terms: () => terms });
		await request(a).put('/api/system/runtime-fallback/settings').send({ chain: ['claude-code', 'antigravity-cli'] });
		expect(terms.reportTermsScreen).toHaveBeenCalledWith('antigravity-cli', { source: 'chain', ownerInitiated: true });
		// Already in the chain: saving again does not re-ask.
		await request(a).put('/api/system/runtime-fallback/settings').send({ chain: ['claude-code', 'antigravity-cli'] });
		expect(terms.reportTermsScreen).toHaveBeenCalledTimes(1);
	});

	it('Test is owner-initiated (a Terms screen then asks again)', async () => {
		smoke.start.mockClear();
		await request(app(deps)).post('/api/system/runtime-smoke-test').send({ runtime: 'crewly-agent' });
		expect(smoke.start).toHaveBeenCalledWith('crewly-agent', { ownerInitiated: true });
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

	describe('Claude Code accounts (#942)', () => {
		const makeAccounts = () => {
			const names = new Set<string>(['work']);
			return {
				names,
				list: jest.fn(() => [...names].map((name) => ({ name, target: `claude-code@${name}`, signedIn: name === 'work', configDir: `/x/${name}` }))),
				ensure: jest.fn((name: string) => void names.add(name)),
				remove: jest.fn((name: string) => void names.delete(name)),
				startLogin: jest.fn(() => ({ status: 'started' as const, harnessId: 'claude-code' as const, account: 'b', dmAvailable: true })),
			};
		};

		it('lists accounts in the snapshot without their folder', async () => {
			const accounts = makeAccounts();
			const res = await request(app({ ...deps, accounts: () => accounts })).get('/api/system/runtime-fallback');
			expect(res.body.data.claudeAccounts).toEqual([{ name: 'work', target: 'claude-code@work', signedIn: true }]);
		});

		it('adds an account and starts its phone sign-in', async () => {
			const accounts = makeAccounts();
			const invalidateAvailability = jest.fn();
			const res = await request(app({ ...deps, fallback: () => ({ ...fallback, invalidateAvailability }), accounts: () => accounts }))
				.post('/api/system/runtime-fallback/claude-accounts')
				.send({ name: ' B ' });
			expect(res.status).toBe(201);
			expect(accounts.ensure).toHaveBeenCalledWith('b');
			expect(accounts.startLogin).toHaveBeenCalledWith('claude-code', { account: 'b', requestedBy: 'dashboard' });
			expect(invalidateAvailability).toHaveBeenCalled();
			expect(res.body.data.login).toMatchObject({ account: 'b', target: 'claude-code@b', status: 'started', dmAvailable: true });
		});

		it('refuses an invalid or reserved name', async () => {
			const accounts = makeAccounts();
			for (const name of ['../x', 'code', '', 'a b']) {
				const res = await request(app({ ...deps, accounts: () => accounts })).post('/api/system/runtime-fallback/claude-accounts').send({ name });
				expect(res.status).toBe(400);
			}
			expect(accounts.startLogin).not.toHaveBeenCalled();
		});

		it('signs a known account in again, 404 for an unknown one', async () => {
			const accounts = makeAccounts();
			expect((await request(app({ ...deps, accounts: () => accounts })).post('/api/system/runtime-fallback/claude-accounts/work/login')).status).toBe(202);
			expect((await request(app({ ...deps, accounts: () => accounts })).post('/api/system/runtime-fallback/claude-accounts/nope/login')).status).toBe(404);
		});

		it('says so when Slack cannot carry the link', async () => {
			const accounts = { ...makeAccounts(), startLogin: jest.fn(() => ({ status: 'started' as const, harnessId: 'claude-code' as const, dmAvailable: false })) };
			const res = await request(app({ ...deps, accounts: () => accounts })).post('/api/system/runtime-fallback/claude-accounts').send({ name: 'b' });
			expect(res.body.data.login.dmAvailable).toBe(false);
			expect(res.body.data.login.next).toMatch(/Slack is not connected/);
		});

		it('removes an account and takes it out of every fallback order', async () => {
			const accounts = makeAccounts();
			let settings = { chain: ['claude-code', 'claude-code@work', 'crewly-agent'], memberChains: { m1: ['claude-code@work'], m2: ['claude-code@work', 'crewly-agent'] } as Record<string, string[]> };
			const fb = {
				snapshot: jest.fn(async () => snapshot as never),
				getSettings: jest.fn(() => settings as never),
				updateSettings: jest.fn((patch: typeof settings) => {
					settings = patch;
					return settings as never;
				}),
			};
			const res = await request(app({ ...deps, fallback: () => fb, accounts: () => accounts })).delete('/api/system/runtime-fallback/claude-accounts/work');
			expect(res.status).toBe(200);
			expect(fb.updateSettings).toHaveBeenCalledWith({ chain: ['claude-code', 'crewly-agent'], memberChains: { m1: null, m2: ['crewly-agent'] } });
			expect(accounts.remove).toHaveBeenCalledWith('work');
		});

		it('refuses to remove an account an agent runs on', async () => {
			const accounts = makeAccounts();
			const busy = { ...snapshot, overrides: [{ sessionName: 'dev-1', runtime: 'claude-code@work' }] };
			const fb = { ...fallback, snapshot: jest.fn(async () => busy as never) };
			const res = await request(app({ ...deps, fallback: () => fb, accounts: () => accounts })).delete('/api/system/runtime-fallback/claude-accounts/work');
			expect(res.status).toBe(409);
			expect(res.body.error).toContain('dev-1');
			expect(accounts.remove).not.toHaveBeenCalled();
		});
	});

	it('GET /system/runtime-smoke-test/:jobId reads a job', async () => {
		expect((await request(app(deps)).get('/api/system/runtime-smoke-test/smoke-1')).body.data.result.passed).toBe(true);
		expect((await request(app(deps)).get('/api/system/runtime-smoke-test/nope')).status).toBe(404);
	});
});
