/**
 * Tests for mirroring the orchestrator's own-chat posts to the away owner (crewly#1015 §11).
 */

import { REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { mirrorOrcChatPostToOwner, shouldMirrorOrcChatToOwner, type OrcChatMirrorDeps } from './orc-chat-owner-mirror.js';

const NOW = 1_800_000_000_000;
const base = { conversationId: 'a721f48d', slackLinkedDm: false, slackMappedRoom: false, ownerSource: null, ownerAt: null, now: NOW };

describe('shouldMirrorOrcChatToOwner', () => {
	it('mirrors a post in the orc chat the owner never wrote in, or wrote in from Slack', () => {
		expect(shouldMirrorOrcChatToOwner(base).mirror).toBe(true);
		expect(shouldMirrorOrcChatToOwner({ ...base, ownerSource: 'slack', ownerAt: NOW - 1000 }).mirror).toBe(true);
	});

	it('does not mirror while the owner is using that chat elsewhere (dashboard, Cloud Talk)', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, ownerSource: 'crewly-chat', ownerAt: NOW - 60_000 })).toEqual({ mirror: false, reason: 'owner is here' });
		expect(
			shouldMirrorOrcChatToOwner({ ...base, ownerSource: 'cloud-talk', ownerAt: NOW - REPLY_ROUTING_CONSTANTS.DM_AFFINITY_FRESH_MS - 1 }).mirror,
		).toBe(true);
	});

	it('leaves conversations that already reach Slack alone', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, conversationId: 'slack-D0AC7-1790000000.000100' }).reason).toBe('slack thread');
		expect(shouldMirrorOrcChatToOwner({ ...base, slackLinkedDm: true }).reason).toBe('slack-linked dm');
		expect(shouldMirrorOrcChatToOwner({ ...base, slackMappedRoom: true }).reason).toBe('slack room');
	});
});

describe('mirrorOrcChatPostToOwner', () => {
	function deps(over: Partial<OrcChatMirrorDeps> = {}): OrcChatMirrorDeps & { sent: string[] } {
		const sent: string[] = [];
		return {
			sent,
			isSlackConnected: () => true,
			isSlackLinkedDm: () => false,
			isSlackMappedRoom: () => false,
			ownerSource: () => null,
			ownerAt: () => null,
			sendToOwner: async (text) => {
				sent.push(text);
				return { channelId: 'D0ORC' };
			},
			now: () => NOW,
			...over,
		};
	}

	it('DMs the post to the owner', async () => {
		const d = deps();
		expect(await mirrorOrcChatPostToOwner('a721f48d', 'Claude Code 的登录链接…登上了吗？', d)).toBe(true);
		expect(d.sent).toEqual(['Claude Code 的登录链接…登上了吗？']);
	});

	it('does nothing without Slack, and never throws', async () => {
		const off = deps({ isSlackConnected: () => false });
		expect(await mirrorOrcChatPostToOwner('a721f48d', 'x', off)).toBe(false);
		expect(off.sent).toEqual([]);
		const broken = deps({
			sendToOwner: async () => {
				throw new Error('slack down');
			},
		});
		await expect(mirrorOrcChatPostToOwner('a721f48d', 'x', broken)).resolves.toBe(false);
	});
});
