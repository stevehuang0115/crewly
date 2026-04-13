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
  Plus,
} from 'lucide-react';
import { Button } from '../components/UI/Button';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import type { StatusType } from '../components/UI/StatusBadge';
import type { BadgeVariant } from '../components/UI/Badge';
import { PageToolbar } from '../components/UI/PageToolbar';
import { Alert } from '../components/UI/Alert';
import { Modal, ModalBody, ModalFooter } from '../components/UI/Modal';
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
  const [showCreateModal, setShowCreateModal] = useState(false);

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
              onClick={() => setShowCreateModal(true)}
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
      <PageToolbar
        tabs={filterButtons.map((fb) => ({
          value: fb.key,
          label: fb.label,
          count: statusCounts[fb.key],
        }))}
        activeTab={statusFilter}
        onTabChange={(v) => setStatusFilter(v as StatusFilter)}
        searchPlaceholder="Search by objective, team, strategy..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchDebounceMs={0}
      />

      {/* Loading */}
      {loading && (
        <div data-testid="missions-loading">
          <SkeletonRows count={3} />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <Alert variant="error" title="Failed to load objectives" onClose={() => setError(null)} data-testid="missions-error">
          {error}
          <Button variant="ghost" size="sm" onClick={loadMissions} className="mt-2">
            Retry
          </Button>
        </Alert>
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
      {/* Create Objective Modal */}
      <CreateMissionModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => { setShowCreateModal(false); loadMissions(); }}
      />
    </div>
  );
};

Missions.displayName = 'Missions';

// =============================================================================
// Create Mission Modal
// =============================================================================

interface CreateMissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const CreateMissionModal: React.FC<CreateMissionModalProps> = ({ isOpen, onClose, onCreated }) => {
  const [objective, setObjective] = useState('');
  const [ownerTeamId, setOwnerTeamId] = useState('');
  const [cadence, setCadence] = useState('0 9 * * 1');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async () => {
    setFormError('');
    if (!objective.trim()) { setFormError('Objective is required'); return; }
    if (!ownerTeamId.trim()) { setFormError('Team ID is required'); return; }

    try {
      setSubmitting(true);
      await apiService.createMission({
        objective: objective.trim(),
        ownerTeamId: ownerTeamId.trim(),
        cadence: cadence.trim() || '0 9 * * 1',
        successCriteria: successCriteria.trim()
          ? successCriteria.split('\n').map(s => s.trim()).filter(Boolean)
          : [],
      });
      setObjective('');
      setOwnerTeamId('');
      setCadence('0 9 * * 1');
      setSuccessCriteria('');
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create objective');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Objective" size="md">
      <ModalBody>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Objective</label>
            <input
              className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-accent-blue/50"
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="What should this team achieve?"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Owner Team ID</label>
            <input
              className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark font-mono focus:outline-none focus:border-accent-blue/50"
              value={ownerTeamId}
              onChange={(e) => setOwnerTeamId(e.target.value)}
              placeholder="e.g. crewly-product-leo"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Review Cadence (cron)</label>
            <input
              className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark font-mono focus:outline-none focus:border-accent-blue/50"
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
              placeholder="0 9 * * 1"
            />
            <p className="mt-1 text-xs text-text-secondary-dark">How often the system reviews progress (default: weekly Monday 9am)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Success Criteria (one per line)</label>
            <textarea
              className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark resize-none focus:outline-none focus:border-accent-blue/50"
              rows={3}
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder={"All tests passing\nDeployed to staging\n95% code coverage"}
            />
          </div>

          {formError && (
            <Alert variant="error">{formError}</Alert>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} disabled={submitting}>
          {submitting ? 'Creating...' : 'Create Objective'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default Missions;
