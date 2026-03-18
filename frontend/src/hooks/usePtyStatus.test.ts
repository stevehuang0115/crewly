// @vitest-environment jsdom
/**
 * usePtyStatus Hook Tests
 *
 * @module hooks/usePtyStatus.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { usePtyStatus } from './usePtyStatus';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

describe('usePtyStatus', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should initialize with loading state', () => {
    mockedAxios.get.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => usePtyStatus());
    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch sessions on mount and map data', async () => {
    const mockSessions = [
      {
        sessionName: 'agent-sam',
        agentName: 'Sam',
        role: 'team-leader',
        agentStatus: 'active',
        workingStatus: 'in_progress',
        ptyPid: 4821,
        memoryUsage: 134217728,
        uptimeSeconds: 8040,
        fsScope: 'sandboxed',
        netScope: 'localhost',
      },
    ];

    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockSessions },
    });

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0].agentName).toBe('Sam');
    expect(result.current.sessions[0].ptyPid).toBe(4821);
    expect(result.current.error).toBeNull();
  });

  it('should compute summary correctly', async () => {
    const mockSessions = [
      { sessionName: 'a1', agentStatus: 'active' },
      { sessionName: 'a2', agentStatus: 'active' },
    ];

    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: mockSessions },
    });

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.summary.totalAgents).toBe(2);
    expect(result.current.summary.isolatedCount).toBe(2);
    expect(result.current.summary.sharedCount).toBe(0);
    expect(result.current.summary.status).toBe('healthy');
  });

  it('should handle API failure gracefully', async () => {
    mockedAxios.get.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual([]);
    expect(result.current.error).toBe('Failed to fetch PTY sessions');
  });

  it('should call /api/sessions endpoint', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [] },
    });

    renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith('/api/sessions');
    });
  });

  it('should handle empty data gracefully', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [] },
    });

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual([]);
    expect(result.current.summary.totalAgents).toBe(0);
  });

  it('should support manual refresh', async () => {
    let callCount = 0;
    mockedAxios.get.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { data: { success: true, data: [] } };
      }
      return { data: { success: true, data: [{ sessionName: 'new-agent' }] } };
    });

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toEqual([]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.sessions).toHaveLength(1);
  });

  it('should map missing fields with defaults', async () => {
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [{ id: 'minimal-session' }] },
    });

    const { result } = renderHook(() => usePtyStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sessions).toHaveLength(1);
    const session = result.current.sessions[0];
    expect(session.role).toBe('agent');
    expect(session.agentStatus).toBe('inactive');
    expect(session.workingStatus).toBe('idle');
    expect(session.ptyPid).toBeNull();
    expect(session.memoryUsage).toBeNull();
    expect(session.fsScope).toBe('sandboxed');
    expect(session.netScope).toBe('localhost');
  });
});
