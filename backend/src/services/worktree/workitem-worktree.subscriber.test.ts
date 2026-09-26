import axios from 'axios';
import { WorkItemWorktreeSubscriber, createTerminalNotifier, type WorktreeEventSource, type WorktreeClaimSource } from './workitem-worktree.subscriber.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/** A tiny in-process bus with the onInProcess surface. */
function makeBus(): WorktreeEventSource & { emit(type: EventType, workItemId?: string): void; count(): number } {
	const handlers: Array<{ types: EventType[]; fn: (e: AgentEvent) => void | Promise<void> }> = [];
	return {
		onInProcess(types, fn) {
			const entry = { types: Array.isArray(types) ? types : [types], fn };
			handlers.push(entry);
			return () => handlers.splice(handlers.indexOf(entry), 1);
		},
		emit(type, workItemId) {
			for (const h of handlers) if (h.types.includes(type)) void h.fn({ type, workItemId } as AgentEvent);
		},
		count: () => handlers.length,
	};
}

describe('WorkItemWorktreeSubscriber', () => {
	let bus: ReturnType<typeof makeBus>;
	let claimListeners: Array<(wi: WorkItem, agent: string) => void>;
	let pool: WorktreeClaimSource;
	let service: { ensureWorktree: jest.Mock; detectWorkedOutside: jest.Mock; cleanup: jest.Mock; sweep: jest.Mock };
	let sub: WorkItemWorktreeSubscriber;
	const items: Record<string, Partial<WorkItem>> = {
		targeted: { id: 'targeted', target: 'dev-1', status: 'queued' },
		pooled: { id: 'pooled', status: 'queued' },
	};

	beforeEach(() => {
		bus = makeBus();
		claimListeners = [];
		pool = {
			findWorkItem: jest.fn(async (id: string) => (items[id] as WorkItem) ?? null),
			onClaimed: jest.fn((l) => {
				claimListeners.push(l);
				return () => undefined;
			}),
		};
		service = {
			ensureWorktree: jest.fn().mockResolvedValue(null),
			detectWorkedOutside: jest.fn().mockResolvedValue(null),
			cleanup: jest.fn().mockResolvedValue(null),
			sweep: jest.fn().mockResolvedValue({ reposExamined: 0, repos: [] }),
		};
		sub = new WorkItemWorktreeSubscriber({ service, events: bus, pool, sweepIntervalMs: 0 });
		sub.start();
	});

	afterEach(() => sub.stop());

	it('pre-creates on workitem:queued for a targeted WorkItem only', async () => {
		bus.emit('workitem:queued', 'targeted');
		bus.emit('workitem:queued', 'pooled');
		bus.emit('workitem:queued', 'missing');
		await sub.idle();
		expect(service.ensureWorktree).toHaveBeenCalledTimes(1);
		expect(service.ensureWorktree.mock.calls[0][0].id).toBe('targeted');
	});

	it('creates on claim (covers untargeted pool items)', async () => {
		claimListeners[0](items.pooled as WorkItem, 'dev-2');
		await sub.idle();
		expect(service.ensureWorktree).toHaveBeenCalledWith(items.pooled);
	});

	it.each([
		['task:cancelled', false, 'cancelled'],
		['task:done', true, 'done'],
		['task:verified', false, 'verified'],
	] as const)('%s → detector=%s, cleanup(%s)', async (type, detect, reason) => {
		bus.emit(type, 'w1');
		await sub.idle();
		expect(service.detectWorkedOutside).toHaveBeenCalledTimes(detect ? 1 : 0);
		expect(service.cleanup).toHaveBeenCalledWith('w1', reason);
	});

	it('task:done_by_worker runs the detector but does not clean up (review may reject)', async () => {
		bus.emit('task:done_by_worker', 'w1');
		await sub.idle();
		expect(service.detectWorkedOutside).toHaveBeenCalledWith('w1');
		expect(service.cleanup).not.toHaveBeenCalled();
	});

	it('task:rejected is ignored (rework keeps the worktree)', async () => {
		bus.emit('task:rejected', 'w1');
		await sub.idle();
		expect(service.cleanup).not.toHaveBeenCalled();
	});

	it('a failing handler never throws out of the bus', async () => {
		service.cleanup.mockRejectedValueOnce(new Error('boom'));
		bus.emit('task:cancelled', 'w1');
		await expect(sub.idle()).resolves.toBeUndefined();
	});

	it('the sweep timer runs the sweep', async () => {
		jest.useFakeTimers();
		try {
			const timed = new WorkItemWorktreeSubscriber({ service, events: makeBus(), pool, sweepIntervalMs: 1000 });
			timed.start();
			jest.advanceTimersByTime(2500);
			expect(service.sweep).toHaveBeenCalledTimes(2);
			timed.stop();
		} finally {
			jest.useRealTimers();
		}
	});

	it('start is idempotent and stop unsubscribes', () => {
		const before = bus.count();
		sub.start();
		expect(bus.count()).toBe(before);
		sub.stop();
		expect(bus.count()).toBe(0);
	});
});

describe('createTerminalNotifier', () => {
	it('writes the message to the agent terminal through the local API', async () => {
		const post = jest.spyOn(axios, 'post').mockResolvedValue({ status: 200 });
		try {
			await createTerminalNotifier()('dev 1', 'hello');
			expect(post).toHaveBeenCalledWith(
				expect.stringMatching(/\/api\/terminal\/dev%201\/write$/),
				{ data: 'hello', mode: 'message' },
				expect.objectContaining({ headers: { 'X-Agent-Session': 'WorkItemWorktree' } }),
			);
		} finally {
			post.mockRestore();
		}
	});
});
