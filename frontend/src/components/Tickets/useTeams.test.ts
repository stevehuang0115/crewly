/**
 * Tests for useTeams.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTeams, TEAMS_RETRY_BASE_MS } from './useTeams';
import { apiService } from '../../services/api.service';
import type { Team } from '../../types';

vi.mock('../../services/api.service', () => ({ apiService: { getTeams: vi.fn() } }));

const TEAMS = [{ id: 't', name: 'CE', members: [{ sessionName: 'ce-vera-1', name: 'Vera' }] }] as unknown as Team[];

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

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

  it('retries a failed fetch with backoff until the names load', async () => {
    vi.useFakeTimers();
    vi.mocked(apiService.getTeams)
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(TEAMS);
    const { result } = renderHook(() => useTeams());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(apiService.getTeams).toHaveBeenCalledTimes(1);
    expect(result.current.names.size).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEAMS_RETRY_BASE_MS); });
    expect(apiService.getTeams).toHaveBeenCalledTimes(2);
    // Second delay is doubled.
    await act(async () => { await vi.advanceTimersByTimeAsync(TEAMS_RETRY_BASE_MS); });
    expect(apiService.getTeams).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEAMS_RETRY_BASE_MS); });
    expect(apiService.getTeams).toHaveBeenCalledTimes(3);
    expect(result.current.names.get('ce-vera-1')?.name).toBe('Vera');
  });

  it('stops retrying after unmount', async () => {
    vi.useFakeTimers();
    vi.mocked(apiService.getTeams).mockRejectedValue(new Error('down'));
    const { unmount } = renderHook(() => useTeams());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(TEAMS_RETRY_BASE_MS * 10); });
    expect(apiService.getTeams).toHaveBeenCalledTimes(1);
  });
});
