import { buildTicketWorkBrief, checklistProgress, ensureTicketWorkItems, type TicketWorkGuardDeps } from './ticket-work-guard.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const NOW = Date.parse('2026-10-10T19:30:00Z');

function ticket(over: Partial<Request> = {}): Request {
	return {
		id: 'req-418',
		sourceConversationItemId: 's1',
		title: 'Three videos',
		description: 'Make three videos: 1. schedule video 2. Claw replica 3. dashboard replica',
		status: 'open',
		priority: 'normal',
		requiresConfirmation: true,
		workItemIds: [],
		intentLevel: 'L2',
		intentCategory: 'action',
		tags: [],
		createdAt: '2026-10-10T19:06:00Z',
		updatedAt: '2026-10-10T19:06:00Z',
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCost: 0,
		ticketNumber: 418,
		kind: 'feature',
		assignee: 'flopost-pia',
		...over,
	} as Request;
}

function setup(tickets: Request[], over: Partial<TicketWorkGuardDeps> = {}, pool: WorkItem[] = []) {
	const added: WorkItem[] = [];
	const setChecklist = jest.fn(async () => undefined);
	const deps: TicketWorkGuardDeps = {
		listTickets: async () => tickets,
		listWorkItems: async () => pool,
		addWorkItem: async (wi) => {
			added.push(wi);
		},
		setChecklist,
		holdsIntent: () => false,
		lastRealReplyAt: () => undefined,
		now: () => NOW,
		...over,
	};
	return { deps, added, setChecklist };
}

describe('ensureTicketWorkItems', () => {
	it('creates a WorkItem for the assignee, linked to the ticket, with the owner words as the brief', async () => {
		const { deps, added, setChecklist } = setup([ticket()]);
		const out = await ensureTicketWorkItems('flopost-pia', deps);
		expect(out).toHaveLength(1);
		expect(added).toHaveLength(1);
		expect(added[0]).toMatchObject({ target: 'flopost-pia', requestId: 'req-418', type: 'delegate', status: 'queued' });
		expect(added[0]?.briefMarkdown).toContain('> Make three videos');
		expect(added[0]?.metadata).toMatchObject({ harnessCreated: 'ticket-follow-through', ticketNumber: 418 });
		// the request lists three deliverables: a checklist goes on the ticket
		expect(setChecklist).toHaveBeenCalledWith('req-418', [{ text: 'schedule video' }, { text: 'Claw replica' }, { text: 'dashboard replica' }]);
		expect(out[0]?.checklist).toBe(3);
	});

	it('skips a ticket that already has a WorkItem (linked or in the pool)', async () => {
		const a = setup([ticket({ workItemIds: ['wi-1'] })]);
		expect(await ensureTicketWorkItems('flopost-pia', a.deps)).toEqual([]);
		const b = setup([ticket()], {}, [{ id: 'wi-2', requestId: 'req-418', status: 'queued' } as WorkItem]);
		expect(await ensureTicketWorkItems('flopost-pia', b.deps)).toEqual([]);
	});

	it('skips questions, no-review tickets, other assignees, closed and old tickets', async () => {
		const { deps, added } = setup([
			ticket({ id: 'q', kind: 'question' }),
			ticket({ id: 'n', requiresConfirmation: false }),
			ticket({ id: 'o', assignee: 'someone-else' }),
			ticket({ id: 'd', status: 'done' }),
			ticket({ id: 'w', status: 'waiting_confirmation' }),
			ticket({ id: 'old', createdAt: '2026-10-08T00:00:00Z' }),
		]);
		expect(await ensureTicketWorkItems('flopost-pia', deps)).toEqual([]);
		expect(added).toHaveLength(0);
	});

	it('a single-deliverable ticket the agent already answered gets no WorkItem', async () => {
		const t = ticket({ description: 'What is the schedule feature called?', title: 'q' });
		const answered = setup([t], { lastRealReplyAt: () => NOW - 60_000 });
		expect(await ensureTicketWorkItems('flopost-pia', answered.deps)).toEqual([]);
		const viaReply = setup([ticket({ description: 'Make a video', reply: { at: 'x', by: 'flopost-pia', messageId: 'm', excerpt: 'Here it is: out/v.mp4' } })]);
		expect(await ensureTicketWorkItems('flopost-pia', viaReply.deps)).toEqual([]);
	});

	it('an answer that only says "starting now" is not an answer; a held promise or several deliverables still get a WorkItem', async () => {
		const promise = setup([ticket({ description: 'Make a video', reply: { at: 'x', by: 'flopost-pia', messageId: 'm', excerpt: "I'm building it now" } })]);
		expect(await ensureTicketWorkItems('flopost-pia', promise.deps)).toHaveLength(1);
		const held = setup([ticket({ description: 'Make a video' })], { lastRealReplyAt: () => NOW - 60_000, holdsIntent: () => true });
		expect(await ensureTicketWorkItems('flopost-pia', held.deps)).toHaveLength(1);
		const several = setup([ticket()], { lastRealReplyAt: () => NOW - 60_000 });
		expect(await ensureTicketWorkItems('flopost-pia', several.deps)).toHaveLength(1);
	});

	it('does not overwrite a checklist the ticket already has', async () => {
		const { deps, setChecklist } = setup([ticket({ acceptance: [{ text: 'owner criterion' }] })]);
		await ensureTicketWorkItems('flopost-pia', deps);
		expect(setChecklist).not.toHaveBeenCalled();
	});
});

describe('checklist and brief', () => {
	it('shows partial delivery', () => {
		const t = ticket({ acceptance: [{ text: 'a', selfCheck: 'pass' }, { text: 'b' }, { text: 'c', removedAt: 'x' }, { text: 'd' }] });
		expect(checklistProgress(t)).toEqual({ delivered: 1, total: 3 });
		expect(checklistProgress(ticket({ acceptance: [{ text: 'only' }] }))).toBeNull();
	});

	it('the brief tells the agent how to record each delivery and not to mention the ticket', () => {
		const brief = buildTicketWorkBrief(ticket(), ['one', 'two']);
		expect(brief).toContain('TKT-418');
		expect(brief).toContain('do not mention it to the owner');
		expect(brief).toContain('ticket-check --ticket');
	});
});
