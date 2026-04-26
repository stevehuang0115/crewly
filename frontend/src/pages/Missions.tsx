/**
 * Missions Page -- V3
 *
 * Lists all Missions with status filtering and search.
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
  Calendar,
} from 'lucide-react';
import { Button } from '../components/UI/Button';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import { PageToolbar } from '../components/UI/PageToolbar';
import { Alert } from '../components/UI/Alert';
import { Modal, ModalBody, ModalFooter } from '../components/UI/Modal';
import { SkeletonRows } from '../components/UI/SkeletonRows';
import { FormSelect } from '../components/UI/Form';
import { FilterPillGroup } from '../components/UI/FilterPillGroup';
import { apiService } from '../services/api.service';
import {
  PRIORITY_RANK,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  getMissionStatusType,
  getMissionStatusLabel,
  type MissionStatus,
  type MissionPriority,
  type MissionPeriod,
  type KRStatus,
  type KRMetricType,
  type KeyResultSummary,
} from '../types/mission.types';
import {
  computeKrProgress,
  formatKrValue,
  KR_STATUS_COLOR,
} from '../utils/mission.utils';

// =============================================================================
// Types (KR summaries are only used on this page)
// =============================================================================

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
  learnings?: string[];
  /** Priority for sorting/filtering (optional — missing treated as lowest). */
  priority?: MissionPriority;
  /** OKR time window. */
  period?: MissionPeriod;
  /** Parent mission in the OKR hierarchy (company → team → individual). */
  parentMissionId?: string;
  /** Inline Key Result summaries (server-populated). */
  keyResults?: KeyResultSummary[];
}

/** Primary filter: mission status. */
type StatusFilter = 'all' | MissionStatus;

/** Priority filter including an "all" catch-all. */
type PriorityFilter = 'all' | MissionPriority;

/** Period state relative to "now". */
type PeriodFilter = 'all' | 'current' | 'upcoming' | 'past' | 'none';

// =============================================================================
// Constants
// =============================================================================

