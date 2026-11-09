import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnTrigger } from '../trace/turn-trigger.js';
import { shortTitle, triggeredByLine, triggeredByMetadata, triggeredByPhrase, withTriggeredByLine } from './triggered-by.js';

const ELLA = 'crewly-marketing-ella-e6a6b8ea';
const LYRA = 'content-team-lyra-1a2b3c4d';

function trig(over: Partial<TurnTrigger>): TurnTrigger {
	return { triggerKind: 'system', rootKind: 'system', viaAgents: [], at: 0, ...over };
}

function wi(over: Partial<WorkItem>): WorkItem {
	return { id: 'wi-1', title: 'Weekly signup numbers', type: 'task', owner: 'agent', status: 'queued', ...over } as unknown as WorkItem;
}

describe('triggeredByPhrase', () => {
	it('no line for the owner\'s message answered where it was asked', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'owner_message', conversationId: 'c1' }), { postedConversationId: 'c1' })).toBeNull();
	});

	it('names the owner\'s message in another conversation', () => {
		const t = trig({ triggerKind: 'owner_message', conversationId: 'c1' });
		expect(triggeredByPhrase(t, { postedConversationId: 'c2', conversationPlace: () => '#book-publish' })).toBe('your message in #book-publish');
		expect(triggeredByPhrase(t, { postedConversationId: 'c2' })).toBe('your message in another conversation');
	});

	it('no line when the owner asked in this conversation recently, whatever came in since', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'follow_up' }), { postedConversationId: 'c1', ownerAskedHere: true })).toBeNull();
	});

	it('agent messages name only the writer, with the root', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'agent_message', sender: ELLA, viaAgents: [ELLA], rootKind: 'owner_message' }), {})).toBe("Ella's message (passing on your request)");
		expect(triggeredByPhrase(trig({ triggerKind: 'agent_message', sender: LYRA, viaAgents: [ELLA, LYRA], rootKind: 'agent_message' }), {})).toBe("Lyra's message"); // the chain stays in the record, not the line
		expect(triggeredByPhrase(trig({ triggerKind: 'agent_message', sender: 'crewly-orc', viaAgents: ['crewly-orc'], rootKind: 'scheduled' }), {})).toBe("Orc's message (from a scheduled task)");
	});

	it('queued work says where it came from', () => {
		const t = trig({ triggerKind: 'dispatch', workItemId: 'wi-1' });
		expect(triggeredByPhrase(t, { workItem: wi({ metadata: { origin: { kind: 'trigger', topic: 'Daily brief' } } as never }) })).toBe('a scheduled task "Daily brief"');
		expect(triggeredByPhrase(t, { postedConversationId: 'c9', workItem: wi({ metadata: { origin: { kind: 'owner', conversationId: 'c1' } } as never }) })).toBe('your request "Weekly signup numbers"');
		expect(triggeredByPhrase(t, { postedConversationId: 'c1', workItem: wi({ metadata: { origin: { kind: 'owner', conversationId: 'c1' } } as never }) })).toBeNull();
		expect(triggeredByPhrase(t, { workItem: wi({ metadata: { delegatedBy: ELLA } as never }) })).toBe('a task from Ella "Weekly signup numbers"');
		expect(triggeredByPhrase(t, { workItem: null })).toBe('a queued task');
	});

	it('harness reminders say so', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'follow_up', ticket: 'TKT-12' }), {})).toBe('an automatic reminder of something promised to you'); // no ticket id: tickets are internal
		expect(triggeredByPhrase(trig({ triggerKind: 'redelivery' }), {})).toBe('an automatic reminder of queued work');
		expect(triggeredByPhrase(trig({ triggerKind: 'restart' }), {})).toBe('a Crewly restart (resuming interrupted work)');
	});

	it('quoted titles drop internal ids and a leading tag (message audit 2026-10-20)', () => {
		expect(shortTitle('CE 周报（Steve D-228 批准，周一晚 10 点）')).toBe('CE 周报（Steve 批准，周一晚 10 点）');
		expect(shortTitle('[crewly-daily-metrics] 22:00 ET run the nightly post')).toBe('22:00 ET run the nightly post');
		expect(shortTitle('Fix CE-397 checkout (D-12)')).toBe('Fix checkout');
		expect(shortTitle('Compare GPT-4 and Claude')).toBe('Compare GPT-4 and Claude');
	});

	it('no line for an unrecognised prompt or no trigger', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'system' }), {})).toBeNull();
		expect(triggeredByPhrase(null, {})).toBeNull();
	});
});

describe('line and metadata', () => {
	it('appends one muted line, once', () => {
		expect(triggeredByLine(null)).toBeNull();
		const once = withTriggeredByLine('Here are the numbers.\n', 'an automatic reminder of queued work');
		expect(once).toBe('Here are the numbers.\n\n_↳ Triggered by an automatic reminder of queued work_');
		expect(withTriggeredByLine(once, 'something else')).toBe(once);
		expect(withTriggeredByLine('Hi', null)).toBe('Hi');
	});

	it('stores the provenance record', () => {
		const t = trig({ triggerKind: 'agent_message', sender: ELLA, viaAgents: [ELLA], rootKind: 'owner_message', rootRef: 'c1' });
		expect(triggeredByMetadata(t, "Ella's message", 'tr-9')).toEqual({
			traceId: 'tr-9',
			rootKind: 'owner_message',
			rootRef: 'c1',
			triggerKind: 'agent_message',
			viaAgents: [ELLA],
			label: "Triggered by Ella's message",
		});
		expect(triggeredByMetadata({ ...t, traceId: 'tr-1' }, null, 'tr-9')).not.toHaveProperty('label');
		expect(triggeredByMetadata({ ...t, traceId: 'tr-1' }, null, 'tr-9').traceId).toBe('tr-1');
	});
});

describe('triggeredByPhrase — delegated_result (message-routing audit 2026-10-18)', () => {
	const route = { kind: 'owner' as const, conversationId: 'room-brief', thread: 'C0BRIEF01:1.2' };

	it('a result posted where the owner asked needs no line', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'delegated_result', sender: LYRA, route }), { postedConversationId: 'room-brief' })).toBeNull();
	});

	it('elsewhere: names whose result it is and that it passes on the owner request', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'delegated_result', sender: LYRA, route }), { postedConversationId: 'room-x' })).toBe(
			"Lyra's result for work you delegated (passing on your request)",
		);
	});

	it('no owner route behind it: just the result', () => {
		expect(triggeredByPhrase(trig({ triggerKind: 'delegated_result', sender: ELLA }), { postedConversationId: 'room-x' })).toBe(
			"Ella's result for work you delegated",
		);
	});
});
