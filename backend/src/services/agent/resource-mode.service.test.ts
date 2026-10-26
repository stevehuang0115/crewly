jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));
jest.mock('../core/system-health.util.js', () => ({ getMemoryStats: () => ({ usedPercent: 10, freeMB: 9000, totalMB: 16384 }) }));

import { RESOURCE_MODE_CONSTANTS, ResourceModeService, memoryIsTightFor, type RunningAgent } from './resource-mode.service.js';
import { getDefaultSettings } from '../../types/settings.types.js';

const calm = { usedPercent: 40, freeMB: 8000, totalMB: 16384 };
const tight = { usedPercent: 60, freeMB: 1500, totalMB: 16384, swapUsedPercent: 93 };
/** The 2026-10-26 reading: swap near full, 6 GB free, kernel calm — a healthy Mac. */
const swapOnly = { usedPercent: 62, freeMB: 6223, totalMB: 16384, swapUsedPercent: 93.9, pressureElevated: false };

function make(running: RunningAgent[], owners: string[] = [], max = 2) {
	const svc = ResourceModeService.getInstance();
	const stopped: string[] = [];
	let list = [...running];
	svc.setDeps({
		limits: async () => ({ maxRunning: max, idleTimeoutMinutes: 10 }),
		listRunning: async () => list,
		hasOwnerMessage: (n) => owners.includes(n),
		stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
	});
	return { svc, stopped };
}
const agent = (sessionName: string, idleMs: number, busy = false): RunningAgent => ({ sessionName, role: 'dev', idleMs, busy });

async function enter(svc: ResourceModeService) {
	svc.memoryStats = () => tight;
	await svc.sample();
	await svc.sample();
}

beforeEach(() => {
	ResourceModeService.resetInstance();
	const s = ResourceModeService.getInstance();
	s.memoryStats = () => calm;
	s.loadAvg = () => 1;
	s.cpuCount = () => 8;
});
afterAll(() => ResourceModeService.resetInstance());

describe('mode transitions', () => {
	it('enters pressure after 2 tight samples, leaves after 3 calm ones', async () => {
		const svc = ResourceModeService.getInstance();
		svc.memoryStats = () => tight;
		expect(await svc.sample()).toBe('normal');
		expect(await svc.sample()).toBe('pressure');
		svc.memoryStats = () => calm;
		expect(await svc.sample()).toBe('pressure');
		expect(await svc.sample()).toBe('pressure');
		expect(await svc.sample()).toBe('normal');
	});

	it('a single calm sample resets the tight streak', async () => {
		const svc = ResourceModeService.getInstance();
		svc.memoryStats = () => tight; await svc.sample();
		svc.memoryStats = () => calm; await svc.sample();
		svc.memoryStats = () => tight; expect(await svc.sample()).toBe('normal');
	});

	it('sustained CPU load above 2x cores counts as tight', async () => {
		const svc = ResourceModeService.getInstance();
		svc.loadAvg = () => 17;
		await svc.sample();
		expect(await svc.sample()).toBe('pressure');
		expect(svc.stats()).toMatchObject({ resourceMode: 'pressure' });
	});

	it('memoryIsTightFor uses swap (with low free memory) and OS pressure', () => {
		expect(memoryIsTightFor(calm)).toBe(false);
		expect(memoryIsTightFor({ ...calm, pressureElevated: true })).toBe(true);
		expect(memoryIsTightFor(tight)).toBe(true);
	});

	it('swap fill alone is not tight: a full swap file with 6 GB free and a calm kernel is a healthy Mac (2026-10-26)', () => {
		expect(memoryIsTightFor(swapOnly)).toBe(false);
		// Just under twice the free floor: swap counts again.
		expect(memoryIsTightFor({ ...swapOnly, freeMB: 2047 })).toBe(true);
		// The kernel's own flag still wins on its own.
		expect(memoryIsTightFor({ ...swapOnly, pressureElevated: true })).toBe(true);
	});
});

