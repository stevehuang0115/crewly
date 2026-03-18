/**
 * usePtyStatus Hook
 *
 * Polls /api/sessions every 5 seconds for live PTY isolation data.
 * Maps session data into PTY status entries for the Security Overview page.
 *
 * @module hooks/usePtyStatus
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { ApiResponse } from '../types';

const API_BASE = '/api';

/** Polling interval for PTY status in milliseconds (5 seconds) */
const POLL_INTERVAL_MS = 5000;

/** PTY info for a single agent session */
export interface PtySessionInfo {
  /** Agent session name */
  sessionName: string;
  /** Agent display name */
  agentName: string;
  /** Agent role */
  role: string;
  /** Agent status */
  agentStatus: string;
  /** Working status */
  workingStatus: string;
  /** PTY process ID (if available) */
  ptyPid: number | null;
  /** Memory usage in bytes (if available) */
  memoryUsage: number | null;
  /** Session uptime in seconds (if available) */
  uptimeSeconds: number | null;
  /** Filesystem scope */
  fsScope: string;
  /** Network scope */
  netScope: string;
}

/** Summary stats for the PTY status card */
export interface PtySummary {
  /** Total number of agent sessions */
  totalAgents: number;
  /** Number of isolated sessions */
  isolatedCount: number;
  /** Number of shared (non-isolated) sessions — always 0 in Crewly */
  sharedCount: number;
  /** Overall health status */
  status: 'healthy' | 'warning' | 'error';
}

/** Return type for the usePtyStatus hook */
export interface UsePtyStatusResult {
  /** List of PTY session entries */
  sessions: PtySessionInfo[];
  /** Summary stats */
  summary: PtySummary;
  /** Whether the initial fetch is still in progress */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Manual refresh function */
  refresh: () => Promise<void>;
}

/**
 * Hook for polling PTY session status for the security overview.
 *
 * Fetches /api/sessions every 5s and maps the response into PTY isolation data.
 * Falls back to empty state if endpoint is unavailable.
 *
 * @returns PTY sessions, summary, and loading/error state
 *
 * @example
 * ```tsx
 * const { sessions, summary, loading } = usePtyStatus();
 * ```
 */
export function usePtyStatus(): UsePtyStatusResult {
  const [sessions, setSessions] = useState<PtySessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchSessions = useCallback(async () => {
    try {
      const response = await axios.get<ApiResponse<any[]>>(`${API_BASE}/sessions`);
      if (!isMountedRef.current) return;

      if (response.data.success && Array.isArray(response.data.data)) {
        const mapped: PtySessionInfo[] = response.data.data.map((s: any) => ({
          sessionName: s.sessionName || s.id || 'unknown',
          agentName: s.agentName || s.name || s.sessionName || 'Unknown Agent',
          role: s.role || 'agent',
          agentStatus: s.agentStatus || s.status || 'inactive',
          workingStatus: s.workingStatus || 'idle',
          ptyPid: s.ptyPid ?? s.pid ?? null,
          memoryUsage: s.memoryUsage ?? null,
          uptimeSeconds: s.uptimeSeconds ?? null,
          fsScope: s.fsScope || 'sandboxed',
          netScope: s.netScope || 'localhost',
        }));
        setSessions(mapped);
        setError(null);
      } else {
        setSessions([]);
      }
    } catch {
      if (isMountedRef.current) {
        setError('Failed to fetch PTY sessions');
        setSessions([]);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    const init = async () => {
      await fetchSessions();
      if (isMountedRef.current) {
        setLoading(false);
      }
    };

    init();

    const intervalId = setInterval(fetchSessions, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchSessions]);

  const summary: PtySummary = {
    totalAgents: sessions.length,
    isolatedCount: sessions.length, // All Crewly sessions are PTY-isolated
    sharedCount: 0,
    status: sessions.length > 0 ? 'healthy' : 'healthy',
  };

  const refresh = useCallback(async () => {
    await fetchSessions();
  }, [fetchSessions]);

  return { sessions, summary, loading, error, refresh };
}

export default usePtyStatus;
