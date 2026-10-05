/**
 * Owner messages handed to a busy agent at its next tool boundary (the
 * PostToolUse hook), kept queued until answered, idle delivery as fallback.
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

import { OWNER_HOOK_MESSAGE_CONSTANTS as C } from '../../constants.js';
import { SubAgentMessageQueue, withSurfacedNotice } from './sub-agent-message-queue.service.js';
import { AgentPostLog, answersConversation, type QueueMessageMeta } from './queue-priority.js';
import { buildOwnerHookNote, joinHookNotes, ownerHookNoteFor } from './owner-hook-message.js';

const AGENT = 'crewly-orc';
const DM: QueueMessageMeta = { owner: true, ref: 'chat:dm-1:m1', where: { chatChannelId: 'dm-1' } };
const THREAD: QueueMessageMeta = {
	owner: true,
	ref: 'slack:C1:1001.5',
	where: { chatChannelId: 'slack-c1', slackChannelId: 'C1', threadTs: '1001.0' },
};

describe('owner message at the next tool boundary', () => {
	let storePath: string;
	let queue: SubAgentMessageQueue;
	let now: number;

	beforeEach(() => {
		SubAgentMessageQueue.resetInstance();
		AgentPostLog.resetInstance();
		storePath = path.join(os.tmpdir(), `ohm-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
		queue = SubAgentMessageQueue.getInstance(storePath);
		now = Date.now();
	});

	afterEach(() => {
		fs.rmSync(storePath, { force: true });
	});

	describe('takeOwnerMessageForHook', () => {
		it('hands over the owner message but keeps it queued, marked surfaced', () => {
			queue.enqueue(AGENT, '[CHAT:dm-1] owner: what is the codeword?', { queueMeta: DM });
			const got = queue.takeOwnerMessageForHook(AGENT, now);
			expect(got).toEqual({ data: '[CHAT:dm-1] owner: what is the codeword?', queuedAt: expect.any(Number), surfaceCount: 1 });
			expect(queue.getQueueSize(AGENT)).toBe(1);
			expect(queue.peek(AGENT)[0]).toMatchObject({ surfacedAt: now, surfaceCount: 1 });
		});

		it('hands over at most one message per call, the next one on the next call', () => {
			queue.enqueue(AGENT, 'owner one', { queueMeta: DM });
			queue.enqueue(AGENT, 'owner two', { queueMeta: { ...THREAD } });
			expect(queue.takeOwnerMessageForHook(AGENT, now)?.data).toBe('owner one');
			expect(queue.takeOwnerMessageForHook(AGENT, now + 1)?.data).toBe('owner two');
			expect(queue.takeOwnerMessageForHook(AGENT, now + 2)).toBeNull();
		});

		it('shows an unanswered message once more after the wait, and never a third time', () => {
			queue.enqueue(AGENT, 'owner one', { queueMeta: DM });
			expect(queue.takeOwnerMessageForHook(AGENT, now)?.surfaceCount).toBe(1);
			expect(queue.takeOwnerMessageForHook(AGENT, now + C.RESURFACE_AFTER_MS - 1)).toBeNull();
			expect(queue.takeOwnerMessageForHook(AGENT, now + C.RESURFACE_AFTER_MS)?.surfaceCount).toBe(2);
			expect(queue.takeOwnerMessageForHook(AGENT, now + 10 * C.RESURFACE_AFTER_MS)).toBeNull();
			// Still queued for the normal idle delivery.
			expect(queue.getQueueSize(AGENT)).toBe(1);
		});

		it('never hands over system traffic, a harness reminder, or an owner message with no conversation', () => {
			queue.enqueue(AGENT, 'system notice');
			queue.enqueue(AGENT, 'colleague in a thread', { queueMeta: { where: { chatChannelId: 'room', chatThreadId: 't1' } } });
			queue.enqueue(AGENT, 'watchdog reminder', { queueMeta: { owner: true, reminder: true, where: { chatChannelId: 'dm-1' } } });
			queue.enqueue(AGENT, 'owner, nowhere to answer', { queueMeta: { owner: true, ref: 'decision:D-1' } });
			expect(queue.takeOwnerMessageForHook(AGENT, now)).toBeNull();
			expect(queue.getQueueSize(AGENT)).toBe(4);
		});

		it('returns null for an agent with nothing queued', () => {
			expect(queue.takeOwnerMessageForHook('nobody', now)).toBeNull();
		});

		it('drops a surfaced message once the agent answers in its thread after it was shown', () => {
			queue.enqueue(AGENT, 'owner in a thread', { queueMeta: THREAD });
			queue.enqueue(AGENT, 'system notice');
			queue.takeOwnerMessageForHook(AGENT, now);
			AgentPostLog.getInstance().note(AGENT, { slackChannelId: 'C1', threadTs: '1001.0' }, now + 10);
			expect(queue.takeOwnerMessageForHook(AGENT, now + 20)).toBeNull();
			expect(queue.peek(AGENT).map((m) => m.data)).toEqual(['system notice']);
		});

		it('counts a top-level reply in the same DM after it was shown', () => {
			queue.enqueue(AGENT, 'owner in the DM', { queueMeta: DM });
			queue.takeOwnerMessageForHook(AGENT, now);
			AgentPostLog.getInstance().note(AGENT, { chatChannelId: 'dm-1' }, now + 10);
			queue.takeOwnerMessageForHook(AGENT, now + 20);
			expect(queue.hasPending(AGENT)).toBe(false);
		});

		it('does not count a post from before it was shown, another thread, or another agent', () => {
			queue.enqueue(AGENT, 'owner in a thread', { queueMeta: THREAD });
			AgentPostLog.getInstance().note(AGENT, { slackChannelId: 'C1', threadTs: '1001.0' }, now - 5);
			queue.takeOwnerMessageForHook(AGENT, now);
			AgentPostLog.getInstance().note(AGENT, { slackChannelId: 'C1', threadTs: '2002.0' }, now + 5);
			AgentPostLog.getInstance().note(AGENT, { chatChannelId: 'slack-c1' }, now + 5);
			AgentPostLog.getInstance().note('crewly-ella', { slackChannelId: 'C1', threadTs: '1001.0' }, now + 5);
			queue.takeOwnerMessageForHook(AGENT, now + 20);
			expect(queue.getQueueSize(AGENT)).toBe(1);
		});

		it('keeps the surfaced state across a restart', () => {
			queue.enqueue(AGENT, 'owner one', { queueMeta: DM });
			queue.takeOwnerMessageForHook(AGENT, now);
			SubAgentMessageQueue.resetInstance();
			const reloaded = SubAgentMessageQueue.getInstance(storePath);
			expect(reloaded.peek(AGENT)[0]).toMatchObject({ surfacedAt: now, surfaceCount: 1 });
			expect(reloaded.takeOwnerMessageForHook(AGENT, now + 1)).toBeNull();
		});
	});

	describe('idle delivery (fallback)', () => {
		const sent: string[] = [];
		const send = async (data: string) => {
			sent.push(data);
			return { success: true };
		};
		beforeEach(() => {
			sent.length = 0;
		});

		it('does not deliver a surfaced message the agent already answered', async () => {
			queue.enqueue(AGENT, 'owner in a thread', { queueMeta: THREAD });
			queue.takeOwnerMessageForHook(AGENT, now);
			AgentPostLog.getInstance().note(AGENT, { slackChannelId: 'C1', threadTs: '1001.0' }, now + 10);
			const out = await queue.flush(AGENT, send);
			expect(sent).toEqual([]);
			expect(out).toMatchObject({ delivered: 0, skippedStale: 1 });
		});

		it('delivers an unanswered surfaced message with a do-not-answer-twice notice', async () => {
			queue.enqueue(AGENT, 'owner in the DM', { queueMeta: DM });
			queue.takeOwnerMessageForHook(AGENT, now);
			const out = await queue.flush(AGENT, send);
			expect(out.delivered).toBe(1);
			expect(sent[0]).toMatch(/^\[Crewly: this owner message was already shown to you during your last turn .*If you already answered it, do not answer again\.\]\nowner in the DM$/);
			expect(queue.hasPending(AGENT)).toBe(false);
		});

		it('delivers a message that was never surfaced unchanged', async () => {
			queue.enqueue(AGENT, 'owner in the DM', { queueMeta: DM });
			await queue.flush(AGENT, send);
			expect(sent).toEqual(['owner in the DM']);
		});

		it('keeps a surfaced message (and its surfaced state) when the agent is still busy at flush', async () => {
			queue.enqueue(AGENT, 'owner in the DM', { queueMeta: DM });
			queue.takeOwnerMessageForHook(AGENT, now);
			const busy = async (data: string) => {
				queue.enqueue(AGENT, data);
				return { success: true, queued: true };
			};
			const out = await queue.flush(AGENT, busy);
			expect(out.deferred).toBe(1);
			expect(queue.peek(AGENT)).toEqual([expect.objectContaining({ data: 'owner in the DM', surfacedAt: now, surfaceCount: 1 })]);
		});

		it('withSurfacedNotice leaves an unsurfaced message alone', () => {
			expect(withSurfacedNotice({ data: 'x', queuedAt: 1, sessionName: AGENT })).toBe('x');
		});
	});

	describe('the note', () => {
		it('frames the first hand-over as a real owner message to answer now', () => {
			const note = buildOwnerHookNote({ data: '[CHAT:dm-1] owner: hi\nReply with reply-chat --conversation dm-1', queuedAt: 1, surfaceCount: 1 });
			expect(note.startsWith(C.TAG)).toBe(true);
			expect(note).toContain('Crewly delivered this message from the owner while you were working.');
			expect(note).toContain('before your next step of the current work');
			expect(note.endsWith('[CHAT:dm-1] owner: hi\nReply with reply-chat --conversation dm-1')).toBe(true);
		});

		it('says it is a reminder the second time', () => {
			expect(buildOwnerHookNote({ data: 'hi', queuedAt: 1, surfaceCount: 2 })).toMatch(/^\[OWNER MESSAGE\] Reminder:/);
		});

		it('cuts a long message to the ceiling and says so', () => {
			const note = buildOwnerHookNote({ data: 'x'.repeat(10_000), queuedAt: 1, surfaceCount: 1 }, 1000);
			expect(note.length).toBeLessThanOrEqual(1000);
			expect(note).toContain('cut short here');
		});

		it('joins notes owner-first within the ceiling, dropping one that does not fit', () => {
			expect(joinHookNotes([null, undefined])).toBeNull();
			expect(joinHookNotes(['owner', 'nudge'])).toBe('owner\n\nnudge');
			expect(joinHookNotes([null, 'nudge'])).toBe('nudge');
			expect(joinHookNotes(['o'.repeat(90), 'n'.repeat(20)], 100)).toBe('o'.repeat(90));
			expect(joinHookNotes(['o'.repeat(150)], 100)).toHaveLength(100);
		});

		it('ownerHookNoteFor takes from the queue, and the kill switch turns it off', () => {
			queue.enqueue(AGENT, 'owner in the DM', { queueMeta: DM });
			expect(ownerHookNoteFor(AGENT, { [C.KILL_SWITCH_ENV]: C.KILL_SWITCH_OFF_VALUE }, queue)).toBeNull();
			expect(queue.peek(AGENT)[0].surfacedAt).toBeUndefined();
			expect(ownerHookNoteFor(AGENT, {}, queue)).toContain('owner in the DM');
			expect(ownerHookNoteFor(AGENT, {}, queue)).toBeNull();
		});
	});

	describe('answersConversation', () => {
		it('matches the same thread, and a top-level post for a top-level message', () => {
			expect(answersConversation({ slackChannelId: 'C1', threadTs: '1' }, { slackChannelId: 'C1', threadTs: '1' })).toBe(true);
			expect(answersConversation({ chatChannelId: 'dm' }, { chatChannelId: 'dm' })).toBe(true);
			expect(answersConversation({ slackChannelId: 'D1' }, { slackChannelId: 'D1' })).toBe(true);
		});

		it('does not match another thread, a thread post for a top-level message, or another channel', () => {
			expect(answersConversation({ slackChannelId: 'C1', threadTs: '2' }, { slackChannelId: 'C1', threadTs: '1' })).toBe(false);
			expect(answersConversation({ chatChannelId: 'C1' }, { chatChannelId: 'C1', chatThreadId: 't' })).toBe(false);
			expect(answersConversation({ chatChannelId: 'dm', chatThreadId: 't' }, { chatChannelId: 'dm' })).toBe(false);
			expect(answersConversation({ chatChannelId: 'other' }, { chatChannelId: 'dm' })).toBe(false);
		});
	});
});
