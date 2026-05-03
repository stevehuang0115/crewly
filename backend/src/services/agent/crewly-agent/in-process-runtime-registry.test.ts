/**
 * In-Process Runtime Registry tests
 *
 * @module services/agent/crewly-agent/in-process-runtime-registry.test
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  registerInProcessRuntime,
  unregisterInProcessRuntime,
  getInProcessRuntime,
  isInProcessRuntimeActive,
  _resetInProcessRuntimeRegistryForTesting,
  _getInProcessRuntimeRegistrySize,
} from './in-process-runtime-registry.js';
import type { CrewlyAgentRuntimeService } from './crewly-agent-runtime.service.js';

/**
 * Build a minimal CrewlyAgentRuntimeService stub for registry tests.
 *
 * @param ready - Value `isReady()` should return
 * @param throws - When true, `isReady()` throws an error to exercise the
 *                 defensive try/catch path
 */
function makeFakeRuntime(ready: boolean, throws = false): CrewlyAgentRuntimeService {
  return {
    isReady: () => {
      if (throws) {
        throw new Error('boom');
      }
      return ready;
    },
  } as unknown as CrewlyAgentRuntimeService;
}

describe('in-process-runtime-registry', () => {
  beforeEach(() => {
    _resetInProcessRuntimeRegistryForTesting();
  });

  describe('registerInProcessRuntime', () => {
    it('stores a runtime under its session name', () => {
      const runtime = makeFakeRuntime(true);
      registerInProcessRuntime('crewly-orc', runtime);

      expect(getInProcessRuntime('crewly-orc')).toBe(runtime);
      expect(_getInProcessRuntimeRegistrySize()).toBe(1);
    });

    it('replaces an existing entry when called twice for the same session', () => {
      const first = makeFakeRuntime(true);
      const second = makeFakeRuntime(true);
      registerInProcessRuntime('crewly-orc', first);
      registerInProcessRuntime('crewly-orc', second);

      expect(getInProcessRuntime('crewly-orc')).toBe(second);
      expect(_getInProcessRuntimeRegistrySize()).toBe(1);
    });
  });

  describe('unregisterInProcessRuntime', () => {
    it('removes a registered runtime and returns true', () => {
      registerInProcessRuntime('crewly-orc', makeFakeRuntime(true));
      const removed = unregisterInProcessRuntime('crewly-orc');
      expect(removed).toBe(true);
      expect(getInProcessRuntime('crewly-orc')).toBeUndefined();
    });

    it('returns false when the session is not registered', () => {
      expect(unregisterInProcessRuntime('does-not-exist')).toBe(false);
    });
  });

  describe('isInProcessRuntimeActive', () => {
    it('returns false when no runtime is registered', () => {
      expect(isInProcessRuntimeActive('crewly-orc')).toBe(false);
    });

    it('returns true when the runtime reports ready', () => {
      registerInProcessRuntime('crewly-orc', makeFakeRuntime(true));
      expect(isInProcessRuntimeActive('crewly-orc')).toBe(true);
    });

    it('returns false when the runtime reports not ready', () => {
      registerInProcessRuntime('crewly-orc', makeFakeRuntime(false));
      expect(isInProcessRuntimeActive('crewly-orc')).toBe(false);
    });

    it('returns false when isReady throws (defensive)', () => {
      registerInProcessRuntime('crewly-orc', makeFakeRuntime(true, true));
      expect(isInProcessRuntimeActive('crewly-orc')).toBe(false);
    });
  });

  describe('_resetInProcessRuntimeRegistryForTesting', () => {
    it('clears every registered runtime', () => {
      registerInProcessRuntime('a', makeFakeRuntime(true));
      registerInProcessRuntime('b', makeFakeRuntime(true));
      expect(_getInProcessRuntimeRegistrySize()).toBe(2);

      _resetInProcessRuntimeRegistryForTesting();
      expect(_getInProcessRuntimeRegistrySize()).toBe(0);
      expect(getInProcessRuntime('a')).toBeUndefined();
      expect(getInProcessRuntime('b')).toBeUndefined();
    });
  });
});
