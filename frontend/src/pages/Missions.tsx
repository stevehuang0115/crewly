/**
 * Missions Page -- V3
 *
 * Lists all Missions (displayed as "Objectives") with status filtering and search.
 * Fetches real data from GET /api/missions.
 *
 * @module pages/Missions
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw,
  Target,
  Search,
  Plus,
} from 'lucide-react';
import { Button } from '../components/UI/Button';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import type { StatusType } from '../components/UI/StatusBadge';
import type { BadgeVariant } from '../components/UI/Badge';
import { SkeletonRows } from '../components/UI/SkeletonRows';
import { apiService } from '../services/api.service';

// =============================================================================
// Types (mirrors backend/src/types/v2/mission.types.ts)
// =============================================================================

/** Mission lifecycle statuses. */
type MissionStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * Frontend representation of a Mission.
 */
interface Mission {
  /** UUID v4 */
  id: string;
  /** What this mission aims to achieve */
  objective: string;
  /** Team that owns this mission */
  ownerTeamId: string;
  /** Measurable criteria for success */
  successCriteria: string[];
  /** Current strategic approach */
  currentStrategy: string;
  /** Active ProjectTask IDs under this mission */
  activeProjectTaskIds: string[];
  /** Review cadence (cron expression) */
  cadence: string;
  /** Lifecycle status */
  status: MissionStatus;
  /** ISO8601 timestamps */
  createdAt: string;
  updatedAt: string;
  /** Last planning review */
  lastReviewAt?: string;
  /** Next scheduled planning review */
  nextReviewAt?: string;
  /** Accumulated learnings */
  learnings: string[];
}

/** Filter options for the Missions list */
type StatusFilter = 'all' | MissionStatus;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Maps a mission status to a StatusBadge-compatible StatusType.
 *
 * @param status - The mission status
 * @returns StatusType for the UI StatusBadge component
 */
function getMissionStatusType(status: MissionStatus): StatusType {
  const mapping: Record<MissionStatus, StatusType> = {
    active: 'active',
    paused: 'paused',
    completed: 'completed',
    cancelled: 'inactive',
  };
  return mapping[status] ?? 'pending';
}

/**
 * Returns a human-readable label for a mission status.
 *
 * @param status - The mission status
 * @returns Display label string
 */
function getMissionStatusLabel(status: MissionStatus): string {
  const labels: Record<MissionStatus, string> = {
    active: 'Active',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}

/**
 * Formats a relative time string from an ISO date.
 *
 * @param isoDate - ISO date string
 * @returns Human-readable relative time
 */
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

// =============================================================================
// Sub-components
// =============================================================================

/**
 * Renders success criteria badges for a mission with expand/collapse toggle.
 * Shows up to 3 criteria by default with a clickable "+N more" to reveal all.
 *
 * @param props.criteria - Array of success criteria strings
 */
const SuccessCriteriaPreview: React.FC<{ criteria: string[] }> = ({ criteria }) => {
  const [expanded, setExpanded] = useState(false);

  if (criteria.length === 0) return null;

  const visibleCriteria = expanded ? criteria : criteria.slice(0, 3);
  const hiddenCount = criteria.length - 3;

  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      {visibleCriteria.map((sc, idx) => (
        <Badge key={idx} variant="default" size="md">
          {sc.length > 40 ? sc.slice(0, 40) + '...' : sc}
        </Badge>
      ))}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
        >
          +{hiddenCount} more
        </button>
      )}
      {expanded && criteria.length > 3 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(false);
          }}
          className="text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer"
        >
          Show less
        </button>
      )}
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Objectives list page -- displays all Missions as "Objectives" with status filters and search.
 *
 * @returns Objectives page JSX element
 */
