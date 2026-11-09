import { TURN_TRIGGER_CONSTANTS as C } from '../../constants.js';
import { classifyTurnTrigger, TurnTriggerTracker } from './turn-trigger.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

describe('classifyTurnTrigger', () => {
	it.each([
		['[CHAT:conv-1] <owner@#content-team> please draft it', 'owner_message'],
		['[CREWLY-DISPATCH] WorkItem wi-123456 queued for you', 'dispatch'],
		['[CREWLY-DISPATCH] 3 WorkItems are still queued for you', 'redelivery'],
		['[TASK RE-DELIVERY] still yours', 'redelivery'],
		['[FOLLOW-UP TKT-12] The work you promised the owner is ready', 'follow_up'],
		['[OWNER REPORT DUE — reminder] report it', 'owner_report_due'],
		['[FOLLOW-THROUGH] you said you would', 'follow_through'],
		['[STALE ITEM] Ella still has an item', 'stale_item'],
		['[DECISION D-4] The owner chose "A"', 'decision'],
		['[APP CHANGES] The owner commented', 'app_change'],
		['[SCHEDULED] Daily brief', 'scheduled'],
		['[SYSTEM — TASK RECOVERY] You were working on this task', 'restart'],
		['Status from lyra (reports to you): done', 'status'],
		['hello there', 'system'],
	])('%s → %s', (text, kind) => {
		expect(classifyTurnTrigger(text).triggerKind).toBe(kind);
	});

	it('reads the ids a prompt names', () => {
		expect(classifyTurnTrigger('[CHAT:conv-9] <o@#x> hi')).toMatchObject({ conversationId: 'conv-9' });
		// The message queue's delivery fingerprint is not part of the id
		expect(classifyTurnTrigger('[CHAT:conv-9:abcd1234] hi')).toMatchObject({ conversationId: 'conv-9' });
		expect(classifyTurnTrigger('[CREWLY-DISPATCH] WorkItem wi-abcdef queued for you')).toMatchObject({ workItemId: 'wi-abcdef' });
		expect(classifyTurnTrigger('[FOLLOW-UP TKT-7] due')).toMatchObject({ ticket: 'TKT-7' });
		expect(classifyTurnTrigger('[DECISION D-12] chose')).toMatchObject({ ticket: 'D-12' });
	});

	it('an owner message that quotes a harness tag is still the owner\'s', () => {
		expect(classifyTurnTrigger('[CHAT:conv-1] <o@#x> what does [FOLLOW-UP TKT-3] mean?').triggerKind).toBe('owner_message');
	});

	it('a restart that re-delivers an owner message keeps it as the trigger', () => {
		const text = 'Crewly restarted while you were working on the brief. Continue where you left off and deliver.\nThe message you were handling:\n[CHAT:conv-2] <o@#x> the brief please';
		expect(classifyTurnTrigger(text)).toMatchObject({ triggerKind: 'owner_message', conversationId: 'conv-2' });
		expect(classifyTurnTrigger('Crewly restarted while you were working on X. Continue.').triggerKind).toBe('restart');
	});
});

