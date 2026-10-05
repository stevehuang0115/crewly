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

describe('settings defaults', () => {
	it('defaults to cap 6 and a 10 minute pressure timeout', () => {
		const g = getDefaultSettings().general;
		expect(g.pressureMaxRunningAgents).toBe(6);
		expect(g.pressureIdleTimeoutMinutes).toBe(10);
		expect(g.agentIdleTimeoutMinutes).toBe(30);
	});
});
