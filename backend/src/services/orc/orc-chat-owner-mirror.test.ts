/**
 * Tests for mirroring the orchestrator's own-chat answers to the away owner
 * (crewly#1015 §11, review H1).
 */

import { ORC_CHAT_OWNER_MIRROR_CONSTANTS as M, REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { OrcChatOwnerMirror, shouldMirrorOrcChatToOwner, type OrcChatMirrorDeps, type OrcChatMirrorInput } from './orc-chat-owner-mirror.js';

const NOW = 1_800_000_000_000;
const base: OrcChatMirrorInput = {
	conversationId: 'a721f48d',
	text: 'Claude Code switched to the new login page; you need to sign in again.',
	interim: false,
	turn: 'owner-here',
	slackLinkedDm: false,
	slackMappedRoom: false,
	ownerSource: 'crewly-chat',
	ownerAt: NOW - REPLY_ROUTING_CONSTANTS.DM_AFFINITY_FRESH_MS - 1,
	now: NOW,
};

describe('shouldMirrorOrcChatToOwner', () => {
	it('mirrors a real answer to the owner in that chat once they have left it', () => {
		expect(shouldMirrorOrcChatToOwner(base)).toEqual({ mirror: true, reason: 'owner not here' });
	});

	it('not while the owner is using that chat', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, ownerAt: NOW - 60_000 }).reason).toBe('owner is here');
	});

	it('never interim notes, acknowledgements or replies to system events', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, interim: true }).reason).toBe('interim note');
		expect(shouldMirrorOrcChatToOwner({ ...base, text: '收到' }).reason).toBe('acknowledgement');
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'elsewhere' }).reason).toBe('answering another conversation');
	});

	// Follow-up H1: the main case — the owner asks here, the orc delegates, and
	// the result comes back on a system-event turn; and proactive follow-ups.
	it('mirrors a system-event turn when the owner wrote in this chat within 24 h', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system', ownerAt: NOW - 3 * 60 * 60 * 1000 }).mirror).toBe(true);
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system', ownerAt: NOW - M.SYSTEM_TURN_OWNER_WINDOW_MS - 1 }).reason).toBe(
			'system turn, owner not in this chat lately',
		);
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system', ownerSource: null, ownerAt: null }).mirror).toBe(false);
	});

	it('leaves conversations that already reach the owner alone (Slack, Telegram, Google Chat, WhatsApp)', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, conversationId: 'slack-D0AC7-1790000000.000100' }).reason).toBe('slack thread');
		for (const id of ['telegram-123', 'TELEGRAM-123', 'gchat-spaces-AAQA1', 'whatsapp-1555']) {
			expect(shouldMirrorOrcChatToOwner({ ...base, conversationId: id }).reason).toBe('another messenger');
		}
		expect(shouldMirrorOrcChatToOwner({ ...base, ownerSource: 'whatsapp' }).reason).toBe('another messenger');
		expect(shouldMirrorOrcChatToOwner({ ...base, slackLinkedDm: true }).reason).toBe('slack-linked dm');
		expect(shouldMirrorOrcChatToOwner({ ...base, slackMappedRoom: true }).reason).toBe('slack room');
	});
});

describe('OrcChatOwnerMirror', () => {
	function harness(over: Partial<OrcChatMirrorDeps> = {}) {
		const clock = { t: NOW };
		const sent: string[] = [];
		const timers: Array<() => void> = [];
		const mirror = new OrcChatOwnerMirror({
			isSlackConnected: () => true,
			isSlackLinkedDm: () => false,
			isSlackMappedRoom: () => false,
			ownerSource: () => 'crewly-chat',
			ownerAt: () => NOW - 2 * 60 * 60 * 1000,
			lastDeliveredToOrc: () => '[CHAT:a721f48d] <owner@Orc>\n\n帮我看看claude code是不是login变了？',
			sendToOwner: async (text) => {
				sent.push(text);
				return { channelId: 'D0ORC' };
			},
			now: () => clock.t,
			setTimer: (fn) => {
				timers.push(fn);
				return null;
			},
			...over,
		});
		return { mirror, sent, clock, timers };
	}

	it('DMs a real answer once; the same text again is a duplicate', async () => {
		const h = harness();
		expect(await h.mirror.consider('a721f48d', 'Yes — the login page changed.')).toBe('sent');
		h.clock.t += M.MIN_INTERVAL_MS + 1;
		expect(await h.mirror.consider('a721f48d', 'Yes — the login page changed.')).toBe('duplicate');
		expect(h.sent).toEqual(['Yes — the login page changed.']);
	});

	it('at most one DM per conversation per interval; the rest go out together', async () => {
		const h = harness();
		await h.mirror.consider('a721f48d', 'first');
		expect(await h.mirror.consider('a721f48d', 'second')).toBe('batched');
		expect(await h.mirror.consider('a721f48d', 'third')).toBe('batched');
		expect(h.timers).toHaveLength(1);
		h.clock.t += M.MIN_INTERVAL_MS;
		h.timers[0]();
		await new Promise((r) => setImmediate(r));
		expect(h.sent).toEqual(['first', 'second\n\n———\n\nthird']);
	});

	it('a delegated result on a system-event turn is mirrored (owner asked here today); deduped and batched as usual', async () => {
		const h = harness({ lastDeliveredToOrc: () => '[SYSTEM] Ella reported [DONE]' });
		expect(await h.mirror.consider('a721f48d', 'Ella finished the report: link inside.')).toBe('sent');
		expect(await h.mirror.consider('a721f48d', 'Ella finished the report: link inside.')).toBe('duplicate');
		expect(await h.mirror.consider('a721f48d', 'Also, the PDF is attached there.')).toBe('batched');
		expect(h.sent).toEqual(['Ella finished the report: link inside.']);
	});

	it('an answer to the owner in another conversation is not mirrored here', async () => {
		const h = harness({ lastDeliveredToOrc: () => '[CHAT:other-conv] <owner@Orc>\n\nhi' });
		expect(await h.mirror.consider('a721f48d', 'An answer.')).toBe('answering another conversation');
	});

	it('does nothing without Slack, and never throws', async () => {
		const off = harness({ isSlackConnected: () => false });
		expect(await off.mirror.consider('a721f48d', 'x y z')).toBe('slack not connected');
		const broken = harness({
			sendToOwner: async () => {
				throw new Error('slack down');
			},
		});
		await expect(broken.mirror.consider('a721f48d', 'an answer')).resolves.toBe('error');
	});
});
