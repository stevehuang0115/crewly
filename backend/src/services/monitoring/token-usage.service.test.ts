// Cache-aware cost fix
/**
 * Tests for TokenUsageService
 *
 * @module services/monitoring/token-usage.service.test
 */

import { TokenUsageService } from './token-usage.service.js';

describe('TokenUsageService', () => {
  let service: TokenUsageService;

  beforeEach(() => {
    TokenUsageService.resetInstance();
    service = new TokenUsageService('/tmp/test-crewly');
  });

  afterEach(() => {
    service.stopPeriodicFlush();
    TokenUsageService.resetInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = TokenUsageService.getInstance();
      const b = TokenUsageService.getInstance();
      expect(a).toBe(b);
      TokenUsageService.resetInstance();
    });

    it('should create new instance after reset', () => {
      const a = TokenUsageService.getInstance();
      TokenUsageService.resetInstance();
      const b = TokenUsageService.getInstance();
      expect(a).not.toBe(b);
      TokenUsageService.resetInstance();
    });
  });

  describe('recordUsage', () => {
    it('should create a new session record on first call', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      expect(service.getSessionCount()).toBe(1);
    });

    it('should accumulate totals for the same session', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-1', 'agent-a', 200, 80, 'claude-opus');

      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].totalInput).toBe(300);
      expect(sessions[0].totalOutput).toBe(130);
      expect(sessions[0].eventCount).toBe(2);
    });

    it('should track separate sessions independently', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      expect(service.getSessionCount()).toBe(2);
      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('getUsageByAgent', () => {
    it('should aggregate across sessions for the same agent', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-a', 200, 80, 'claude-sonnet');

      const summary = service.getUsageByAgent('agent-a');
      expect(summary.totalInput).toBe(300);
      expect(summary.totalOutput).toBe(130);
      expect(summary.eventCount).toBe(2);
    });

    it('should return zeros for unknown agent', () => {
      const summary = service.getUsageByAgent('nonexistent');
      expect(summary.totalInput).toBe(0);
      expect(summary.totalOutput).toBe(0);
      expect(summary.eventCount).toBe(0);
    });

    it('should not include other agents', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      const summary = service.getUsageByAgent('agent-a');
      expect(summary.totalInput).toBe(100);
      expect(summary.totalOutput).toBe(50);
      expect(summary.eventCount).toBe(1);
    });
  });

  describe('getUsageBySessions', () => {
    it('should return empty array when no data', () => {
      const sessions = service.getUsageBySessions();
      expect(sessions).toEqual([]);
    });

    it('should return per-session summaries', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(2);

      const s1 = sessions.find(s => s.sessionName === 'session-1');
      expect(s1).toBeDefined();
      expect(s1!.agentId).toBe('agent-a');
      expect(s1!.totalInput).toBe(100);

      const s2 = sessions.find(s => s.sessionName === 'session-2');
      expect(s2).toBeDefined();
      expect(s2!.agentId).toBe('agent-b');
      expect(s2!.totalOutput).toBe(80);
    });
  });

  describe('getUsageByTask', () => {
    it('should return empty map when no data', () => {
      const taskMap = service.getUsageByTask();
      expect(taskMap.size).toBe(0);
    });

    it('should aggregate by task ID across sessions', () => {
      service.recordUsage('s1', 'a1', 100, 50, 'claude-opus', 'task-1');
      service.recordUsage('s2', 'a2', 200, 80, 'claude-opus', 'task-1');
      service.recordUsage('s1', 'a1', 300, 120, 'claude-opus', 'task-2');
      service.recordUsage('s1', 'a1', 50, 20, 'claude-opus'); // no taskId

      const taskMap = service.getUsageByTask();
      expect(taskMap.size).toBe(3);

      const task1 = taskMap.get('task-1')!;
      expect(task1.totalInput).toBe(300);
      expect(task1.totalOutput).toBe(130);
      expect(task1.eventCount).toBe(2);

      const task2 = taskMap.get('task-2')!;
      expect(task2.totalInput).toBe(300);
      expect(task2.eventCount).toBe(1);

      const unassigned = taskMap.get('unassigned')!;
      expect(unassigned.totalInput).toBe(50);
    });
  });

  describe('resetUsage', () => {
    it('should clear all tracked data', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      service.resetUsage();

      expect(service.getSessionCount()).toBe(0);
      expect(service.getUsageBySessions()).toEqual([]);
    });
  });

  describe('flushToDisk and loadFromDisk', () => {
    it('should round-trip data through disk', async () => {
      const tmpDir = `/tmp/test-crewly-${Date.now()}`;
      const diskService = new TokenUsageService(tmpDir);

      diskService.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      await diskService.flushToDisk();

      const loadService = new TokenUsageService(tmpDir);
      await loadService.loadFromDisk();

      const sessions = loadService.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionName).toBe('session-1');
      expect(sessions[0].totalInput).toBe(100);
    });

    it('should not fail when loading from non-existent file', async () => {
      const loadService = new TokenUsageService('/tmp/nonexistent-dir');
      await expect(loadService.loadFromDisk()).resolves.toBeUndefined();
    });
  });

  describe('periodic flush', () => {
    it('should start and stop without errors', () => {
      service.startPeriodicFlush();
      service.startPeriodicFlush(); // idempotent
      service.stopPeriodicFlush();
      service.stopPeriodicFlush(); // idempotent
    });
  });
});
