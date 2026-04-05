/**
 * Tests for Token Billing Integration
 *
 * Tests the enhanced TokenUsageService with:
 * - Server-side cost calculation
 * - Per-model breakdown
 * - Task context tracking
 * - taskId filtering
 *
 * @module services/monitoring/token-billing.test
 */

import { TokenUsageService, calculateCost, TOKEN_COSTS } from './token-usage.service.js';

describe('Token Billing Integration', () => {
  let service: TokenUsageService;

  beforeEach(() => {
    TokenUsageService.resetInstance();
    service = new TokenUsageService('/tmp/test-crewly');
  });

  describe('calculateCost', () => {
    it('should calculate cost for known model', () => {
      const cost = calculateCost(1000, 500, 'claude-opus-4-20250514');
      // 1000 * 0.000015 + 500 * 0.000075 = 0.015 + 0.0375 = 0.0525
      expect(cost).toBeCloseTo(0.0525, 4);
    });

    it('should use default rates for unknown model', () => {
      const cost = calculateCost(1000, 500, 'unknown-model');
      const defaultCost = 1000 * TOKEN_COSTS.default.input + 500 * TOKEN_COSTS.default.output;
      expect(cost).toBeCloseTo(defaultCost, 6);
    });

    it('should return 0 for zero tokens', () => {
      expect(calculateCost(0, 0, 'claude-opus-4-20250514')).toBe(0);
    });

    it('should handle Gemini models', () => {
      const cost = calculateCost(10000, 5000, 'gemini-3-flash-preview');
      // 10000 * 0.0000001 + 5000 * 0.0000004 = 0.001 + 0.002 = 0.003
      expect(cost).toBeCloseTo(0.003, 6);
    });
  });

  describe('getUsageBySessions with cost and model breakdown', () => {
    it('should include cost in session summary', () => {
      service.recordUsage('s1', 'agent-a', 1000, 500, 'claude-opus-4-20250514');

      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].cost).toBeCloseTo(0.0525, 4);
    });

    it('should include per-model breakdown', () => {
      service.recordUsage('s1', 'agent-a', 1000, 500, 'claude-opus-4-20250514');
      service.recordUsage('s1', 'agent-a', 2000, 800, 'gemini-3-flash-preview');

      const sessions = service.getUsageBySessions();
      expect(sessions[0].modelBreakdown).toHaveLength(2);

      const opus = sessions[0].modelBreakdown.find(m => m.model === 'claude-opus-4-20250514');
      expect(opus).toBeDefined();
      expect(opus!.inputTokens).toBe(1000);
      expect(opus!.outputTokens).toBe(500);
      expect(opus!.cost).toBeGreaterThan(0);

      const gemini = sessions[0].modelBreakdown.find(m => m.model === 'gemini-3-flash-preview');
      expect(gemini).toBeDefined();
      expect(gemini!.inputTokens).toBe(2000);
    });

    it('should sum costs from all models', () => {
      service.recordUsage('s1', 'agent-a', 1000, 500, 'claude-opus-4-20250514');
      service.recordUsage('s1', 'agent-a', 2000, 800, 'gemini-3-flash-preview');

      const sessions = service.getUsageBySessions();
      const totalFromBreakdown = sessions[0].modelBreakdown.reduce((sum, m) => sum + m.cost, 0);
      expect(sessions[0].cost).toBeCloseTo(totalFromBreakdown, 6);
    });
  });

  describe('taskId tracking', () => {
    it('should record taskId when provided explicitly', () => {
      service.recordUsage('s1', 'agent-a', 100, 50, 'claude-opus-4-20250514', 'task-123');

      const sessions = service.getUsageBySessions('task-123');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].totalInput).toBe(100);
    });

    it('should filter by taskId', () => {
      service.recordUsage('s1', 'agent-a', 100, 50, 'claude-opus-4-20250514', 'task-1');
      service.recordUsage('s1', 'agent-a', 200, 80, 'claude-opus-4-20250514', 'task-2');
      service.recordUsage('s1', 'agent-a', 300, 120, 'claude-opus-4-20250514');

      // Filter for task-1 only
      const task1 = service.getUsageBySessions('task-1');
      expect(task1).toHaveLength(1);
      expect(task1[0].totalInput).toBe(100);
      expect(task1[0].eventCount).toBe(1);

      // Filter for task-2 only
      const task2 = service.getUsageBySessions('task-2');
      expect(task2).toHaveLength(1);
      expect(task2[0].totalInput).toBe(200);

      // No filter — all events
      const all = service.getUsageBySessions();
      expect(all).toHaveLength(1);
      expect(all[0].totalInput).toBe(600);
      expect(all[0].eventCount).toBe(3);
    });

    it('should return empty for unknown taskId', () => {
      service.recordUsage('s1', 'agent-a', 100, 50, 'model', 'task-1');
      const result = service.getUsageBySessions('task-unknown');
      expect(result).toHaveLength(0);
    });
  });

  describe('task context', () => {
    it('should auto-apply task context to recordUsage calls', () => {
      service.setTaskContext('s1', 'task-active');
      service.recordUsage('s1', 'agent-a', 100, 50, 'model');
      service.recordUsage('s1', 'agent-a', 200, 80, 'model');

      const filtered = service.getUsageBySessions('task-active');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].totalInput).toBe(300);
      expect(filtered[0].eventCount).toBe(2);
    });

    it('should clear task context when set to null', () => {
      service.setTaskContext('s1', 'task-active');
      service.recordUsage('s1', 'agent-a', 100, 50, 'model');

      service.setTaskContext('s1', null);
      service.recordUsage('s1', 'agent-a', 200, 80, 'model');

      const filtered = service.getUsageBySessions('task-active');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].totalInput).toBe(100); // Only the first event
    });

    it('should allow explicit taskId to override context', () => {
      service.setTaskContext('s1', 'task-context');
      service.recordUsage('s1', 'agent-a', 100, 50, 'model', 'task-explicit');

      const contextFiltered = service.getUsageBySessions('task-context');
      expect(contextFiltered).toHaveLength(0);

      const explicitFiltered = service.getUsageBySessions('task-explicit');
      expect(explicitFiltered).toHaveLength(1);
    });

    it('should return current task context', () => {
      expect(service.getTaskContext('s1')).toBeNull();
      service.setTaskContext('s1', 'task-1');
      expect(service.getTaskContext('s1')).toBe('task-1');
    });
  });

  describe('TOKEN_COSTS', () => {
    it('should have rates for major Anthropic models', () => {
      expect(TOKEN_COSTS['claude-opus-4-20250514']).toBeDefined();
      expect(TOKEN_COSTS['claude-sonnet-4-20250514']).toBeDefined();
      expect(TOKEN_COSTS['claude-haiku-4-20250506']).toBeDefined();
    });

    it('should have rates for Gemini models', () => {
      expect(TOKEN_COSTS['gemini-3-flash-preview']).toBeDefined();
      expect(TOKEN_COSTS['gemini-2.0-flash']).toBeDefined();
    });

    it('should have rates for OpenAI models', () => {
      expect(TOKEN_COSTS['gpt-4o']).toBeDefined();
      expect(TOKEN_COSTS['gpt-4o-mini']).toBeDefined();
    });

    it('should have default fallback rates', () => {
      expect(TOKEN_COSTS.default).toBeDefined();
      expect(TOKEN_COSTS.default.input).toBeGreaterThan(0);
      expect(TOKEN_COSTS.default.output).toBeGreaterThan(0);
    });
  });
});