describe('TurnTriggerTracker', () => {
	let t: TurnTriggerTracker;
	beforeEach(() => {
		t = new TurnTriggerTracker();
	});

	it('records a delivery and its root', () => {
		const got = t.noteDelivery('ella', '[CHAT:conv-1] <o@#x> hi', { traceId: 'tr-1' }, NOW);
		expect(got).toMatchObject({ triggerKind: 'owner_message', rootKind: 'owner_message', rootRef: 'conv-1', viaAgents: [], traceId: 'tr-1' });
		expect(t.trigger('ella', NOW + 1000)).toBe(got);
	});

	it('an agent send matched by text, even when it was queued and wrapped', () => {
		t.noteDelivery('ella', '[CHAT:conv-1] <o@#x> ask Lyra for the numbers', {}, NOW);
		t.noteSender('lyra', 'Lyra, can you pull last week\'s signup numbers for the owner?', 'ella', NOW);
		const got = t.noteDelivery('lyra', '[queued while you were busy]\nLyra, can you pull   last week\'s signup numbers for the owner?', {}, NOW + 60_000);
		expect(got).toMatchObject({ triggerKind: 'agent_message', sender: 'ella', rootKind: 'owner_message', rootRef: 'conv-1', viaAgents: ['ella'] });
	});

	it('follows a hand-off chain', () => {
		t.noteDelivery('ella', '[CHAT:conv-1] <o@#x> go', {}, NOW);
		t.noteSender('lyra', 'Please hand this to Luna with the brief attached', 'ella', NOW);
		t.noteDelivery('lyra', 'Please hand this to Luna with the brief attached', {}, NOW);
		t.noteSender('luna', 'Luna, Ella needs the cut by tonight, brief attached', 'lyra', NOW);
		expect(t.noteDelivery('luna', 'Luna, Ella needs the cut by tonight, brief attached', {}, NOW)).toMatchObject({
			rootKind: 'owner_message',
			viaAgents: ['ella', 'lyra'],
		});
	});

	it("an old turn of the sender is not the root (message audit 2026-10-20)", () => {
		t.noteDelivery('ella', '[CHAT:conv-1] <o@#x> go', {}, NOW);
		const later = NOW + C.CHAIN_LINK_MS + 1;
		t.noteSender('lyra', 'Unrelated question about the logo colours', 'ella', later);
		expect(t.noteDelivery('lyra', 'Unrelated question about the logo colours', {}, later)).toMatchObject({
			triggerKind: 'agent_message',
			sender: 'ella',
			rootKind: 'agent_message',
			viaAgents: ['ella'],
		});
	});

	it('the sender header names an agent message nobody noted (crewly#1375)', () => {
		const text =
			'[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread.]\n[TASK] quoted';
		expect(classifyTurnTrigger(text).triggerKind).toBe('agent_message');
		expect(t.noteDelivery('flopost-pia-1', text, {}, NOW)).toMatchObject({ triggerKind: 'agent_message', sender: 'think-tank-atlas-b4e166f6' });
	});

	it('a send is matched once; harness services are not agents', () => {
		t.noteSender('lyra', 'Status check on the queued work item please', 'WorkItemDispatch', NOW);
		expect(t.noteDelivery('lyra', 'Status check on the queued work item please', {}, NOW).triggerKind).toBe('system');
		t.noteSender('lyra', 'One more thing about the draft wording', 'ella', NOW);
		expect(t.noteDelivery('lyra', 'One more thing about the draft wording', {}, NOW).sender).toBe('ella');
		expect(t.noteDelivery('lyra', 'One more thing about the draft wording', {}, NOW).sender).toBeUndefined();
	});

	it('a trigger goes stale', () => {
		t.noteDelivery('ella', '[FOLLOW-UP TKT-1] due', {}, NOW);
		expect(t.trigger('ella', NOW + C.FRESH_MS + 1)).toBeNull();
	});

	it('remembers where the owner asked, for a while', () => {
		t.noteDelivery('ella', '[CHAT:conv-1] <o@#x> hi', {}, NOW);
		t.noteDelivery('ella', '[FOLLOW-UP TKT-1] due', {}, NOW + 1000);
		expect(t.ownerAskedRecently('ella', 'conv-1', NOW + 60_000)).toBe(true);
		expect(t.ownerAskedRecently('ella', 'conv-2', NOW + 60_000)).toBe(false);
		expect(t.ownerAskedRecently('ella', 'conv-1', NOW + C.OWNER_ANSWER_WINDOW_MS + 1)).toBe(false);
	});
});

