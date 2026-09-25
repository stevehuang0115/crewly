/**
 * useHarnessStatus Hook
 *
 * Loads `GET /api/harness` and exposes the orc-harness setter. Shared by
 * the `/setup` flow and the Settings → Harness tab.
 *
 * @module hooks/useHarnessStatus
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { harnessService } from '../services/harness.service';
import type { HarnessId, HarnessOverview, HarnessStatus } from '../types/harness.types';
import { HARNESS_ORDER } from '../constants/harness.constants';

export interface UseHarnessStatusResult {
  /** Latest overview, harnesses sorted in display order (null until first load) */
  overview: HarnessOverview | null;
  /** True during the first load */
  loading: boolean;
  /** Load / save error message */
  error: string | null;
  /** Re-fetch the overview */
  refresh: () => Promise<void>;
  /** Save the orc harness; resolves true on success */
  setOrcHarness: (harnessId: HarnessId) => Promise<boolean>;
  /** True while the orc choice is being saved */
  savingOrc: boolean;
  /** Replace one harness's status in place (e.g. after an API-key save) */
  replaceHarness: (status: HarnessStatus) => void;
}

/**
 * Sort harnesses in the canonical display order (unknown ids last).
 *
 * @param harnesses - Harness list
 * @returns Sorted copy
 */
export function sortHarnesses(harnesses: HarnessStatus[]): HarnessStatus[] {
  const rank = (id: string): number => {
    const i = HARNESS_ORDER.indexOf(id as HarnessId);
    return i === -1 ? HARNESS_ORDER.length : i;
  };
  return [...harnesses].sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Harness overview state + actions.
 *
 * @returns {@link UseHarnessStatusResult}
 */
export function useHarnessStatus(): UseHarnessStatusResult {
  const [overview, setOverview] = useState<HarnessOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingOrc, setSavingOrc] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await harnessService.getStatus();
      if (!mounted.current) return;
      setOverview({ ...data, harnesses: sortHarnesses(data.harnesses) });
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setOrcHarness = useCallback(async (harnessId: HarnessId): Promise<boolean> => {
    setSavingOrc(true);
    try {
      const orcHarness = await harnessService.setOrcHarness(harnessId);
      if (mounted.current) {
        setOverview((prev) => (prev ? { ...prev, orcHarness } : prev));
        setError(null);
      }
      return true;
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (mounted.current) setSavingOrc(false);
    }
  }, []);

  const replaceHarness = useCallback((status: HarnessStatus) => {
    setOverview((prev) =>
      prev ? { ...prev, harnesses: prev.harnesses.map((h) => (h.id === status.id ? status : h)) } : prev,
    );
  }, []);

  return { overview, loading, error, refresh, setOrcHarness, savingOrc, replaceHarness };
}
