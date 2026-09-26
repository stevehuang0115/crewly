/**
 * Tests for the /api/harness controller: every route of the contract, the
 * owner-only refusals (X-Agent-Session → 403) and error mapping.
 */

import express from 'express';
import request from 'supertest';
import { HarnessApiKeyError } from '../../services/harness/harness-api-key.service.js';
import { HarnessInstallError } from '../../services/harness/harness-install.service.js';
import { HarnessService, UnknownHarnessError } from '../../services/harness/harness.service.js';
import type { HarnessStatus, LoginSession } from '../../services/harness/harness.types.js';
import { LoginBrokerError } from '../../services/harness/login-broker.service.js';
import { createHarnessRouter } from './harness.routes.js';
import { refuseAgent, sendError } from './harness.controller.js';

const STATUS: HarnessStatus = {
	id: 'claude-code',
	displayName: 'Claude Code',
	installed: true,
	version: '2.1.282',
	latestVersion: '2.1.300',
	updateAvailable: true,
	loginState: 'logged_out',
	loginSource: null,
	loginMethods: [
		{ id: 'subscription', label: 'Claude subscription (Pro / Max)', kind: 'broker' },
		{ id: 'api_key', label: 'Anthropic API key', kind: 'api_key' },
	],
	retired: false,
};

const SESSION: LoginSession = {
	id: 's1',
	harnessId: 'claude-code',
	method: 'subscription',
	state: 'awaiting_user',
	url: 'https://claude.com/cai/oauth/authorize?x=1',
	userCode: null,
	needsInput: true,
	message: null,
	screen: 'Paste code here if prompted >',
	startedAt: '2026-09-25T00:00:00.000Z',
	updatedAt: '2026-09-25T00:00:01.000Z',
};

/**
 * Fake harness service.
 *
 * @returns Mocks cast to HarnessService
 */
function fakeService() {
	const mocks = {
		getOverview: jest.fn(async () => ({ harnesses: [STATUS], orcHarness: 'claude-code', systemTools: [{ id: 'jq', installed: true, installHint: 'brew install jq' }] })),
		startInstall: jest.fn(() => ({ jobId: 'job-1', harnessId: 'claude-code', state: 'running', log: '', usedUserPrefix: false })),
		getInstallJob: jest.fn(() => ({ jobId: 'job-1', harnessId: 'claude-code', state: 'succeeded', log: 'Installed.\n', usedUserPrefix: true })),
		setOrcHarness: jest.fn(async (id: string) => id),
		startLogin: jest.fn(() => SESSION),
		getStatus: jest.fn(async () => ({ ...STATUS, loginState: 'logged_out' })),
		submitApiKey: jest.fn(async () => ({ ...STATUS, loginState: 'logged_in', loginSource: 'crewly-api-key' })),
		broker: {
			get: jest.fn(() => SESSION),
			input: jest.fn(() => ({ ...SESSION, state: 'verifying', needsInput: false })),
			cancel: jest.fn(() => ({ ...SESSION, state: 'cancelled' })),
		},
	};
	return { mocks, service: mocks as unknown as HarnessService };
}

/**
 * Express app with the harness router.
 *
 * @param service - Harness service
 * @returns App
 */
function appWith(service: HarnessService) {
	const app = express();
	app.use(express.json());
	app.use('/api/harness', createHarnessRouter(() => service));
	return app;
}

const AGENT = { 'X-Agent-Session': 'crewly-orc' };

