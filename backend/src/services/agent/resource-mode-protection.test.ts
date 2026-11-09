import { createProtectedReason, createWaitsOn, type ProtectionTicket } from './resource-mode-protection.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const wi = (over: Partial<WorkItem> & { metadata?: Record<string, unknown> }): WorkItem =>
	({ id: 'w1', status: 'queued', title: 't', ...over }) as unknown as WorkItem;
const ticket = (over: Partial<ProtectionTicket>): ProtectionTicket => ({ id: 'T-1', status: 'in_progress', assignee: null, source: null, ...over });

function reasonFor(items: WorkItem[], tickets: ProtectionTicket[] | undefined, session = 'pia') {
	return createProtectedReason({ getWorkItems: async () => items, ...(tickets ? { listTickets: async () => tickets } : {}) })(session);
}

describe('createProtectedReason', () => {
	it('is null when the agent has nothing in flight', async () => {
		expect(await reasonFor([wi({ target: 'dex' })], [ticket({ assignee: 'dex' })])).toBeNull();
	});
	it('protects an agent with work queued for it', async () => {
		expect(await reasonFor([wi({ target: 'pia', status: 'accepted' })], [])).toMatch(/queued for it/);
		expect(await reasonFor([wi({ target: 'pia', status: 'done' })], [])).toBeNull();
	});
	it('protects an agent that owns an open ticket, not a backlog or finished one', async () => {
		expect(await reasonFor([], [ticket({ assignee: 'pia', status: 'in_progress' })])).toMatch(/owns open ticket T-1/);
		expect(await reasonFor([], [ticket({ assignee: 'pia', status: 'backlog' }), ticket({ assignee: 'pia', status: 'done' })])).toBeNull();
	});
	it('protects an agent waiting on a work item it delegated (Pia waiting for Dex)', async () => {
		const open = wi({ id: 'w9', target: 'dex', status: 'running', metadata: { delegatedBy: 'pia' } });
		expect(await reasonFor([open], [])).toMatch(/waiting on work item w9 .* dex/);
		expect(await reasonFor([wi({ ...open, status: 'done_by_worker' })], [])).toMatch(/w1|w9/);
		expect(await reasonFor([wi({ ...open, status: 'verified' })], [])).toBeNull();
		expect(await reasonFor([wi({ ...open, status: 'cancelled' })], [])).toBeNull();
	});
	it('protects an agent waiting on a ticket it created for someone else', async () => {
		expect(await reasonFor([], [ticket({ source: 'agent:pia', assignee: 'dex', status: 'review' })])).toMatch(/waiting on ticket T-1/);
		expect(await reasonFor([], [ticket({ source: 'agent:pia', assignee: 'dex', status: 'done' })])).toBeNull();
	});
	it('lets the waiting-on-a-teammate reasons lapse after 30 min idle, not owned work (2026-10-19: Owen and Sam held two slots)', async () => {
		const sources = {
			getWorkItems: async () => [wi({ id: 'w9', target: 'dex', status: 'running', metadata: { delegatedBy: 'pia' } })],
			listTickets: async () => [ticket({ source: 'agent:pia', assignee: 'dex', status: 'backlog' })],
		};
		const reason = createProtectedReason(sources);
		expect(await reason('pia', 29 * 60_000)).toMatch(/waiting on work item w9/);
		expect(await reason('pia', 31 * 60_000)).toBeNull();
		const owned = createProtectedReason({ getWorkItems: async () => [], listTickets: async () => [ticket({ assignee: 'pia' })] });
		expect(await owned('pia', 5 * 60 * 60_000)).toMatch(/owns open ticket/);
	});
	it('works without ticket storage', async () => {
		expect(await reasonFor([], undefined)).toBeNull();
	});
	it('protects an agent with a background run it announced that is still expected (stall watcher, crewly#1363)', async () => {
		const check = (reason: string | null) => createProtectedReason({ getWorkItems: async () => [], backgroundRunReason: (name) => (name === 'rex' ? reason : null) })('rex');
		expect(await check('a background run it announced ("已经开跑") is expected by 2026-10-17T15:44:00.000Z')).toMatch(/background run it announced/);
		expect(await check(null)).toBeNull();
	});
	it('protects an agent with messages queued for it (2026-10-16)', async () => {
		const check = (count: number) => createProtectedReason({ getWorkItems: async () => [], queuedMessageCount: () => count })('luna');
		expect(await check(2)).toMatch(/2 message\(s\) are queued for it/);
		expect(await check(0)).toBeNull();
	});
});

describe('createWaitsOn', () => {
	const waitsOn = (items: WorkItem[], tickets?: ProtectionTicket[]) =>
		createWaitsOn({ getWorkItems: async () => items, ...(tickets ? { listTickets: async () => tickets } : {}) });

	it('is true while the waiter waits on an open work item it delegated to the candidate', async () => {
		const open = wi({ target: 'dex', status: 'running', metadata: { delegatedBy: 'pia' } });
		expect(await waitsOn([open])('pia', 'dex')).toBe(true);
		expect(await waitsOn([open])('pia', 'max')).toBe(false);
		expect(await waitsOn([open])('max', 'dex')).toBe(false);
		expect(await waitsOn([wi({ ...open, status: 'verified' })])('pia', 'dex')).toBe(false);
	});
	it('is true while the waiter waits on an open ticket it created for the candidate', async () => {
		expect(await waitsOn([], [ticket({ source: 'agent:pia', assignee: 'dex', status: 'in_progress' })])('pia', 'dex')).toBe(true);
		expect(await waitsOn([], [ticket({ source: 'agent:pia', assignee: 'dex', status: 'done' })])('pia', 'dex')).toBe(false);
		expect(await waitsOn([], [ticket({ source: 'agent:max', assignee: 'dex', status: 'in_progress' })])('pia', 'dex')).toBe(false);
	});
	it('lets the waiting-on-a-teammate reasons lapse after 30 min idle, not owned work (2026-10-19: Owen and Sam held two slots)', async () => {
		const sources = {
			getWorkItems: async () => [wi({ id: 'w9', target: 'dex', status: 'running', metadata: { delegatedBy: 'pia' } })],
			listTickets: async () => [ticket({ source: 'agent:pia', assignee: 'dex', status: 'backlog' })],
		};
		const reason = createProtectedReason(sources);
		expect(await reason('pia', 29 * 60_000)).toMatch(/waiting on work item w9/);
		expect(await reason('pia', 31 * 60_000)).toBeNull();
		const owned = createProtectedReason({ getWorkItems: async () => [], listTickets: async () => [ticket({ assignee: 'pia' })] });
		expect(await owned('pia', 5 * 60 * 60_000)).toMatch(/owns open ticket/);
	});
	it('works without ticket storage', async () => {
		expect(await waitsOn([])('pia', 'dex')).toBe(false);
	});
});
