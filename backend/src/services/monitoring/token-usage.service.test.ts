// Cache-aware cost fix
/**
 * Tests for TokenUsageService
 *
 * @module services/monitoring/token-usage.service.test
 */

import { TokenUsageService, cachedIsPartOfInput, calculateCost, dropCrossSessionDuplicates, eventCostUsd, eventTokens } from './token-usage.service.js';
import { calculateCost as cacheAwareCost } from './model-pricing.js';

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

    it('bills DeepSeek cache hits at the hit rate, not the miss rate', () => {
      // 38,532 input of which 32,384 cached, 1 output — the local orc's
      // real smoke-test run. Flat miss pricing said $0.0116; cache-aware
      // pricing is 6,148 × $0.30/M + 32,384 × $0.006/M + 1 × $1.20/M.
      const cost = calculateCost(38_532, 1, 'deepseek/deepseek-chat', 32_384);
      expect(cost).toBeCloseTo(6_148 * 0.0000003 + 32_384 * 0.000000006 + 0.0000012, 9);
      // A model without a cache rate ignores the hint entirely.
      expect(calculateCost(1000, 10, 'claude-3-opus', 900)).toBe(1000 * 0.000015 + 10 * 0.000075);
      // Cached can never exceed input.
      expect(calculateCost(100, 0, 'deepseek/deepseek-chat', 5000)).toBeCloseTo(100 * 0.000000006, 12);
    });

    it('keeps cache-hit and step counts per event and totals cached input (2026-09-18)', () => {
      service.recordUsage('session-1', 'agent-a', 1200, 40, 'deepseek/deepseek-chat', undefined, { cachedInput: 38_000, steps: 3 });
      service.recordUsage('session-1', 'agent-a', 900, 20, 'deepseek/deepseek-chat', undefined, { cachedInput: 39_000, steps: 1 });
      service.recordUsage('session-1', 'agent-a', 100, 5, 'claude-opus'); // no detail → nothing invented

      const [session] = service.getUsageBySessions();
      expect(session.totalInput).toBe(2200);
      expect(session.totalCachedInput).toBe(77_000);
      expect(session.eventCount).toBe(3);
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

  describe('getSessionUsageSince', () => {
    it('prices cache hits at the cached rate (feeds the team budget gate)', () => {
      const since = new Date(Date.now() - 60_000);
      service.recordUsage('session-1', 'agent-a', 38_532, 1, 'deepseek/deepseek-chat', undefined, {
        cachedInput: 32_384,
      });

      const usage = service.getSessionUsageSince('session-1', since);

      expect(usage.inputTokens).toBe(38_532);
      expect(usage.outputTokens).toBe(1);
      expect(usage.cost).toBeCloseTo(calculateCost(38_532, 1, 'deepseek/deepseek-chat', 32_384), 12);
      expect(usage.cost).toBeLessThan(calculateCost(38_532, 1, 'deepseek/deepseek-chat'));
    });

    it('excludes events before the window', () => {
      service.recordUsage('session-1', 'agent-a', 100, 10, 'claude-opus');
      const future = new Date(Date.now() + 60_000);
      expect(service.getSessionUsageSince('session-1', future)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
      });
      expect(service.getSessionUsageSince('missing', future).cost).toBe(0);
    });
  });

  describe('eventCostUsd (the one per-event cost computation)', () => {
    it('prices a Claude transcript turn with its cache reads and writes (fresh input beside them)', () => {
      const cost = eventCostUsd({ input: 10, output: 400, model: 'claude-opus-5-5', cachedInput: 102_000, cacheWrite: 2_000 });
      expect(cost).toBeCloseTo(cacheAwareCost({ input: 10, output: 400, cacheRead: 100_000, cacheWrite: 2_000 }, 'claude-opus-5-5').cost, 12);
    });

    it('prices an in-process DeepSeek run with its cache hits as part of input', () => {
      const e = { input: 70_000, output: 500, model: 'deepseek/deepseek-chat', cachedInput: 60_000 };
      expect(eventCostUsd(e)).toBeCloseTo(calculateCost(70_000, 500, 'deepseek/deepseek-chat', 60_000), 12);
    });

    it('falls back to the legacy table for other models', () => {
      expect(eventCostUsd({ input: 100, output: 10, model: 'gpt-4o' })).toBeCloseTo(calculateCost(100, 10, 'gpt-4o'), 12);
    });

    it('getSessionUsageSince uses it, so a Claude agent\'s cached context is counted', () => {
      const since = new Date(Date.now() - 60_000);
      service.recordUsage('ella', 'ella', 10, 100, 'claude-opus-5-5', undefined, { cachedInput: 600_000 });
      expect(service.getSessionUsageSince('ella', since).cost).toBeGreaterThan(0.85);
    });
  });

  describe('forEachEvent', () => {
    it('visits events at or after `since`, with their session', () => {
      service.recordUsage('a', 'a', 1, 1, 'm', undefined, { timestamp: '2026-10-01T10:00:00.000Z' });
      service.recordUsage('b', 'b', 2, 2, 'm', undefined, { timestamp: '2026-10-02T10:00:00.000Z' });
      const all: string[] = [];
      service.forEachEvent((s) => all.push(s));
      expect(all.sort()).toEqual(['a', 'b']);
      const recent: string[] = [];
      service.forEachEvent((s, e) => recent.push(`${s}:${e.input}`), new Date('2026-10-02T00:00:00.000Z'));
      expect(recent).toEqual(['b:2']);
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

    it('drops turns that were booked to several agents at once, and recomputes their totals', () => {
      // Before the shared-cwd guard, one foreign transcript was booked to
      // five agents; the same turn cannot belong to two of them.
      const shared = { timestamp: '2026-09-21T13:55:34.388Z', agentId: 'x', input: 32, output: 3252, model: 'claude-fable-5-1', cachedInput: 302_168 };
      const own = { timestamp: '2026-09-22T22:31:54.358Z', agentId: 'atlas', input: 32, output: 620, model: 'claude-fable-5-1', cachedInput: 301_194 };
      const records = [
        { sessionName: 'atlas', agentId: 'atlas', totalInput: 96, totalOutput: 10376, eventCount: 3, totalCachedInput: 905_530, events: [shared, { ...shared }, own] },
        { sessionName: 'max', agentId: 'max', totalInput: 32, totalOutput: 3252, eventCount: 1, events: [{ ...shared }] },
      ];

      expect(dropCrossSessionDuplicates(records)).toBe(3);

      expect(records[0].events).toEqual([own]);
      expect(records[0]).toMatchObject({ eventCount: 1, totalInput: 32, totalOutput: 620, totalCachedInput: 301_194 });
      expect(records[1].events).toEqual([]);
    });

    it('leaves a clean ledger untouched', () => {
      const records = [
        { sessionName: 'a', agentId: 'a', totalInput: 1, totalOutput: 1, eventCount: 1, events: [{ timestamp: 't1', agentId: 'a', input: 1, output: 1, model: 'm' }] },
        { sessionName: 'b', agentId: 'b', totalInput: 1, totalOutput: 1, eventCount: 1, events: [{ timestamp: 't2', agentId: 'b', input: 1, output: 1, model: 'm' }] },
      ];
      expect(dropCrossSessionDuplicates(records)).toBe(0);
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

describe('eventTokens — the token unit', () => {
  const Svc = TokenUsageService;

  it('counts cached input once whether it is inside input (in-process) or on top (Claude / Codex / agy)', () => {
    expect(eventTokens({ model: 'deepseek/deepseek-chat', input: 1000, cachedInput: 900, output: 50 })).toEqual({ input: 1000, cachedInput: 900, output: 50, total: 1050 });
    expect(eventTokens({ model: 'claude-opus-5-5', input: 100, cachedInput: 900, output: 50 })).toEqual({ input: 1000, cachedInput: 900, output: 50, total: 1050 });
    expect(eventTokens({ model: 'gpt-6-sol', runtime: 'codex-cli', input: 100, cachedInput: 900, output: 50 }).total).toBe(1050);
    expect(eventTokens({ model: 'antigravity-cli-default', runtime: 'antigravity-cli', input: 12719, output: 169 }).total).toBe(12888);
    expect(cachedIsPartOfInput({ model: 'x', runtime: 'crewly-agent' })).toBe(true);
  });

  it('getSessionUsageSince reports totalTokens and cachedInputTokens; recordUsage keeps the runtime', () => {
    const svc = new Svc('/tmp/token-unit-test-unused');
    svc.recordUsage('nova', 'nova', 100, 50, 'gpt-6-sol', undefined, { cachedInput: 900, runtime: 'codex-cli', timestamp: '2026-10-02T10:00:00.000Z' });
    const u = svc.getSessionUsageSince('nova', new Date('2026-10-02T00:00:00.000Z'));
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 1050, cachedInputTokens: 900 });
    let runtime: string | undefined;
    svc.forEachEvent((_s, e) => {
      runtime = e.runtime;
    });
    expect(runtime).toBe('codex-cli');
  });
});
