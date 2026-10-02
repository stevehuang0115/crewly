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

/** Result of {@link useTeams}. */
export interface UseTeamsResult {
  teams: Team[];
  /** session name → name and team */
  names: Map<string, AgentName>;
}

/**
 * Load the teams once (the API service caches them), unless the caller
 * already has them.
 *
 * @param provided - Teams the caller already has; skips the fetch
 * @returns Teams and the name index
 */
export function useTeams(provided?: Team[]): UseTeamsResult {
  const [fetched, setFetched] = useState<Team[]>([]);

  useEffect(() => {
    if (provided) return undefined;
    let alive = true;
    // Promise.resolve() first: a missing service method (tests) becomes a rejection.
    Promise.resolve()
      .then(() => apiService.getTeams())
      .then((t) => {
        if (alive && Array.isArray(t)) setFetched(t);
      })
      .catch(() => {
        // Names fall back to session names; nothing else depends on this.
      });
    return () => {
      alive = false;
    };
  }, [provided]);

  const teams = provided ?? fetched;
  const names = useMemo(() => buildAgentNames(teams), [teams]);
  return { teams, names };
}