describe('idle timeout switching', () => {
	it('uses the pressure timeout only in pressure mode', async () => {
		const svc = ResourceModeService.getInstance();
		expect(svc.effectiveIdleTimeoutMinutes(30, 10)).toBe(30);
		await enter(svc);
		expect(svc.effectiveIdleTimeoutMinutes(30, 10)).toBe(10);
		expect(svc.effectiveIdleTimeoutMinutes(30, 0)).toBe(30);
	});
});

describe('start cap', () => {
	it('allows starts without a cap in normal mode', async () => {
		const { svc, stopped } = make([agent('a', 1), agent('b', 2), agent('c', 3)]);
		expect(await svc.requestStart('d', false)).toBe(true);
		expect(stopped).toEqual([]);
	});

	it('under the cap starts immediately', async () => {
		const { svc, stopped } = make([agent('a', 1)]);
		await enter(svc);
		expect(await svc.requestStart('d', false)).toBe(true);
		expect(stopped).toEqual([]);
	});

	it('at the cap stops the longest-idle agent, skipping busy, owner-pending and orchestrator', async () => {
		const { svc, stopped } = make(
			[agent('long-busy', 9e6, true), agent('long-owner', 8e6), agent('mid', 2e6), agent('short', 1e6), { sessionName: 'orc', role: 'orchestrator', idleMs: 1e9, busy: false }],
			['long-owner'], 4);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['mid']);
	});

	it('queues when nothing can be stopped and admits when a slot frees', async () => {
		const { svc, stopped } = make([agent('a', 1e6, true), agent('b', 2e6, true)]);
		await enter(svc);
		let done: boolean | null = null;
		void svc.requestStart('new', false).then((r) => { done = r; });
		await new Promise((r) => setTimeout(r, 20));
		expect(done).toBeNull();
		expect(svc.stats().waiting).toBe(1);
		expect(stopped).toEqual([]);
		svc.setDeps({ limits: async () => ({ maxRunning: 2, idleTimeoutMinutes: 10 }), listRunning: async () => [agent('a', 1e6, true)], hasOwnerMessage: () => false, stopAgent: async () => undefined });
		await svc.pump(); await new Promise((r) => setTimeout(r, 5));
		expect(done).toBe(true);
	});

	it('starts for an owner message go ahead of earlier queued starts', async () => {
		const running = [agent('a', 1e6, true)];
		let list = running;
		const svc = ResourceModeService.getInstance();
		svc.setDeps({ limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }), listRunning: async () => list, hasOwnerMessage: () => false, stopAgent: async () => undefined });
		await enter(svc);
		const order: string[] = [];
		void svc.requestStart('other', false).then(() => order.push('other'));
		void svc.requestStart('owner', true).then(() => order.push('owner'));
		await new Promise((r) => setTimeout(r, 20));
		list = [];
		await svc.pump(); await new Promise((r) => setTimeout(r, 5));
		expect(order).toEqual(['owner']);
		list = [];
		await svc.pump(); await new Promise((r) => setTimeout(r, 5));
		// owner is admitted (counts against the cap), so 'other' keeps waiting
		expect(order).toEqual(['owner']);
		expect(svc.stats().waiting).toBe(1);
	});

	it('holds one place in line per agent: a second request joins the first (CREW-304)', async () => {
		const { svc } = make([agent('a', 1e6, true), agent('b', 2e6, true)]);
		await enter(svc);
		expect(svc.isStartWaiting('new')).toBe(false);
		const first = svc.requestStart('new', false);
		const second = svc.requestStart('new', false);
		await new Promise((r) => setTimeout(r, 20));
		expect(svc.stats().waiting).toBe(1);
		expect(svc.isStartWaiting('new')).toBe(true);
		// An owner message moves the existing place to the front.
		void svc.requestStart('other', false);
		void svc.requestStart('new', true);
		await new Promise((r) => setTimeout(r, 5));
		expect(svc.stats().waiting).toBe(2);
		svc.setDeps({ limits: async () => ({ maxRunning: 2, idleTimeoutMinutes: 10 }), listRunning: async () => [agent('a', 1e6, true)], hasOwnerMessage: () => false, stopAgent: async () => undefined });
		await svc.pump(); await new Promise((r) => setTimeout(r, 5));
		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(svc.isStartWaiting('new')).toBe(false);
		expect(svc.isStartWaiting('other')).toBe(true);
		// Settled: a later request queues afresh.
		await new Promise((r) => setTimeout(r, 5));
		void svc.requestStart('new', false);
		await new Promise((r) => setTimeout(r, 5));
		expect(svc.isStartWaiting('new')).toBe(true);
	});

	it('releases waiters when pressure ends', async () => {
		const { svc } = make([agent('a', 1e6, true), agent('b', 1e6, true)]);
		await enter(svc);
		let done: boolean | null = null;
		void svc.requestStart('new', false).then((r) => { done = r; });
		await new Promise((r) => setTimeout(r, 20));
		svc.memoryStats = () => calm;
		await svc.sample(); await svc.sample(); await svc.sample();
		expect(done).toBe(true);
	});
});

