/**
 * Session routes — who may open, write to and close a terminal (#1012).
 *
 * The router is mounted behind the real caller-identity middleware. The
 * session backend is a fake, so nothing is spawned.
 *
 * @module controllers/session/session.routes.test
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express, { type Express } from 'express';
import request from 'supertest';

const mockCreate = jest.fn<any>();
const mockWrite = jest.fn<any>();
const mockKill = jest.fn<any>();
const fakeBackend = {
	listSessions: () => ['crewly-orc'],
	sessionExists: (name: string) => name === 'crewly-orc',
	getSession: () => ({ pid: 1, cwd: '/tmp', write: mockWrite }),
	createSession: mockCreate,
	killSession: mockKill,
	captureOutput: () => 'output',
};

jest.mock('../../services/session/index.js', () => ({
	getSessionBackendSync: () => fakeBackend,
	getSessionBackend: async () => fakeBackend,
	getSessionStatePersistence: () => ({ getRegisteredSessionsMap: () => new Map(), getRegisteredSessions: () => [], forgetSessions: async () => undefined }),
	createSessionCommandHelper: () => ({ sendMessage: jest.fn() }),
}));

jest.mock('../../services/agent/oauth-relogin-monitor.service.js', () => ({
	OAuthReloginMonitorService: { submitOAuthCode: () => true },
}));

import { createSessionRouter } from './session.routes.js';
import { agentAuthHeaders, callerIdentityForTests, ownerAuthHeaders, relayAuthHeaders } from '../../middleware/caller-identity.testing.js';
import type { ApiContext } from '../types.js';

/** App with the real classifier in front of the session router. */
function buildApp(): Express {
	const app = express();
	app.use(express.json());
	app.use(callerIdentityForTests());
	app.use('/sessions', createSessionRouter({} as ApiContext));
	return app;
}

const AGENT = 'crewly-dev-sam-1234abcd';

describe('session routes (#1012)', () => {
	let app: Express;

	beforeEach(() => {
		jest.clearAllMocks();
		mockCreate.mockResolvedValue({ pid: 99, cwd: '/tmp' });
		app = buildApp();
	});

	describe('POST /sessions (open a terminal)', () => {
		const body = { name: 'evil', command: '/bin/bash', args: ['-c', 'echo pwned'] };

		it('refuses a caller with no credential', async () => {
			const res = await request(app).post('/sessions').send(body);
			expect(res.status).toBe(401);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it('refuses an agent with its badge', async () => {
			const res = await request(app).post('/sessions').set(agentAuthHeaders(AGENT)).send(body);
			expect(res.status).toBe(403);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it('refuses an agent with only the legacy session header', async () => {
			const res = await request(app).post('/sessions').set({ 'X-Agent-Session': AGENT }).send(body);
			expect(res.status).toBe(403);
			expect(mockCreate).not.toHaveBeenCalled();
		});

		it('refuses the self-set dashboard marker', async () => {
			const res = await request(app).post('/sessions').set({ 'X-Crewly-Caller': 'dashboard' }).send(body);
			expect(res.status).toBe(401);
		});

		it('lets the owner open one, with the command it asked for', async () => {
			const res = await request(app).post('/sessions').set(ownerAuthHeaders()).send({ name: 'owner-shell', command: '/bin/zsh' });
			expect(res.status).toBe(201);
			expect(mockCreate).toHaveBeenCalledWith('owner-shell', expect.objectContaining({ command: '/bin/zsh' }));
		});
	});

	describe('POST /sessions/:name/write (type into a terminal)', () => {
		it('refuses a caller with no credential and an agent', async () => {
			expect((await request(app).post('/sessions/crewly-orc/write').send({ data: 'rm -rf ~\r' })).status).toBe(401);
			expect((await request(app).post('/sessions/crewly-orc/write').set(agentAuthHeaders(AGENT)).send({ data: 'x' })).status).toBe(403);
			expect(mockWrite).not.toHaveBeenCalled();
		});

		it('lets the owner write', async () => {
			const res = await request(app).post('/sessions/crewly-orc/write').set(ownerAuthHeaders()).send({ data: 'x' });
			expect(res.status).toBe(200);
			expect(mockWrite).toHaveBeenCalledWith('x');
		});
	});

	describe('DELETE /sessions/:name and POST /sessions/:name/oauth-callback', () => {
		it('refuses anonymous and agent callers', async () => {
			expect((await request(app).delete('/sessions/crewly-orc')).status).toBe(401);
			expect((await request(app).delete('/sessions/crewly-orc').set(agentAuthHeaders(AGENT))).status).toBe(403);
			expect((await request(app).post('/sessions/crewly-orc/oauth-callback').send({ code: 'c' })).status).toBe(401);
			expect((await request(app).post('/sessions/crewly-orc/oauth-callback').set(agentAuthHeaders(AGENT)).send({ code: 'c' })).status).toBe(403);
			expect(mockKill).not.toHaveBeenCalled();
		});

		it('lets the owner (and the relay) through', async () => {
			expect((await request(app).delete('/sessions/crewly-orc').set(ownerAuthHeaders())).status).toBe(200);
			expect((await request(app).post('/sessions/crewly-orc/oauth-callback').set(relayAuthHeaders()).send({ code: 'c' })).status).toBe(200);
		});
	});

	describe('reads stay open (dashboard PTY status, crewly status)', () => {
		it('lists and reads sessions without a credential', async () => {
			expect((await request(app).get('/sessions')).status).toBe(200);
			expect((await request(app).get('/sessions/crewly-orc')).status).toBe(200);
			expect((await request(app).get('/sessions/crewly-orc/output')).status).toBe(200);
		});
	});
});
