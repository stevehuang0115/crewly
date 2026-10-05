/**
 * Tests for queue metadata context and the agent post log.
 *
 * @module services/messaging/queue-priority.test
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { AgentPostLog, currentQueueMeta, noteAgentChatTurn, sameConversation, withQueueMeta } from './queue-priority.js';

describe('withQueueMeta / currentQueueMeta', () => {
	it('binds metadata to one message for one agent, across awaits', async () => {
		const seen = await withQueueMeta('atlas', 'hello', { owner: true }, async () => {
			await new Promise((r) => setTimeout(r, 1));
			return {
				same: currentQueueMeta('atlas', 'hello'),
				otherText: currentQueueMeta('atlas', 'other'),
				otherAgent: currentQueueMeta('ella', 'hello'),
			};
		});
		expect(seen).toEqual({ same: { owner: true }, otherText: undefined, otherAgent: undefined });
		expect(currentQueueMeta('atlas', 'hello')).toBeUndefined();
	});
});

describe('sameConversation', () => {
	it('matches by chat thread or Slack thread', () => {
		expect(sameConversation({ chatChannelId: 'c', chatThreadId: 't' }, { chatChannelId: 'c', chatThreadId: 't' })).toBe(true);
		expect(sameConversation({ chatChannelId: 'c', chatThreadId: 'u' }, { chatChannelId: 'c', chatThreadId: 't' })).toBe(false);
		expect(sameConversation({ slackChannelId: 'C1', threadTs: '1.0' }, { chatChannelId: 'c', slackChannelId: 'C1', threadTs: '1.0' })).toBe(true);
		expect(sameConversation({ slackChannelId: 'C1', threadTs: '2.0' }, { slackChannelId: 'C1', threadTs: '1.0' })).toBe(false);
	});

	it('never matches a conversation with no thread (a top-level DM)', () => {
		expect(sameConversation({ chatChannelId: 'dm' }, { chatChannelId: 'dm' })).toBe(false);
		expect(sameConversation({ chatChannelId: 'dm', chatThreadId: 'x' }, { chatChannelId: 'dm' })).toBe(false);
	});
});

describe('AgentPostLog / noteAgentChatTurn', () => {
	beforeEach(() => AgentPostLog.resetInstance());

	it('records an agent answer, not an interim note or a person\'s turn', () => {
		const log = AgentPostLog.getInstance();
		noteAgentChatTurn({ senderType: 'agent', senderId: 'atlas', channelId: 'room', threadId: 'root', metadata: { interim: true } });
		noteAgentChatTurn({ senderType: 'user', senderId: 'steve', channelId: 'room', threadId: 'root' });
		expect(log.postedSince('atlas', { chatChannelId: 'room', chatThreadId: 'root' }, 0)).toBe(false);
		noteAgentChatTurn({
			senderType: 'agent',
			senderId: 'atlas',
			channelId: 'room',
			threadId: 'root',
			metadata: { slackChannelId: 'C1', slackThreadTs: '1001.0' },
		});
		expect(log.postedSince('atlas', { chatChannelId: 'room', chatThreadId: 'root' }, 0)).toBe(true);
		expect(log.postedSince('atlas', { slackChannelId: 'C1', threadTs: '1001.0' }, 0)).toBe(true);
		expect(log.postedSince('ella', { chatChannelId: 'room', chatThreadId: 'root' }, 0)).toBe(false);
		expect(log.postedSince('atlas', { chatChannelId: 'room', chatThreadId: 'root' }, Date.now() + 1000)).toBe(false);
	});
});
