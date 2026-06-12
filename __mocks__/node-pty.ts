/**
 * Manual mock for node-pty native module.
 *
 * Provides a fake IPty-compatible object so test suites that
 * transitively import node-pty don't fail with native-binary
 * architecture mismatches (arm64 vs x86_64).
 *
 * The fake implements the full surface `PtySession` touches —
 * `onData`/`onExit` (node-pty IEvent functions returning an
 * `IDisposable`), `kill`, and `destroy` — so PTY-lifecycle tests can
 * assert teardown/FD-close behaviour WITHOUT spawning a real PTY.
 * `destroy` is the node-pty Unix method that closes the master fd
 * socket; the FD-leak fix routes through it, so the mock exposes it as
 * a `jest.fn()` for assertions.
 *
 * @module __mocks__/node-pty
 */

import { EventEmitter } from 'events';

/**
 * Every mock IPty produced by {@link spawn}, in creation order. Tests read the
 * tail to assert kill/destroy (FD-close) behaviour without a spawn jest.fn().
 * Call {@link __resetSpawnedMockPtys} in a beforeEach to isolate suites.
 */
export const __spawnedMockPtys: MockIPty[] = [];

/** Clear the recorded mock-IPty list (test isolation helper). */
export function __resetSpawnedMockPtys(): void {
	__spawnedMockPtys.length = 0;
}

/**
 * Listener registered via the node-pty IEvent functions. Stored so a test
 * can drive `onExit`/`onData` callbacks to simulate a natural process exit.
 */
type MockListener<T> = (arg: T) => void;

/**
 * Shape of the mock IPty returned by {@link spawn}. Extends EventEmitter for
 * backward compatibility with existing callers while adding the node-pty
 * IEvent + lifecycle members `PtySession` actually uses.
 */
export interface MockIPty extends EventEmitter {
  pid: number;
  cols: number;
  rows: number;
  process: string;
  handleFlowControl: boolean;
  write: jest.Mock;
  resize: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  kill: jest.Mock;
  clear: jest.Mock;
  /** Unix-only fd-closing method the FD-leak fix calls. */
  destroy: jest.Mock;
  onData: (cb: MockListener<string>) => { dispose: () => void };
  onExit: (cb: MockListener<{ exitCode: number; signal?: number }>) => {
    dispose: () => void;
  };
  /** Test helper: invoke all registered onExit listeners to simulate exit. */
  emitExit: (exitCode: number, signal?: number) => void;
  /** Test helper: invoke all registered onData listeners. */
  emitData: (data: string) => void;
}

/**
 * Create a fake IPty instance backed by an EventEmitter.
 *
 * @param file - Shell command (ignored in mock)
 * @param args - Shell arguments (ignored in mock)
 * @param options - Spawn options (ignored in mock)
 * @returns Mock IPty-like object with jest.fn() lifecycle members
 */
export function spawn(
  file: string,
  args: string[],
  options?: Record<string, unknown>,
): MockIPty {
  const ee = new EventEmitter() as MockIPty;
  const dataListeners = new Set<MockListener<string>>();
  const exitListeners = new Set<
    MockListener<{ exitCode: number; signal?: number }>
  >();

  ee.pid = 99999;
  ee.cols = (options?.cols as number) ?? 80;
  ee.rows = (options?.rows as number) ?? 24;
  ee.process = file;
  ee.handleFlowControl = false;
  ee.write = jest.fn();
  ee.resize = jest.fn();
  ee.pause = jest.fn();
  ee.resume = jest.fn();
  ee.kill = jest.fn();
  ee.clear = jest.fn();
  ee.destroy = jest.fn();

  ee.onData = (cb: MockListener<string>) => {
    dataListeners.add(cb);
    return { dispose: () => dataListeners.delete(cb) };
  };
  ee.onExit = (cb: MockListener<{ exitCode: number; signal?: number }>) => {
    exitListeners.add(cb);
    return { dispose: () => exitListeners.delete(cb) };
  };

  ee.emitExit = (exitCode: number, signal?: number) => {
    for (const cb of [...exitListeners]) {
      cb({ exitCode, signal });
    }
  };
  ee.emitData = (data: string) => {
    for (const cb of [...dataListeners]) {
      cb(data);
    }
  };

  __spawnedMockPtys.push(ee);
  return ee;
}