export const Missions: React.FC = () => {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Fetches all missions from the backend.
   */
  const loadMissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiService.getMissions();
      setMissions(data as Mission[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load objectives');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMissions();
  }, [loadMissions]);

  /** Filtered missions based on status and search */
  const filteredMissions = useMemo(() => {
    let result = missions;

    if (statusFilter !== 'all') {
      result = result.filter((m) => m.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.objective.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.ownerTeamId.toLowerCase().includes(q) ||
          m.currentStrategy.toLowerCase().includes(q),
      );
    }

    // Sort newest first
    return result.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }, [missions, statusFilter, searchQuery]);

  /** Status counts for filter badges */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: missions.length };
    for (const m of missions) {
      counts[m.status] = (counts[m.status] || 0) + 1;
    }
    return counts;
  }, [missions]);

  const filterButtons: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto" data-testid="missions-page">
      {/* Page header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-text-primary-dark">Objectives</h1>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={Plus}
              onClick={() => navigate('/missions/new')}
              data-testid="missions-new"
            >
              New Objective
            </Button>
            <button
              onClick={loadMissions}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark bg-surface-dark border border-border-dark rounded-lg transition-colors disabled:opacity-50"
              data-testid="missions-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>
        <p className="text-sm text-text-secondary-dark">
          Strategic goals and long-term objectives driving autonomous team performance.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Status filter buttons */}
        <div className="flex items-center gap-1 flex-wrap">
          {filterButtons.map((fb) => (
            <button
              key={fb.key}
              onClick={() => setStatusFilter(fb.key)}
              className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                statusFilter === fb.key
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : 'bg-surface-dark text-text-secondary-dark border-border-dark hover:text-text-primary-dark'
              }`}
              data-testid={`filter-${fb.key}`}
            >
              {fb.label}
              {statusCounts[fb.key] !== undefined && (
                <span className="ml-1 opacity-60">({statusCounts[fb.key]})</span>
              )}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-[400px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-secondary-dark" />
          <input
            type="text"
            placeholder="Search by objective, team, strategy..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-surface-dark border border-border-dark rounded-lg text-text-primary-dark placeholder:text-text-secondary-dark focus:outline-none focus:border-primary/50"
            data-testid="missions-search"
          />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div data-testid="missions-loading">
          <SkeletonRows count={3} />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <Card variant="default" padding="lg" data-testid="missions-error">
          <div className="text-center py-8">
            <p className="text-red-400 mb-2">{error}</p>
            <button
              onClick={loadMissions}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              Retry
            </button>
          </div>
        </Card>
      )}

      {/* Empty state */}
      {!loading && !error && filteredMissions.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-secondary-dark" data-testid="missions-empty">
          <Target className="h-10 w-10 opacity-40" />
          <span className="text-sm">
            {missions.length === 0
              ? 'No objectives created yet.'
              : 'No objectives match the current filters.'}
          </span>
        </div>
      )}

      {/* Missions list */}
      {!loading && !error && filteredMissions.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="missions-list">
          {filteredMissions.map((mission) => (
            <Card
              key={mission.id}
              variant="default"
              padding="md"
              className="border border-border-dark cursor-pointer hover:border-primary/30 transition-colors"
              data-testid={`mission-row-${mission.id}`}
              onClick={() => navigate(`/missions/${mission.id}`)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-semibold leading-6 text-text-primary-dark">
                      {mission.objective}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <StatusBadge status={getMissionStatusType(mission.status)}>
                      {getMissionStatusLabel(mission.status)}
                    </StatusBadge>
                    <Badge variant="default" size="sm">
                      Team: {mission.ownerTeamId.slice(0, 12)}
                    </Badge>
                    <Badge variant="info" size="sm">
                      {mission.activeProjectTaskIds.length} active tasks
                    </Badge>
                    <span className="text-xs text-text-secondary-dark">
                      Updated {formatRelativeTime(mission.updatedAt)}
                    </span>
                  </div>
                  {/* Strategy summary */}
                  <p className="text-xs text-text-secondary-dark line-clamp-2">
                    {mission.currentStrategy}
                  </p>
                  {/* Success criteria preview with expand toggle */}
                  <SuccessCriteriaPreview criteria={mission.successCriteria} />
                </div>
                <span className="text-xs text-text-secondary-dark font-mono flex-shrink-0">
                  {mission.id.slice(0, 8)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

Missions.displayName = 'Missions';

export default Missions;
