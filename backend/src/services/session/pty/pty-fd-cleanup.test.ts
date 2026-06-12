/**
 * PTY file-descriptor cleanup tests.
 *
 * These tests pin the FD-leak fix: every session-end path must release the
 * node-pty master/slave file descriptors (via `PtySession.closePty()` →
 * node-pty `destroy()`), centralized teardown must be idempotent, the orphan
 * reaper must reap dead-but-still-registered sessions while leaving live ones
 * alone, and the sessionName→PtySession registry must add/remove correctly.
 *
 * node-pty is mocked globally (jest.config moduleNameMapper → __mocks__/node-pty),
 * so NO real PTY is ever spawned. The mock exposes `kill` and `destroy` as
 * jest.fn()s plus `emitExit()` to simulate a natural process exit.
 *
 * @module pty-fd-cleanup.test
 */

import { PtySession } from './pty-session.js';
import { PtySessionBackend } from './pty-session-backend.js';
import { RuntimePidRegistry } from '../runtime-pid-registry.service.js';
import type { SessionOptions } from '../session-backend.interface.js';
import {
	__spawnedMockPtys,
	__resetSpawnedMockPtys,
	type MockIPty,
} from '../../../../../__mocks__/node-pty.js';
import { PTY_CONSTANTS } from '../../../constants.js';

/** Build default options for a mocked session (command/cwd are ignored by the mock). */
function createTestOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
	return {
		cwd: '/tmp',
		command: '/bin/bash',
		...overrides,
	};
}

/**
 * Retrieve the underlying mock IPty for the most recently spawned PtySession.
 * Tests use this to assert kill/destroy (FD-close) calls on the mock.
 */
function lastSpawnedMockPty(): MockIPty {
	return __spawnedMockPtys[__spawnedMockPtys.length - 1];
}

