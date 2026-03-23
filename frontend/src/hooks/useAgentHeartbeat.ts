/**
 * Use Agent Heartbeat Hook
 *
 * Derives agent heartbeat data from team member information fetched via
 * the teams API. Polls at a regular interval to keep status current.
 *
 * @module hooks/useAgentHeartbeat
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiService } from '../services/api.service';
import type { Team, TeamMember } from '../types';

// ========================= Types =========================

/**
 * Derived heartbeat info for a single agent, combining team context
 * with real-time status fields.
 */
export interface AgentHeartbeatInfo {
  /** Team member ID */
  memberId: string;
  /** Display name */
  name: string;
  /** PTY session name */
  sessionName: string;
  /** Role in the team */
  role: string;
  /** Team name this agent belongs to */
  teamName: string;
  /** Team ID */
  teamId: string;
  /** Current agent status */
  agentStatus: TeamMember['agentStatus'];
  /** Current working status */
  workingStatus: TeamMember['workingStatus'];
  /** ISO timestamp when agent reported ready */
  readyAt: string | null;
  /** ISO timestamp of last activity check */
  lastActivityCheck: string | null;
  /** Runtime type */
  runtimeType: TeamMember['runtimeType'];
}

/**
 * Return type for the useAgentHeartbeat hook
 */
export interface UseAgentHeartbeatResult {
  /** List of agent heartbeat info */
  agents: AgentHeartbeatInfo[];
  /** Whether data is being loaded */
  isLoading: boolean;
  /** Error message if the last fetch failed */
  error: string | null;
  /** Manually refresh heartbeat data */
  refresh: () => Promise<void>;
}

// ========================= Constants =========================

/** Polling interval for heartbeat refresh (10 seconds) */
const POLL_INTERVAL_MS = 10_000;

// ========================= Helpers =========================

/**
 * Extracts heartbeat info from teams data by flattening all members.
 *
 * @param teams - Array of teams from the API
 * @returns Flattened array of agent heartbeat info
 */
export function extractHeartbeats(teams: Team[]): AgentHeartbeatInfo[] {
  const agents: AgentHeartbeatInfo[] = [];

  for (const team of teams) {
    for (const member of team.members) {
      agents.push({
        memberId: member.id,
        name: member.name,
        sessionName: member.sessionName,
        role: member.role,
        teamName: team.name,
        teamId: team.id,
        agentStatus: member.agentStatus,
        workingStatus: member.workingStatus,
        readyAt: member.readyAt ?? null,
        lastActivityCheck: member.lastActivityCheck ?? null,
        runtimeType: member.runtimeType,
      });
    }
  }

  return agents;
}

// ========================= Hook =========================

/**
 * Hook for polling agent heartbeat data derived from team members.
 *
 * Fetches teams on mount, then polls every 10 seconds. Forces a cache
 * refresh to ensure fresh agent status data.
 *
 * @returns Object with agents array, loading/error state, and refresh method
 *
 * @example
 * ```typescript
 * const { agents, isLoading } = useAgentHeartbeat();
 * // agents[0].agentStatus: 'active' | 'inactive' | ...
 * ```
 */
export function useAgentHeartbeat(): UseAgentHeartbeatResult {
  const [agents, setAgents] = useState<AgentHeartbeatInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchHeartbeats = useCallback(async () => {
    try {
      const teams = await apiService.getTeams(true);
      if (isMountedRef.current) {
        setAgents(extractHeartbeats(teams));
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch agent heartbeats');
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchHeartbeats();
  }, [fetchHeartbeats]);

  useEffect(() => {
    isMountedRef.current = true;

    const init = async () => {
      await fetchHeartbeats();
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    };

    init();

    const intervalId = setInterval(fetchHeartbeats, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchHeartbeats]);

  return { agents, isLoading, error, refresh };
}

export default useAgentHeartbeat;
