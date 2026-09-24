/**
 * Tests for RestartDrainService.
 */

import { RestartDrainService, resolveRestartDrainMs } from './restart-drain.service.js';
import { InFlightTurnTracker, type TurnProbeResult } from './in-flight-turn-tracker.service.js';
import { SAFE_RESTART } from '../../constants.js';

const mockLogs: { level: string; msg: string; meta?: unknown }[] = [];
jest.mock('../core/logger.service.js', () => ({
	LoggerService: {
		getInstance: () => ({
			createComponentLogger: () => ({
				info: (msg: string, meta?: unknown) => mockLogs.push({ level: 'info', msg, meta }),
				debug: jest.fn(),
				warn: (msg: string, meta?: unknown) => mockLogs.push({ level: 'warn', msg, meta }),
				error: (msg: string, meta?: unknown) => mockLogs.push({ level: 'error', msg, meta }),
			}),
		}),
	},
}));

/** Fake clock driven by the fake sleep. */
function fakeTime(start = 10_000_000): { now: () => number; sleep: (ms: number) => Promise<void>; advance: (ms: number) => void } {
	let t = start;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe('resolveRestartDrainMs', () => {
	it('defaults, honours overrides, and rejects junk', () => {
		expect(resolveRestartDrainMs({})).toBe(SAFE_RESTART.DRAIN_TIMEOUT_MS);
		expect(resolveRestartDrainMs({ [SAFE_RESTART.DRAIN_ENV_VAR]: '0' })).toBe(0);
		expect(resolveRestartDrainMs({ [SAFE_RESTART.DRAIN_ENV_VAR]: '30000' })).toBe(30_000);
		expect(resolveRestartDrainMs({ [SAFE_RESTART.DRAIN_ENV_VAR]: ' ' })).toBe(SAFE_RESTART.DRAIN_TIMEOUT_MS);
		expect(resolveRestartDrainMs({ [SAFE_RESTART.DRAIN_ENV_VAR]: 'abc' })).toBe(SAFE_RESTART.DRAIN_TIMEOUT_MS);
		expect(resolveRestartDrainMs({ [SAFE_RESTART.DRAIN_ENV_VAR]: '-5' })).toBe(SAFE_RESTART.DRAIN_TIMEOUT_MS);
	});
});

describe('RestartDrainService', () => {
	let tracker: InFlightTurnTracker;
	let drain: RestartDrainService;
	let verdicts: Record<string, TurnProbeResult>;

	beforeEach(() => {
		mockLogs.length = 0;
		InFlightTurnTracker.resetInstance();
		RestartDrainService.resetInstance();
		tracker = InFlightTurnTracker.getInstance();
		drain = RestartDrainService.getInstance();
		verdicts = {};
		tracker.setProbe((s) => verdicts[s] ?? 'busy');
	});

	it('pauses delivery once and reports it', () => {
		expect(drain.isDeliveryPaused()).toBe(false);
		drain.pauseDelivery('SIGTERM');
		drain.pauseDelivery('again');
		expect(drain.isDeliveryPaused()).toBe(true);
		expect(mockLogs.filter((l) => l.msg.includes('paused'))).toHaveLength(1);
	});

	it('returns drained immediately when nobody is mid-turn', async () => {
		const clock = fakeTime();
		const result = await drain.drain({ timeoutMs: 120_000, now: clock.now, sleep: clock.sleep });
		expect(result).toEqual({ outcome: 'drained', waitedMs: 0, remaining: [] });
		expect(drain.isDeliveryPaused()).toBe(true);
		expect(drain.isDraining()).toBe(false);
	});

	it('waits until the busy agent finishes, logging who it waits on', async () => {
		const clock = fakeTime();
		tracker.recordDelivery('ella', 'check my To Do', 'pty', clock.now() - 60_000);
		let polls = 0;
		const sleep = async (ms: number): Promise<void> => {
			await clock.sleep(ms);
			polls += 1;
			if (polls === 3) verdicts.ella = 'idle';
		};
		const result = await drain.drain({ timeoutMs: 120_000, pollMs: 2_000, now: clock.now, sleep });
		expect(result.outcome).toBe('drained');
		expect(result.waitedMs).toBe(6_000);
		const waiting = mockLogs.find((l) => l.msg.includes('waiting for agents'));
		expect(JSON.stringify(waiting?.meta)).toContain('ella');
		expect(JSON.stringify(waiting?.meta)).toContain('check my To Do');
	});

	it('times out and returns the turns still in flight', async () => {
		const clock = fakeTime();
		tracker.recordDelivery('ella', 'check my To Do', 'pty', clock.now() - 60_000);
		const result = await drain.drain({ timeoutMs: 10_000, pollMs: 3_000, now: clock.now, sleep: clock.sleep });
		expect(result.outcome).toBe('timed-out');
		expect(result.waitedMs).toBe(10_000);
		expect(result.remaining.map((t) => t.sessionName)).toEqual(['ella']);
		expect(mockLogs.some((l) => l.level === 'warn' && l.msg.includes('timed out'))).toBe(true);
	});

	it('stops waiting when a skip is requested (second signal)', async () => {
		tracker.recordDelivery('ella', 'hello', 'pty', Date.now() - 60_000);
		const pending = drain.drain({ timeoutMs: 120_000, pollMs: 60_000 });
		await Promise.resolve();
		expect(drain.isDraining()).toBe(true);
		expect(drain.requestSkip('second SIGTERM')).toBe(true);
		const result = await pending;
		expect(result.outcome).toBe('skipped');
		expect(result.remaining).toHaveLength(1);
		expect(drain.requestSkip('late')).toBe(false);
	});

	it('does not wait when the timeout is 0, but still reports in-flight turns', async () => {
		tracker.recordDelivery('ella', 'hello', 'pty', Date.now() - 60_000);
		const result = await drain.drain({ timeoutMs: 0 });
		expect(result.outcome).toBe('disabled');
		expect(result.remaining.map((t) => t.sessionName)).toEqual(['ella']);
		expect(drain.isDeliveryPaused()).toBe(true);
	});

	it('reports readiness with busy agents and queued count', () => {
		expect(drain.getReadiness()).toEqual({ safe: true, busyAgents: [], queued: 0, draining: false });
		drain.setQueueCounter(() => 4);
		const since = Date.now() - 60_000;
		tracker.recordDelivery('ella', 'check my To Do', 'pty', since);
		const readiness = drain.getReadiness();
		expect(readiness.safe).toBe(false);
		expect(readiness.queued).toBe(4);
		expect(readiness.busyAgents).toEqual([
			{ session: 'ella', since: new Date(since).toISOString(), messagePreview: 'check my To Do' },
		]);
	});

	it('survives a throwing queue counter', () => {
		drain.setQueueCounter(() => {
			throw new Error('no queue');
		});
		expect(drain.getReadiness().queued).toBe(0);
	});

	it('runs the registered graceful shutdown handler', async () => {
		expect(drain.requestGracefulShutdown({ reason: 'x' })).toBe(false);
		const handler = jest.fn(async () => undefined);
		drain.setShutdownHandler(handler);
		expect(drain.requestGracefulShutdown({ reason: 'api', exitCode: 120 })).toBe(true);
		expect(handler).toHaveBeenCalledWith({ reason: 'api', exitCode: 120 });
	});

	it('logs when the graceful shutdown handler rejects', async () => {
		drain.setShutdownHandler(async () => {
			throw new Error('nope');
		});
		drain.requestGracefulShutdown({ reason: 'api' });
		await new Promise((r) => setImmediate(r));
		expect(mockLogs.some((l) => l.level === 'error' && l.msg.includes('Graceful shutdown handler failed'))).toBe(true);
	});
});
