/**
 * Tests for the wind-down step before an owner shutdown / restart.
 *
 * @module services/system/wind-down.service.test
 */

import { RestartDrainService } from '../restart/restart-drain.service.js';
import { SAFE_RESTART } from '../../constants.js';
import { WindDownService, buildWindDownNote, resolveGraceSeconds, type WindDownDeps } from './wind-down.service.js';

interface Harness {
	service: WindDownService;
	deps: WindDownDeps;
	clock: { now: number };
	busy: { sessions: string[] };
	delivered: Array<{ session: string; text: string; pausedAtDelivery: boolean }>;
}

function makeHarness(agents: string[], busyAtStart: string[] = []): Harness {
	const clock = { now: Date.parse('2026-10-05T10:00:00Z') };
	const busy = { sessions: [...busyAtStart] };
	const delivered: Harness['delivered'] = [];
	const deps: WindDownDeps = {
		listAgents: () => agents,
		getBusyAgents: () => busy.sessions,
		// What the real delivery path asks while it writes: is delivery paused for me?
		deliver: async (session, text) => {
			delivered.push({ session, text, pausedAtDelivery: RestartDrainService.getInstance().isDeliveryPaused() });
		},
		now: () => clock.now,
		sleep: jest.fn(async (ms: number) => {
			clock.now += ms;
		}),
		logger: { info: jest.fn(), warn: jest.fn() },
	};
	return { service: new WindDownService(deps), deps, clock, busy, delivered };
}

