/**
 * Daily token cap on `POST /terminal/:sessionName/write` — end to end (#937).
 *
 * Real spend-cap wiring (`startSpendCaps`: service, gate, release), real
 * token ledger and real persistent `SubAgentMessageQueue`; only the PTY
 * backend and the team store are faked. Proves that a capped agent gets no
 * write from a message-mode `/write`, that the message is queued on the queue
 * `/deliver` uses, and that lifting the cap (a boost) delivers it.
 *
 * @module controllers/monitoring/terminal.controller.spend-cap.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

const addInboundInterceptor = jest.fn(() => () => undefined);
jest.mock('../../services/slack/slack-orchestrator-bridge.js', () => ({
	getSlackOrchestratorBridge: () => ({ addInboundInterceptor }),
}));
jest.mock('../../services/slack/slack.service.js', () => ({
	getSlackService: () => ({ isConnected: () => false, getOwnerUserId: () => null }),
}));
jest.mock('../../services/slack/slack-agent-identity.service.js', () => ({
	getSlackAgentIdentityService: () => null,
}));

const mockGetSessionBackendSync = jest.fn<() => unknown>();
jest.mock('../../services/session/index.js', () => ({
	getSessionBackendSync: () => mockGetSessionBackendSync(),
	getSessionBackend: async () => mockGetSessionBackendSync(),
}));

jest.mock('../../services/core/storage.service.js', () => ({
	StorageService: {
		getInstance: () => ({ findMemberBySessionName: async () => null }),
	},
}));

import { writeToSession } from './terminal.controller.js';
import { startSpendCaps } from '../../services/spend/spend-cap.wiring.js';
import { setSpendCapGate, spendCapStopOf } from '../../services/spend/spend-cap.gate.js';
import { getSpendCapService, setSpendCapService } from '../../services/spend/spend-cap.service.js';
import { DecisionService } from '../../services/decisions/decision.service.js';
import { SubAgentMessageQueue } from '../../services/messaging/sub-agent-message-queue.service.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';

/** Session of the capped agent under test */
const ELLA = 'ella-1';

/**
 * A minimal Express response recording status and body.
 *
 * @returns The fake response and what it captured
 */
function fakeResponse(): { res: Response; sent: { status: number; body: unknown } } {
	const sent = { status: 200, body: undefined as unknown };
	const res = {
		get statusCode() {
			return sent.status;
		},
		status(code: number) {
			sent.status = code;
			return this;
		},
		json(body: unknown) {
			sent.body = body;
			return this;
		},
	};
	return { res: res as unknown as Response, sent };
}

describe('POST /terminal/:s/write under the daily token cap (#937)', () => {
	let home: string;
	const logger = { info: jest.fn(), warn: jest.fn() };
	const ptyWrite = jest.fn<(data: string) => void>();

	beforeEach(() => {
		home = mkdtempSync(path.join(os.tmpdir(), 'spend-write-gate-'));
		TokenUsageService.resetInstance();
		SubAgentMessageQueue.getInstance().dequeueAll(ELLA);
		ptyWrite.mockReset();
		mockGetSessionBackendSync.mockReturnValue({
			getSession: (name: string) => (name === ELLA ? { name, write: ptyWrite } : null),
			sessionExists: (name: string) => name === ELLA,
		});
	});

	afterEach(() => {
		getSpendCapService()?.stop();
		setSpendCapService(null);
		setSpendCapGate(null);
		DecisionService.registerKindHandler('spend_cap', null);
		SubAgentMessageQueue.getInstance().dequeueAll(ELLA);
		rmSync(home, { recursive: true, force: true });
	});

	it('queues a message for a capped agent (no PTY write) and delivers it when the cap is lifted', async () => {
		// The release path writes into the live session, like sendMessageToAgent.
		const sendMessageToAgent = jest.fn(async (session: string, data: string) => {
			if (session === ELLA) ptyWrite(data);
			return { success: true };
		});
		const service = await startSpendCaps({
			crewlyHome: home,
			storage: { getTeams: async () => [{ id: 'team-mk', name: 'Marketing', members: [{ name: 'Ella', sessionName: ELLA }] }] },
			registration: () => ({ isInProcessRuntimeActive: () => false, sendMessageToAgent }),
			sessionExists: (s) => s === ELLA,
			activate: jest.fn(async () => ({ success: true })),
			logger,
		});
		await service.refreshTeams();

		// Ella is over her team's 1M cap.
		TokenUsageService.getInstance().recordUsage(ELLA, ELLA, 5_000_000, 100_000, 'deepseek/deepseek-chat');
		await service.setCaps({ teams: { 'team-mk': '1M' } });
		expect(spendCapStopOf(ELLA)).not.toBeNull();

		// Another agent's send-message skill: POST /terminal/ella-1/write {mode:"message"}.
		const { res, sent } = fakeResponse();
		await writeToSession(
			{ params: { sessionName: ELLA }, body: { data: 'PR #42 is ready for review', mode: 'message' }, headers: { 'x-agent-session': 'sam-1' } } as unknown as Request,
			res,
		);

		expect(ptyWrite).not.toHaveBeenCalled();
		expect(sent.status).toBe(202);
		expect(sent.body).toMatchObject({ success: true, queued: true, spendCapped: true });
		expect((sent.body as { message: string }).message).toMatch(/^\[SPEND_CAP\] Ella is stopped: team Marketing hit its daily token cap/);
		expect(SubAgentMessageQueue.getInstance().hasPending(ELLA)).toBe(true);

		// The owner lifts the cap for today: the stop lifts and the queued message is delivered.
		await service.boost({ scope: 'team', id: 'Marketing', unlimited: true });

		expect(spendCapStopOf(ELLA)).toBeNull();
		expect(sendMessageToAgent).toHaveBeenCalledWith(ELLA, 'PR #42 is ready for review');
		expect(ptyWrite).toHaveBeenCalledWith('PR #42 is ready for review');
		expect(SubAgentMessageQueue.getInstance().hasPending(ELLA)).toBe(false);
	});
});
