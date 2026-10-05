/**
 * Tests for the owner-only Upgrade / Restart endpoints.
 *
 * @module controllers/system/system-control.controller.test
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../services/core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

import { describeActor, parseWhen, registerSystemControlRoutes } from './system-control.controller.js';
import { SystemControlService } from '../../services/system/system-control.service.js';
import { SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';
import { ownerAuthHeaders, ownerUnlessAgentForTests } from '../../middleware/caller-identity.testing.js';

/**
 * App with the three routes under /api.
 *
 * @returns Express app
 */
function makeApp(): express.Express {
	const app = express();
	app.use(ownerUnlessAgentForTests);
	app.use(express.json());
	const router = express.Router();
	registerSystemControlRoutes(router);
	app.use('/api', router);
	return app;
}

const fakeService = {
	getStatus: jest.fn(async () => ({ currentVersion: '1.20.174', installKind: 'npm-global' })),
	requestUpgrade: jest.fn(async () => ({ ok: true, action: { id: 'a1', kind: 'upgrade', status: 'installing' } })),
	requestRestart: jest.fn(async () => ({ ok: true, action: { id: 'a2', kind: 'restart', status: 'restarting' } })),
	requestShutdown: jest.fn(async (_r?: unknown) => ({ ok: true, action: { id: 'a3', kind: 'shutdown', status: 'winding-down' } })),
	skipWindDown: jest.fn((_actor?: string) => true),
	runInputGuardCheck: jest.fn(async (_build?: string) => ({ ok: true, checkedAt: 'x', agents: [] }) as unknown),
};

