jest.mock('../core/logger.service.js', () => ({
	LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }) },
}));
jest.mock('../core/system-health.util.js', () => ({ getMemoryStats: () => ({ usedPercent: 10, freeMB: 9000, totalMB: 16384 }) }));

import { ResourceModeService, memoryIsTightFor, type RunningAgent } from './resource-mode.service.js';
import { getDefaultSettings } from '../../types/settings.types.js';

const calm = { usedPercent: 40, freeMB: 8000, totalMB: 16384 };
const tight = { usedPercent: 60, freeMB: 8000, totalMB: 16384, swapUsedPercent: 93 };

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

	it('memoryIsTightFor uses swap and OS pressure', () => {
		expect(memoryIsTightFor(calm)).toBe(false);
		expect(memoryIsTightFor({ ...calm, pressureElevated: true })).toBe(true);
		expect(memoryIsTightFor(tight)).toBe(true);
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
			[agent('long-busy', 9e6, true), agent('long-owner', 8e6), agent('mid', 5e5), agent('short', 1e5), { sessionName: 'orc', role: 'orchestrator', idleMs: 1e9, busy: false }],
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
		const { svc, stopped, told } = makeOwing([agent('atlas', 9e6), agent('kai', 1e5)], ['atlas']);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['kai']);
		expect(told).toEqual(['kai']);
	});

	it('still frees a slot from an owing agent when it is the only candidate', async () => {
		const { svc, stopped, told } = makeOwing([agent('atlas', 9e6), agent('busy', 1e5, true)], ['atlas']);
		await enter(svc);
		expect(await svc.requestStart('new', false)).toBe(true);
		expect(stopped).toEqual(['atlas']);
		expect(told).toEqual(['atlas']);
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
		const { svc, stopped } = make([agent('atlas', 9e6), agent('kai', 1e5)]);
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
