/**
 * Teams for the Tickets pages: agent names ("Atlas" rather than a session
 * name) and assignee choices.
 *
 * @module components/Tickets/useTeams
 */

import { useEffect, useMemo, useState } from 'react';
import type { Team } from '../../types';
import { apiService } from '../../services/api.service';
import { buildAgentNames, type AgentName } from './board.utils';

/** First retry delay after a failed teams fetch (ms); doubles each time. */
export const TEAMS_RETRY_BASE_MS = 2_000;

/** Longest delay between retries (ms). */
export const TEAMS_RETRY_MAX_MS = 60_000;

/** Result of {@link useTeams}. */
export interface UseTeamsResult {
  teams: Team[];
  /** session name → name and team */
  names: Map<string, AgentName>;
}

/**
 * Load the teams (the API service caches them), unless the caller already
 * has them. A failed fetch is retried with backoff (2 s, 4 s, … up to 60 s).
 *
 * @param provided - Teams the caller already has; skips the fetch
 * @returns Teams and the name index
 */
export function useTeams(provided?: Team[]): UseTeamsResult {
  const [fetched, setFetched] = useState<Team[]>([]);

  useEffect(() => {
    if (provided) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    /** Fetch; on failure try again with backoff so names show up once the API answers. */
    const fetchTeams = (): void => {
      // Promise.resolve() first: a missing service method (tests) becomes a rejection.
      Promise.resolve()
        .then(() => apiService.getTeams())
        .then((t) => {
          if (alive && Array.isArray(t)) setFetched(t);
        })
        .catch(() => {
          if (!alive) return;
          const delay = Math.min(TEAMS_RETRY_BASE_MS * 2 ** attempt, TEAMS_RETRY_MAX_MS);
          attempt += 1;
          timer = setTimeout(fetchTeams, delay);
        });
    };
    fetchTeams();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [provided]);

  const teams = provided ?? fetched;
  const names = useMemo(() => buildAgentNames(teams), [teams]);
  return { teams, names };
}
