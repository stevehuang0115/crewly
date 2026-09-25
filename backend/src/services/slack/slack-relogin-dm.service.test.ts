/**
 * Tests for the Slack side of the harness re-login.
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import { SlackReloginDmService, createReloginReplyInterceptor, escapeSlackText, type ReloginDmSlackApi } from './slack-relogin-dm.service.js';

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
		expect(dm.isOwnerDmReply(inbound({ authorAgentSession: 'dev-1' }))).toBe(false);
		expect(dm.isOwnerDmReply(inbound({ handoffTo: 'dev-1' }))).toBe(false);
	});

	it('without a known DM channel or owner id, accepts any master-bot DM', () => {
		const dm = new SlackReloginDmService(() => fakeSlack({ getOwnerUserId: null }));
		expect(dm.isOwnerDmReply(inbound({ channelId: 'DANY', userId: 'UANY' }))).toBe(true);
	});
});

describe('createReloginReplyInterceptor', () => {
	it('offers owner DM text to the coordinator and returns its verdict', () => {
		const coordinator = { handleOwnerReply: jest.fn(() => true) };
		const intercept = createReloginReplyInterceptor({ isOwnerDmReply: () => true }, coordinator);
		expect(intercept(inbound({ text: 'the-code-1234567890' }))).toBe(true);
		expect(coordinator.handleOwnerReply).toHaveBeenCalledWith('the-code-1234567890');
		coordinator.handleOwnerReply.mockReturnValue(false);
		expect(intercept(inbound({ text: 'hello orc' }))).toBe(false);
	});

	it('never offers non-owner-DM messages or file uploads', () => {
		const coordinator = { handleOwnerReply: jest.fn(() => true) };
		expect(createReloginReplyInterceptor({ isOwnerDmReply: () => false }, coordinator)(inbound())).toBe(false);
		const owner = createReloginReplyInterceptor({ isOwnerDmReply: () => true }, coordinator);
		expect(owner(inbound({ hasFiles: true }))).toBe(false);
		expect(owner(inbound({ text: '' }))).toBe(false);
		expect(coordinator.handleOwnerReply).not.toHaveBeenCalled();
	});
});