describe('PTY FD cleanup', () => {
	beforeEach(() => {
		__resetSpawnedMockPtys();
		// Point the persistent orphan-PID registry at an isolated temp file so
		// teardown's RuntimePidRegistry.remove() doesn't touch the real one.
		RuntimePidRegistry.resetForTesting({
			filePath: `/tmp/pty-fd-cleanup-${process.pid}-${Date.now()}.json`,
			cmdlineReader: () => null,
		});
	});

	describe('PtySession.closePty — releases the node-pty master/slave FDs', () => {
		it('calls node-pty destroy() to close the PTY fd', () => {
			const session = new PtySession('s1', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			session.closePty();

			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('is idempotent — destroy() is only called once across repeated closePty()', () => {
			const session = new PtySession('s2', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			session.closePty();
			session.closePty();
			session.closePty();

			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('does not throw when node-pty destroy() throws (already-closed fd)', () => {
			const session = new PtySession('s3', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();
			mock.destroy.mockImplementation(() => {
				throw new Error('socket already destroyed');
			});

			expect(() => session.closePty()).not.toThrow();
		});
	});

	describe('PtySession end paths all release the FD', () => {
		it('kill() closes the PTY fd (stop/terminate path)', () => {
			const session = new PtySession('kill-path', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			session.kill();

			expect(mock.kill).toHaveBeenCalled();
			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('forceKill() closes the PTY fd (idle-exit/dropout/force path)', async () => {
			const session = new PtySession('force-path', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			await session.forceKill();

			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('natural exit (crash/dropout) closes the PTY fd via onExit', () => {
			const session = new PtySession('exit-path', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			// Simulate the shell exiting on its own.
			mock.emitExit(0);

			expect(session.isKilled()).toBe(true);
			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('kill() after natural exit does not double-close the fd', () => {
			const session = new PtySession('exit-then-kill', '/tmp', createTestOptions());
			const mock = lastSpawnedMockPty();

			mock.emitExit(0); // fd closed here
			session.kill(); // no-op: already killed

			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});
	});

	describe('PtySessionBackend centralized teardown + registry', () => {
		let backend: PtySessionBackend;

		afterEach(async () => {
			await backend.destroy();
		});

		it('killSession routes through centralized teardown: closes fd + removes from registry', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('agent-a', createTestOptions());
			const mock = lastSpawnedMockPty();

			expect(backend.sessionExists('agent-a')).toBe(true);

			await backend.killSession('agent-a');

			expect(backend.sessionExists('agent-a')).toBe(false);
			expect(backend.getSession('agent-a')).toBeUndefined();
			expect(mock.destroy).toHaveBeenCalledTimes(1);
		});

		it('killSession is idempotent — safe to call twice', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('agent-b', createTestOptions());

			await backend.killSession('agent-b');
			await expect(backend.killSession('agent-b')).resolves.toBeUndefined();

			expect(backend.sessionExists('agent-b')).toBe(false);
		});

		it('registry add/remove tracking is reflected in getSessionCount', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('one', createTestOptions());
			await backend.createSession('two', createTestOptions());
			expect(backend.getSessionCount()).toBe(2);

			await backend.killSession('one');
			expect(backend.getSessionCount()).toBe(1);
			expect(backend.listSessions()).toEqual(['two']);
		});
	});

	describe('Orphan reaper', () => {
		let backend: PtySessionBackend;

		afterEach(async () => {
			await backend.destroy();
		});

		it('reaps a dead-but-still-registered session and closes its fd', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('orphan', createTestOptions());
			const mock = lastSpawnedMockPty();

			// Simulate the shell dying WITHOUT routing through teardown — the exact
			// leak shape. onExit marks the session killed but it stays in the map.
			mock.emitExit(137);
			expect(backend.sessionExists('orphan')).toBe(true);
			const destroyCallsBeforeReap = mock.destroy.mock.calls.length;

			const reaped = await backend.reapOrphanPtys();

			expect(reaped).toBe(1);
			expect(backend.sessionExists('orphan')).toBe(false);
			// closePty is idempotent, so destroy total stays at 1 even after reap.
			expect(mock.destroy.mock.calls.length).toBe(destroyCallsBeforeReap);
		});

		it('leaves active (living) sessions untouched', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('alive', createTestOptions());

			const reaped = await backend.reapOrphanPtys();

			expect(reaped).toBe(0);
			expect(backend.sessionExists('alive')).toBe(true);
		});

		it('reaps only the dead session in a mixed set', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('dead', createTestOptions());
			const deadMock = lastSpawnedMockPty();
			await backend.createSession('live', createTestOptions());

			deadMock.emitExit(0);

			const reaped = await backend.reapOrphanPtys();

			expect(reaped).toBe(1);
			expect(backend.sessionExists('dead')).toBe(false);
			expect(backend.sessionExists('live')).toBe(true);
		});
	});

	describe('PTY diagnostics (observability)', () => {
		let backend: PtySessionBackend;

		afterEach(async () => {
			await backend.destroy();
		});

		it('reports registry occupancy split into active vs dead', async () => {
			backend = new PtySessionBackend();
			await backend.createSession('a1', createTestOptions());
			const deadMock = lastSpawnedMockPty();
			await backend.createSession('a2', createTestOptions());

			deadMock.emitExit(0); // a1 now dead-but-registered

			const d = backend.getPtyDiagnostics();
			expect(d.registrySize).toBe(2);
			expect(d.activeSessions).toBe(1);
			expect(d.deadSessions).toBe(1);
			// openFileCount is environment-dependent: a number or null, never throws.
			expect(d.openFileCount === null || typeof d.openFileCount === 'number').toBe(true);
		});
	});

	describe('reaper cadence constant', () => {
		it('uses a non-hardcoded interval from PTY_CONSTANTS', () => {
			expect(PTY_CONSTANTS.ORPHAN_REAPER_INTERVAL_MS).toBeGreaterThan(0);
		});
	});
});
