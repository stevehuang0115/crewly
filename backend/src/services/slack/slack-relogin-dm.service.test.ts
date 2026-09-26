/**
 * Tests for the Slack side of the harness re-login.
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import {
	SlackReloginDmService,
	createReloginReplyInterceptor,
	escapeSlackText,
	resolveOrcTurnReplyTarget,
	type ReloginDmSlackApi,
} from './slack-relogin-dm.service.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
		}),
	},
}));

/**
 * Fake Slack service.
 *
 * @param overrides - Field overrides
 * @returns The fake
 */
function fakeSlack(overrides: Partial<ReloginDmSlackApi> = {}) {
	return {
		isConnected: jest.fn(() => true),
		getOwnerUserId: () => 'UOWNER',
		isAgentOwnedConversation: (id: string) => id === 'DAGENT',
		openDirectMessage: jest.fn(async () => 'DOWNER'),
		sendMessage: jest.fn(async () => '123.456'),
		sendNotification: jest.fn(async () => undefined),
		...overrides,
	};
}

/**
 * An inbound message.
 *
 * @param overrides - Field overrides
 * @returns The message
 */
function inbound(overrides: Partial<SlackIncomingMessage> = {}): SlackIncomingMessage {
	return { id: '1', type: 'message', text: 'code', userId: 'UOWNER', channelId: 'DOWNER', ts: '1', teamId: 'T', eventTs: '1', ...overrides };
}

describe('escapeSlackText', () => {
	it('escapes &, < and > (URLs stay clickable, Slack decodes &amp;)', () => {
		expect(escapeSlackText('https://x.io/a?b=1&c=2 > <b>')).toBe('https://x.io/a?b=1&amp;c=2 &gt; &lt;b&gt;');
	});
});

describe('SlackReloginDmService.sendToOwner', () => {
	it('opens a DM with the owner and posts there without link previews or chat mirror', async () => {
		const slack = fakeSlack();
		const dm = new SlackReloginDmService(() => slack);
		expect(await dm.sendToOwner('Open https://x.io/?a=1&b=2')).toBe(true);
		expect(slack.openDirectMessage).toHaveBeenCalledWith('UOWNER');
		expect(slack.sendMessage).toHaveBeenCalledWith({
			channelId: 'DOWNER',
			text: 'Open https://x.io/?a=1&amp;b=2',
			unfurlLinks: false,
			unfurlMedia: false,
			skipChatV2Mirror: true,
		});
	});

	it('falls back to the owner-notification path when the owner is unknown or the DM fails', async () => {
		const unknown = fakeSlack({ getOwnerUserId: () => null });
		expect(await new SlackReloginDmService(() => unknown, () => new Date(0)).sendToOwner('hi')).toBe(true);
		expect(unknown.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ message: 'hi', urgency: 'high', timestamp: new Date(0).toISOString() }));

		const failing = fakeSlack({ sendMessage: jest.fn(async () => { throw new Error('channel_not_found'); }) });
		expect(await new SlackReloginDmService(() => failing).sendToOwner('hi')).toBe(true);
		expect(failing.sendNotification).toHaveBeenCalled();
	});

	it('returns false when Slack is not connected or nothing could be sent', async () => {
		const offline = fakeSlack({ isConnected: jest.fn(() => false) });
		expect(await new SlackReloginDmService(() => offline).sendToOwner('hi')).toBe(false);
		expect(offline.sendMessage).not.toHaveBeenCalled();

		const broken = fakeSlack({ getOwnerUserId: () => null, sendNotification: jest.fn(async () => { throw new Error('no channel'); }) });
		expect(await new SlackReloginDmService(() => broken).sendToOwner('hi')).toBe(false);
	});
});

describe('SlackReloginDmService.isOwnerDmReply', () => {
	it('accepts the owner writing in the DM the re-login went to', async () => {
		const dm = new SlackReloginDmService(() => fakeSlack());
		await dm.sendToOwner('hi');
		expect(dm.isOwnerDmReply(inbound())).toBe(true);
		expect(dm.isOwnerDmReply(inbound({ threadTs: '123.456' }))).toBe(true);
	});

	it('rejects channels, other users, other DMs, agent-bot DMs and agent-authored messages', async () => {
		const dm = new SlackReloginDmService(() => fakeSlack());
		await dm.sendToOwner('hi');
		expect(dm.isOwnerDmReply(inbound({ channelId: 'C123' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ userId: 'USOMEONE' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DOTHER' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DAGENT' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ agentSession: 'dev-1' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DORC', agentSession: 'crewly-orc', userId: 'USOMEONE' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DORC', agentSession: 'crewly-orc', authorAgentSession: 'dev-1' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ authorAgentSession: 'dev-1' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ handoffTo: 'dev-1' }))).toBe(false);
	});

	it('accepts the owner writing in the orchestrator\'s own-bot DM (where they talk to the orc)', async () => {
		const dm = new SlackReloginDmService(() => fakeSlack({ isAgentOwnedConversation: () => true }));
		await dm.sendToOwner('hi');
		// Not the DM the master bot used, and agent-owned — still the owner talking to the orc.
		expect(dm.isOwnerDmReply(inbound({ channelId: 'D0C381XPD3L', agentSession: 'crewly-orc', threadTs: '1790450776.351799' }))).toBe(true);
	});

	it('without a known DM channel or owner id, accepts any master-bot DM', () => {
		const dm = new SlackReloginDmService(() => fakeSlack({ getOwnerUserId: null }));
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DANY', userId: 'UANY' }))).toBe(true);
	});
});

