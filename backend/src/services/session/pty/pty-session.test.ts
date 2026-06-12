/**
 * Tests for PtySession class
 */

import * as pty from 'node-pty';
import {
	PtySession,
	PtySpawnExhaustedError,
	_setPtySpawnImplForTesting,
} from './pty-session.js';
import type { SessionOptions } from '../session-backend.interface.js';

/** Snapshot the real node-pty spawn so transient-retry tests can
 *  delegate to it after a couple of simulated failures. */
const ORIGINAL_SPAWN = pty.spawn;

/**
 * Minimum-viable IPty stub. The PtySession constructor calls
 * `onData`, `onExit`, and reads `pid` — these are the only members our
 * retry-on-transient test needs. Returning this from the spawn stub
 * keeps the test independent of the real node-pty native binding
 * (which is unavailable in the jest worker env, see jest.config
 * testPathIgnorePatterns for pty-session.test.ts at base).
 */
function makeStubPty(pid = 99999): pty.IPty {
	return {
		pid,
		cols: 80,
		rows: 24,
		process: 'stub',
		handleFlowControl: false,
		onData: () => ({ dispose: () => undefined }),
		onExit: () => ({ dispose: () => undefined }),
		on: () => undefined,
		resize: () => undefined,
		clear: () => undefined,
		write: () => undefined,
		kill: () => undefined,
		pause: () => undefined,
		resume: () => undefined,
	} as unknown as pty.IPty;
}

// Determine the shell to use based on platform
const TEST_SHELL = process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
const TEST_CWD = process.cwd();

/**
 * Create default session options for testing
 */
function createTestOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
	return {
		cwd: TEST_CWD,
		command: TEST_SHELL,
		...overrides,
	};
}

