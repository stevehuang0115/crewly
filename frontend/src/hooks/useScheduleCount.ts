/**
 * useScheduleCount — the number on the Schedules nav badge: active,
 * owner-facing recurring triggers plus enabled per-team cron tasks.
 *
 * Uses the small `/triggers/status` and `/cron-tasks?enabled=true` endpoints
 * rather than the full trigger list, and refreshes on a slow poll. Failures
 * are silent — a badge is not worth breaking the sidebar for.
 *
 * @module hooks/useScheduleCount
 */

import { useEffect, useState } from 'react';
import { apiService } from '../services/api.service';
import { SCHEDULE_BADGE_POLL_MS } from '../constants/schedules.constants';

/**
 * Active recurring schedules, or null until the first successful load.
 *
 * @returns Count for the nav badge
 */
export function useScheduleCount(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [status, crons] = await Promise.all([
          apiService.getTriggerEngineStatus(),
          apiService.getCronTasks({ enabled: true }),
        ]);
        if (cancelled) return;
        setCount((status.recurringActive ?? 0) + crons.length);
      } catch {
        /* keep the last known count */
      }
    };
    void load();
    const timer = setInterval(() => void load(), SCHEDULE_BADGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return count;
}

export default useScheduleCount;
