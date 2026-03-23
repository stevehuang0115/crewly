/**
 * Tests for useCronTasks hook
 *
 * @module hooks/useCronTasks.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useCronTasks } from './useCronTasks';
import { apiService } from '../services/api.service';
import type { CronTask } from '../types/cron-task.types';

vi.mock('../services/api.service', () => ({
  apiService: {
    getCronTasks: vi.fn(),
    createCronTask: vi.fn(),
    updateCronTask: vi.fn(),
    deleteCronTask: vi.fn(),
  },
}));

const mockTask: CronTask = {
  id: 'cron-0001',
  cronExpression: '0 9 * * *',
  timezone: 'Asia/Shanghai',
  targetAgent: 'crewly-product-sam-217bfbbf',
  targetTeamId: 'team-001',
  taskDescription: 'Daily standup',
  createdBy: 'user',
  createdAt: '2026-03-23T00:00:00.000Z',
  enabled: true,
  lastRunAt: null,
  nextRunAt: '2026-03-24T01:00:00.000Z',
};

describe('useCronTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start in loading state', () => {
    vi.mocked(apiService.getCronTasks).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useCronTasks());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should load tasks on mount', async () => {
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask]);
    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.tasks).toEqual([mockTask]);
    expect(result.current.error).toBeNull();
  });

  it('should handle fetch error', async () => {
    vi.mocked(apiService.getCronTasks).mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.tasks).toEqual([]);
  });

  it('should set up polling interval on mount', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    vi.mocked(apiService.getCronTasks).mockReturnValue(new Promise(() => {}));

    renderHook(() => useCronTasks());

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    setIntervalSpy.mockRestore();
  });

  it('should clear polling interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    vi.mocked(apiService.getCronTasks).mockReturnValue(new Promise(() => {}));

    const { unmount } = renderHook(() => useCronTasks());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('should create a task and refresh list', async () => {
    vi.mocked(apiService.getCronTasks).mockResolvedValue([]);
    vi.mocked(apiService.createCronTask).mockResolvedValue(mockTask);

    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // After create, getCronTasks is called again for refresh
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask]);

    await act(async () => {
      const created = await result.current.createTask({
        cronExpression: '0 9 * * *',
        timezone: 'Asia/Shanghai',
        targetAgent: 'crewly-product-sam-217bfbbf',
        targetTeamId: 'team-001',
        taskDescription: 'Daily standup',
        createdBy: 'user',
      });
      expect(created.id).toBe('cron-0001');
    });

    expect(apiService.createCronTask).toHaveBeenCalledTimes(1);
    // Initial fetch + refresh after create
    expect(apiService.getCronTasks).toHaveBeenCalledTimes(2);
  });

  it('should update a task and refresh list', async () => {
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask]);
    const updatedTask = { ...mockTask, enabled: false };
    vi.mocked(apiService.updateCronTask).mockResolvedValue(updatedTask);

    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    vi.mocked(apiService.getCronTasks).mockResolvedValue([updatedTask]);

    await act(async () => {
      const updated = await result.current.updateTask('cron-0001', { enabled: false });
      expect(updated.enabled).toBe(false);
    });

    expect(apiService.updateCronTask).toHaveBeenCalledWith('cron-0001', { enabled: false });
  });

  it('should delete a task and refresh list', async () => {
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask]);
    vi.mocked(apiService.deleteCronTask).mockResolvedValue(undefined);

    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    vi.mocked(apiService.getCronTasks).mockResolvedValue([]);

    await act(async () => {
      await result.current.deleteTask('cron-0001');
    });

    expect(apiService.deleteCronTask).toHaveBeenCalledWith('cron-0001');
    expect(result.current.tasks).toEqual([]);
  });

  it('should refresh tasks manually', async () => {
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask]);

    const { result } = renderHook(() => useCronTasks());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const newTask = { ...mockTask, id: 'cron-0002' };
    vi.mocked(apiService.getCronTasks).mockResolvedValue([mockTask, newTask]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.tasks).toHaveLength(2);
  });
});