describe('wind-down', () => {
	beforeEach(() => {
		RestartDrainService.resetInstance();
	});

	describe('resolveGraceSeconds', () => {
		it('defaults per kind and clamps to the maximum', () => {
			expect(resolveGraceSeconds('restart', undefined)).toBe(SAFE_RESTART.WIND_DOWN_RESTART_GRACE_SECONDS);
			expect(resolveGraceSeconds('restart', undefined)).toBe(180);
			expect(resolveGraceSeconds('shutdown', undefined)).toBe(300);
			expect(resolveGraceSeconds('shutdown', 99999)).toBe(900);
			expect(resolveGraceSeconds('shutdown', 45.9)).toBe(45);
			expect(resolveGraceSeconds('shutdown', -5)).toBe(300);
			expect(resolveGraceSeconds('shutdown', 'x')).toBe(300);
		});
	});

	describe('buildWindDownNote', () => {
		it('is English, tagged, and tells the agent what to do', () => {
			const note = buildWindDownNote('shutdown', 300);
			expect(note.startsWith('[Crewly wind-down]')).toBe(true);
			expect(note).toContain('shutting down in about 5 minutes');
			expect(note).toMatch(/commit or save your work/);
			expect(note).toMatch(/handover note/);
			expect(note).toMatch(/do not start new long tasks/);
			expect(note).toMatch(/go idle/);
			expect(buildWindDownNote('restart', 180)).toContain('restarting in about 3 minutes');
			expect(buildWindDownNote('restart', 30)).toContain('about 1 minute.');
		});
	});

	it('sends the note to every running agent, the orchestrator included', async () => {
		const h = makeHarness(['crewly-orc', 'dev-1', 'qa-1']);
		await h.service.run({ kind: 'shutdown' });
		expect(h.delivered.map((d) => d.session)).toEqual(['crewly-orc', 'dev-1', 'qa-1']);
		for (const d of h.delivered) expect(d.text).toBe(buildWindDownNote('shutdown', 300));
		expect(h.service.getProgress()).toMatchObject({ kind: 'shutdown', total: 3, notified: ['crewly-orc', 'dev-1', 'qa-1'], phase: 'done', endedBy: 'idle' });
	});

	it('the note passes the delivery pause that holds everything else', async () => {
		const h = makeHarness(['dev-1']);
		const drain = RestartDrainService.getInstance();
		await h.service.run({ kind: 'restart' });
		expect(h.delivered[0].pausedAtDelivery).toBe(false); // the note itself is let through
		expect(drain.isDeliveryPaused()).toBe(true); // everything else is held
	});

	it('holds new work for the duration, and can lift the hold when the action fails', async () => {
		const h = makeHarness(['dev-1'], ['dev-1']);
		const drain = RestartDrainService.getInstance();
		expect(drain.isWindingDown()).toBe(false);
		const run = h.service.run({ kind: 'restart', graceSeconds: 10 });
		await Promise.resolve();
		expect(drain.isWindingDown()).toBe(true);
		expect(drain.isDeliveryPaused()).toBe(true);
		await run;
		expect(drain.isWindingDown()).toBe(true); // stays held until the process exits
		h.service.abort();
		expect(drain.isWindingDown()).toBe(false);
		expect(drain.isDeliveryPaused()).toBe(false);
	});

	it('abort does not lift a pause a real shutdown set', async () => {
		const drain = RestartDrainService.getInstance();
		drain.pauseDelivery('SIGTERM');
		const h = makeHarness(['dev-1']);
		await h.service.run({ kind: 'restart' });
		h.service.abort();
		expect(drain.isDeliveryPaused()).toBe(true);
	});

	it('waits while an agent is busy and ends as soon as all are idle', async () => {
		const h = makeHarness(['dev-1', 'dev-2'], ['dev-1', 'dev-2']);
		let polls = 0;
		(h.deps.sleep as jest.Mock).mockImplementation(async (ms: number) => {
			h.clock.now += ms;
			polls++;
			if (polls === 1) h.busy.sessions = ['dev-2'];
			if (polls === 2) h.busy.sessions = [];
		});
		const ended = await h.service.run({ kind: 'restart', graceSeconds: 180 });
		expect(ended).toBe('idle');
		expect(polls).toBe(2);
		expect(h.clock.now - Date.parse('2026-10-05T10:00:00Z')).toBeLessThan(180_000);
	});

	it('gives up at the grace period when an agent never goes idle', async () => {
		const h = makeHarness(['dev-1'], ['dev-1']);
		const start = h.clock.now;
		const ended = await h.service.run({ kind: 'restart', graceSeconds: 20 });
		expect(ended).toBe('grace');
		expect(h.clock.now - start).toBeGreaterThanOrEqual(20_000);
		expect(h.clock.now - start).toBeLessThan(25_000);
		expect(h.service.getProgress()).toMatchObject({ phase: 'done', endedBy: 'grace', busy: ['dev-1'] });
	});

	it('skip ends the wait at once', async () => {
		const h = makeHarness(['dev-1'], ['dev-1']);
		(h.deps.sleep as jest.Mock).mockImplementation(() => new Promise<void>(() => undefined)); // never wakes by itself
		const run = h.service.run({ kind: 'shutdown' });
		await new Promise((r) => setImmediate(r));
		expect(h.service.skip()).toBe(true);
		await expect(run).resolves.toBe('skipped');
		expect(h.service.skip()).toBe(false); // nothing running any more
	});

	it('carries on when one delivery fails', async () => {
		const h = makeHarness(['a', 'b']);
		(h.deps.deliver as unknown) = jest.fn(async (session: string) => {
			if (session === 'a') throw new Error('pty gone');
		});
		const svc = new WindDownService(h.deps);
		await expect(svc.run({ kind: 'shutdown' })).resolves.toBe('idle');
		expect(svc.getProgress()?.notified).toEqual(['a', 'b']);
		expect(h.deps.logger.warn).toHaveBeenCalled();
	});

	it('with no running agents it finishes immediately', async () => {
		const h = makeHarness([]);
		await expect(h.service.run({ kind: 'shutdown' })).resolves.toBe('no-agents');
	});

	it('hands a busy agent the note at its next tool boundary, once', async () => {
		const h = makeHarness(['dev-1', 'dev-2'], ['dev-1']);
		const seen: Array<string | null> = [];
		(h.deps.sleep as jest.Mock).mockImplementationOnce(async (ms: number) => {
			seen.push(h.service.noteForHook('dev-1'), h.service.noteForHook('dev-1'), h.service.noteForHook('dev-2'));
			h.clock.now += ms;
			h.busy.sessions = [];
		});
		await h.service.run({ kind: 'shutdown' });
		expect(seen[0]).toBe(buildWindDownNote('shutdown', 300));
		expect(seen[1]).toBeNull();
		expect(seen[2]).toBeNull();
		expect(h.service.noteForHook('dev-1')).toBeNull(); // cleared once the wind-down ends
	});
});

describe('RestartDrainService wind-down hold', () => {
	beforeEach(() => RestartDrainService.resetInstance());

	it('runAsWindDownNotice lets only the notice through the pause', async () => {
		const drain = RestartDrainService.getInstance();
		drain.beginWindDown('test');
		expect(drain.isDeliveryPaused()).toBe(true);
		expect(drain.runAsWindDownNotice(() => drain.isDeliveryPaused())).toBe(false);
		await expect(drain.runAsWindDownNotice(async () => { await Promise.resolve(); return drain.isDeliveryPaused(); })).resolves.toBe(false);
		expect(drain.isDeliveryPaused()).toBe(true);
	});
});