describe('routes carried by agent messages and results (message-routing audit 2026-10-18)', () => {
	const ROUTE = '{route: owner room-brief thread C0BRIEF01:1790856242.596149}';

	it('an agent message header carries its route', () => {
		const text = `[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to think-tank-atlas-b4e166f6; do not post it in an owner thread. It concerns x ${ROUTE}; Atlas answers the owner on it.]\nplease check`;
		expect(classifyTurnTrigger(text)).toEqual({
			triggerKind: 'agent_message',
			route: { kind: 'owner', conversationId: 'room-brief', thread: 'C0BRIEF01:1790856242.596149' },
		});
	});

	it('a [RESULT] relay is a delegated_result naming sender, work item and route', () => {
		const text = `[RESULT] From sage-1a2b3c4d about WorkItem wi-abcdef "Note" (work you delegated while answering x ${ROUTE}. Give the owner …):\nNote is ready.`;
		expect(classifyTurnTrigger(text)).toEqual({
			triggerKind: 'delegated_result',
			textSender: 'sage-1a2b3c4d',
			workItemId: 'wi-abcdef',
			route: { kind: 'owner', conversationId: 'room-brief', thread: 'C0BRIEF01:1790856242.596149' },
		});
	});

	it('a token quoted in the body (not the header line) is not read as the route', () => {
		const text = `[RESULT] From sage-1a2b3c4d (work you delegated):\nthe owner wrote ${ROUTE}`;
		expect(classifyTurnTrigger(text).route).toBeUndefined();
	});

	it('a [TASK HANDOFF] is a dispatch of its work item', () => {
		expect(classifyTurnTrigger('[TASK HANDOFF] from Atlas — WorkItem: wi-abcdef {route: work-item wi-abcdef}\n…')).toEqual(
			expect.objectContaining({ triggerKind: 'dispatch', workItemId: 'wi-abcdef' }),
		);
	});

	it('an owner chat message keeps its Slack thread', () => {
		expect(classifyTurnTrigger('[CHAT:room-1] <steve@Ella>\n[SLACK-THREAD:C0ROOM001:1790000000.000100]\n\nhi')).toEqual(
			expect.objectContaining({ triggerKind: 'owner_message', conversationId: 'room-1', thread: 'C0ROOM001:1790000000.000100' }),
		);
	});

	it('routedTrigger keeps what the agent answers; a later reminder does not replace it', () => {
		const t = new TurnTriggerTracker();
		const NOW = 1_790_000_000_000;
		t.noteDelivery('ella', '[CHAT:room-1] <steve@Ella>\n\nupdate the sheet', {}, NOW);
		t.noteDelivery('ella', '[FOLLOW-UP TKT-187] still open', {}, NOW + 1000);
		expect(t.trigger('ella', NOW + 2000)?.triggerKind).toBe('follow_up');
		expect(t.routedTrigger('ella', NOW + 2000)).toEqual(expect.objectContaining({ triggerKind: 'owner_message', conversationId: 'room-1' }));
		expect(t.routedTrigger('ella', NOW + C.FRESH_MS + 1)).toBeNull();
	});

	// crewly#1381 item 3: Pia answered Atlas with send-message; a later bare
	// reply must not go back to Atlas for the next 6 hours.
	it('an agent message answered with send-message is no longer what a bare reply answers', () => {
		const t = new TurnTriggerTracker();
		const NOW = 1_790_000_000_000;
		const ATLAS = 'think-tank-atlas-b4e166f6';
		t.noteDelivery('pia', `[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to ${ATLAS}; do not post it in an owner thread.]\nwhat were the timings?`, {}, NOW);
		expect(t.openRoutedTrigger('pia', NOW + 1)).toEqual(expect.objectContaining({ triggerKind: 'agent_message', sender: ATLAS }));
		// Writing to someone else answers nothing.
		t.noteAnsweredAgent('pia', 'ops-luna-11111111', NOW + 2);
		expect(t.openRoutedTrigger('pia', NOW + 3)?.sender).toBe(ATLAS);
		t.noteAnsweredAgent('pia', ATLAS, NOW + 4);
		expect(t.openRoutedTrigger('pia', NOW + 5)).toBeNull();
		// The route it carried still travels with Pia's messages.
		expect(t.routedTrigger('pia', NOW + 5)?.sender).toBe(ATLAS);
		// A new message from Atlas is open again.
		t.noteDelivery('pia', `[MESSAGE from Atlas (Think Tank) — a colleague, not the owner. Answer with send-message --to ${ATLAS}; do not post it in an owner thread.]\none more`, {}, NOW + 6);
		expect(t.openRoutedTrigger('pia', NOW + 7)?.sender).toBe(ATLAS);
	});

	it('writing to an agent does not close an owner message', () => {
		const t = new TurnTriggerTracker();
		t.noteDelivery('pia', '[CHAT:room-1] <steve@Pia>\n\nask Atlas and tell me', {}, 1000);
		t.noteAnsweredAgent('pia', 'think-tank-atlas-b4e166f6', 2000);
		expect(t.openRoutedTrigger('pia', 3000)).toEqual(expect.objectContaining({ triggerKind: 'owner_message', conversationId: 'room-1' }));
	});

	it('a delegated result is attributed to the delegate named in the text', () => {
		const t = new TurnTriggerTracker();
		const tr = t.noteDelivery('atlas', `[RESULT] From sage-1a2b3c4d about WorkItem wi-abcdef "Note" (x ${ROUTE}):\nok`, {}, 1000);
		expect(tr).toEqual(expect.objectContaining({ triggerKind: 'delegated_result', sender: 'sage-1a2b3c4d' }));
		expect(tr.route).toEqual({ kind: 'owner', conversationId: 'room-brief', thread: 'C0BRIEF01:1790856242.596149' });
	});
});