describe('PtySession', () => {
	let session: PtySession | null = null;

	afterEach(() => {
		// Clean up any session after each test
		if (session && !session.isKilled()) {
			session.kill();
		}
		session = null;
	});

	describe('constructor', () => {
		it('should create a session with the given name', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			expect(session.name).toBe('test-session');
		});

		it('should create a session with the given cwd', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			expect(session.cwd).toBe(TEST_CWD);
		});

		it('should spawn a PTY process with a valid PID', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			expect(session.pid).toBeGreaterThan(0);
		});

		it('should accept custom terminal dimensions', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions({
				cols: 120,
				rows: 40,
			}));

			expect(session.pid).toBeGreaterThan(0);
		});

		it('should accept custom environment variables', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions({
				env: { CUSTOM_VAR: 'test-value' },
			}));

			expect(session.pid).toBeGreaterThan(0);
		});

		// Regression: 2026-05-23 incident — node-pty's "posix_spawnp failed"
		// was bubbling up to the user on transient process-table pressure.
		// We now retry up to 4 times with backoff (150/400/1000 ms).
		describe('posix_spawnp retry-on-transient behavior', () => {
			it('retries when pty.spawn throws "posix_spawnp failed" and succeeds on attempt 3', () => {
				let attempts = 0;
				const restoreSpawn = _setPtySpawnImplForTesting(((): pty.IPty => {
					attempts++;
					if (attempts < 3) {
						throw new Error('posix_spawnp failed.');
					}
					// On attempt 3 return a stub IPty — keeps the test
					// independent of the real native binding.
					return makeStubPty();
				}) as typeof pty.spawn);
				try {
					session = new PtySession('retry-success', TEST_CWD, createTestOptions());
					expect(attempts).toBe(3);
					expect(session.pid).toBeGreaterThan(0);
				} finally {
					restoreSpawn();
				}
			});

			it('throws PtySpawnExhaustedError with actionable hint after all 4 attempts fail', () => {
				let attempts = 0;
				const restoreSpawn = _setPtySpawnImplForTesting(
					((/* args */) => {
						attempts++;
						throw new Error('posix_spawnp failed.');
					}) as unknown as Parameters<typeof _setPtySpawnImplForTesting>[0],
				);
				try {
					let caught: unknown;
					try {
						new PtySession('retry-exhausted', TEST_CWD, createTestOptions());
					} catch (err) {
						caught = err;
					}
					expect(caught).toBeInstanceOf(PtySpawnExhaustedError);
					if (caught instanceof PtySpawnExhaustedError) {
						expect(caught.message).toMatch(/PTY spawn failed after 4 attempts/);
						// Either the "near process limit" hint or the generic
						// "transient kernel-level" hint should appear.
						expect(caught.message).toMatch(/process|transient/i);
						expect(caught.diagnostics.attempts).toBe(4);
						expect(caught.diagnostics.lastError).toMatch(/posix_spawnp/);
					}
					expect(attempts).toBe(4);
				} finally {
					restoreSpawn();
				}
			});

			it('does NOT retry on non-transient errors (e.g. ENOENT command not found)', () => {
				let attempts = 0;
				const restoreSpawn = _setPtySpawnImplForTesting(
					((/* args */) => {
						attempts++;
						const err = new Error('spawn /no/such/cmd ENOENT');
						(err as NodeJS.ErrnoException).code = 'ENOENT';
						throw err;
					}) as unknown as Parameters<typeof _setPtySpawnImplForTesting>[0],
				);
				try {
					expect(() => {
						new PtySession(
							'no-retry-on-enoent',
							TEST_CWD,
							createTestOptions({ command: '/no/such/cmd' }),
						);
					}).toThrow(/ENOENT/);
					// 1 attempt, no retries — ENOENT isn't transient.
					expect(attempts).toBe(1);
				} finally {
					restoreSpawn();
				}
			});
		});
	});

	describe('write', () => {
		it('should write data to the session', async () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Should not throw
			expect(() => session!.write('echo hello\n')).not.toThrow();
		});

		it('should throw when writing to a killed session', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());
			session.kill();

			expect(() => session!.write('echo hello\n')).toThrow(
				'Cannot write to killed session test-session'
			);
		});
	});

	describe('onData', () => {
		it('should register a data listener', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const callback = jest.fn();
			const unsubscribe = session.onData(callback);

			expect(typeof unsubscribe).toBe('function');
		});

		it('should return an unsubscribe function', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const callback = jest.fn();
			const unsubscribe = session.onData(callback);

			// Should not throw
			expect(() => unsubscribe()).not.toThrow();
		});

		it('should receive data from the session', (done) => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			let received = false;
			session.onData((data) => {
				if (!received) {
					received = true;
					expect(data.length).toBeGreaterThan(0);
					done();
				}
			});

			// Write a command that produces output
			session.write('echo hello\n');
		}, 10000);

		it('should allow multiple data listeners', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const callback1 = jest.fn();
			const callback2 = jest.fn();

			const unsub1 = session.onData(callback1);
			const unsub2 = session.onData(callback2);

			expect(typeof unsub1).toBe('function');
			expect(typeof unsub2).toBe('function');
		});

		it('should throw when max listeners exceeded', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Register 100 listeners (the maximum)
			for (let i = 0; i < 100; i++) {
				session.onData(() => {});
			}

			// The 101st should throw
			expect(() => session!.onData(() => {})).toThrow(
				'Maximum data listener count (100) exceeded'
			);
		});
	});

	describe('onExit', () => {
		it('should register an exit listener', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const callback = jest.fn();
			const unsubscribe = session.onExit(callback);

			expect(typeof unsubscribe).toBe('function');
		});

		it('should return an unsubscribe function', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const callback = jest.fn();
			const unsubscribe = session.onExit(callback);

			// Should not throw
			expect(() => unsubscribe()).not.toThrow();
		});

		it('should call exit listener when process exits naturally', (done) => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			session.onExit((code) => {
				expect(typeof code).toBe('number');
				done();
			});

			// Send exit command to trigger natural process exit
			setTimeout(() => {
				const exitCommand = process.platform === 'win32'
					? 'exit\r\n'
					: 'exit\n';
				session!.write(exitCommand);
			}, 100);
		}, 10000);

		it('should throw when max listeners exceeded', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Register 50 listeners (the maximum)
			for (let i = 0; i < 50; i++) {
				session.onExit(() => {});
			}

			// The 51st should throw
			expect(() => session!.onExit(() => {})).toThrow(
				'Maximum exit listener count (50) exceeded'
			);
		});
	});

	describe('resize', () => {
		it('should resize the terminal', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Should not throw
			expect(() => session!.resize(120, 40)).not.toThrow();
		});

		it('should throw when resizing a killed session', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());
			session.kill();

			expect(() => session!.resize(120, 40)).toThrow(
				'Cannot resize killed session test-session'
			);
		});
	});

	describe('kill', () => {
		it('should kill the session', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Should not throw
			expect(() => session!.kill()).not.toThrow();
			expect(session.isKilled()).toBe(true);
		});

		it('should be idempotent (can be called multiple times)', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			session.kill();
			session.kill();
			session.kill();

			expect(session.isKilled()).toBe(true);
		});

		it('should clear all listeners', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const dataCallback = jest.fn();
			const exitCallback = jest.fn();

			session.onData(dataCallback);
			session.onExit(exitCallback);

			session.kill();

			expect(session.isKilled()).toBe(true);
		});

		it('should accept a signal parameter', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Should not throw when passing a signal
			expect(() => session!.kill('SIGTERM')).not.toThrow();
			expect(session.isKilled()).toBe(true);
		});

		it('should accept SIGKILL as a signal', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			expect(() => session!.kill('SIGKILL')).not.toThrow();
			expect(session.isKilled()).toBe(true);
		});
	});

	describe('forceKill', () => {
		it('should force-kill the session', async () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			await session.forceKill();
			expect(session.isKilled()).toBe(true);
		});

		it('should not throw if process is already dead', async () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			// Kill normally first, then force-kill should still work
			session.kill();
			await expect(session.forceKill()).resolves.toBeUndefined();
		});

		it('should clear all listeners', async () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			const dataCallback = jest.fn();
			const exitCallback = jest.fn();

			session.onData(dataCallback);
			session.onExit(exitCallback);

			await session.forceKill();
			expect(session.isKilled()).toBe(true);
		});
	});

	describe('isKilled', () => {
		it('should return false for new session', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());

			expect(session.isKilled()).toBe(false);
		});

		it('should return true after kill()', () => {
			session = new PtySession('test-session', TEST_CWD, createTestOptions());
			session.kill();

			expect(session.isKilled()).toBe(true);
		});
	});

	describe('closePty — PTY file-descriptor release (FD-leak fix)', () => {
		/**
		 * Stub IPty that records calls to `destroy` (the node-pty Unix method that
		 * closes the master fd socket). Injected via the spawn seam so no real PTY
		 * is created and the FD-close path can be asserted directly.
		 */
		function makeDestroyTrackingPty(): {
			ipty: pty.IPty;
			killCalls: number;
			destroyCalls: number;
		} {
			const state = { killCalls: 0, destroyCalls: 0 };
			const ipty = {
				pid: 99999,
				cols: 80,
				rows: 24,
				process: 'stub',
				handleFlowControl: false,
				onData: () => ({ dispose: () => undefined }),
				onExit: () => ({ dispose: () => undefined }),
				on: () => undefined,
				resize: () => undefined,
				clear: () => undefined,
				write: () => undefined,
				kill: () => {
					state.killCalls++;
				},
				destroy: () => {
					state.destroyCalls++;
				},
				pause: () => undefined,
				resume: () => undefined,
			} as unknown as pty.IPty;
			return {
				ipty,
				get killCalls() {
					return state.killCalls;
				},
				get destroyCalls() {
					return state.destroyCalls;
				},
			};
		}

		it('kill() releases the fd via node-pty destroy()', () => {
			const tracker = makeDestroyTrackingPty();
			const restore = _setPtySpawnImplForTesting(
				(() => tracker.ipty) as unknown as Parameters<typeof _setPtySpawnImplForTesting>[0],
			);
			try {
				session = new PtySession('fd-kill', TEST_CWD, createTestOptions());
				session.kill();
				expect(tracker.killCalls).toBeGreaterThanOrEqual(1);
				expect(tracker.destroyCalls).toBe(1);
			} finally {
				restore();
			}
		});

		it('closePty() is idempotent — destroy() called at most once', () => {
			const tracker = makeDestroyTrackingPty();
			const restore = _setPtySpawnImplForTesting(
				(() => tracker.ipty) as unknown as Parameters<typeof _setPtySpawnImplForTesting>[0],
			);
			try {
				session = new PtySession('fd-idem', TEST_CWD, createTestOptions());
				session.closePty();
				session.closePty();
				expect(tracker.destroyCalls).toBe(1);
			} finally {
				restore();
			}
		});
	});
});

