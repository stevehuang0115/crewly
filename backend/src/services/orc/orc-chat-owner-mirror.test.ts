/**
 * Tests for mirroring the orchestrator's own-chat answers to the away owner
 * (crewly#1015 §11, review H1).
 */

import { ORC_CHAT_OWNER_MIRROR_CONSTANTS as M, REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { OrcChatOwnerMirror, conversationsOfSystemEvent, shouldMirrorOrcChatToOwner, type OrcChatMirrorDeps, type OrcChatMirrorInput } from './orc-chat-owner-mirror.js';

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

	// Follow-up H1: a system event that belongs to this chat (a delegated
	// result, a promise follow-up) — not a digest, an unrelated [DONE], a reminder.
	it('mirrors a system-event turn only when it belongs to this chat, the owner was here within 24 h, and under the daily cap', () => {
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system-related', ownerAt: NOW - 3 * 60 * 60 * 1000 }).mirror).toBe(true);
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system-unrelated', ownerAt: NOW - 3 * 60 * 60 * 1000 }).reason).toBe('system event not about this chat');
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system-related', ownerAt: NOW - M.SYSTEM_TURN_OWNER_WINDOW_MS - 1 }).reason).toBe(
			'system turn, owner not in this chat lately',
		);
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system-related', ownerSource: null, ownerAt: null }).mirror).toBe(false);
		expect(shouldMirrorOrcChatToOwner({ ...base, turn: 'system-related', systemMirrorsToday: M.SYSTEM_TURN_DAILY_CAP }).reason).toBe('daily cap for system-turn mirrors');
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

describe('conversationsOfSystemEvent', () => {
	const WI = '2f0c1a9e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
	const lookups = {
		workItem: async (id: string) => (id === WI ? { id, requestId: 'req-1' } : null),
		request: async (id: string) => (id === 'req-1' ? { chatRef: { channelId: 'a721f48d' } } : null),
		requestByTicket: async (n: number) => (n === 185 ? { chatRef: { channelId: 'book-chat' } } : null),
	};
	it('finds the origin chat of the WorkItems and tickets an event names', async () => {
		expect(await conversationsOfSystemEvent(`[DONE] Agent ella (WorkItem ${WI}:verify:${WI})`, lookups)).toEqual(['a721f48d']);
		expect(await conversationsOfSystemEvent('[FOLLOW-UP TKT-185] You promised …', lookups)).toEqual(['book-chat']);
	});
	it('a digest or a reminder belongs to no chat', async () => {
		expect(await conversationsOfSystemEvent('[SYSTEM] Status digest: 3 agents idle', lookups)).toEqual([]);
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
			conversationsOfEvent: async () => [],
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

	// Re-review H1: ~144 DMs a day from digests / [DONE] / reminders.
	it('unrelated system events send no DM even with the owner active in that chat in the last 24 h', async () => {
		let event = '[SYSTEM] Status digest (30 min): Owen [DONE] CE-41, Nova [IN_PROGRESS]';
		const h = harness({ lastDeliveredToOrc: () => event, conversationsOfEvent: async () => ['another-chat'] });
		expect(await h.mirror.consider('a721f48d', 'Digest: Owen finished CE-41.')).toBe('system event not about this chat');
		event = '[SYSTEM] Reminder: check the open tickets';
		const none = harness({ lastDeliveredToOrc: () => event });
		expect(await none.mirror.consider('a721f48d', 'Nothing new on the tickets.')).toBe('system event not about this chat');
		expect([...h.sent, ...none.sent]).toEqual([]);
	});

	it('a delegated result whose origin is this chat sends one DM (deduped and batched as usual)', async () => {
		const h = harness({
			lastDeliveredToOrc: () => '[DONE] Agent ella: report done (WorkItem 2f0c1a9e-3b4d-4e5f-8a9b-0c1d2e3f4a5b)',
			conversationsOfEvent: async (text) => (text.includes('2f0c1a9e') ? ['a721f48d'] : []),
		});
		expect(await h.mirror.consider('a721f48d', 'Ella finished the report: link inside.')).toBe('sent');
		expect(await h.mirror.consider('a721f48d', 'Ella finished the report: link inside.')).toBe('duplicate');
		expect(h.sent).toEqual(['Ella finished the report: link inside.']);
	});

	it('the daily cap holds: at most 3 system-turn mirrors per chat per day', async () => {
		const h = harness({ lastDeliveredToOrc: () => '[FOLLOW-UP TKT-185] promised …', conversationsOfEvent: async () => ['a721f48d'] });
		const outcomes: string[] = [];
		for (let i = 0; i < 5; i += 1) {
			h.clock.t += M.MIN_INTERVAL_MS + 1;
			outcomes.push(await h.mirror.consider('a721f48d', `update ${i}`));
		}
		expect(outcomes).toEqual(['sent', 'sent', 'sent', 'daily cap for system-turn mirrors', 'daily cap for system-turn mirrors']);
		// A day later, the owner having written here again.
		h.clock.t += 24 * 60 * 60 * 1000;
		const later = h.clock.t;
		(h.mirror as unknown as { deps: { ownerAt: () => number } }).deps.ownerAt = () => later - 2 * 60 * 60 * 1000;
		expect(await h.mirror.consider('a721f48d', 'next day')).toBe('sent');
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
