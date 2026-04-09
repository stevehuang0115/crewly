/**
 * Mission Detail Page
 *
 * Displays the full details of a single Mission including objective,
 * status, team, strategy, success criteria, and timestamps.
 * Fetches real data from GET /api/missions/:id.
 *
 * @module pages/MissionDetail
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  Target,
  Calendar,
  Clock,
  Users,
  CheckCircle2,
  BookOpen,
  ListChecks,
} from 'lucide-react';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import type { StatusType } from '../components/UI/StatusBadge';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import { Button } from '../components/UI/Button';
import { apiService } from '../services/api.service';

// =============================================================================
// Types
// =============================================================================

/** Mission lifecycle statuses. */
type MissionStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/**
 * Full Mission object returned by the API.
 */
interface Mission {
  id: string;
  objective: string;
  ownerTeamId: string;
  successCriteria: string[];
  currentStrategy: string;
  activeProjectTaskIds: string[];
  cadence: string;
  status: MissionStatus;
  createdAt: string;
  updatedAt: string;
  lastReviewAt?: string;
  nextReviewAt?: string;
  learnings: string[];
}

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
 * Formats an ISO date string to a readable date/time.
 *
 * @param isoDate - ISO date string
 * @returns Formatted date string
 */
function formatDateTime(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}

// =============================================================================
// Component
// =============================================================================

/**
 * MissionDetail page -- displays full details for a single mission.
 *
 * @returns MissionDetail page JSX element
 */
export const MissionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  /**
   * Fetches the mission from the backend API.
   *
   * @param showLoadingSpinner - Whether to show the full loading state
   */
  const loadMission = useCallback(
    async (showLoadingSpinner = true) => {
      if (!id) return;

      if (showLoadingSpinner) setLoading(true);
      else setRefreshing(true);

      setError(null);

      try {
        const data = await apiService.getMission(id);
        setMission(data as Mission);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load mission';
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id],
  );

  useEffect(() => {
    loadMission();
  }, [loadMission]);

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="xl" text="Loading objective..." />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------
  if (error) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto" data-testid="mission-detail-error">
        <button
          onClick={() => navigate('/missions')}
          className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Objectives
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8">
            <p className="text-red-400 mb-2">{error}</p>
            <button
              onClick={() => loadMission()}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Not found state
  // ---------------------------------------------------------------------------
  if (!mission) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto">
        <button
          onClick={() => navigate('/missions')}
          className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Objectives
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8 text-text-secondary-dark">
            <Target className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>Objective not found.</p>
          </div>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------
  return (
    <div className="p-6 max-w-[1000px] mx-auto" data-testid="mission-detail-page">
      {/* Back navigation */}
      <button
        onClick={() => navigate('/missions')}
        className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        data-testid="mission-detail-back"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Objectives
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-text-primary-dark mb-2">
            {mission.objective}
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={getMissionStatusType(mission.status)}>
              {getMissionStatusLabel(mission.status)}
            </StatusBadge>
            <Badge variant="default" size="sm">
              {mission.id.slice(0, 12)}
            </Badge>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          onClick={() => loadMission(false)}
          disabled={refreshing}
          className={refreshing ? 'animate-spin' : ''}
          aria-label="Refresh mission"
        >
          Refresh
        </Button>
      </div>

      {/* Content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content (left 2 cols) */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Strategy */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Target className="h-4 w-4" />
              Current Strategy
            </h2>
            <p className="text-sm text-text-primary-dark leading-relaxed whitespace-pre-wrap">
              {mission.currentStrategy || 'No strategy defined.'}
            </p>
          </Card>

          {/* Success Criteria */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              Success Criteria ({mission.successCriteria.length})
            </h2>
            {mission.successCriteria.length === 0 ? (
              <p className="text-sm text-text-secondary-dark">
                No success criteria defined.
              </p>
            ) : (
              <ul className="space-y-2">
                {mission.successCriteria.map((criterion, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-2 text-sm text-text-primary-dark"
                  >
                    <span className="text-primary mt-0.5 flex-shrink-0">
                      <ListChecks className="h-4 w-4" />
                    </span>
                    {criterion}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Learnings */}
          {mission.learnings && mission.learnings.length > 0 && (
            <Card variant="default" padding="md" className="border border-border-dark">
              <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <BookOpen className="h-4 w-4" />
                Learnings ({mission.learnings.length})
              </h2>
              <ul className="space-y-2">
                {mission.learnings.map((learning, idx) => (
                  <li
                    key={idx}
                    className="text-sm text-text-primary-dark pl-4 border-l-2 border-border-dark"
                  >
                    {learning}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* Sidebar (right col) */}
        <div className="flex flex-col gap-4">
          {/* Team & Tasks */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              Team & Tasks
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Owner Team</span>
                <span className="text-text-primary-dark font-mono text-xs">
                  {mission.ownerTeamId.slice(0, 12)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Active Tasks</span>
                <span className="text-text-primary-dark">
                  {mission.activeProjectTaskIds.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Cadence</span>
                <span className="text-text-primary-dark font-mono text-xs">
                  {mission.cadence || 'N/A'}
                </span>
              </div>
            </div>
          </Card>

          {/* Timestamps */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              Timestamps
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Created</span>
                <span className="text-text-primary-dark text-xs">
                  {formatDateTime(mission.createdAt)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Updated</span>
                <span className="text-text-primary-dark text-xs">
                  {formatDateTime(mission.updatedAt)}
                </span>
              </div>
              {mission.lastReviewAt && (
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Last Review</span>
                  <span className="text-text-primary-dark text-xs">
                    {formatDateTime(mission.lastReviewAt)}
                  </span>
                </div>
              )}
              {mission.nextReviewAt && (
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Next Review</span>
                  <span className="text-text-primary-dark text-xs">
                    {formatDateTime(mission.nextReviewAt)}
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Active Task IDs */}
          {mission.activeProjectTaskIds.length > 0 && (
            <Card variant="default" padding="md" className="border border-border-dark">
              <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Clock className="h-4 w-4" />
                Active Task IDs
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {mission.activeProjectTaskIds.map((taskId) => (
                  <Badge key={taskId} variant="default" size="sm">
                    {taskId.slice(0, 12)}
                  </Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

MissionDetail.displayName = 'MissionDetail';

export default MissionDetail;