const PRIORITY_OPTIONS: { key: PriorityFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

const PERIOD_OPTIONS: { key: PeriodFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'current', label: 'Current' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  { key: 'none', label: 'No period' },
];

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Classifies a mission's period relative to `now`.
 *
 * @param period - Mission period or undefined
 * @param now - Reference timestamp (defaults to current time)
 * @returns One of 'current' | 'upcoming' | 'past' | 'none'
 */
function classifyPeriod(period: MissionPeriod | undefined, now: Date = new Date()): Exclude<PeriodFilter, 'all'> {
  if (!period) return 'none';
  const start = new Date(period.startDate).getTime();
  const end = new Date(period.endDate).getTime();
  const t = now.getTime();
  if (t < start) return 'upcoming';
  if (t >= end) return 'past';
  return 'current';
}

/**
 * Formats a relative time string from an ISO date.
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

/**
 * Renders a compact list of KR progress bars under a mission card.
 *
 * Each row shows: title, current → target, and a coloured progress bar.
 * Returns null when no KRs are attached so the card stays tidy.
 *
 * @param props.missionId - Parent mission ID (used for stable testids)
 * @param props.keyResults - KR summaries to render
 */
const KeyResultsList: React.FC<{ missionId: string; keyResults: KeyResultSummary[] }> = ({
  missionId,
  keyResults,
}) => {
  if (keyResults.length === 0) return null;
  return (
    <div className="mt-3 space-y-1.5" data-testid={`mission-krs-${missionId}`}>
      {keyResults.map((kr) => {
        const progress = computeKrProgress(kr);
        const pct = Math.round(progress * 100);
        return (
          <div
            key={kr.id}
            className="flex flex-col gap-1 rounded-md bg-surface-dark/60 border border-border-dark px-3 py-2"
            data-testid={`mission-kr-${missionId}-${kr.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-text-primary-dark truncate">
                {kr.title}
                {kr.ownerId && (
                  <span className="ml-2 px-1.5 py-0.5 rounded-sm bg-surface-dark text-[10px] text-text-secondary-dark font-mono">
                    @{kr.ownerId.slice(0, 8)}
                  </span>
                )}
              </span>
              <span className="text-[11px] text-text-secondary-dark flex-shrink-0 font-mono">
                {formatKrValue(kr.current, kr.metricType, kr.unit)} /{' '}
                {formatKrValue(kr.target, kr.metricType, kr.unit)}
                <span className="ml-2 opacity-70">({pct}%)</span>
              </span>
            </div>
            <div className="h-1 w-full rounded-full bg-border-dark/40 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${KR_STATUS_COLOR[kr.status]}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Missions list page -- displays all Missions with status/priority/period/team
 * filters and search.
 *
 * @returns Missions page JSX element
 */
export const Missions: React.FC = () => {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('all');
  const [teamFilter, setTeamFilter] = useState<string>('all');
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
      setError(err instanceof Error ? err.message : 'Failed to load missions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMissions();
  }, [loadMissions]);

  /** Map from mission ID → mission, used for rendering parent chips. */
  const missionsById = useMemo(() => {
    const map = new Map<string, Mission>();
    for (const m of missions) map.set(m.id, m);
    return map;
  }, [missions]);

  /** Unique team IDs found across all missions (for team filter). */
  const teamOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const m of missions) {
      if (m.ownerTeamId) seen.add(m.ownerTeamId);
    }
    return [
      { key: 'all', label: 'All' },
      ...Array.from(seen).sort().map((id) => ({
        key: id,
        label: id.length > 16 ? `${id.slice(0, 12)}…` : id,
      })),
    ];
  }, [missions]);

  /** Filtered + sorted missions. */
  const filteredMissions = useMemo(() => {
    let result = missions;

    if (statusFilter !== 'all') {
      result = result.filter((m) => m.status === statusFilter);
    }

    if (priorityFilter !== 'all') {
      result = result.filter((m) => (m.priority ?? 'low') === priorityFilter);
    }

    if (periodFilter !== 'all') {
      result = result.filter((m) => classifyPeriod(m.period) === periodFilter);
    }

    if (teamFilter !== 'all') {
      result = result.filter((m) => m.ownerTeamId === teamFilter);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.objective.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.ownerTeamId.toLowerCase().includes(q) ||
          m.currentStrategy?.toLowerCase().includes(q) ||
          m.period?.label?.toLowerCase().includes(q),
      );
    }

    // Sort: active first → priority rank → updated desc
    return [...result].sort((a, b) => {
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;
      const rankA = PRIORITY_RANK[a.priority ?? 'low'];
      const rankB = PRIORITY_RANK[b.priority ?? 'low'];
      if (rankA !== rankB) return rankA - rankB;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [missions, statusFilter, priorityFilter, periodFilter, teamFilter, searchQuery]);

  /** Status counts for filter badges. */
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
    <div className="p-6 max-w-7xl mx-auto" data-testid="missions-page">
      {/* Page header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-text-primary-dark">Missions</h1>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={Plus}
              onClick={() => setShowCreateModal(true)}
              data-testid="missions-new"
            >
              New Mission
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
          Strategic missions driving autonomous team performance.
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
        searchPlaceholder="Search by mission, team, strategy, period..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchDebounceMs={0}
      />

      {/* Secondary filters: priority / period / team */}
      <div className="flex flex-col gap-2 mb-4" data-testid="missions-secondary-filters">
        <FilterPillGroup<PriorityFilter>
          label="Priority"
          options={PRIORITY_OPTIONS}
          value={priorityFilter}
          onChange={setPriorityFilter}
          testIdPrefix="priority-filter"
        />
        <FilterPillGroup<PeriodFilter>
          label="Period"
          options={PERIOD_OPTIONS}
          value={periodFilter}
          onChange={setPeriodFilter}
          testIdPrefix="period-filter"
        />
        {teamOptions.length > 1 && (
          <FilterPillGroup<string>
            label="Team"
            options={teamOptions}
            value={teamFilter}
            onChange={setTeamFilter}
            testIdPrefix="team-filter"
          />
        )}
      </div>

      {/* Loading */}
      {loading && (
        <div data-testid="missions-loading">
          <SkeletonRows count={3} />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <Alert variant="error" title="Failed to load missions" onClose={() => setError(null)} data-testid="missions-error">
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
              ? 'No missions created yet.'
              : 'No missions match the current filters.'}
          </span>
        </div>
      )}

      {/* Missions list */}
      {!loading && !error && filteredMissions.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="missions-list">
          {filteredMissions.map((mission) => {
            const periodState = classifyPeriod(mission.period);
            const parent = mission.parentMissionId
              ? missionsById.get(mission.parentMissionId)
              : undefined;
            const krs = mission.keyResults ?? [];
            return (
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
                    {mission.parentMissionId && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (parent) navigate(`/missions/${parent.id}`);
                        }}
                        className="mb-1 flex items-center gap-1 text-[11px] text-text-secondary-dark hover:text-primary transition-colors"
                        data-testid={`mission-parent-${mission.id}`}
                      >
                        <span>↳ Child of</span>
                        <span className="font-medium">
                          {parent?.objective ?? mission.parentMissionId.slice(0, 8)}
                        </span>
                      </button>
                    )}
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base font-semibold leading-6 text-text-primary-dark">
                        {mission.objective}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <StatusBadge status={getMissionStatusType(mission.status)}>
                        {getMissionStatusLabel(mission.status)}
                      </StatusBadge>
                      {mission.priority && (
                        <Badge
                          variant={PRIORITY_VARIANT[mission.priority]}
                          size="sm"
                          data-testid={`mission-priority-${mission.id}`}
                        >
                          {PRIORITY_LABEL[mission.priority]}
                        </Badge>
                      )}
                      {mission.period && (
                        <Badge
                          variant={periodState === 'current' ? 'success' : periodState === 'past' ? 'default' : 'info'}
                          size="sm"
                          data-testid={`mission-period-${mission.id}`}
                        >
                          {mission.period.label ?? `${mission.period.type}`}
                        </Badge>
                      )}
                      <Badge variant="default" size="sm">
                        Team: {mission.ownerTeamId.slice(0, 12)}
                      </Badge>
                      <Badge variant="info" size="sm">
                        {mission.activeProjectTaskIds.length} active tasks
                      </Badge>
                      {krs.length > 0 && (
                        <Badge variant="info" size="sm">
                          {krs.length} KR{krs.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                      <span className="text-xs text-text-secondary-dark">
                        Updated {formatRelativeTime(mission.updatedAt)}
                      </span>
                    </div>
                    {mission.currentStrategy && (
                      <p className="text-xs text-text-secondary-dark line-clamp-2">
                        {mission.currentStrategy}
                      </p>
                    )}
                    {krs.length > 0 ? (
                      <KeyResultsList missionId={mission.id} keyResults={krs} />
                    ) : (
                      <SuccessCriteriaPreview criteria={mission.successCriteria ?? []} />
                    )}
                  </div>
                  <span className="text-xs text-text-secondary-dark font-mono flex-shrink-0">
                    {mission.id.slice(0, 8)}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {/* Create Mission Modal */}
      <CreateMissionModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => { setShowCreateModal(false); loadMissions(); }}
        parentOptions={missions.map((m) => ({ id: m.id, objective: m.objective }))}
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
  /** Missions available as a potential parent in the hierarchy. */
  parentOptions: { id: string; objective: string }[];
}

const CreateMissionModal: React.FC<CreateMissionModalProps> = ({ isOpen, onClose, onCreated, parentOptions }) => {
  const [objective, setObjective] = useState('');
  const [ownerTeamId, setOwnerTeamId] = useState('');
  const [cadence, setCadence] = useState('0 9 * * 1');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [priority, setPriority] = useState<MissionPriority>('medium');
  const [parentMissionId, setParentMissionId] = useState<string>('');
  const [periodType, setPeriodType] = useState<MissionPeriodType | ''>('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async () => {
    setFormError('');
    if (!objective.trim()) { setFormError('Objective is required'); return; }
    if (!ownerTeamId.trim()) { setFormError('Team ID is required'); return; }

    try {
      setSubmitting(true);
      
      const period = (periodType && periodStart && periodEnd) ? {
        type: periodType,
        startDate: new Date(periodStart).toISOString(),
        endDate: new Date(periodEnd).toISOString(),
        ...(periodLabel ? { label: periodLabel } : {}),
      } : undefined;

      await apiService.createMission({
        objective: objective.trim(),
        ownerTeamId: ownerTeamId.trim(),
        cadence: cadence.trim() || '0 9 * * 1',
        successCriteria: successCriteria.trim()
          ? successCriteria.split('\n').map(s => s.trim()).filter(Boolean)
          : [],
        priority,
        ...(parentMissionId ? { parentMissionId } : {}),
        ...(period ? { period } : {}),
      });
      setObjective('');
      setOwnerTeamId('');
      setCadence('0 9 * * 1');
      setSuccessCriteria('');
      setPriority('medium');
      setParentMissionId('');
      setPeriodType('');
      setPeriodStart('');
      setPeriodEnd('');
      setPeriodLabel('');
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create mission');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Mission" size="md">
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
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Priority</label>
            <FormSelect
              value={priority}
              onChange={(e) => setPriority(e.target.value as MissionPriority)}
              data-testid="create-mission-priority"
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </FormSelect>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">
              Parent Mission <span className="text-text-secondary-dark font-normal">(optional)</span>
            </label>
            <FormSelect
              value={parentMissionId}
              onChange={(e) => setParentMissionId(e.target.value)}
              data-testid="create-mission-parent"
            >
              <option value="">— No parent (top-level) —</option>
              {parentOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.objective.length > 80 ? opt.objective.slice(0, 80) + '…' : opt.objective}
                </option>
              ))}
            </FormSelect>
            <p className="mt-1 text-xs text-text-secondary-dark">
              Cascade this mission under a company or team-level OKR.
            </p>
          </div>

          <div className="border-t border-border-dark pt-4">
            <label className="block text-sm font-semibold text-text-primary-dark mb-2 flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-text-secondary-dark" />
              OKR Period
            </label>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-secondary-dark mb-1">Type</label>
                <FormSelect
                  value={periodType}
                  onChange={(e) => setPeriodType(e.target.value as MissionPeriodType | '')}
                >
                  <option value="">— No period —</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="custom">Custom</option>
                </FormSelect>
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-secondary-dark mb-1">Label</label>
                <input
                  className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-accent-blue/50"
                  value={periodLabel}
                  onChange={(e) => setPeriodLabel(e.target.value)}
                  placeholder="e.g. Q2 2026"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-secondary-dark mb-1">Start Date</label>
                <input
                  type="date"
                  className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-accent-blue/50"
                  value={periodStart}
                  onChange={(e) => setPeriodStart(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-text-secondary-dark mb-1">End Date</label>
                <input
                  type="date"
                  className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-accent-blue/50"
                  value={periodEnd}
                  onChange={(e) => setPeriodEnd(e.target.value)}
                />
              </div>
            </div>
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
          {submitting ? 'Creating...' : 'Create Mission'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default Missions;
