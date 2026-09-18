/**
 * Use Pending Logins Hook
 *
 * Polls `GET /api/oauth/pending` — every agent session currently parked on
 * a runtime sign-in screen — so the app can show a global "Sign-in needed"
 * banner. Polls once a minute; the list is small and only changes when a
 * runtime's OAuth token expires, so a WebSocket subscription is not worth
 * the extra plumbing.
 *
 * @module hooks/usePendingLogins
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import type { PendingLogin } from '../types';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';

/**
 * Return type for the usePendingLogins hook
 */
export interface UsePendingLoginsResult {
  /** Sessions waiting on a human sign-in (empty when none) */
  pending: PendingLogin[];
  /** Whether the first fetch is still in flight */
  isLoading: boolean;
  /** Re-fetch immediately */
  refresh: () => Promise<void>;
}

/**
 * Hook that keeps the pending-logins list fresh.
 *
 * @param intervalMs - Poll interval (defaults to SIGN_IN_CONSTANTS.PENDING_POLL_INTERVAL_MS)
 * @returns Pending logins, loading flag and a manual refresh
 */
export function usePendingLogins(
  intervalMs: number = SIGN_IN_CONSTANTS.PENDING_POLL_INTERVAL_MS,
): UsePendingLoginsResult {
  const [pending, setPending] = useState<PendingLogin[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await axios.get<{ success: boolean; data?: PendingLogin[] }>(
        SIGN_IN_CONSTANTS.PENDING_ENDPOINT,
        { timeout: SIGN_IN_CONSTANTS.PENDING_REQUEST_TIMEOUT_MS },
      );
      if (!isMountedRef.current) return;
      if (response.data.success && Array.isArray(response.data.data)) {
        setPending(response.data.data);
      }
    } catch {
      // Non-critical: keep the last known list rather than flashing the banner off.
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, intervalMs);
    return () => {
      isMountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { pending, isLoading, refresh };
}

export default usePendingLogins;
