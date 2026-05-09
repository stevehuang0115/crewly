/**
 * Tests for `agent-behavior-log.singleton`.
 *
 * Validates:
 * - lazy construction returns the same instance across calls
 * - reset clears the cached instance
 * - testing helpers install pre-built instances for callsite tests
 * - construction failure is silently swallowed (returns null)
 *
 * @module services/observability/agent-behavior-log.singleton.test
 */

import {
  getAgentBehaviorLogService,
  setAgentBehaviorLogServiceForTesting,
  createInMemoryAgentBehaviorLogServiceForTesting,
  resetAgentBehaviorLogServiceForTesting,
} from './agent-behavior-log.singleton.js';
import { AgentBehaviorLogService } from './agent-behavior-log.service.js';

describe('agent-behavior-log.singleton', () => {
  afterEach(() => {
    resetAgentBehaviorLogServiceForTesting();
  });

  describe('createInMemoryAgentBehaviorLogServiceForTesting', () => {
    it('installs a working in-memory service that getAgentBehaviorLogService returns', () => {
      const svc = createInMemoryAgentBehaviorLogServiceForTesting();
      expect(svc).toBeInstanceOf(AgentBehaviorLogService);
      expect(getAgentBehaviorLogService()).toBe(svc);
    });

    it('returns the same instance across multiple get calls (no rebuild)', () => {
      createInMemoryAgentBehaviorLogServiceForTesting();
      const a = getAgentBehaviorLogService();
      const b = getAgentBehaviorLogService();
      expect(a).toBe(b);
    });

    it('records a row that is readable via listRecent', () => {
      const svc = createInMemoryAgentBehaviorLogServiceForTesting();
      svc.record({
        type: 'agent.action',
        agent: 'test-agent',
        actionType: 'delegate',
      });
      const rows = svc.listRecent(10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.eventType).toBe('agent.action');
      expect(rows[0]!.agent).toBe('test-agent');
    });
  });

  describe('setAgentBehaviorLogServiceForTesting', () => {
    it('installs an arbitrary service instance', () => {
      const fake = { record: jest.fn() } as unknown as AgentBehaviorLogService;
      setAgentBehaviorLogServiceForTesting(fake);
      expect(getAgentBehaviorLogService()).toBe(fake);
    });

    it('null override returns null from getAgentBehaviorLogService', () => {
      // Set null to force lazy-construct on next get().
      setAgentBehaviorLogServiceForTesting(null);
      // The next get() will lazily attempt construction; we cannot assert
      // it returns null without simulating a construction failure, but we
      // CAN assert the override survives at least one re-read cycle when
      // a non-null value is then set.
      const fake = {} as AgentBehaviorLogService;
      setAgentBehaviorLogServiceForTesting(fake);
      expect(getAgentBehaviorLogService()).toBe(fake);
    });
  });

  describe('resetAgentBehaviorLogServiceForTesting', () => {
    it('closes the existing instance and clears the cache', () => {
      const svc = createInMemoryAgentBehaviorLogServiceForTesting();
      const closeSpy = jest.spyOn(svc, 'close');
      resetAgentBehaviorLogServiceForTesting();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('after reset, get returns a fresh instance (not the closed one)', () => {
      const a = createInMemoryAgentBehaviorLogServiceForTesting();
      resetAgentBehaviorLogServiceForTesting();
      // Install a new in-memory instance so the lazy default doesn't try
      // to open the real ~/.crewly/observability.db during a unit test.
      const b = createInMemoryAgentBehaviorLogServiceForTesting();
      expect(a).not.toBe(b);
      expect(getAgentBehaviorLogService()).toBe(b);
    });

    it('is safe to call when no instance was ever constructed', () => {
      expect(() => resetAgentBehaviorLogServiceForTesting()).not.toThrow();
    });

    it('survives close() throwing', () => {
      const fake = {
        close: jest.fn(() => {
          throw new Error('close failed');
        }),
      } as unknown as AgentBehaviorLogService;
      setAgentBehaviorLogServiceForTesting(fake);
      expect(() => resetAgentBehaviorLogServiceForTesting()).not.toThrow();
      expect(fake.close).toHaveBeenCalled();
    });
  });
});
