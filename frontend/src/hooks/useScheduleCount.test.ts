/**
 * Tests for useScheduleCount.
 *
 * @module hooks/useScheduleCount.test
 */

import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useScheduleCount } from './useScheduleCount';
import { apiService } from '../services/api.service';

vi.mock('../services/api.service', () => ({
  apiService: {
    getTriggerEngineStatus: vi.fn(),
    getCronTasks: vi.fn(),
  },
}));

describe('useScheduleCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds active recurring triggers and enabled cron tasks', async () => {
    vi.mocked(apiService.getTriggerEngineStatus).mockResolvedValue({ running: true, total: 9, byStatus: {} as never, byType: {}, recurringActive: 3 });
    vi.mocked(apiService.getCronTasks).mockResolvedValue([{}, {}] as never);
    const { result } = renderHook(() => useScheduleCount());
    await waitFor(() => expect(result.current).toBe(5));
    expect(apiService.getCronTasks).toHaveBeenCalledWith({ enabled: true });
  });

  it('stays null when the API fails', async () => {
    vi.mocked(apiService.getTriggerEngineStatus).mockRejectedValue(new Error('down'));
    vi.mocked(apiService.getCronTasks).mockResolvedValue([]);
    const { result } = renderHook(() => useScheduleCount());
    await waitFor(() => expect(apiService.getTriggerEngineStatus).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});