describe('eviction guards (idle threshold, pending work, open delegations)', () => {
	function makeGuarded(running: RunningAgent[], reasons: Record<string, string>, max = 2) {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		let list = [...running];
		svc.setDeps({
			limits: async () => ({ maxRunning: max, idleTimeoutMinutes: 10 }),
			listRunning: async () => list,
			hasOwnerMessage: () => false,
			protectedReason: async (n) => reasons[n] ?? null,
			stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
		});
		return { svc, stopped };
	}
	const waits = async (svc: ResourceModeService) => {
		let done: boolean | null = null;
		void svc.requestStart('new', false).then((r) => { done = r; });
		await new Promise((r) => setTimeout(r, 20));
		return done;
	};

	it('never stops an agent idle for less than the pressure idle timeout; the waiter waits', async () => {
		const { svc, stopped } = makeGuarded([agent('a', 2 * 60_000), agent('b', 9 * 60_000)], {});
		await enter(svc);
		expect(await waits(svc)).toBeNull();
		expect(stopped).toEqual([]);
		expect(svc.stats().waiting).toBe(1);
	});

	it('stops one that is past the threshold', async () => {
		const { svc, stopped } = makeGuarded([agent('a', 2 * 60_000), agent('b', 11 * 60_000)], {});
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['b']);
	});

	it('skips agents with pending work, an open ticket or an open delegation', async () => {
		const { svc, stopped } = makeGuarded(
			[agent('queued', 9e6), agent('owner-of-ticket', 8e6), agent('waiting-on-dex', 7e6), agent('free', 6e6)],
			{ queued: 'work item w1 is queued for it', 'owner-of-ticket': 'it owns open ticket T-1', 'waiting-on-dex': 'it is waiting on work item w2' },
			4,
		);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['free']);
	});

	it('waits when every candidate is protected', async () => {
		const { svc, stopped } = makeGuarded([agent('a', 9e6), agent('b', 8e6)], { a: 'x', b: 'y' });
		await enter(svc);
		expect(await waits(svc)).toBeNull();
		expect(stopped).toEqual([]);
	});

	it('treats a failing protection check as unprotected', async () => {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		svc.setDeps({
			limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }),
			listRunning: async () => [agent('a', 9e6)],
			hasOwnerMessage: () => false,
			protectedReason: async () => { throw new Error('boom'); },
			stopAgent: async (n) => { stopped.push(n); },
		});
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['a']);
	});
});

