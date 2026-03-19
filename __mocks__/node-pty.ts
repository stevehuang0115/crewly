/**
 * Manual mock for node-pty native module.
 *
 * Provides a fake IPty-compatible object so test suites that
 * transitively import node-pty don't fail with native-binary
 * architecture mismatches (arm64 vs x86_64).
 *
 * @module __mocks__/node-pty
 */

import { EventEmitter } from 'events';

/**
 * Create a fake IPty instance backed by an EventEmitter.
 *
 * @param file - Shell command (ignored in mock)
 * @param args - Shell arguments (ignored in mock)
 * @param options - Spawn options (ignored in mock)
 * @returns Mock IPty-like object
 */
export function spawn(
  file: string,
  args: string[],
  options?: Record<string, unknown>,
): Record<string, unknown> & EventEmitter {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  ee.pid = 99999;
  ee.cols = options?.cols ?? 80;
  ee.rows = options?.rows ?? 24;
  ee.process = file;
  ee.handleFlowControl = false;
  ee.write = jest.fn();
  ee.resize = jest.fn();
  ee.pause = jest.fn();
  ee.resume = jest.fn();
  ee.kill = jest.fn();
  ee.clear = jest.fn();
  return ee;
}
