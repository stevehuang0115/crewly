/**
 * Urgent lead/delegator messages reach a busy agent at its next tool call (CREW-844).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: jest.fn(() => ({
			createComponentLogger: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() })),
		})),
	},
}));

import { OWNER_HOOK_MESSAGE_CONSTANTS as C, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { SubAgentMessageQueue, withSurfacedNotice } from './sub-agent-message-queue.service.js';
import { ownerHookNoteFor } from './owner-hook-message.js';
import { isUrgentSender, urgentHookNoteFor, type UrgentSenderLookups } from './urgent-message.js';
import type { Team, TeamMember } from '../../types/index.js';

const WORKER = 'dev-worker';
const LEAD = 'dev-lead';
const PEER = 'dev-peer';
const OTHER_TEAM_LEAD = 'other-lead';

const member = (id: string, sessionName: string, parentMemberId?: string): TeamMember =>
	({ id, sessionName, parentMemberId }) as unknown as TeamMember;
const teamOf = (id: string, members: TeamMember[]): Team => ({ id, members }) as unknown as Team;

const alpha = teamOf('alpha', [member('m-lead', LEAD), member('m-worker', WORKER, 'm-lead'), member('m-peer', PEER, 'm-lead')]);
const beta = teamOf('beta', [member('b-lead', OTHER_TEAM_LEAD)]);

/** Lookups over a fixed roster and a list of WorkItems for the worker. */
function lookups(items: Array<{ status: string; delegatedBy?: string }> = []): UrgentSenderLookups {
	return {
		findMember: async (session) => {
			for (const team of [alpha, beta]) {
				const m = team.members.find((x) => x.sessionName === session);
				if (m) return { team, member: m };
			}
			return null;
		},
		workItemsFor: async () => items.map((i) => ({ status: i.status, metadata: i.delegatedBy ? { delegatedBy: i.delegatedBy } : {} })) as never,
	};
}

describe('isUrgentSender', () => {
	it('honours the orchestrator', async () => {
		expect(await isUrgentSender(ORCHESTRATOR_SESSION_NAME, WORKER, lookups())).toBe(true);
	});

	it("honours the target's team lead", async () => {
		expect(await isUrgentSender(LEAD, WORKER, lookups())).toBe(true);
	});

	it('honours the agent that delegated one of the target\'s open WorkItems', async () => {
		expect(await isUrgentSender('someone-else', WORKER, lookups([{ status: 'running', delegatedBy: 'someone-else' }]))).toBe(true);
	});

	it('refuses a peer, another team\'s lead, an unknown sender and the target itself', async () => {
		expect(await isUrgentSender(PEER, WORKER, lookups())).toBe(false);
		expect(await isUrgentSender(OTHER_TEAM_LEAD, WORKER, lookups())).toBe(false);
		expect(await isUrgentSender('stranger', WORKER, lookups())).toBe(false);
		expect(await isUrgentSender(WORKER, WORKER, lookups())).toBe(false);
	});

	it('refuses a delegator whose WorkItem is finished, and the worker flagging its own lead', async () => {
		expect(await isUrgentSender('someone-else', WORKER, lookups([{ status: 'done', delegatedBy: 'someone-else' }]))).toBe(false);
		expect(await isUrgentSender(WORKER, LEAD, lookups())).toBe(false);
	});

	it('answers false when a lookup fails', async () => {
		const failing: UrgentSenderLookups = { findMember: async () => { throw new Error('boom'); }, workItemsFor: async () => [] };
		expect(await isUrgentSender(LEAD, WORKER, failing)).toBe(false);
	});
});

describe('urgent message at the next tool call', () => {
	let storePath: string;
	let queue: SubAgentMessageQueue;

	beforeEach(() => {
		SubAgentMessageQueue.resetInstance();
		storePath = path.join(os.tmpdir(), `urgent-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
		queue = SubAgentMessageQueue.getInstance(storePath);
	});

	afterEach(() => {
		fs.rmSync(storePath, { force: true });
	});

	it('shows an urgent message once, framed, and keeps it queued', () => {
		queue.enqueue(WORKER, 'HOLD: do not render', { queueMeta: { urgent: true } });
		const note = urgentHookNoteFor(WORKER, {}, queue);
		expect(note).toContain(C.URGENT_TAG);
		expect(note).toContain('HOLD: do not render');
		expect(queue.getQueueSize(WORKER)).toBe(1);
		expect(urgentHookNoteFor(WORKER, {}, queue)).toBeNull();
	});

	it('does not show a normal agent message', () => {
		queue.enqueue(WORKER, 'FYI: lunch at noon');
		expect(urgentHookNoteFor(WORKER, {}, queue)).toBeNull();
		expect(ownerHookNoteFor(WORKER, {}, queue)).toBeNull();
		expect(queue.peek(WORKER)[0].surfacedAt).toBeUndefined();
	});

	it('hands over one urgent message per call, in order', () => {
		queue.enqueue(WORKER, 'urgent one', { queueMeta: { urgent: true } });
		queue.enqueue(WORKER, 'urgent two', { queueMeta: { urgent: true } });
		expect(urgentHookNoteFor(WORKER, {}, queue)).toContain('urgent one');
		expect(urgentHookNoteFor(WORKER, {}, queue)).toContain('urgent two');
		expect(urgentHookNoteFor(WORKER, {}, queue)).toBeNull();
	});

	it('the idle delivery of a shown urgent message says it was already shown', () => {
		queue.enqueue(WORKER, 'HOLD', { queueMeta: { urgent: true } });
		urgentHookNoteFor(WORKER, {}, queue);
		const text = withSurfacedNotice(queue.peek(WORKER)[0]);
		expect(text).toContain('urgent message was already shown');
		expect(text).toContain('HOLD');
	});

	it('is off with the kill switch', () => {
		queue.enqueue(WORKER, 'HOLD', { queueMeta: { urgent: true } });
		expect(urgentHookNoteFor(WORKER, { [C.KILL_SWITCH_ENV]: C.KILL_SWITCH_OFF_VALUE }, queue)).toBeNull();
	});

	it('leaves owner messages first and unchanged', () => {
		queue.enqueue(WORKER, 'urgent', { queueMeta: { urgent: true } });
		queue.enqueue(WORKER, '[CHAT:dm-1] owner: hello', { queueMeta: { owner: true, ref: 'chat:dm-1:m1', where: { chatChannelId: 'dm-1' } } });
		expect(ownerHookNoteFor(WORKER, {}, queue)).toContain('owner: hello');
		expect(queue.peek(WORKER).find((m) => m.meta?.urgent)?.surfacedAt).toBeUndefined();
	});
});
