import { holdReasonFor, releaseHeldWork, TICKET_HOLD_MAX_AGE_MS, type IdleWorkGuardDeps } from './idle-work-guard.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';

const NOW = Date.parse('2026-10-10T19:36:00Z');
const wi = (over: Partial<WorkItem>): WorkItem => ({ id: 'w', target: 'pia', status: 'queued', ...over }) as WorkItem;
const tk = (over: Partial<Request>): Request =>
	({ id: 't', ticketNumber: 1, assignee: 'pia', status: 'open', kind: 'feature', createdAt: '2026-10-10T19:06:00Z', ...over }) as Request;

function deps(over: Partial<IdleWorkGuardDeps> & { items?: WorkItem[]; tickets?: Request[] } = {}): IdleWorkGuardDeps {
	return {
		listWorkItems: async () => over.items ?? [],
		listTickets: async () => over.tickets ?? [],
		owesOwner: () => false,
		holdsIntent: () => false,
		now: () => NOW,
		...over,
	};
}

describe('holdReasonFor', () => {
	it('nothing holds an agent with no work', async () => {
		expect(await holdReasonFor('pia', deps())).toBeNull();
	});

	it.each(['queued', 'proposed', 'accepted', 'running'] as const)('a %s WorkItem holds it', async (status) => {
		expect(await holdReasonFor('pia', deps({ items: [wi({ status })] }))).toBe('work_item');
	});

	it('done, blocked, scheduled and other agents\' items do not', async () => {
		const items = [wi({ status: 'done' }), wi({ status: 'blocked' }), wi({ status: 'scheduled' }), wi({ target: 'luna', status: 'running' })];
		expect(await holdReasonFor('pia', deps({ items }))).toBeNull();
	});

	it('an assigned open ticket holds it (the 2026-10-10 case: ticket, no WorkItem)', async () => {
		expect(await holdReasonFor('pia', deps({ tickets: [tk({})] }))).toBe('ticket');
		expect(await holdReasonFor('pia', deps({ tickets: [tk({ status: 'running' })] }))).toBe('ticket');
	});

	it('closed, waiting-for-owner, question, other-assignee and ancient tickets do not', async () => {
		const tickets = [
			tk({ status: 'done' }),
			tk({ status: 'waiting_confirmation' }),
			tk({ kind: 'question' }),
			tk({ assignee: 'luna' }),
			tk({ createdAt: new Date(NOW - TICKET_HOLD_MAX_AGE_MS - 1000).toISOString() }),
		];
		expect(await holdReasonFor('pia', deps({ tickets }))).toBeNull();
	});

	it('an owner promise and a stated intent hold it', async () => {
		expect(await holdReasonFor('pia', deps({ owesOwner: () => true }))).toBe('promise');
		expect(await holdReasonFor('pia', deps({ holdsIntent: () => true }))).toBe('stated_intent');
	});
});

describe('releaseHeldWork', () => {
	it('puts only the agent\'s running items back and parks an open intent', async () => {
		const releaseBack = jest.fn(async () => undefined);
		const out = await releaseHeldWork('pia', 'memory', {
			listWorkItems: async () => [wi({ id: 'a', status: 'running' }), wi({ id: 'b', status: 'queued' }), wi({ id: 'c', target: 'luna', status: 'running' })],
			releaseBack,
			parkIntent: async () => 'parked-1',
		});
		expect(releaseBack).toHaveBeenCalledTimes(1);
		expect(releaseBack).toHaveBeenCalledWith('a', 'memory');
		expect(out).toEqual(['a', 'parked-1']);
	});

	it('never throws, whatever fails', async () => {
		const out = await releaseHeldWork('pia', 'memory', {
			listWorkItems: async () => {
				throw new Error('pool unreadable');
			},
			releaseBack: async () => undefined,
		});
		expect(out).toEqual([]);
	});
});
