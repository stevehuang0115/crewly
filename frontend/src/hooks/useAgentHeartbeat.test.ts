/**
 * Tests for useAgentHeartbeat hook
 *
 * @module hooks/useAgentHeartbeat.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useAgentHeartbeat, extractHeartbeats } from './useAgentHeartbeat';
import { apiService } from '../services/api.service';
import type { Team } from '../types';

vi.mock('../services/api.service', () => ({
  apiService: {
    getTeams: vi.fn(),
  },
}));

const mockTeam: Team = {
  id: 'team-001',
  name: 'Crewly Product',
  members: [
    {
      id: 'member-001',
      name: 'Sam',
      sessionName: 'crewly-product-sam-217bfbbf',
      role: 'developer',
      systemPrompt: 'You are a developer.',
      agentStatus: 'active',
      workingStatus: 'in_progress',
      runtimeType: 'claude-code',
      readyAt: '2026-03-23T08:00:00.000Z',
      lastActivityCheck: '2026-03-23T10:30:00.000Z',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-23T10:30:00.000Z',
    },
    {
      id: 'member-002',
      name: 'Leo',
      sessionName: 'crewly-product-leo-member-n',
      role: 'developer',
      systemPrompt: 'You are a developer.',
      agentStatus: 'inactive',
      workingStatus: 'idle',
      runtimeType: 'claude-code',
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-21T00:00:00.000Z',
    },
  ],
  projectIds: ['proj-001'],
  createdAt: '2026-03-20T00:00:00.000Z',
  updatedAt: '2026-03-23T00:00:00.000Z',
};

describe('extractHeartbeats', () => {
  it('should flatten team members into heartbeat info', () => {
    const agents = extractHeartbeats([mockTeam]);
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe('Sam');
    expect(agents[0].teamName).toBe('Crewly Product');
    expect(agents[0].agentStatus).toBe('active');
    expect(agents[0].workingStatus).toBe('in_progress');
    expect(agents[0].readyAt).toBe('2026-03-23T08:00:00.000Z');
    expect(agents[1].name).toBe('Leo');
    expect(agents[1].agentStatus).toBe('inactive');
    expect(agents[1].readyAt).toBeNull();
    expect(agents[1].lastActivityCheck).toBeNull();
  });

  it('should return empty array for no teams', () => {
    expect(extractHeartbeats([])).toEqual([]);
  });

  it('should return empty array for teams with no members', () => {
    const emptyTeam = { ...mockTeam, members: [] };
    expect(extractHeartbeats([emptyTeam])).toEqual([]);
  });

  it('should handle multiple teams', () => {
    const team2: Team = {
      ...mockTeam,
      id: 'team-002',
      name: 'Marketing',
      members: [mockTeam.members[0]],
    };
    const agents = extractHeartbeats([mockTeam, team2]);
    expect(agents).toHaveLength(3);
  });
});

describe('useAgentHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start in loading state', () => {
    vi.mocked(apiService.getTeams).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAgentHeartbeat());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.agents).toEqual([]);
  });

  it('should load agents on mount', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue([mockTeam]);
    const { result } = renderHook(() => useAgentHeartbeat());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.agents).toHaveLength(2);
    expect(result.current.agents[0].name).toBe('Sam');
    expect(result.current.error).toBeNull();
  });

  it('should force refresh teams cache', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue([mockTeam]);
    renderHook(() => useAgentHeartbeat());

    await waitFor(() => {
      expect(apiService.getTeams).toHaveBeenCalledWith(true);
    });
  });

  it('should handle fetch error', async () => {
    vi.mocked(apiService.getTeams).mockRejectedValue(new Error('Server down'));
    const { result } = renderHook(() => useAgentHeartbeat());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Server down');
  });

  it('should set up polling interval on mount', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    vi.mocked(apiService.getTeams).mockReturnValue(new Promise(() => {}));

    renderHook(() => useAgentHeartbeat());

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    setIntervalSpy.mockRestore();
  });

  it('should clear polling interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    vi.mocked(apiService.getTeams).mockReturnValue(new Promise(() => {}));

    const { unmount } = renderHook(() => useAgentHeartbeat());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('should refresh manually', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue([mockTeam]);
    const { result } = renderHook(() => useAgentHeartbeat());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Change mock for refresh
    const updatedTeam = {
      ...mockTeam,
      members: [{ ...mockTeam.members[0], agentStatus: 'inactive' as const }],
    };
    vi.mocked(apiService.getTeams).mockResolvedValue([updatedTeam]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.agents).toHaveLength(1);
    expect(result.current.agents[0].agentStatus).toBe('inactive');
  });
});
