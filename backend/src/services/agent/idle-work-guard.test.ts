import { hasOpenOwnerCommitment, holdReasonFor, releaseHeldWork, FRESH_PROMISE_MS, TICKET_HOLD_MAX_AGE_MS, type IdleWorkGuardDeps } from './idle-work-guard.js';
import { OPEN_ITEMS_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { RequestOpenItem } from '../../types/v2/open-item.types.js';

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
		// A background run the agent announced (stall watcher, crewly#1363) holds it; checked after the intent.
		expect(await holdReasonFor('pia', deps({ holdsBackgroundRun: () => true }))).toBe('background_run');
		expect(await holdReasonFor('pia', deps({ holdsIntent: () => true, holdsBackgroundRun: () => true }))).toBe('stated_intent');
		expect(await holdReasonFor('pia', deps({ holdsBackgroundRun: () => false }))).toBeNull();
	});
});

describe('open owner commitments (crewly#1386, Pia idle-stopped with her plan open)', () => {
	const item = (over: Partial<RequestOpenItem> = {}): RequestOpenItem => ({
		id: 'c-1',
		type: 'commitment',
		text: '三条已经提交，让它们跑完，对比后看差多少。',
		agent: 'pia',
		sourceMessageId: 'm-1',
		createdAt: new Date(NOW - 2 * 3600_000).toISOString(),
		status: 'open',
		...over,
	});
	const req = (items: RequestOpenItem[], over: Partial<Request> = {}): Request => ({ id: 'r', status: 'in_progress', createdAt: '2026-10-10T17:00:00Z', openItems: items, ...over }) as Request;

	it.each(['open', 'ready', 'overdue'] as const)('a %s commitment holds the agent', async (status) => {
		expect(await holdReasonFor('pia', deps({ tickets: [req([item({ status })])] }))).toBe('open_commitment');
	});

	it('is not a fresh promise: memory pressure still stops the agent', async () => {
		expect(await holdReasonFor('pia', deps({ tickets: [req([item({ createdAt: new Date(NOW - 60_000).toISOString() })])] }))).toBe('open_commitment');
	});

	it.each([
		['waiting on the owner', [item({ status: 'waiting_owner' })], {}],
		['delivered', [item({ status: 'delivered' })], {}],
		['another agent', [item({ agent: 'luna' })], {}],
		['a question', [item({ type: 'question' })], {}],
		['too old', [item({ createdAt: new Date(NOW - OPEN_ITEMS_CONSTANTS.IDLE_HOLD_MAX_AGE_MS - 1000).toISOString() })], {}],
		['on a done request', [item()], { status: 'done' }],
		['on a cancelled request', [item()], { status: 'cancelled' }],
	] as const)('%s does not hold it', async (_label, items, over) => {
		expect(await holdReasonFor('pia', deps({ tickets: [req([...items], over as Partial<Request>)] }))).toBeNull();
	});

	it('hasOpenOwnerCommitment tolerates requests without open items', () => {
		expect(hasOpenOwnerCommitment([req([]), { id: 'x', status: 'open' } as Request], 'pia', NOW)).toBe(false);
	});
});

describe('fresh promises', () => {
	it('a promise made minutes ago is kept even under pressure (its own reason)', async () => {
		expect(await holdReasonFor('pia', deps({ owesOwner: () => true, owedAgeMs: () => 5 * 60_000 }))).toBe('fresh_promise');
		expect(await holdReasonFor('pia', deps({ owesOwner: () => true, owedAgeMs: () => FRESH_PROMISE_MS + 1 }))).toBe('promise');
		expect(await holdReasonFor('pia', deps({ owedAgeMs: () => null }))).toBeNull();
	});
});

describe('releaseHeldWork', () => {
	it('parks a promise that was not a stated intent', async () => {
		const out = await releaseHeldWork('pia', 'memory', {
			listWorkItems: async () => [],
			releaseBack: async () => undefined,
			parkIntent: async () => null,
			parkPromise: async () => 'promise-wi',
		});
		expect(out).toEqual(['promise-wi']);
	});

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