describe('createReloginReplyInterceptor', () => {
	it('offers owner DM text to the coordinator and returns its verdict', () => {
		const coordinator = { handleOwnerReply: jest.fn(() => true) };
		const dm = new SlackReloginDmService(() => fakeSlack({ getOwnerUserId: null }));
		const intercept = createReloginReplyInterceptor(dm, coordinator);
		expect(intercept(inbound({ text: 'the-code-1234567890' }))).toBe(true);
		expect(coordinator.handleOwnerReply).toHaveBeenCalledWith('the-code-1234567890', { channelId: 'DOWNER', threadTs: '1' });
		intercept(inbound({ text: '重新登录 claude', channelId: 'DORC', agentSession: 'crewly-orc', ts: '9', threadTs: '5' }));
		expect(coordinator.handleOwnerReply).toHaveBeenLastCalledWith('重新登录 claude', { channelId: 'DORC', threadTs: '5', agentSession: 'crewly-orc' });
		coordinator.handleOwnerReply.mockReturnValue(false);
		expect(intercept(inbound({ text: 'hello orc' }))).toBe(false);
	});

	it('never offers non-owner-DM messages or file uploads', () => {
		const coordinator = { handleOwnerReply: jest.fn(() => true) };
		const replyTargetOf = () => ({ channelId: 'DOWNER' });
		expect(createReloginReplyInterceptor({ isOwnerDmReply: () => false, replyTargetOf }, coordinator)(inbound())).toBe(false);
		const owner = createReloginReplyInterceptor({ isOwnerDmReply: () => true, replyTargetOf }, coordinator);
		expect(owner(inbound({ hasFiles: true }))).toBe(false);
		expect(owner(inbound({ text: '' }))).toBe(false);
		expect(coordinator.handleOwnerReply).not.toHaveBeenCalled();
	});
});

describe('SlackReloginDmService.sendToOwner with a reply target', () => {
	it('answers in the orc DM thread under the orc bot token', async () => {
		const slack = fakeSlack();
		const dm = new SlackReloginDmService(() => slack, undefined, (session) => (session === 'crewly-orc' ? 'xoxb-orc' : null));
		expect(await dm.sendToOwner('link', { channelId: 'D0C381XPD3L', threadTs: '1790450776.351799', agentSession: 'crewly-orc' })).toBe(true);
		expect(slack.sendMessage).toHaveBeenCalledWith({
			channelId: 'D0C381XPD3L',
			text: 'link',
			threadTs: '1790450776.351799',
			botToken: 'xoxb-orc',
			unfurlLinks: false,
			unfurlMedia: false,
			skipChatV2Mirror: true,
		});
		expect(slack.openDirectMessage).not.toHaveBeenCalled();
	});

	it('falls back to the master-bot DM when the agent has no bot token or the post fails', async () => {
		const slack = fakeSlack();
		const dm = new SlackReloginDmService(() => slack);
		expect(await dm.sendToOwner('link', { channelId: 'DORC', agentSession: 'crewly-orc' })).toBe(true);
		expect(slack.sendMessage).toHaveBeenCalledTimes(1);
		expect(slack.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'DOWNER' }));

		const failing = fakeSlack({
			sendMessage: jest.fn(async (m: { channelId: string }) => {
				if (m.channelId === 'DMASTERTHREAD') throw new Error('not_in_channel');
				return '1.2';
			}),
		});
		const dm2 = new SlackReloginDmService(() => failing);
		expect(await dm2.sendToOwner('link', { channelId: 'DMASTERTHREAD', threadTs: '1.0' })).toBe(true);
		expect(failing.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ channelId: 'DOWNER' }));
	});

	it('reports availability from the Slack connection', () => {
		expect(new SlackReloginDmService(() => fakeSlack()).isAvailable()).toBe(true);
		expect(new SlackReloginDmService(() => fakeSlack({ isConnected: jest.fn(() => false) })).isAvailable()).toBe(false);
	});
});

describe('resolveOrcTurnReplyTarget', () => {
	const links = {
		findBySlackChannelId: (id: string) => (id === 'D0C381XPD3L' ? { agentSession: 'crewly-orc', slackChannelId: id, replyThreadTs: '1.0' } : null),
		findByChatChannelId: (id: string) =>
			id === 'a721f48d' ? { agentSession: 'crewly-orc', slackChannelId: 'D0C381XPD3L', replyThreadTs: '1790450776.351799' } : null,
	};

	it('uses the orc DM link of the chat channel the turn came from', () => {
		expect(resolveOrcTurnReplyTarget({ conversationId: 'a721f48d' }, links)).toEqual({
			channelId: 'D0C381XPD3L',
			threadTs: '1790450776.351799',
			agentSession: 'crewly-orc',
		});
	});

	it('uses a [SLACK:…] DM marker, with the owning agent when known', () => {
		expect(resolveOrcTurnReplyTarget({ conversationId: 'x', slackChannelId: 'D0C381XPD3L', slackThreadTs: '2.0' }, links)).toEqual({
			channelId: 'D0C381XPD3L',
			threadTs: '2.0',
			agentSession: 'crewly-orc',
		});
		expect(resolveOrcTurnReplyTarget({ conversationId: 'x', slackChannelId: 'DMASTER' }, links)).toEqual({ channelId: 'DMASTER' });
	});

	it('returns null (master-bot DM) for channels, web chat and no origin', () => {
		expect(resolveOrcTurnReplyTarget({ conversationId: 'x', slackChannelId: 'C123' }, links)).toBeNull();
		expect(resolveOrcTurnReplyTarget({ conversationId: 'web-chat' }, links)).toBeNull();
		expect(resolveOrcTurnReplyTarget(undefined, links)).toBeNull();
		expect(resolveOrcTurnReplyTarget({ conversationId: 'a721f48d' }, null)).toBeNull();
	});
});
