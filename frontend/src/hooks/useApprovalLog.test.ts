// @vitest-environment jsdom
/**
 * useApprovalLog Hook Tests
 *
 * @module hooks/useApprovalLog.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { useApprovalLog } from './useApprovalLog';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

// Mock isCancel
(mockedAxios as any).isCancel = vi.fn(() => false);

describe('useApprovalLog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (mockedAxios as any).isCancel = vi.fn(() => false);
  });

  it('should initialize with loading state', () => {
    mockedAxios.get.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useApprovalLog());
    expect(result.current.loading).toBe(true);
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch events from API when available', async () => {
    const mockEvents = [
      {
        id: 'ev-1',
        timestamp: new Date().toISOString(),
        sessionName: 'agent-sam',
        agentName: 'Sam',
        toolName: 'git push',
        outcome: 'approved',
        riskLevel: 'medium',
      },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEvents },
    });

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toEqual(mockEvents);
    expect(result.current.error).toBeNull();
  });

  it('should fall back to mock data when API fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('404 Not Found'));

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Should have mock data (6 events)
    expect(result.current.events.length).toBeGreaterThan(0);
    expect(result.current.error).toBeNull(); // No error for expected fallback
  });

  it('should filter events by agent', async () => {
    const mockEvents = [
      { id: '1', timestamp: new Date().toISOString(), sessionName: 'a-sam', agentName: 'Sam', toolName: 'git push', outcome: 'approved', riskLevel: 'medium' },
      { id: '2', timestamp: new Date().toISOString(), sessionName: 'a-leo', agentName: 'Leo', toolName: 'rm -rf', outcome: 'denied', riskLevel: 'high' },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEvents },
    });

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.filteredEvents).toHaveLength(2);

    act(() => {
      result.current.setFilter({ agent: 'Sam' });
    });

    expect(result.current.filteredEvents).toHaveLength(1);
    expect(result.current.filteredEvents[0].agentName).toBe('Sam');
  });

  it('should filter events by outcome', async () => {
    const mockEvents = [
      { id: '1', timestamp: new Date().toISOString(), sessionName: 'a-sam', agentName: 'Sam', toolName: 'git push', outcome: 'approved', riskLevel: 'medium' },
      { id: '2', timestamp: new Date().toISOString(), sessionName: 'a-leo', agentName: 'Leo', toolName: 'rm -rf', outcome: 'denied', riskLevel: 'high' },
      { id: '3', timestamp: new Date().toISOString(), sessionName: 'a-ava', agentName: 'Ava', toolName: 'npm install', outcome: 'auto', riskLevel: 'low' },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEvents },
    });

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setFilter({ outcome: 'denied' });
    });

    expect(result.current.filteredEvents).toHaveLength(1);
    expect(result.current.filteredEvents[0].outcome).toBe('denied');
  });

  it('should compute summary correctly', async () => {
    const today = new Date().toISOString();
    const mockEvents = [
      { id: '1', timestamp: today, sessionName: 'a-sam', agentName: 'Sam', toolName: 'git push', outcome: 'approved', riskLevel: 'medium' },
      { id: '2', timestamp: today, sessionName: 'a-leo', agentName: 'Leo', toolName: 'rm -rf', outcome: 'denied', riskLevel: 'high' },
      { id: '3', timestamp: today, sessionName: 'a-ava', agentName: 'Ava', toolName: 'npm install', outcome: 'auto', riskLevel: 'low' },
    ];

    mockedAxios.get.mockResolvedValueOnce({
      data: { success: true, data: mockEvents },
    });

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.summary.totalToday).toBe(3);
    expect(result.current.summary.deniedToday).toBe(1);
    expect(result.current.summary.bypassedToday).toBe(0);
    expect(result.current.summary.status).toBe('enforced');
  });

  it('should support manual refresh', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ data: { success: true, data: [] } })
      .mockResolvedValueOnce({
        data: { success: true, data: [{ id: '1', timestamp: new Date().toISOString(), sessionName: 'a', agentName: 'A', toolName: 'test', outcome: 'auto', riskLevel: 'low' }] },
      });

    const { result } = renderHook(() => useApprovalLog());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.events).toEqual([]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.events).toHaveLength(1);
  });
});
