import { createProtectedReason, type ProtectionTicket } from './resource-mode-protection.js';
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
	it('works without ticket storage', async () => {
		expect(await reasonFor([], undefined)).toBeNull();
	});
});
