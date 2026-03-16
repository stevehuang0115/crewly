import { describe, it, expect, jest } from '@jest/globals';

// Mock heavy dependencies to avoid OOM (must use jest.mock for ts-jest CommonJS)
jest.mock('ai', () => ({
  tool: jest.fn((def: Record<string, unknown>) => def),
  generateText: jest.fn(),
  stepCountIs: jest.fn(),
}));

jest.mock('@ai-sdk/anthropic', () => ({
  anthropic: jest.fn((id: string) => ({ provider: 'anthropic', modelId: id })),
}));

jest.mock('@ai-sdk/openai', () => ({
  openai: jest.fn((id: string) => ({ provider: 'openai', modelId: id })),
}));

jest.mock('@ai-sdk/google', () => ({
  google: jest.fn((id: string) => ({ provider: 'google', modelId: id })),
}));

import * as barrel from './index.js';

/**
 * Tests for the crewly-agent barrel export.
 *
 * Verifies that all public APIs are accessible via the index module.
 */
describe('crewly-agent barrel export', () => {
  it('should export AgentRunnerService', () => {
    expect(barrel.AgentRunnerService).toBeDefined();
    expect(typeof barrel.AgentRunnerService).toBe('function');
  });

  it('should export CrewlyAgentRuntimeService', () => {
    expect(barrel.CrewlyAgentRuntimeService).toBeDefined();
    expect(typeof barrel.CrewlyAgentRuntimeService).toBe('function');
  });

  it('should export CrewlyApiClient', () => {
    expect(barrel.CrewlyApiClient).toBeDefined();
    expect(typeof barrel.CrewlyApiClient).toBe('function');
  });

  it('should export ModelManager', () => {
    expect(barrel.ModelManager).toBeDefined();
    expect(typeof barrel.ModelManager).toBe('function');
  });

  it('should export createTools and getToolNames', () => {
    expect(barrel.createTools).toBeDefined();
    expect(typeof barrel.createTools).toBe('function');
    expect(barrel.getToolNames).toBeDefined();
    expect(typeof barrel.getToolNames).toBe('function');
  });

  it('should export createAuditorTools and getAuditorToolNames', () => {
    expect(barrel.createAuditorTools).toBeDefined();
    expect(typeof barrel.createAuditorTools).toBe('function');
    expect(barrel.getAuditorToolNames).toBeDefined();
    expect(typeof barrel.getAuditorToolNames).toBe('function');
  });

  it('should export InProcessLogBuffer', () => {
    expect(barrel.InProcessLogBuffer).toBeDefined();
    expect(typeof barrel.InProcessLogBuffer).toBe('function');
  });

  it('should export type constants and guards', () => {
    expect(barrel.MODEL_PROVIDERS).toBeDefined();
    expect(Array.isArray(barrel.MODEL_PROVIDERS)).toBe(true);
    expect(barrel.CREWLY_AGENT_DEFAULTS).toBeDefined();
    expect(typeof barrel.isModelProvider).toBe('function');
    expect(typeof barrel.isModelConfig).toBe('function');
  });

  it('should export RateLimiter and RATE_LIMITER_DEFAULTS', () => {
    expect(barrel.RateLimiter).toBeDefined();
    expect(typeof barrel.RateLimiter).toBe('function');
    expect(barrel.RATE_LIMITER_DEFAULTS).toBeDefined();
    expect(typeof barrel.RATE_LIMITER_DEFAULTS.maxRequestsPerWindow).toBe('number');
  });
});
