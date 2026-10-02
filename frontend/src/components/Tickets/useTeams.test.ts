/**
 * Tests for useTeams.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useTeams } from './useTeams';
import { apiService } from '../../services/api.service';
import type { Team } from '../../types';

vi.mock('../../services/api.service', () => ({ apiService: { getTeams: vi.fn() } }));

const TEAMS = [{ id: 't', name: 'CE', members: [{ sessionName: 'ce-vera-1', name: 'Vera' }] }] as unknown as Team[];

beforeEach(() => vi.clearAllMocks());

describe('useTeams', () => {
  it('fetches teams and indexes names', async () => {
    vi.mocked(apiService.getTeams).mockResolvedValue(TEAMS);
    const { result } = renderHook(() => useTeams());
    await waitFor(() => expect(result.current.names.get('ce-vera-1')).toEqual({ name: 'Vera', team: 'CE' }));
  });

  it('uses the caller\'s teams without fetching', () => {
    const { result } = renderHook(() => useTeams(TEAMS));
    expect(apiService.getTeams).not.toHaveBeenCalled();
    expect(result.current.teams).toBe(TEAMS);
  });

  it('survives a failed fetch', async () => {
    vi.mocked(apiService.getTeams).mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => useTeams());
    await waitFor(() => expect(apiService.getTeams).toHaveBeenCalled());
    expect(result.current.names.size).toBe(0);
  });
});
