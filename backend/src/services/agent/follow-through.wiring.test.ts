import { handedOffSince, owedWorkReminder, releaseWorkDeps, restoreStoppedOwingWork, OWED_REMINDER_MARKER, type StoppedOwingDeps } from './follow-through.wiring.js';
import { buildFollowUpWorkItem } from '../open-items/open-items.wiring.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { OwnerThreadSentinelService, setOwnerThreadSentinel } from '../messaging/owner-thread-sentinel.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));

const SINCE = Date.parse('2026-10-10T19:12:00Z');
const wi = (over: Partial<WorkItem>): WorkItem => ({ id: 'w', createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), status: 'queued', ...over }) as WorkItem;

describe('handedOffSince', () => {
	it('a WorkItem for the agent itself or one it delegated, created after the statement, covers it', () => {
		expect(handedOffSince([wi({ target: 'pia', status: 'running' })], 'pia', SINCE)).toBe(true);
		expect(handedOffSince([wi({ target: 'luna', metadata: { delegatedBy: 'pia' } })], 'pia', SINCE)).toBe(true);
		expect(handedOffSince([wi({ target: 'luna', metadata: { createdBy: 'pia' } })], 'pia', SINCE)).toBe(true);
	});

	it('a queued item the harness made for the agent is not the agent starting', () => {
		expect(handedOffSince([wi({ target: 'pia', metadata: { harnessCreated: 'stated-intent' } })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([wi({ target: 'pia', metadata: { harnessCreated: 'ticket-follow-through' } })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([wi({ target: 'pia', status: 'running', metadata: { harnessCreated: 'stated-intent' } })], 'pia', SINCE)).toBe(true);
	});

	it('the held follow-up of a promise made in the same reply is not the agent starting (Pia, 2026-11-16)', () => {
		const followUp = buildFollowUpWorkItem({
			request: { id: 'r1', ticketNumber: 927 } as never,
			item: { id: 'c-1', type: 'commitment', text: '我现在做头型,出来后发你对比图。', agent: 'pia', sourceMessageId: 'm1', createdAt: new Date().toISOString(), status: 'open', due: new Date(Date.now() + 4 * 3600_000).toISOString() },
			place: null,
		});
		expect(followUp.status).toBe('blocked');
		expect(handedOffSince([followUp], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([{ ...followUp, status: 'running' }], 'pia', SINCE)).toBe(true);
	});

	it('older items, other agents\' work and unrelated items do not', () => {
		expect(handedOffSince([wi({ target: 'pia', createdAt: '2026-10-10T18:00:00Z' })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([wi({ target: 'luna', metadata: { delegatedBy: 'ella' } })], 'pia', SINCE)).toBe(false);
		expect(handedOffSince([], 'pia', SINCE)).toBe(false);
	});
});

describe('owedWorkReminder', () => {
	it('lists what is queued for the stopped agent, and is null when nothing is', () => {
		const items = [wi({ target: 'pia', title: 'Follow through: starting v3 now' }), wi({ target: 'luna', title: 'other' }), wi({ target: 'pia', status: 'done', title: 'old' })];
		const text = owedWorkReminder(items, 'pia');
		expect(text).toContain('Follow through: starting v3 now');
		expect(text).not.toContain('other');
		expect(text).not.toContain('old');
		expect(owedWorkReminder(items, 'nobody')).toBeNull();
		expect(text).toContain('(asked 1 h ago)');
		expect(text).toContain('send NOTHING to the owner');
	});

	it('leaves out work queued past the reminder cutoff', () => {
		const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
		expect(owedWorkReminder([wi({ target: 'pia', title: 'ancient', createdAt: old })], 'pia')).toBeNull();
	});
});

describe('restoreStoppedOwingWork — the one hook every stop path runs (Pia, 2026-10-12)', () => {
	function make(items: WorkItem[], over: Partial<StoppedOwingDeps> = {}) {
		const calls: string[] = [];
		const queue: string[] = [];
		const deps: StoppedOwingDeps = {
			release: async (s, why) => { calls.push(`release:${s}:${why}`); },
			listWorkItems: async () => items,
			isHeldBack: () => false,
			hasReminder: () => queue.length > 0,
			enqueue: (_s, text) => { queue.push(text); },
			holdPlaceholders: async (s) => { calls.push(`hold:${s}`); },
			restart: async (s) => { calls.push(`restart:${s}`); },
			...over,
		};
		return { deps, calls, queue };
	}

	it('releases the work, holds placeholders, queues the reminder and restarts an agent that owes', async () => {
		const { deps, calls, queue } = make([wi({ target: 'pia', title: 'Follow through: build the video' })]);
		expect(await restoreStoppedOwingWork('pia', 'stopped to free a slot', deps)).toBe(true);
		expect(calls).toEqual(['release:pia:stopped to free a slot', 'hold:pia', 'restart:pia']);
		expect(queue).toHaveLength(1);
		expect(queue[0].startsWith(OWED_REMINDER_MARKER)).toBe(true);
		expect(queue[0]).toContain('build the video');
	});

	it('does nothing more for an agent that owes nothing', async () => {
		const { deps, calls, queue } = make([]);
		expect(await restoreStoppedOwingWork('pia', 'runtime exited', deps)).toBe(false);
		expect(calls).toEqual(['release:pia:runtime exited']);
		expect(queue).toEqual([]);
	});

	it('leaves an agent stopped on purpose alone', async () => {
		const { deps, calls } = make([wi({ target: 'pia' })], { isHeldBack: () => true });
		expect(await restoreStoppedOwingWork('pia', 'x', deps)).toBe(false);
		expect(calls).toEqual([]);
	});

	it('does not queue a second reminder while one waits', async () => {
		const { deps, queue } = make([wi({ target: 'pia' })], { hasReminder: () => true });
		await restoreStoppedOwingWork('pia', 'x', deps);
		expect(queue).toEqual([]);
	});

	it('is safe to call twice at once (idle event and stop path)', async () => {
		const { deps, calls } = make([wi({ target: 'pia' })]);
		const [a, b] = await Promise.all([restoreStoppedOwingWork('pia', 'x', deps), restoreStoppedOwingWork('pia', 'x', deps)]);
		expect([a, b].filter(Boolean)).toHaveLength(1);
		expect(calls.filter((c) => c.startsWith('restart'))).toHaveLength(1);
	});

	it('never throws', async () => {
		const { deps } = make([wi({ target: 'pia' })], { restart: async () => { throw new Error('boom'); } });
		await expect(restoreStoppedOwingWork('pia', 'x', deps)).resolves.toBe(false);
	});
});

describe('releaseWorkDeps().parkPromise: one WorkItem per thread + promise', () => {
	const NOW = Date.parse('2026-10-12T10:00:00Z');
	let items: WorkItem[];
	let added: WorkItem[];
	let sentinel: OwnerThreadSentinelService;

	beforeEach(() => {
		items = [];
		added = [];
		const pool = {
			getAllItems: async () => [...items],
			addToPool: async (item: WorkItem) => {
				await new Promise((r) => setTimeout(r, 5));
				added.push(item);
				items.push(item);
				return item;
			},
		};
		jest.spyOn(TaskPoolService, 'getInstance').mockReturnValue(pool as unknown as TaskPoolService);
		sentinel = new OwnerThreadSentinelService({
			postStatus: async () => true,
			nudgeAgent: async () => true,
			now: () => NOW,
		});
		setOwnerThreadSentinel(sentinel);
	});

	afterEach(() => {
		setOwnerThreadSentinel(null);
		jest.restoreAllMocks();
	});

	function promise(text: string, at = NOW - 60_000): void {
		const ref = { slackChannelId: 'C1', threadTs: '1.1' };
		sentinel.noteOwnerMessage({ ...ref, agent: 'atlas', at: at - 1000 });
		sentinel.noteAgentPost({ ...ref, agent: 'atlas', text, at });
	}

	it('an unkept promise makes exactly one item, however often the agent is stopped', async () => {
		promise("I'll redo the cover now, ~10 min");
		const first = await releaseWorkDeps().parkPromise!('atlas');
		const second = await releaseWorkDeps().parkPromise!('atlas');
		expect(first).toBe(added[0].id);
		expect(second).toBeNull();
		expect(added).toHaveLength(1);
		expect((added[0].metadata as Record<string, unknown>)['promiseKey']).toMatch(/^C1:1\.1@\d+$/);
	});

	it('an item for the same thread + promise that already exists (even done) is not made again', async () => {
		promise("I'll redo the cover now, ~10 min");
		const key = sentinel.parkablePromise('atlas')!.key;
		items.push(wi({ id: 'old', target: 'atlas', status: 'done', metadata: { promiseKey: key } }));
		expect(await releaseWorkDeps().parkPromise!('atlas')).toBeNull();
		expect(added).toHaveLength(0);
	});

	it('burst: concurrent stop paths and repeated ticks for one promise make exactly one item', async () => {
		promise("I'll redo the cover now, ~10 min");
		const deps = releaseWorkDeps();
		const ids = await Promise.all([deps.parkPromise!('atlas'), deps.parkPromise!('atlas'), deps.parkPromise!('atlas')]);
		for (let i = 0; i < 10; i++) await deps.parkPromise!('atlas');
		expect(added).toHaveLength(1);
		expect(ids.filter((id) => id === added[0].id)).toHaveLength(3);
	});

	it('an item made before promiseKey existed (same target + title) is not duplicated', async () => {
		const text = "I'll redo the cover now, ~10 min";
		promise(text);
		items.push(wi({ id: 'legacy', target: 'atlas', status: 'done', title: `Follow through: ${text.slice(0, 70)}`, metadata: { harnessCreated: 'owner-promise' } }));
		expect(await releaseWorkDeps().parkPromise!('atlas')).toBeNull();
		expect(added).toHaveLength(0);
	});

	it('a promise the agent followed up on makes no item', async () => {
		promise("I'll redo the cover now, ~10 min");
		sentinel.noteAgentPost({ slackChannelId: 'C1', threadTs: '1.1', agent: 'atlas', text: 'Done: it is in the thread.', at: NOW - 1000 });
		expect(await releaseWorkDeps().parkPromise!('atlas')).toBeNull();
		expect(added).toHaveLength(0);
	});
});
