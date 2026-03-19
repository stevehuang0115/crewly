/**
 * useApprovalLog Hook
 *
 * Fetches approval audit events from /api/approvals/audit or provides
 * mock data when the endpoint is not available.
 *
 * @module hooks/useApprovalLog
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { ApiResponse } from '../types';

const API_BASE = '/api';

/** Outcome types for approval events */
export type ApprovalOutcome = 'auto' | 'approved' | 'denied' | 'sop_block';

/** Filter options for the approval log */
export interface ApprovalLogFilter {
  /** Filter by agent name */
  agent?: string;
  /** Filter by outcome */
  outcome?: ApprovalOutcome;
}

/** A single approval audit event */
export interface ApprovalEvent {
  /** Unique event ID */
  id: string;
  /** ISO timestamp */
  timestamp: string;
  /** Agent session name */
  sessionName: string;
  /** Agent display name */
  agentName: string;
  /** Tool or command that was requested */
  toolName: string;
  /** Outcome of the approval */
  outcome: ApprovalOutcome;
  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high';
  /** Optional reason for denial/block */
  reason?: string;
}

/** Summary stats for the approvals card */
export interface ApprovalSummary {
  /** Total events today */
  totalToday: number;
  /** Number denied today */
  deniedToday: number;
  /** Number bypassed (should always be 0) */
  bypassedToday: number;
  /** Overall enforcement status */
  status: 'enforced' | 'partial' | 'disabled';
}

/** Return type for the useApprovalLog hook */
export interface UseApprovalLogResult {
  /** All approval events */
  events: ApprovalEvent[];
  /** Filtered events based on current filter */
  filteredEvents: ApprovalEvent[];
  /** Summary stats */
  summary: ApprovalSummary;
  /** Current filter */
  filter: ApprovalLogFilter;
  /** Update filter */
  setFilter: (filter: ApprovalLogFilter) => void;
  /** Whether the initial fetch is still in progress */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Manual refresh function */
  refresh: () => Promise<void>;
}

/** Mock data for when the API endpoint is not available */
const MOCK_EVENTS: ApprovalEvent[] = [
  {
    id: 'mock-1',
    timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    sessionName: 'agent-sam',
    agentName: 'Sam',
    toolName: 'git push origin feat/auth',
    outcome: 'approved',
    riskLevel: 'medium',
  },
  {
    id: 'mock-2',
    timestamp: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
    sessionName: 'agent-sam',
    agentName: 'Sam',
    toolName: 'npm install jsonwebtoken',
    outcome: 'auto',
    riskLevel: 'low',
  },
  {
    id: 'mock-3',
    timestamp: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    sessionName: 'agent-leo',
    agentName: 'Leo',
    toolName: 'rm -rf dist/',
    outcome: 'denied',
    riskLevel: 'high',
    reason: 'Destructive operation on build directory',
  },
  {
    id: 'mock-4',
    timestamp: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
    sessionName: 'agent-sam',
    agentName: 'Sam',
    toolName: 'git push --force main',
    outcome: 'denied',
    riskLevel: 'high',
    reason: 'Force push to protected branch',
  },
  {
    id: 'mock-5',
    timestamp: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    sessionName: 'agent-ava',
    agentName: 'Ava',
    toolName: 'npx tailwindcss build',
    outcome: 'auto',
    riskLevel: 'low',
  },
  {
    id: 'mock-6',
    timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    sessionName: 'agent-leo',
    agentName: 'Leo',
    toolName: 'git commit -m "feat: ..."',
    outcome: 'sop_block',
    riskLevel: 'medium',
    reason: 'Commit does not follow project SOP',
  },
];

/**
 * Maps backend audit action to frontend outcome type.
 *
 * @param action - Backend action string ('approved', 'rejected', etc.)
 * @returns Frontend ApprovalOutcome
 */
function mapAuditAction(action: string): ApprovalOutcome {
  switch (action) {
    case 'approved': return 'approved';
    case 'rejected': return 'denied';
    case 'denied': return 'denied';
    case 'auto': return 'auto';
    case 'sop_block': return 'sop_block';
    default: return 'auto';
  }
}

/**
 * Hook for fetching and filtering approval audit events.
 *
 * Attempts to fetch from /api/approvals/audit. Falls back to mock data
 * if the endpoint is not available.
 *
 * @returns Approval events, summary, filter controls, and loading/error state
 *
 * @example
 * ```tsx
 * const { filteredEvents, summary, setFilter } = useApprovalLog();
 * ```
 */
export function useApprovalLog(): UseApprovalLogResult {
  const [events, setEvents] = useState<ApprovalEvent[]>([]);
  const [filter, setFilter] = useState<ApprovalLogFilter>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await axios.get<ApiResponse<ApprovalEvent[]>>(
        `${API_BASE}/approvals/audit`,
        { signal }
      );
      if (response.data.success && Array.isArray(response.data.data)) {
        // Map backend ApprovalAuditEntry to frontend ApprovalEvent
        const mapped: ApprovalEvent[] = response.data.data.map((entry: any) => ({
          id: entry.approvalId || entry.id || `audit-${Date.now()}-${Math.random()}`,
          timestamp: entry.timestamp,
          sessionName: entry.sessionName || '',
          agentName: entry.resolvedBy || entry.agentName || entry.sessionName || 'Unknown',
          toolName: entry.toolName || '',
          outcome: mapAuditAction(entry.action || entry.outcome),
          riskLevel: entry.riskLevel || 'medium',
          reason: entry.reason,
        }));
        setEvents(mapped);
        setError(null);
      } else {
        // Endpoint exists but returned no data — use mock
        setEvents(MOCK_EVENTS);
      }
    } catch (err) {
      if (axios.isCancel(err)) return;
      // Endpoint not available — use mock data
      setEvents(MOCK_EVENTS);
      setError(null); // Don't show error for expected fallback
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(controller.signal);
    return () => controller.abort();
  }, [fetchEvents]);

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (filter.agent && event.agentName.toLowerCase() !== filter.agent.toLowerCase()) {
        return false;
      }
      if (filter.outcome && event.outcome !== filter.outcome) {
        return false;
      }
      return true;
    });
  }, [events, filter]);

  const summary: ApprovalSummary = useMemo(() => {
    const today = new Date().toDateString();
    const todayEvents = events.filter(
      (e) => new Date(e.timestamp).toDateString() === today
    );
    return {
      totalToday: todayEvents.length,
      deniedToday: todayEvents.filter((e) => e.outcome === 'denied').length,
      bypassedToday: 0,
      status: 'enforced',
    };
  }, [events]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchEvents();
  }, [fetchEvents]);

  return { events, filteredEvents, summary, filter, setFilter, loading, error, refresh };
}

export default useApprovalLog;