describe('harness controller', () => {
	it('GET / returns harnesses, orc harness and system tools', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).get('/api/harness');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			success: true,
			data: { harnesses: [STATUS], orcHarness: 'claude-code', systemTools: [{ id: 'jq', installed: true, installHint: 'brew install jq' }] },
		});
	});

	it('GET / stays readable for agents', async () => {
		const { service } = fakeService();
		expect((await request(appWith(service)).get('/api/harness').set(AGENT)).status).toBe(200);
	});

	it('POST /:id/install returns the job id', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/harness/claude-code/install');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: { jobId: 'job-1' } });
		expect(mocks.startInstall).toHaveBeenCalledWith('claude-code');
	});

	it('GET /install/:jobId returns the job', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).get('/api/harness/install/job-1');
		expect(res.body).toEqual({ success: true, data: { jobId: 'job-1', harnessId: 'claude-code', state: 'succeeded', log: 'Installed.\n', usedUserPrefix: true } });
	});

	it('PUT /orc sets the orchestrator harness', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).put('/api/harness/orc').send({ harnessId: 'codex-cli' });
		expect(res.body).toEqual({ success: true, data: { orcHarness: 'codex-cli' } });
		expect(mocks.setOrcHarness).toHaveBeenCalledWith('codex-cli');
		expect((await request(appWith(service)).put('/api/harness/orc').send({})).status).toBe(400);
	});

	it('POST /orc is the relay twin of PUT /orc', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/harness/orc').send({ harnessId: 'claude-code' });
		expect(res.body).toEqual({ success: true, data: { orcHarness: 'claude-code' } });
		expect(mocks.setOrcHarness).toHaveBeenCalledWith('claude-code');
	});

	it('POST /:id/login starts a broker login', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/harness/claude-code/login').send({ method: 'subscription' });
		expect(res.body).toEqual({ success: true, data: SESSION });
		expect(mocks.startLogin).toHaveBeenCalledWith('claude-code', 'subscription');
		expect((await request(appWith(service)).post('/api/harness/claude-code/login').send({})).status).toBe(400);
	});

	it('POST /:id/login refuses a harness that is already logged in unless forced (a start logs it out, 2026-09-26)', async () => {
		const { service, mocks } = fakeService();
		mocks.getStatus.mockResolvedValue({ ...STATUS, loginState: 'logged_in', loginSource: 'chatgpt' } as never);
		const refused = await request(appWith(service)).post('/api/harness/codex-cli/login').send({ method: 'device' });
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe('already_logged_in');
		expect(mocks.startLogin).not.toHaveBeenCalled();
		const forced = await request(appWith(service)).post('/api/harness/codex-cli/login').send({ method: 'device', force: true });
		expect(forced.status).toBe(200);
		expect(mocks.startLogin).toHaveBeenCalledWith('codex-cli', 'device');
	});

	it('GET /login/:sessionId returns the session', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).get('/api/harness/login/s1');
		expect(res.body).toEqual({ success: true, data: SESSION });
		expect(mocks.broker.get).toHaveBeenCalledWith('s1');
	});

	it('POST /login/:sessionId/input types the reply', async () => {
		const { service, mocks } = fakeService();
		const res = await request(appWith(service)).post('/api/harness/login/s1/input').send({ text: '  code#state  ' });
		expect(res.body.data.state).toBe('verifying');
		expect(mocks.broker.input).toHaveBeenCalledWith('s1', 'code#state');
		expect((await request(appWith(service)).post('/api/harness/login/s1/input').send({ text: ' ' })).status).toBe(400);
	});

	it('POST /login/:sessionId/cancel cancels', async () => {
		const { service } = fakeService();
		const res = await request(appWith(service)).post('/api/harness/login/s1/cancel');
		expect(res.body.data.state).toBe('cancelled');
	});

	it('POST /:id/api-key stores the key and never echoes it', async () => {
		const { service, mocks } = fakeService();
		const key = `sk-ant-api03-${'k'.repeat(60)}`;
		const res = await request(appWith(service)).post('/api/harness/claude-code/api-key').send({ key });
		expect(res.body).toEqual({ success: true, data: { ...STATUS, loginState: 'logged_in', loginSource: 'crewly-api-key' } });
		expect(JSON.stringify(res.body)).not.toContain(key);
		expect(mocks.submitApiKey).toHaveBeenCalledWith('claude-code', key);
		expect((await request(appWith(service)).post('/api/harness/claude-code/api-key').send({ key: '' })).status).toBe(400);
	});

	describe('owner-only routes refuse agent sessions with 403', () => {
		const cases: Array<[string, (r: request.SuperTest<request.Test>) => request.Test]> = [
			['install', (r) => r.post('/api/harness/claude-code/install')],
			['orc', (r) => r.put('/api/harness/orc').send({ harnessId: 'codex-cli' })],
			['orc (relay twin)', (r) => r.post('/api/harness/orc').send({ harnessId: 'codex-cli' })],
			['login', (r) => r.post('/api/harness/claude-code/login').send({ method: 'subscription' })],
			['login get', (r) => r.get('/api/harness/login/s1')],
			['login input', (r) => r.post('/api/harness/login/s1/input').send({ text: 'x' })],
			['login cancel', (r) => r.post('/api/harness/login/s1/cancel')],
			['api-key', (r) => r.post('/api/harness/claude-code/api-key').send({ key: 'sk-ant-xxxxxxxxxxxxxxxxxxxxxxxx' })],
		];
		it.each(cases)('%s', async (_name, call) => {
			const { service, mocks } = fakeService();
			const res = await call(request(appWith(service)) as unknown as request.SuperTest<request.Test>).set(AGENT);
			expect(res.status).toBe(403);
			expect(res.body.success).toBe(false);
			expect(mocks.startInstall).not.toHaveBeenCalled();
			expect(mocks.setOrcHarness).not.toHaveBeenCalled();
			expect(mocks.startLogin).not.toHaveBeenCalled();
			expect(mocks.submitApiKey).not.toHaveBeenCalled();
			expect(mocks.broker.input).not.toHaveBeenCalled();
			expect(mocks.broker.cancel).not.toHaveBeenCalled();
		});
	});

	describe('error mapping', () => {
		it('unknown harness → 404', async () => {
			const { service, mocks } = fakeService();
			mocks.startInstall.mockImplementation(() => { throw new UnknownHarnessError('nope'); });
			const res = await request(appWith(service)).post('/api/harness/nope/install');
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ success: false, error: 'Unknown harness: nope' });
		});

		it('broker errors map by code', async () => {
			const { service, mocks } = fakeService();
			mocks.startLogin.mockImplementation(() => { throw new LoginBrokerError('not_installed', 'Codex is not installed'); });
			const res = await request(appWith(service)).post('/api/harness/codex-cli/login').send({ method: 'device' });
			expect(res.status).toBe(409);
			expect(res.body).toEqual({ success: false, error: 'Codex is not installed', code: 'not_installed' });
			mocks.broker.get.mockImplementation(() => { throw new LoginBrokerError('not_found', 'gone'); });
			expect((await request(appWith(service)).get('/api/harness/login/x')).status).toBe(404);
			mocks.broker.input.mockImplementation(() => { throw new LoginBrokerError('not_active', 'done'); });
			expect((await request(appWith(service)).post('/api/harness/login/x/input').send({ text: 'a' })).status).toBe(409);
			mocks.broker.cancel.mockImplementation(() => { throw new LoginBrokerError('not_found', 'gone'); });
			expect((await request(appWith(service)).post('/api/harness/login/x/cancel')).status).toBe(404);
		});

		it('install and api-key errors map by code', async () => {
			const { service, mocks } = fakeService();
			mocks.getInstallJob.mockImplementation(() => { throw new HarnessInstallError('job_not_found', 'no job'); });
			expect((await request(appWith(service)).get('/api/harness/install/x')).status).toBe(404);
			mocks.submitApiKey.mockRejectedValue(new HarnessApiKeyError('invalid_key', 'Anthropic rejected this API key'));
			const res = await request(appWith(service)).post('/api/harness/claude-code/api-key').send({ key: 'sk-ant-whatever-xxxxxxxxxxxxxxxx' });
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('invalid_key');
			mocks.submitApiKey.mockRejectedValue(new HarnessApiKeyError('login_failed', 'Codex did not accept the key'));
			expect((await request(appWith(service)).post('/api/harness/codex-cli/api-key').send({ key: 'k'.repeat(30) })).status).toBe(422);
		});

		it('unexpected errors → 500', async () => {
			const { service, mocks } = fakeService();
			mocks.getOverview.mockRejectedValue(new Error('disk'));
			const res = await request(appWith(service)).get('/api/harness');
			expect(res.status).toBe(500);
			expect(res.body).toEqual({ success: false, error: 'disk' });
			mocks.setOrcHarness.mockRejectedValue('weird');
			expect((await request(appWith(service)).put('/api/harness/orc').send({ harnessId: 'codex-cli' })).body.error).toBe('Internal error');
		});
	});

	it('helpers work outside a router', () => {
		const json = jest.fn();
		const res = { status: jest.fn(() => ({ json })) } as unknown as express.Response;
		expect(refuseAgent({ headers: {} } as express.Request, res, 'x')).toBe(false);
		expect(refuseAgent({ headers: { 'x-agent-session': 'dev-1' } } as unknown as express.Request, res, 'do x')).toBe(true);
		expect(json).toHaveBeenCalledWith({ success: false, error: 'Only the owner can do x' });
		sendError(res, new LoginBrokerError('spawn_failed', 'no pty'));
		expect(res.status).toHaveBeenCalledWith(500);
	});
});
