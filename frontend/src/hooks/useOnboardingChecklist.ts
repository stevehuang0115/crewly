/**
 * useOnboardingChecklist Hook
 *
 * Loads `GET /api/onboarding/checklist` and exposes refresh + dismiss.
 * Shared by the `/setup` checklist steps and the dashboard "开始使用" card.
 *
 * @module hooks/useOnboardingChecklist
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { onboardingChecklistService } from '../services/onboarding-checklist.service';
import type { OnboardingChecklist } from '../types/onboarding-checklist.types';

export interface UseOnboardingChecklistResult {
  /** Latest checklist (null until the first load, or when it failed) */
  checklist: OnboardingChecklist | null;
  /** True during the first load */
  loading: boolean;
  /** Last load / dismiss error */
  error: string | null;
  /** Re-read the checklist */
  refresh: () => Promise<void>;
  /** Hide (true) or show (false) the dashboard card */
  setDismissed: (dismissed: boolean) => Promise<void>;
}

/**
 * Checklist state + actions.
 *
 * @returns {@link UseOnboardingChecklistResult}
 */
export function useOnboardingChecklist(): UseOnboardingChecklistResult {
  const [checklist, setChecklist] = useState<OnboardingChecklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await onboardingChecklistService.getChecklist();
      if (!mounted.current) return;
      setChecklist(next);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const setDismissed = useCallback(async (dismissed: boolean): Promise<void> => {
    try {
      const next = await onboardingChecklistService.setDismissed(dismissed);
      if (mounted.current) setChecklist(next);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { checklist, loading, error, refresh, setDismissed };
}
