/**
 * useApprovalActivity Hook
 *
 * Loads the approval activity for Settings › Security
 * (`GET /api/security/approvals`) for 7 or 30 days. Loads on open, on a
 * window change and on Refresh; no polling.
 *
 * @module hooks/useApprovalActivity
 */

import { useCallback, useEffect, useState } from 'react';
import { securityService, type ApprovalActivity } from '../services/security.service';

/** Result of {@link useApprovalActivity}. */
export interface UseApprovalActivityResult {
  data: ApprovalActivity | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * Approval activity for a window.
 *
 * @param days - 7 or 30
 * @returns {@link UseApprovalActivityResult}
 */
export function useApprovalActivity(days: 7 | 30): UseApprovalActivityResult {
  const [data, setData] = useState<ApprovalActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await securityService.approvals(days));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
