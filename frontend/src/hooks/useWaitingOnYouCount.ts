/**
 * useWaitingOnYouCount — the number on the Dashboard nav badge and phone
 * tab: open owner decisions (the Dashboard's "Waiting on you" list).
 *
 * Same endpoint (`GET /api/decisions?status=open`) as `WaitingOnYouCard`. Failures are
 * silent: a badge is not worth breaking the navigation for.
 *
 * @module hooks/useWaitingOnYouCount
 */

import { useEffect, useState } from 'react';
import { listOpenDecisions } from '../services/decisions.service';

/** Refresh interval (ms) — same as the Dashboard's "Waiting on you" list. */
export const WAITING_ON_YOU_BADGE_POLL_MS = 30_000;

/**
 * Open decisions waiting on the owner, or null until the first load.
 *
 * @param pollMs - Refresh interval
 * @returns Count for the badge
 */
export function useWaitingOnYouCount(pollMs: number = WAITING_ON_YOU_BADGE_POLL_MS): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const open = await listOpenDecisions();
        if (!cancelled) setCount(open.length);
      } catch {
        /* keep the last known count */
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);

  return count;
}

export default useWaitingOnYouCount;