describe('relaxing after a long wait', () => {
	function setup(running: RunningAgent[], reasons: Record<string, string>) {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		let list = [...running];
		svc.setDeps({
			limits: async () => ({ maxRunning: running.length, idleTimeoutMinutes: 10 }),
			listRunning: async () => list,
			hasOwnerMessage: (n) => n === 'owner-holder',
			protectedReason: async (n) => reasons[n] ?? null,
			stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
		});
		return { svc, stopped };
	}

	it('never stops a protected agent even after the start has waited past RELAX_AFTER_MS, across a deferral (2026-10-16)', async () => {
		jest.useFakeTimers();
		try {
			const { svc, stopped } = setup(
				[agent('busy', 9e6, true), agent('owner-holder', 9e6), agent('waiting-on-dex', 8e6), agent('queued', 7e6)],
				{ 'waiting-on-dex': 'it is waiting on work item w2', queued: 'work item w1 is queued for it' },
			);
			await enter(svc);
			const first = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
			expect(await first).toBe(false);
			const second = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
			// waited past RELAX_AFTER_MS, yet every agent is busy, holds an owner message or is protected: the waiter waits
			expect(await second).toBe(false);
			expect(stopped).toEqual([]);
		} finally {
			jest.useRealTimers();
		}
	});

	it('even when relaxed, prefers an agent that is only under the idle timeout over a protected one', async () => {
		jest.useFakeTimers();
		try {
			// 'young' is past the 5-minute eviction floor (crewly#1344) but under the 10-minute idle timeout.
			const { svc, stopped } = setup([agent('protected', 9e6), agent('young', 6 * 60_000)], { protected: 'it owns open ticket T-1' });
			await enter(svc);
			const first = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.RELAX_AFTER_MS + 10);
			expect(await first).toBe(false);
			expect(await svc.requestStart('new', false)).toBe(true);
			expect(stopped).toEqual(['young']);
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not relax before RELAX_AFTER_MS', async () => {
		jest.useFakeTimers();
		try {
			const { svc, stopped } = setup([agent('a', 9e6)], { a: 'it owns open ticket T-1' });
			await enter(svc);
			const p = svc.requestStart('new', true);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
			expect(await p).toBe(false);
			expect(stopped).toEqual([]);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('anti-thrash rules (2026-10-16: Luna and Max evicting each other)', () => {
	function setup(running: RunningAgent[], opts: { max?: number; waitsOn?: (w: string, c: string) => Promise<boolean> } = {}) {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		const list = new Map(running.map((r) => [r.sessionName, r]));
		svc.setDeps({
			limits: async () => ({ maxRunning: opts.max ?? running.length, idleTimeoutMinutes: 10 }),
			listRunning: async () => [...list.values()],
			hasOwnerMessage: () => false,
			protectedReason: async () => null,
			...(opts.waitsOn ? { waitsOn: opts.waitsOn } : {}),
			stopAgent: async (n) => { stopped.push(n); list.delete(n); },
		});
		/** The admitted agent shows as running (and long idle, so only the anti-thrash rules can keep it) */
		const run = (name: string, idleMs = 9e6) => list.set(name, agent(name, idleMs));
		return { svc, stopped, run };
	}
	/** Advance fake time and return the start's result (false when it was deferred) */
	async function settleWithin(p: Promise<boolean>, ms: number): Promise<boolean> {
		let result: boolean | null = null;
		void p.then((r) => { result = r; });
		await jest.advanceTimersByTimeAsync(ms);
		return result === true;
	}
	/** Ask for a start and let it run past RELAX_AFTER_MS; resolves with the result once settled or deferred */
	async function waitedStart(svc: ResourceModeService, name: string, owner = false): Promise<boolean> {
		const first = await settleWithin(svc.requestStart(name, owner), RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
		if (first) return true;
		// Deferred after START_WAIT_MS (before RELAX_AFTER_MS): ask again, as the reconciler would.
		const again = svc.requestStart(name, owner);
		await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
		return again;
	}

	beforeEach(() => jest.useFakeTimers());
	afterEach(() => jest.useRealTimers());

	it('a relaxed start never stops an agent started less than MIN_RUN_BEFORE_EVICT_MS ago', async () => {
		// Both past the 5-minute eviction floor (crewly#1344) but under the 10-minute idle timeout.
		const { svc, stopped, run } = setup([agent('old', 6 * 60_000)], { max: 2 });
		await enter(svc);
		expect(await svc.requestStart('fresh', false)).toBe(true);
		run('fresh', 7 * 60_000);
		// Both are under the idle timeout and 'fresh' is idle longer, but it was just started: relaxing may only stop 'old'
		expect(await waitedStart(svc, 'waiter')).toBe(true);
		expect(stopped).toEqual(['old']);
	});

	it('the waiter waits when the only candidate was started inside the protection window, then gets it once the window passes', async () => {
		const { svc, stopped, run } = setup([], { max: 1 });
		await enter(svc);
		expect(await svc.requestStart('luna', false)).toBe(true);
		run('luna', 6 * 60_000);
		expect(await waitedStart(svc, 'max')).toBe(false);
		expect(stopped).toEqual([]);
		await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS);
		expect(await waitedStart(svc, 'max')).toBe(true);
		expect(stopped).toEqual(['luna']);
	});

	it('an owner-message start is not bound by the start window: it takes a just-started agent at once', async () => {
		const { svc, stopped, run } = setup([], { max: 1 });
		await enter(svc);
		expect(await svc.requestStart('luna', false)).toBe(true);
		run('luna', 6 * 60_000);
		expect(await settleWithin(svc.requestStart('max', true), 20)).toBe(true);
		expect(stopped).toEqual(['luna']);
	});

	it('an agent idle for less than MIN_IDLE_BEFORE_EVICT_MS is never a slot — not for an owner-message start, not when the rules relax (crewly#1344)', async () => {
		const { svc, stopped, run } = setup([agent('luna', 9e6)], { max: 1 });
		await enter(svc);
		// Luna just finished a turn: 0 minutes idle, well past her start window.
		run('luna', 0);
		await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS);
		expect(await settleWithin(svc.requestStart('max', true), 20)).toBe(false);
		expect(await waitedStart(svc, 'max')).toBe(false);
		expect(stopped).toEqual([]);
		// Past the floor (still under the idle timeout) the relaxed start may take her.
		run('luna', RESOURCE_MODE_CONSTANTS.MIN_IDLE_BEFORE_EVICT_MS);
		expect(await waitedStart(svc, 'max')).toBe(true);
		expect(stopped).toEqual(['luna']);
	});

	it('an owner-message start still keeps the agent whose work it waits on', async () => {
		const { svc, stopped } = setup([agent('dex', 9e6)], { waitsOn: async (w, c) => w === 'pia' && c === 'dex' });
		await enter(svc);
		expect(await waitedStart(svc, 'pia', true)).toBe(false);
		expect(stopped).toEqual([]);
	});

	it('an owner-message start still keeps an agent with queued work', async () => {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		svc.setDeps({
			limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }),
			listRunning: async () => [agent('luna', 9e6)],
			hasOwnerMessage: () => false,
			protectedReason: async () => '2 message(s) are queued for it',
			stopAgent: async (n) => { stopped.push(n); },
		});
		await enter(svc);
		expect(await waitedStart(svc, 'max', true)).toBe(false);
		expect(stopped).toEqual([]);
	});

	it('an owner-message start skips the ping-pong guard: it may stop the agent that displaced it at once', async () => {
		const { svc, stopped, run } = setup([agent('luna', 9e6)], { max: 1 });
		await enter(svc);
		expect(await waitedStart(svc, 'max')).toBe(true);
		run('max');
		// Inside both Max's start window and the hysteresis window; an owner start ignores both.
		expect(await settleWithin(svc.requestStart('luna', true), 20)).toBe(true);
		expect(stopped).toEqual(['luna', 'max']);
	});

	it('never stops the agent whose work the waiter is waiting on', async () => {
		const { svc, stopped } = setup([agent('dex', 9e6), agent('other', 1e6)], {
			waitsOn: async (w, c) => w === 'pia' && c === 'dex',
		});
		await enter(svc);
		expect(await waitedStart(svc, 'pia')).toBe(true);
		expect(stopped).toEqual(['other']);
	});

	it('waits when the only candidate is doing the waiter\'s work', async () => {
		const { svc, stopped } = setup([agent('dex', 9e6)], { waitsOn: async () => true });
		await enter(svc);
		expect(await waitedStart(svc, 'pia')).toBe(false);
		expect(stopped).toEqual([]);
	});

	it('treats a failing waitsOn check as "not waiting"', async () => {
		const { svc, stopped } = setup([agent('dex', 9e6)], { waitsOn: async () => { throw new Error('boom'); } });
		await enter(svc);
		expect(await waitedStart(svc, 'pia')).toBe(true);
		expect(stopped).toEqual(['dex']);
	});

	it('no ping-pong: a displaced agent\'s restart cannot stop the agent that displaced it within DISPLACED_GUARD_MS', async () => {
		const { svc, stopped, run } = setup([agent('luna', 9e6)], { max: 1 });
		await enter(svc);
		// Max's start (relaxed) stops Luna.
		expect(await waitedStart(svc, 'max')).toBe(true);
		expect(stopped).toEqual(['luna']);
		run('max');
		// Past Max's start protection, inside the hysteresis window: Luna's restart may not stop Max.
		await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.MIN_RUN_BEFORE_EVICT_MS);
		expect(await waitedStart(svc, 'luna')).toBe(false);
		expect(stopped).toEqual(['luna']);
		// Hysteresis is per pair: another agent's start may still take Max's slot.
		expect(await waitedStart(svc, 'sage')).toBe(true);
		expect(stopped).toEqual(['luna', 'max']);
	});

	it('the hysteresis expires after DISPLACED_GUARD_MS', async () => {
		const { svc, stopped, run } = setup([agent('luna', 9e6)], { max: 1 });
		await enter(svc);
		expect(await waitedStart(svc, 'max')).toBe(true);
		run('max');
		await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.DISPLACED_GUARD_MS);
		expect(await waitedStart(svc, 'luna')).toBe(true);
		expect(stopped).toEqual(['luna', 'max']);
	});

	it('critical memory overrides the anti-thrash rules', async () => {
		const { svc, stopped, run } = setup([], { max: 1 });
		await enter(svc);
		expect(await svc.requestStart('luna', false)).toBe(true);
		run('luna');
		svc.memoryStats = () => ({ usedPercent: 99, freeMB: 100, totalMB: 16384 });
		expect(await waitedStart(svc, 'max')).toBe(true);
		expect(stopped).toEqual(['luna']);
	});
});

