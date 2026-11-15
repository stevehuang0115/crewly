/**
 * Tests for the `crewly start` startup wait: it lasts while the backend
 * child is alive, ends when the child exits, and a give-up stops the child.
 *
 * @module cli/utils/backend-startup.test
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { hasExited, terminateBackendChild, waitForBackendReady } from './backend-startup.js';
import { SERVER_CONSTANTS } from '../../../config/index.js';

/** A stand-in child process whose exit the test controls. */
function fakeChild(): ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null } {
	const child = new EventEmitter() as ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };
	child.exitCode = null;
	child.signalCode = null;
	return child;
}

/** A clock that only moves when the injected sleep is called. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: () => number } {
	let t = 0;
	return { now: () => t, sleep: async (ms) => void (t += ms), slept: () => t };
}

/** True while a pid exists. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe('waitForBackendReady', () => {
	it('keeps waiting far past the old 30 s limit while the child is alive (loaded machine, 2026-11-13)', async () => {
		const clock = fakeClock();
		let probes = 0;
		// Healthy only after 95 probes, i.e. ~95 s.
		await waitForBackendReady(fakeChild(), { probe: async () => ++probes > 95, now: clock.now, sleep: clock.sleep });
		expect(clock.slept()).toBe(95 * SERVER_CONSTANTS.STARTUP_POLL_INTERVAL_MS);
	});

	it('returns at once when the backend is already healthy', async () => {
		const clock = fakeClock();
		await waitForBackendReady(fakeChild(), { probe: async () => true, now: clock.now, sleep: clock.sleep });
		expect(clock.slept()).toBe(0);
	});

	it('stops as soon as the child exits instead of waiting out the cap', async () => {
		const clock = fakeClock();
		const child = fakeChild();
		let probes = 0;
		const probe = async (): Promise<boolean> => {
			if (++probes === 3) child.exitCode = 1;
			return false;
		};
		await expect(waitForBackendReady(child, { probe, now: clock.now, sleep: clock.sleep })).rejects.toThrow('Backend exited before it was ready (code: 1');
		expect(probes).toBe(3);
	});

	it('gives up at the cap when the child stays alive but never answers', async () => {
		const clock = fakeClock();
		await expect(waitForBackendReady(fakeChild(), { probe: async () => false, now: clock.now, sleep: clock.sleep })).rejects.toThrow(
			'Server failed to start within timeout (600s)',
		);
		expect(clock.slept()).toBe(SERVER_CONSTANTS.STARTUP_MAX_WAIT_MS);
	});

	it('treats a probe that throws as "not ready yet"', async () => {
		const clock = fakeClock();
		let probes = 0;
		const probe = async (): Promise<boolean> => {
			if (++probes < 3) throw new Error('ECONNREFUSED');
			return true;
		};
		await waitForBackendReady(fakeChild(), { probe, now: clock.now, sleep: clock.sleep });
		expect(probes).toBe(3);
	});

	it('the cap is generous: minutes, not the old 30 seconds', () => {
		expect(SERVER_CONSTANTS.STARTUP_MAX_WAIT_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
	});
});

describe('terminateBackendChild', () => {
	it('stops a live child so no orphan is left behind', async () => {
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		const pid = child.pid!;
		expect(isAlive(pid)).toBe(true);
		await terminateBackendChild(child);
		expect(hasExited(child)).toBe(true);
		expect(isAlive(pid)).toBe(false);
	});

	it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
		const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
		await terminateBackendChild(child, 200);
		expect(child.signalCode).toBe('SIGKILL');
		expect(isAlive(child.pid!)).toBe(false);
	});

	it('resolves at once for a child that has already exited', async () => {
		const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
		await new Promise<void>((resolve) => child.once('exit', () => resolve()));
		await terminateBackendChild(child);
		expect(hasExited(child)).toBe(true);
	});
});
