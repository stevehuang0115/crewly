/**
 * Use Cron Tasks Hook
 *
 * Provides CRUD operations for cron tasks with loading/error states
 * and automatic refresh after mutations.
 *
 * @module hooks/useCronTasks
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiService } from '../services/api.service';
import type { CronTask, CreateCronTaskRequest, UpdateCronTaskRequest } from '../types/cron-task.types';

// ========================= Types =========================

/**
 * Return type for the useCronTasks hook
 */
export interface UseCronTasksResult {
  /** List of cron tasks */
  tasks: CronTask[];
  /** Whether data is being loaded */
  isLoading: boolean;
  /** Error message if the last operation failed */
  error: string | null;
  /** Refresh the task list */
  refresh: () => Promise<void>;
  /** Create a new cron task */
  createTask: (request: CreateCronTaskRequest) => Promise<CronTask>;
  /** Update an existing cron task (e.g. toggle enabled) */
  updateTask: (id: string, updates: UpdateCronTaskRequest) => Promise<CronTask>;
  /** Delete a cron task */
  deleteTask: (id: string) => Promise<void>;
}

// ========================= Constants =========================

/** Polling interval for cron task list refresh (30 seconds) */
const POLL_INTERVAL_MS = 30_000;

// ========================= Hook =========================

/**
 * Hook for managing cron tasks with CRUD operations.
 *
 * Fetches tasks on mount and polls every 30 seconds to keep nextRunAt
 * and lastRunAt values current. Mutations automatically trigger a refresh.
 *
 * @returns Object with tasks array, loading/error state, and CRUD methods
 *
 * @example
 * ```typescript
 * const { tasks, isLoading, deleteTask, updateTask } = useCronTasks();
 * // Toggle enabled: updateTask(task.id, { enabled: !task.enabled })
 * ```
 */
export function useCronTasks(): UseCronTasksResult {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    try {
      const data = await apiService.getCronTasks();
      if (isMountedRef.current) {
        setTasks(data);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch cron tasks');
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchTasks();
  }, [fetchTasks]);

  const createTask = useCallback(async (request: CreateCronTaskRequest): Promise<CronTask> => {
    const created = await apiService.createCronTask(request);
    await fetchTasks();
    return created;
  }, [fetchTasks]);

  const updateTask = useCallback(async (id: string, updates: UpdateCronTaskRequest): Promise<CronTask> => {
    const updated = await apiService.updateCronTask(id, updates);
    await fetchTasks();
    return updated;
  }, [fetchTasks]);

  const deleteTask = useCallback(async (id: string): Promise<void> => {
    await apiService.deleteCronTask(id);
    await fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    isMountedRef.current = true;

    const init = async () => {
      await fetchTasks();
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    };

    init();

    const intervalId = setInterval(fetchTasks, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchTasks]);

  return { tasks, isLoading, error, refresh, createTask, updateTask, deleteTask };
}

export default useCronTasks;
