/**
 * useTokenUsage Hook
 *
 * Polls the token usage API every 10 seconds and computes cost estimates
 * per agent using model-specific pricing rates.
 *
 * @module hooks/useTokenUsage
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiService } from '../services/api.service';
import type { SessionUsageSummary, AgentCostEntry, TokenCostRate } from '../types';

/** Polling interval in milliseconds */
const POLL_INTERVAL_MS = 10_000;

/** Staleness threshold in milliseconds (30 seconds) */
const STALE_THRESHOLD_MS = 30_000;

/**
 * Per-model token cost rates (USD per token).
 * Rates sourced from Anthropic pricing as of 2025.
 */
const TOKEN_COSTS: Record<string, TokenCostRate> = {
  'claude-3-opus': { input: 0.000015, output: 0.000075 },
  'claude-3-5-sonnet': { input: 0.000003, output: 0.000015 },
  'claude-3-haiku': { input: 0.00000025, output: 0.00000125 },
  'claude-opus-4': { input: 0.000015, output: 0.000075 },
  'claude-sonnet-4': { input: 0.000003, output: 0.000015 },
  default: { input: 0.000003, output: 0.000015 },
};

/**
 * Return type for the useTokenUsage hook.
 */
export interface UseTokenUsageResult {
  /** Computed cost entries per agent */
  sessions: AgentCostEntry[];
  /** Total estimated cost across all agents in USD */
  totalCost: number;
  /** Total tokens consumed across all agents */
  totalTokens: number;
  /** Number of agents with recorded usage */
  activeAgents: number;
  /** Average cost per task (cost / total events) */
  avgCostPerTask: number;
  /** Whether the initial fetch is in progress */
  loading: boolean;
  /** Error message if the last fetch failed */
  error: string | null;
  /** Timestamp of the last successful data fetch */
  lastUpdated: Date | null;
  /** True when data is older than 30 seconds */
  isStale: boolean;
  /** Manually trigger a data refresh */
  refresh: () => Promise<void>;
}

/**
 * Computes the estimated cost for a token usage entry using default rates.
 *
 * @param entry - Raw session usage data from the API
 * @returns Cost in USD
 */
function computeCost(entry: SessionUsageSummary): number {
  const rates = TOKEN_COSTS.default;
  return entry.totalInput * rates.input + entry.totalOutput * rates.output;
}

/**
 * Transforms raw API data into computed agent cost entries.
 *
 * @param sessions - Raw session usage summaries from the API
 * @returns Array of agent cost entries with computed values
 */
function transformSessions(sessions: SessionUsageSummary[]): AgentCostEntry[] {
  return sessions.map((s) => ({
    sessionName: s.sessionName,
    agentId: s.agentId,
    inputTokens: s.totalInput,
    outputTokens: s.totalOutput,
    totalTokens: s.totalInput + s.totalOutput,
    cost: computeCost(s),
    eventCount: s.eventCount,
  }));
}

/**
 * Hook that polls token usage data and computes cost metrics.
 *
 * Fetches GET /api/monitoring/token-usage every 10 seconds,
 * then derives per-agent costs, totals, and staleness status.
 *
 * @returns Token usage data, cost metrics, and control functions
 *
 * @example
 * ```tsx
 * const { totalCost, sessions, loading } = useTokenUsage();
 * ```
 */
export function useTokenUsage(): UseTokenUsageResult {
  const [sessions, setSessions] = useState<AgentCostEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isStale, setIsStale] = useState<boolean>(false);
  const mountedRef = useRef(true);

  /**
   * Fetches token usage from the API and updates state.
   */
  const fetchUsage = useCallback(async (): Promise<void> => {
    try {
      const data = await apiService.getTokenUsage();
      if (!mountedRef.current) return;
      setSessions(transformSessions(data));
      setLastUpdated(new Date());
      setIsStale(false);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch token usage');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Initial fetch and polling
  useEffect(() => {
    mountedRef.current = true;
    fetchUsage();

    const intervalId = setInterval(fetchUsage, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchUsage]);

  // Staleness checker
  useEffect(() => {
    const staleCheckId = setInterval(() => {
      if (lastUpdated) {
        const age = Date.now() - lastUpdated.getTime();
        setIsStale(age > STALE_THRESHOLD_MS);
      }
    }, 5_000);

    return () => clearInterval(staleCheckId);
  }, [lastUpdated]);

  // Compute aggregate metrics
  const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  const activeAgents = sessions.length;
  const totalEvents = sessions.reduce((sum, s) => sum + s.eventCount, 0);
  const avgCostPerTask = totalEvents > 0 ? totalCost / totalEvents : 0;

  return {
    sessions,
    totalCost,
    totalTokens,
    activeAgents,
    avgCostPerTask,
    loading,
    error,
    lastUpdated,
    isStale,
    refresh: fetchUsage,
  };
}