describe('PtySession integration', () => {
	let session: PtySession | null = null;

	afterEach(() => {
		if (session && !session.isKilled()) {
			session.kill();
		}
		session = null;
	});

	it('should execute a command and receive output', (done) => {
		session = new PtySession('test-session', TEST_CWD, createTestOptions());

		let outputBuffer = '';
		session.onData((data) => {
			outputBuffer += data;
			// Look for our test string in the output
			if (outputBuffer.includes('CREWLY_TEST_123')) {
				expect(outputBuffer).toContain('CREWLY_TEST_123');
				done();
			}
		});

		// Use a command that works on both Unix and Windows
		const command = process.platform === 'win32'
			? 'Write-Host "CREWLY_TEST_123"\r\n'
			: 'echo "CREWLY_TEST_123"\n';

		setTimeout(() => {
			session!.write(command);
		}, 500);
	}, 15000);

	it('should handle special characters', (done) => {
		session = new PtySession('test-session', TEST_CWD, createTestOptions());

		let outputBuffer = '';
		session.onData((data) => {
			outputBuffer += data;
			if (outputBuffer.includes('special')) {
				done();
			}
		});

		const command = process.platform === 'win32'
			? 'Write-Host "special"\r\n'
			: 'echo "special"\n';

		setTimeout(() => {
			session!.write(command);
		}, 500);
	}, 15000);

	describe('isChildProcessAlive', () => {
		it('should return true when shell has child processes', async () => {
			// A fresh shell session should have at least a login shell child
			session = new PtySession('test-child', TEST_CWD, createTestOptions());

			// Start a long-running child process inside the shell
			session.write('sleep 60 &\n');
			// Wait for the command to spawn
			await new Promise((r) => setTimeout(r, 500));

			expect(session.isChildProcessAlive()).toBe(true);
		}, 10000);

		it('should return false after session is killed', () => {
			session = new PtySession('test-child-killed', TEST_CWD, createTestOptions());
			session.kill();

			expect(session.isChildProcessAlive()).toBe(false);
		});
	});
});
