/**
 * useTriggers Hook
 *
 * Provides CRUD + lifecycle operations for V3 Triggers with loading/error states
 * and automatic refresh after mutations.
 *
 * @module hooks/useTriggers
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiService } from '../services/api.service';
import type {
  Trigger,
  TriggerEngineStatus,
  CreateTriggerInput,
} from '../types/trigger.types';

// ========================= Types =========================

export interface UseTriggersResult {
  triggers: Trigger[];
  engineStatus: TriggerEngineStatus | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createTrigger: (input: CreateTriggerInput) => Promise<Trigger>;
  pauseTrigger: (id: string) => Promise<Trigger>;
  resumeTrigger: (id: string) => Promise<Trigger>;
  cancelTrigger: (id: string) => Promise<Trigger>;
  deleteTrigger: (id: string) => Promise<void>;
}

// ========================= Constants =========================

const POLL_INTERVAL_MS = 30_000;

// ========================= Hook =========================

/**
 * Hook for managing V3 triggers with full lifecycle operations.
 *
 * Polls every 30 seconds to keep nextFireAt and fireCount current.
 * All mutations trigger a refresh.
 *
 * @returns Triggers list, engine status, loading/error state, and operation methods
 */
export function useTriggers(): UseTriggersResult {
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [engineStatus, setEngineStatus] = useState<TriggerEngineStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchAll = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([
        apiService.getTriggers(),
        apiService.getTriggerEngineStatus(),
      ]);
      if (isMountedRef.current) {
        setTriggers(list);
        setEngineStatus(status);
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch triggers');
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchAll();
  }, [fetchAll]);

  const createTrigger = useCallback(async (input: CreateTriggerInput): Promise<Trigger> => {
    const created = await apiService.createTrigger(input);
    await fetchAll();
    return created;
  }, [fetchAll]);

  const pauseTrigger = useCallback(async (id: string): Promise<Trigger> => {
    const updated = await apiService.pauseTrigger(id);
    await fetchAll();
    return updated;
  }, [fetchAll]);

  const resumeTrigger = useCallback(async (id: string): Promise<Trigger> => {
    const updated = await apiService.resumeTrigger(id);
    await fetchAll();
    return updated;
  }, [fetchAll]);

  const cancelTrigger = useCallback(async (id: string): Promise<Trigger> => {
    const updated = await apiService.cancelTrigger(id);
    await fetchAll();
    return updated;
  }, [fetchAll]);

  const deleteTrigger = useCallback(async (id: string): Promise<void> => {
    await apiService.deleteTrigger(id);
    await fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    isMountedRef.current = true;

    const init = async () => {
      await fetchAll();
      if (isMountedRef.current) setIsLoading(false);
    };

    init();

    const intervalId = setInterval(fetchAll, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchAll]);

  return {
    triggers,
    engineStatus,
    isLoading,
    error,
    refresh,
    createTrigger,
    pauseTrigger,
    resumeTrigger,
    cancelTrigger,
    deleteTrigger,
  };
}

export default useTriggers;
