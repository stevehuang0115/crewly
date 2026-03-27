/**
 * useTokenUsage Hook Tests
 *
 * @module hooks/useTokenUsage.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useTokenUsage } from './useTokenUsage';
import { apiService } from '../services/api.service';

// Mock the API service
vi.mock('../services/api.service', () => ({
  apiService: {
    getTokenUsage: vi.fn(),
  },
}));

const mockApiService = vi.mocked(apiService);

const mockUsageData = [
  { sessionName: 'agent-opus', agentId: 'a1', totalInput: 1000, totalOutput: 500, eventCount: 3 },
  { sessionName: 'agent-sonnet', agentId: 'a2', totalInput: 2000, totalOutput: 1000, eventCount: 5 },
];

describe('useTokenUsage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should initialize with loading state', () => {
    mockApiService.getTokenUsage.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useTokenUsage());

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch and transform token usage data', async () => {
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].sessionName).toBe('agent-opus');
    expect(result.current.sessions[0].inputTokens).toBe(1000);
    expect(result.current.sessions[0].outputTokens).toBe(500);
    expect(result.current.sessions[0].totalTokens).toBe(1500);
    expect(result.current.activeAgents).toBe(2);
    expect(result.current.totalTokens).toBe(4500);
  });

  it('should compute cost using default rates', async () => {
    mockApiService.getTokenUsage.mockResolvedValue([
      { sessionName: 'test', agentId: 'a1', totalInput: 1000, totalOutput: 1000, eventCount: 1 },
    ]);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Default rates: input=0.000003, output=0.000015
    // 1000 * 0.000003 + 1000 * 0.000015 = 0.003 + 0.015 = 0.018
    expect(result.current.totalCost).toBeCloseTo(0.018, 6);
  });

  it('should compute average cost per task', async () => {
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Total events = 3 + 5 = 8
    const totalCost = result.current.totalCost;
    expect(result.current.avgCostPerTask).toBeCloseTo(totalCost / 8, 6);
  });

  it('should handle API errors', async () => {
    mockApiService.getTokenUsage.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.sessions).toEqual([]);
  });

  it('should poll by calling API multiple times', async () => {
    // Use fake timers that don't block async
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(mockApiService.getTokenUsage).toHaveBeenCalledTimes(1);
    });

    // Advance timer by 10 seconds to trigger poll
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => {
      expect(mockApiService.getTokenUsage).toHaveBeenCalledTimes(2);
    });

    vi.useRealTimers();
  });

  it('should set lastUpdated after successful fetch', async () => {
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.lastUpdated).toBeInstanceOf(Date);
    expect(result.current.isStale).toBe(false);
  });

  it('should support manual refresh', async () => {
    mockApiService.getTokenUsage.mockResolvedValue(mockUsageData);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const callsBefore = mockApiService.getTokenUsage.mock.calls.length;

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockApiService.getTokenUsage.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('should return zero avgCostPerTask when no events', async () => {
    mockApiService.getTokenUsage.mockResolvedValue([]);

    const { result } = renderHook(() => useTokenUsage());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.avgCostPerTask).toBe(0);
    expect(result.current.activeAgents).toBe(0);
  });
});