describe('owner-triggered start under the cap', () => {
	function setup(running: RunningAgent[], reasons: Record<string, string> = {}) {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		let list = [...running];
		svc.setDeps({
			limits: async () => ({ maxRunning: running.length, idleTimeoutMinutes: 10 }),
			listRunning: async () => list,
			hasOwnerMessage: () => false,
			protectedReason: async (n) => reasons[n] ?? null,
			stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
		});
		return { svc, stopped };
	}

	it('stops the longest-idle agent at once even when every agent is under the idle timeout', async () => {
		// Both past the 5-minute eviction floor (crewly#1344), both under the 10-minute idle timeout.
		const { svc, stopped } = setup([agent('a', 6 * 60_000), agent('b', 7 * 60_000)]);
		await enter(svc);
		expect(await svc.requestStart('new', true)).toBe(true);
		expect(stopped).toEqual(['b']);
	});

	it('still keeps an agent with pending work, an open ticket or an open delegation', async () => {
		jest.useFakeTimers();
		try {
			const { svc, stopped } = setup([agent('a', 6 * 60_000), agent('b', 7 * 60_000)], { b: 'work item w1 is queued for it' });
			await enter(svc);
			expect(await svc.requestStart('new', true)).toBe(true);
			expect(stopped).toEqual(['a']);
		} finally {
			jest.useRealTimers();
		}
	});

	it('an ordinary (not owner) start still respects the idle timeout', async () => {
		jest.useFakeTimers();
		try {
			const { svc, stopped } = setup([agent('a', 6 * 60_000)]);
			await enter(svc);
			const p = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
			expect(await p).toBe(false);
			expect(stopped).toEqual([]);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('owner threads (specs/2026-10-08-owner-thread-sentinel.md)', () => {
	function makeOwing(running: RunningAgent[], owing: string[], max = 2) {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		const told: string[] = [];
		let list = [...running];
		svc.setDeps({
			limits: async () => ({ maxRunning: max, idleTimeoutMinutes: 10 }),
			listRunning: async () => list,
			hasOwnerMessage: () => false,
			owesOwnerThread: (n) => owing.includes(n),
			onStoppedForSlot: (n) => told.push(n),
			stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
		});
		return { svc, stopped, told };
	}

	it('never picks an agent that owes an owner thread while another candidate exists', async () => {
		const { svc, stopped, told } = makeOwing([agent('atlas', 9e6), agent('kai', 1e6)], ['atlas']);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['kai']);
		expect(told).toEqual(['kai']);
	});

	it('passes each agent\'s idle time, so a soft keep can lapse after SOFT_KEEP_MAX_IDLE_MS (Ella, 2026-10-19)', async () => {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		const seen: Array<[string, number]> = [];
		let list = [agent('atlas', RESOURCE_MODE_CONSTANTS.SOFT_KEEP_MAX_IDLE_MS + 60_000)];
		svc.setDeps({
			limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }),
			listRunning: async () => list,
			hasOwnerMessage: () => false,
			owesOwnerThread: (n, idleMs) => { seen.push([n, idleMs]); return idleMs < RESOURCE_MODE_CONSTANTS.SOFT_KEEP_MAX_IDLE_MS; },
			stopAgent: async (n) => { stopped.push(n); list = list.filter((r) => r.sessionName !== n); },
		});
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(seen[0]?.[1]).toBeGreaterThanOrEqual(RESOURCE_MODE_CONSTANTS.SOFT_KEEP_MAX_IDLE_MS);
		expect(stopped).toEqual(['atlas']);
	});

	it('never frees a slot from an owing agent: the waiter waits (Pia, 2026-10-12)', async () => {
		const { svc, stopped, told } = makeOwing([agent('atlas', 9e6), agent('busy', 1e5, true)], ['atlas']);
		await enter(svc);
		jest.useFakeTimers();
		try {
			const p = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS + 10);
			expect(await p).toBe(false);
			expect(stopped).toEqual([]);
			expect(told).toEqual([]);
		} finally {
			jest.useRealTimers();
		}
	});

	it('does not evict an owing agent even when the start has waited past the relax limit', async () => {
		const { svc, stopped } = makeOwing([agent('atlas', 9e6)], ['atlas'], 1);
		await enter(svc);
		jest.useFakeTimers();
		try {
			const p = svc.requestStart('new', true);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.RELAX_AFTER_MS + 20_000);
			expect(stopped).toEqual([]);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS);
			expect(await p).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

	it('stops an owing agent only when memory is critical', async () => {
		const { svc, stopped } = makeOwing([agent('atlas', 9e6)], ['atlas'], 1);
		await enter(svc);
		svc.memoryStats = () => ({ ...tight, usedPercent: 97 });
		expect(await svc.requestStart('new', true)).toBe(true);
		expect(stopped).toEqual(['atlas']);
	});

	it('an owner-triggered start takes a non-owing agent and leaves the owing one', async () => {
		const { svc, stopped } = makeOwing([agent('atlas', 9e6), agent('kai', 1e6)], ['atlas']);
		await enter(svc);
		expect(await svc.requestStart('new', true)).toBe(true);
		expect(stopped).toEqual(['kai']);
	});

	it('reports a start that waited for a slot and got none', async () => {
		jest.useFakeTimers();
		try {
			const svc = ResourceModeService.getInstance();
			const deferred: string[] = [];
			svc.setDeps({
				limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }),
				listRunning: async () => [agent('a', 1e6, true)],
				hasOwnerMessage: () => false,
				onStartDeferred: (n) => deferred.push(n),
				stopAgent: async () => undefined,
			});
			svc.memoryStats = () => tight;
			await svc.sample();
			await svc.sample();
			const p = svc.requestStart('nova', false);
			await jest.advanceTimersByTimeAsync(2 * 60_000 + 10);
			expect(await p).toBe(false);
			expect(deferred).toEqual(['nova']);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('idle time counts from when the agent became idle (Pia, 2026-10-12)', () => {
	it('an agent that just turned idle after a silent hour is not "idle for 60 min"', async () => {
		const { svc, stopped } = make([agent('pia', 60 * 60_000), agent('kai', 20 * 60_000)], [], 2);
		await enter(svc);
		svc.noteWorkingStatus('pia', true, Date.now() - 1000);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['kai']);
	});

	it('a busy sighting by the pump also restarts the clock', async () => {
		const svc = ResourceModeService.getInstance();
		const stopped: string[] = [];
		let piaBusy = true;
		svc.setDeps({
			limits: async () => ({ maxRunning: 1, idleTimeoutMinutes: 10 }),
			listRunning: async () => [agent('pia', 60 * 60_000, piaBusy)],
			hasOwnerMessage: () => false,
			stopAgent: async (n) => { stopped.push(n); },
		});
		await enter(svc);
		jest.useFakeTimers();
		try {
			const p = svc.requestStart('new', false);
			await jest.advanceTimersByTimeAsync(1000);
			piaBusy = false;
			await jest.advanceTimersByTimeAsync(10_500);
			expect(stopped).toEqual([]);
			await svc.pump();
			expect(stopped).toEqual([]);
			await jest.advanceTimersByTimeAsync(RESOURCE_MODE_CONSTANTS.START_WAIT_MS);
			expect(await p).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('Drive mode keep-warm (specs/2026-10-09-drive-mode-v3.md §5)', () => {
	afterEach(async () => {
		const { DriveKeepWarm, setDriveKeepWarm } = await import('../drive/drive-keep-warm.js');
		setDriveKeepWarm(new DriveKeepWarm());
	});

	it('never frees a slot from an agent the owner is talking to in Drive mode', async () => {
		const { DriveKeepWarm, setDriveKeepWarm } = await import('../drive/drive-keep-warm.js');
		const warm = new DriveKeepWarm();
		warm.set('drv_abcdefghijkl', ['atlas'], Date.now() + 60_000);
		setDriveKeepWarm(warm);
		const { svc, stopped } = make([agent('atlas', 9e6), agent('kai', 1e6)]);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['kai']);
	});

	it('a warm agent\'s start (owner priority) goes ahead of an ordinary start waiting for a slot', async () => {
		jest.useFakeTimers();
		try {
			let list: RunningAgent[] = [agent('busy1', 1e5, true), agent('busy2', 1e5, true)];
			const svc = ResourceModeService.getInstance();
			svc.setDeps({
				limits: async () => ({ maxRunning: 2, idleTimeoutMinutes: 10 }),
				listRunning: async () => list,
				hasOwnerMessage: () => false,
				stopAgent: async (n) => { list = list.filter((r) => r.sessionName !== n); },
			});
			await enter(svc);
			const order: string[] = [];
			const ordinary = svc.requestStart('ordinary', false).then((ok) => ok && order.push('ordinary'));
			const warm = svc.requestStart('ella', true).then((ok) => ok && order.push('ella'));
			await jest.advanceTimersByTimeAsync(10);
			// One slot frees up: the warm agent gets it.
			list = [agent('busy2', 1e5, true)];
			await svc.sample();
			await jest.advanceTimersByTimeAsync(10);
			expect(order[0]).toBe('ella');
			await jest.advanceTimersByTimeAsync(3 * 60_000);
			await Promise.all([ordinary, warm]);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('settings defaults', () => {
	it('defaults to cap 6 and a 10 minute pressure timeout', () => {
		const g = getDefaultSettings().general;
		expect(g.pressureMaxRunningAgents).toBe(6);
		expect(g.pressureIdleTimeoutMinutes).toBe(10);
		expect(g.agentIdleTimeoutMinutes).toBe(30);
	});
});
