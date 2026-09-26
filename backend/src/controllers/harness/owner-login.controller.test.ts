/**
 * Tests for the orchestrator-only owner-login route.
 */

import type { Request, Response } from 'express';
import { HARNESS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import {
	OWNER_LOGIN_NEXT_NO_SLACK,
	OWNER_LOGIN_NEXT_STARTED,
	createOwnerLoginHandler,
	type OwnerLoginControllerDeps,
} from './owner-login.controller.js';

jest.mock('../../services/core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

const NOW = 1_790_451_000_000;

/** A request with optional agent header, harness id and body. */
function req(opts: { session?: string; id?: string; body?: unknown } = {}): Request {
	return {
		headers: opts.session ? { 'x-agent-session': opts.session } : {},
		params: { id: opts.id ?? 'claude' },
		body: opts.body ?? {},
	} as unknown as Request;
}

/** Express response that remembers its status and JSON body. */
type RecordingResponse = Response & { statusCode: number; body: Record<string, unknown> };

/** A response that records status and JSON. */
function res(): RecordingResponse {
	const r = { statusCode: 200, body: {} as Record<string, unknown> } as unknown as RecordingResponse;
	(r as unknown as { status: unknown }).status = jest.fn((code: number) => {
		r.statusCode = code;
		return r;
	});
	(r as unknown as { json: unknown }).json = jest.fn((body: Record<string, unknown>) => {
		r.body = body;
		return r;
	});
	return r;
}

/** Fake dependencies; `messages` are the owner's recent messages. */
function deps(overrides: Partial<OwnerLoginControllerDeps> & { messages?: string[] } = {}) {
	const startOwnerLogin = jest.fn(
		(harnessId: Parameters<OwnerLoginControllerDeps['startOwnerLogin']>[0]) =>
			({ status: 'started', harnessId, dmAvailable: true }) as ReturnType<OwnerLoginControllerDeps['startOwnerLogin']>,
	);
	const recentOwnerMessages = jest.fn(() => overrides.messages ?? ['帮我重新登陆claude code']);
	const d: OwnerLoginControllerDeps = {
		startOwnerLogin,
		recentOwnerMessages,
		resolveReplyTarget: () => ({ channelId: 'D0C381XPD3L', threadTs: '1790450776.351799', agentSession: 'crewly-orc' }),
		now: () => NOW,
		...overrides,
	};
	return { d, startOwnerLogin, recentOwnerMessages };
}

describe('POST /api/harness/:id/owner-login', () => {
	it('refuses callers without an agent session (the owner uses Setup)', async () => {
		const { d, startOwnerLogin } = deps();
		const r = res();
		await createOwnerLoginHandler(() => d)(req(), r);
		expect(r.statusCode).toBe(403);
		expect(r.body.code).toBe('orchestrator_only');
		expect(startOwnerLogin).not.toHaveBeenCalled();
	});

	it('refuses every agent that is not the orchestrator', async () => {
		const { d, startOwnerLogin } = deps();
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: 'dev-team-joe-1a2b3c4d' }), r);
		expect(r.statusCode).toBe(403);
		expect(r.body.code).toBe('orchestrator_only');
		expect(startOwnerLogin).not.toHaveBeenCalled();
	});

	it('starts the forced owner flow for the orchestrator when the owner asked', async () => {
		const { d, startOwnerLogin, recentOwnerMessages } = deps();
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME, body: { switchAccount: true } }), r);
		expect(recentOwnerMessages).toHaveBeenCalledWith(NOW - HARNESS_CONSTANTS.OWNER_LOGIN.EVIDENCE_LOOKBACK_MS);
		expect(startOwnerLogin).toHaveBeenCalledWith('claude-code', {
			switchAccount: true,
			replyTarget: { channelId: 'D0C381XPD3L', threadTs: '1790450776.351799', agentSession: 'crewly-orc' },
			requestedBy: 'orchestrator',
		});
		expect(r.statusCode).toBe(202);
		expect(r.body).toEqual({
			success: true,
			data: { status: 'started', harnessId: 'claude-code', displayName: 'Claude Code', dmAvailable: true, next: OWNER_LOGIN_NEXT_STARTED },
		});
	});

	it('accepts full ids and aliases', async () => {
		const { d, startOwnerLogin } = deps({ messages: ['relogin codex please'] });
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME, id: 'codex-cli' }), res());
		expect(startOwnerLogin).toHaveBeenCalledWith('codex-cli', expect.objectContaining({ switchAccount: false }));
	});

	it('refuses when no recent owner message asks for this login', async () => {
		const { d, startOwnerLogin } = deps({ messages: ['部署一下 CE 站点', '重新登录 codex'] });
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME }), r);
		expect(r.statusCode).toBe(403);
		expect(r.body.code).toBe('owner_request_not_found');
		expect(String(r.body.error)).toMatch(/Claude Code/);
		expect(startOwnerLogin).not.toHaveBeenCalled();
	});

	it('refuses when the owner history cannot be read', async () => {
		const { d, startOwnerLogin } = deps({
			recentOwnerMessages: () => {
				throw new Error('db locked');
			},
		});
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME }), r);
		expect(r.statusCode).toBe(503);
		expect(r.body.code).toBe('owner_request_unverifiable');
		expect(startOwnerLogin).not.toHaveBeenCalled();
	});

	it('404s an unknown harness', async () => {
		const { d } = deps();
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME, id: 'cursor' }), r);
		expect(r.statusCode).toBe(404);
		expect(r.body.code).toBe('unknown_harness');
	});

	it('passes on the no-link-login message for Antigravity', async () => {
		const { d } = deps({
			messages: ['登录 agy'],
			startOwnerLogin: (harnessId) => ({ status: 'no_broker_login', harnessId, message: 'Antigravity CLI 用的是 Gemini API key' }),
		});
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME, id: 'agy' }), r);
		expect(r.statusCode).toBe(400);
		expect(r.body.code).toBe('no_link_login');
		expect(r.body.error).toMatch(/Gemini API key/);
	});

	it('tells the orc when Slack is down and no link went out', async () => {
		const { d } = deps({ startOwnerLogin: (harnessId) => ({ status: 'started', harnessId, dmAvailable: false }) });
		const r = res();
		await createOwnerLoginHandler(() => d)(req({ session: ORCHESTRATOR_SESSION_NAME }), r);
		expect((r.body.data as Record<string, unknown>).next).toBe(OWNER_LOGIN_NEXT_NO_SLACK);
	});
});