describe('system control endpoints', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		SystemControlService.setInstance(fakeService as unknown as SystemControlService);
	});

	afterAll(() => {
		SystemControlService.setInstance(null);
	});

	describe('owner-only guard', () => {
		it.each([
			['get', '/api/system/update-status'],
			['post', '/api/system/upgrade'],
			['post', '/api/system/restart'],
			['post', '/api/system/shutdown'],
			['post', '/api/system/wind-down/skip'],
			['post', '/api/system/input-guard-check'],
		] as const)('%s %s refuses an agent session with 403', async (method, url) => {
			const res = await request(makeApp())[method](url).set('X-Agent-Session', 'crewly-orc').send({ when: 'now' });
			expect(res.status).toBe(403);
			expect(res.body).toMatchObject({ success: false, code: SYSTEM_CONTROL_CONSTANTS.CODES.OWNER_ONLY });
			expect(fakeService.requestRestart).not.toHaveBeenCalled();
			expect(fakeService.requestUpgrade).not.toHaveBeenCalled();
			expect(fakeService.requestShutdown).not.toHaveBeenCalled();
			expect(fakeService.skipWindDown).not.toHaveBeenCalled();
			expect(fakeService.getStatus).not.toHaveBeenCalled();
		});

		it('also refuses the legacy agent session header', async () => {
			const res = await request(makeApp()).post('/api/system/restart').set('X-Crewly-Agent-Session', 'dev-1').send({});
			expect(res.status).toBe(403);
			expect(fakeService.requestRestart).not.toHaveBeenCalled();
		});
	});

	describe('shutdown and wind-down', () => {
		it('POST shutdown starts a shutdown for the owner and passes the grace period', async () => {
			const res = await request(makeApp()).post('/api/system/shutdown').send({ graceSeconds: 120 });
			expect(res.status).toBe(202);
			expect(res.body).toMatchObject({ success: true, data: { action: { kind: 'shutdown' } } });
			expect(fakeService.requestShutdown).toHaveBeenCalledWith(expect.objectContaining({ graceSeconds: 120 }));
		});

		it('POST shutdown without a body uses the default grace', async () => {
			const res = await request(makeApp()).post('/api/system/shutdown').send({});
			expect(res.status).toBe(202);
			expect(fakeService.requestShutdown).toHaveBeenCalledWith(expect.not.objectContaining({ graceSeconds: expect.anything() }));
		});

		it.each([[-1], [901], ['soon']])('rejects graceSeconds %p with 400', async (grace) => {
			const res = await request(makeApp()).post('/api/system/shutdown').send({ graceSeconds: grace });
			expect(res.status).toBe(400);
			expect(fakeService.requestShutdown).not.toHaveBeenCalled();
		});

		it('relays a refusal (409) from the service', async () => {
			fakeService.requestShutdown.mockResolvedValueOnce({ ok: false, httpStatus: 409, code: 'in-progress', error: 'A restart is already in progress.' } as never);
			const res = await request(makeApp()).post('/api/system/shutdown').send({});
			expect(res.status).toBe(409);
			expect(res.body).toMatchObject({ success: false, code: 'in-progress' });
		});

		it('POST restart passes graceSeconds through', async () => {
			await request(makeApp()).post('/api/system/restart').send({ when: 'now', graceSeconds: 60 });
			expect(fakeService.requestRestart).toHaveBeenCalledWith(expect.objectContaining({ when: 'now', graceSeconds: 60 }));
		});

		it('POST wind-down/skip skips the wait, or answers 409 when none is running', async () => {
			const ok = await request(makeApp()).post('/api/system/wind-down/skip').send({});
			expect(ok.status).toBe(202);
			fakeService.skipWindDown.mockReturnValueOnce(false);
			const none = await request(makeApp()).post('/api/system/wind-down/skip').send({});
			expect(none.status).toBe(409);
			expect(none.body.code).toBe(SYSTEM_CONTROL_CONSTANTS.CODES.NOT_WINDING_DOWN);
		});
	});

	it('GET update-status returns the service status', async () => {
		const res = await request(makeApp()).get('/api/system/update-status?refresh=1');
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true, data: { currentVersion: '1.20.174', installKind: 'npm-global' } });
		expect(fakeService.getStatus).toHaveBeenCalledWith({ refresh: true });
	});

	it('POST restart accepts with 202 and passes when + who', async () => {
		const res = await request(makeApp()).post('/api/system/restart').set('X-Crewly-Caller', 'dashboard').send({ when: 'now' });
		expect(res.status).toBe(202);
		expect(res.body).toMatchObject({ success: true, data: { action: { id: 'a2' }, escalated: false } });
		expect(fakeService.requestRestart).toHaveBeenCalledWith({ when: 'now', actor: expect.stringMatching(/^dashboard from /) });
	});

	it('defaults `when` to idle', async () => {
		await request(makeApp()).post('/api/system/upgrade').send({});
		expect(fakeService.requestUpgrade).toHaveBeenCalledWith({ when: 'idle', actor: expect.any(String) });
	});

	it('passes the owner override `force` to the upgrade', async () => {
		await request(makeApp()).post('/api/system/upgrade').send({ when: 'now', force: true });
		expect(fakeService.requestUpgrade).toHaveBeenCalledWith({ when: 'now', actor: expect.any(String), force: true });
	});

	it('POST input-guard-check runs the check for a build, 503 when none is wired, 400 on a bad build', async () => {
		const ok = await request(makeApp()).post('/api/system/input-guard-check').send({ build: '/x/dist' });
		expect(ok.status).toBe(200);
		expect(ok.body).toMatchObject({ success: true, data: { ok: true } });
		expect(fakeService.runInputGuardCheck).toHaveBeenCalledWith('/x/dist');
		fakeService.runInputGuardCheck.mockResolvedValueOnce(null as unknown);
		expect((await request(makeApp()).post('/api/system/input-guard-check').send({})).status).toBe(503);
		expect((await request(makeApp()).post('/api/system/input-guard-check').send({ build: 5 })).status).toBe(400);
	});

	it('rejects an invalid `when` with 400', async () => {
		const res = await request(makeApp()).post('/api/system/upgrade').send({ when: 'tomorrow' });
		expect(res.status).toBe(400);
		expect(fakeService.requestUpgrade).not.toHaveBeenCalled();
	});

	it('passes a refusal through with its status and code (dev checkout → 409)', async () => {
		fakeService.requestUpgrade.mockResolvedValueOnce({
			ok: false,
			httpStatus: 409,
			code: SYSTEM_CONTROL_CONSTANTS.CODES.DEV_CHECKOUT,
			error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT,
		} as never);
		const res = await request(makeApp()).post('/api/system/upgrade').send({ when: 'now' });
		expect(res.status).toBe(409);
		expect(res.body).toEqual({
			success: false,
			code: SYSTEM_CONTROL_CONSTANTS.CODES.DEV_CHECKOUT,
			error: SYSTEM_CONTROL_CONSTANTS.MESSAGES.DEV_CHECKOUT,
		});
	});

	it('answers 503 before the service exists (still booting)', async () => {
		SystemControlService.setInstance(null);
		const res = await request(makeApp()).post('/api/system/restart').send({ when: 'now' });
		expect(res.status).toBe(503);
		expect(res.body.code).toBe(SYSTEM_CONTROL_CONSTANTS.CODES.UNAVAILABLE);
	});
});

describe('parseWhen', () => {
	it.each([
		[undefined, 'idle'],
		[{}, 'idle'],
		[{ when: 'idle' }, 'idle'],
		[{ when: 'now' }, 'now'],
		[{ when: 'later' }, null],
		[{ when: 5 }, null],
	])('%j → %s', (body, expected) => {
		expect(parseWhen(body)).toBe(expected);
	});
});

describe('describeActor', () => {
	it('names the phone relay', () => {
		expect(describeActor({ headers: { 'x-crewly-client': 'mobile' }, socket: { remoteAddress: '127.0.0.1' } } as never)).toBe('phone (relay)');
	});

	it('names the dashboard (owner session) and its address', () => {
		expect(describeActor({ headers: ownerAuthHeaders(), socket: { remoteAddress: '192.168.1.20' } } as never)).toBe(
			'dashboard from 192.168.1.20',
		);
	});

	it('does not take the self-set dashboard marker at its word (#999)', () => {
		expect(describeActor({ headers: { 'x-crewly-caller': 'dashboard' }, socket: { remoteAddress: '127.0.0.1' } } as never)).toBe('api from 127.0.0.1');
	});

	it('falls back to api', () => {
		expect(describeActor({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never)).toBe('api from 127.0.0.1');
	});
});
