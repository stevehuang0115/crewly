/**
 * Monitoring Types Tests
 *
 * Validates type structures and guards for monitoring types.
 *
 * @module types/monitoring.types.test
 */

import { describe, it, expect } from 'vitest';
import type {
  SessionUsageSummary,
  BudgetConfig,
  TokenCostRate,
  AgentCostEntry,
} from './monitoring.types';

describe('monitoring types', () => {
  it('should accept valid SessionUsageSummary', () => {
    const summary: SessionUsageSummary = {
      sessionName: 'agent-session-1',
      agentId: 'agent-001',
      totalInput: 1000,
      totalOutput: 500,
      eventCount: 3,
    };

    expect(summary.sessionName).toBe('agent-session-1');
    expect(summary.totalInput).toBe(1000);
    expect(summary.totalOutput).toBe(500);
    expect(summary.eventCount).toBe(3);
  });

  it('should accept valid BudgetConfig', () => {
    const config: BudgetConfig = {
      dailyLimit: 50,
      weeklyLimit: 200,
      monthlyLimit: 500,
      maxTokensPerTask: 100000,
      warningThreshold: 80,
    };

    expect(config.dailyLimit).toBe(50);
    expect(config.warningThreshold).toBe(80);
  });

  it('should accept valid TokenCostRate', () => {
    const rate: TokenCostRate = {
      input: 0.000003,
      output: 0.000015,
    };

    expect(rate.input).toBeLessThan(rate.output);
  });

  it('should accept valid AgentCostEntry', () => {
    const entry: AgentCostEntry = {
      sessionName: 'test-session',
      agentId: 'agent-001',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cost: 0.015,
      eventCount: 5,
    };

    expect(entry.totalTokens).toBe(entry.inputTokens + entry.outputTokens);
  });
});
