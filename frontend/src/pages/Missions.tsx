/**
 * Missions Page -- V3
 *
 * Lists all Missions grouped by OKR cascade level (company → team → project),
 * with status filtering and search. Fetches real data from GET /api/missions
 * and the cascade roll-up from GET /api/missions/:id/okr-summary/cascade.
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
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { Badge } from '@crewly/ui/Badge';
import { StatusBadge } from '@crewly/ui/StatusBadge';
import { PageToolbar } from '@crewly/ui/PageToolbar';
import { Alert } from '@crewly/ui/Alert';
import { Modal, ModalBody, ModalFooter } from '@crewly/ui/Modal';
import { SkeletonRows } from '@crewly/ui/SkeletonRows';
import { FormSelect, FormInput, FormTextarea } from '@crewly/ui/Form';
import { FilterPillGroup } from '@crewly/ui/FilterPillGroup';
import { LevelBadge, ApprovalChip, KrStatusCountsRow, ProgressBar } from '../components/Missions/OkrBadges';
import { ApprovalActions } from '../components/Missions/ApprovalActions';
import { apiService } from '../services/api.service';
import type { Project, Team } from '../types';
import {
  PRIORITY_RANK,
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  LEVEL_LABEL,
  MISSION_LEVELS,
  PARENT_LEVEL,
  getMissionStatusType,
  getMissionStatusLabel,
  buildMissionTree,
  resolveLevel,
  computeKrProgressPercent,
  formatKrValue,
  countKrStatuses,
  summaryToKrStatusCounts,
  flattenCascadeSummary,
  KR_STATUS_COLOR,
  type Mission,
  type MissionLevel,
  type MissionStatus,
  type MissionPriority,
  type MissionPeriod,
  type MissionTreeNode,
  type KeyResultSummary,
  type CascadeOKRSummary,
} from '../types/mission.types';

// =============================================================================
// Types
// =============================================================================

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
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
        >
          +{hiddenCount} more
        </Button>
      )}
      {expanded && criteria.length > 3 && (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(false);
          }}
        >
          Show less
        </Button>
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
        const pct = Math.round(computeKrProgressPercent(kr));
        return (
          <div
            key={kr.id}
            className="flex flex-col gap-1 rounded-md bg-surface-dark/60 border border-border-dark px-3 py-2"
            data-testid={`mission-kr-${missionId}-${kr.id}`}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-text-primary-dark truncate">
                {kr.title}
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
// Helpers
// =============================================================================

/**
 * Sort comparator shared by every sibling group in the tree:
 * active first → priority rank → updated desc.
 */
function compareMissions(a: Mission, b: Mission): number {
  if (a.status === 'active' && b.status !== 'active') return -1;
  if (a.status !== 'active' && b.status === 'active') return 1;
  const rankA = PRIORITY_RANK[a.priority ?? 'low'];
  const rankB = PRIORITY_RANK[b.priority ?? 'low'];
  if (rankA !== rankB) return rankA - rankB;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/**
 * Own progress (0–100) computed from inline KR summaries; `null` when the
 * mission has no KRs so the row can hide the bar.
 */
function ownProgressFromKrs(krs: readonly KeyResultSummary[]): number | null {
  if (krs.length === 0) return null;
  const total = krs.reduce((sum, kr) => sum + computeKrProgressPercent(kr), 0);
  return total / krs.length;
}

/** Row-level data derived once per mission (level, cascade summary, progress). */
interface MissionRowContext {
  missionsById: ReadonlyMap<string, Mission>;
  cascadeById: ReadonlyMap<string, CascadeOKRSummary>;
  teamNames: ReadonlyMap<string, string>;
  onDecided: (mission: Mission) => void;
  navigate: (path: string) => void;
}

/** Left indent (px) applied per nesting depth. */
const TREE_INDENT_PX = 24;

// =============================================================================
// Mission row (recursive)
// =============================================================================

/**
 * Renders one mission card followed by its nested children.
 */
const MissionRow: React.FC<{ node: MissionTreeNode<Mission>; depth: number; ctx: MissionRowContext }> = ({
  node,
  depth,
  ctx,
}) => {
  const { mission } = node;
  const { missionsById, cascadeById, teamNames, onDecided, navigate } = ctx;
  const periodState = classifyPeriod(mission.period);
  const parentInTree = mission.parentMissionId ? missionsById.get(mission.parentMissionId) : undefined;
  const showParentChip = depth === 0 && !!mission.parentMissionId;
  const krs = mission.keyResults ?? [];
  const level = resolveLevel(mission, missionsById);
  const cascade = cascadeById.get(mission.id);
  const rolledUp = cascade ? cascade.rolledUpProgress : ownProgressFromKrs(krs);
  const counts = cascade && cascade.totalKRs > 0 ? summaryToKrStatusCounts(cascade) : countKrStatuses(krs);
  const approvalState = mission.approval?.state;
  const showApproval = !!approvalState && (approvalState !== 'approved' || !!mission.approval?.decidedAt);
  const teamName = teamNames.get(mission.ownerTeamId) ?? mission.ownerTeamId;

  return (
    <div data-testid={`mission-node-${mission.id}`} style={{ marginLeft: depth * TREE_INDENT_PX }}>
      <Card
        variant="default"
        padding="md"
        className={`border cursor-pointer transition-colors ${
          approvalState === 'pending_approval'
            ? 'border-yellow-500/40 hover:border-yellow-500/70'
            : 'border-border-dark hover:border-primary/30'
        } ${depth > 0 ? 'border-l-2 border-l-primary/30' : ''}`}
        data-testid={`mission-row-${mission.id}`}
        onClick={() => navigate(`/missions/${mission.id}`)}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {showParentChip && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (mission.parentMissionId) navigate(`/missions/${mission.parentMissionId}`);
                }}
                className="mb-1 flex items-center gap-1 text-[11px] text-text-secondary-dark hover:text-primary transition-colors"
                data-testid={`mission-parent-${mission.id}`}
              >
                <span>↳ Child of</span>
                <span className="font-medium">
                  {parentInTree?.objective ?? mission.parentMissionId?.slice(0, 8)}
                </span>
              </button>
            )}
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <LevelBadge level={level} />
              <span className="text-base font-semibold leading-6 text-text-primary-dark">
                {mission.objective}
              </span>
              {showApproval && approvalState && <ApprovalChip state={approvalState} />}
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
              <Badge variant="default" size="sm" data-testid={`mission-team-${mission.id}`}>
                Team: {teamName.length > 24 ? `${teamName.slice(0, 22)}…` : teamName}
              </Badge>
              <Badge variant="info" size="sm">
                {mission.activeProjectTaskIds.length} active tasks
              </Badge>
              {krs.length > 0 && (
                <Badge variant="info" size="sm">
                  {krs.length} KR{krs.length === 1 ? '' : 's'}
                </Badge>
              )}
              {mission.cadence && (
                <span
                  className="text-[11px] font-mono text-text-secondary-dark"
                  title="Review cadence (cron)"
                  data-testid={`mission-cadence-${mission.id}`}
                >
                  ⏱ {mission.cadence}
                </span>
              )}
              <span className="text-xs text-text-secondary-dark">
                Updated {formatRelativeTime(mission.updatedAt)}
              </span>
            </div>

            {/* Roll-up + KR status counts */}
            {(rolledUp !== null || cascade) && (
              <div className="mb-2 flex flex-col gap-1" data-testid={`mission-rollup-${mission.id}`}>
                <ProgressBar
                  percent={rolledUp ?? 0}
                  label={cascade && cascade.childMissionCount > 0 ? `Rolled-up (${cascade.childMissionCount} child${cascade.childMissionCount === 1 ? '' : 'ren'})` : 'Progress'}
                  data-testid={`mission-progress-${mission.id}`}
                />
                <KrStatusCountsRow counts={counts} />
              </div>
            )}

            {approvalState === 'pending_approval' && (
              <div className="mb-2">
                <ApprovalActions missionId={mission.id} onDecided={onDecided} />
              </div>
            )}

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

      {node.children.length > 0 && (
        <div className="mt-2 flex flex-col gap-2" data-testid={`mission-children-${mission.id}`}>
          {node.children.map((child) => (
            <MissionRow key={child.mission.id} node={child} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

/**
 * Missions list page -- displays all Missions as a company → team → project
 * tree with status/priority/period/team filters and search.
 *
 * @returns Missions page JSX element
 */
export const Missions: React.FC = () => {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [cascadeById, setCascadeById] = useState<Map<string, CascadeOKRSummary>>(new Map());
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('all');
  const [teamFilter, setTeamFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  /**
   * Fetches the cascade roll-up for every root mission and flattens the
   * subtrees into a single id → summary map. Non-fatal: a failed root just
   * falls back to inline-KR progress for that subtree.
   */
  const loadCascades = useCallback(async (list: Mission[]) => {
    const ids = new Set(list.map((m) => m.id));
    const roots = list.filter((m) => !m.parentMissionId || !ids.has(m.parentMissionId));
    const next = new Map<string, CascadeOKRSummary>();
    await Promise.all(
      roots.map(async (root) => {
        try {
          const summary = await apiService.getCascadeSummary(root.id);
          flattenCascadeSummary(summary, next);
        } catch {
          // fall back to inline KR progress for this subtree
        }
      }),
    );
    setCascadeById(next);
  }, []);

  /**
   * Fetches all missions from the backend, then the cascade roll-ups.
   */
  const loadMissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await apiService.getMissions()) as Mission[];
      setMissions(data);
      void loadCascades(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load missions');
    } finally {
      setLoading(false);
    }
  }, [loadCascades]);

  useEffect(() => {
    loadMissions();
  }, [loadMissions]);

  // Teams + projects are only needed for display names and the create modal;
  // both are non-fatal.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await apiService.getTeams();
        if (!cancelled) setTeams(Array.isArray(t) ? t : []);
      } catch {
        // display falls back to the raw team id
      }
      try {
        const p = await apiService.getProjects();
        if (!cancelled) setProjects(Array.isArray(p) ? p : []);
      } catch {
        // project picker stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Map from mission ID → mission, used for parent chips + level resolution. */
  const missionsById = useMemo(() => {
    const map = new Map<string, Mission>();
    for (const m of missions) map.set(m.id, m);
    return map;
  }, [missions]);

  /** Team id → display name. */
  const teamNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of teams) map.set(t.id, t.name);
    return map;
  }, [teams]);

  /** Unique team IDs found across all missions (for team filter). */
  const teamOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const m of missions) {
      if (m.ownerTeamId) seen.add(m.ownerTeamId);
    }
    return [
      { key: 'all', label: 'All' },
      ...Array.from(seen).sort().map((id) => {
        const name = teamNames.get(id) ?? id;
        return { key: id, label: name.length > 16 ? `${name.slice(0, 12)}…` : name };
      }),
    ];
  }, [missions, teamNames]);

  /** Filtered missions (flat). */
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
          (teamNames.get(m.ownerTeamId) ?? '').toLowerCase().includes(q) ||
          m.currentStrategy?.toLowerCase().includes(q) ||
          m.period?.label?.toLowerCase().includes(q),
      );
    }

    return result;
  }, [missions, statusFilter, priorityFilter, periodFilter, teamFilter, searchQuery, teamNames]);

  /**
   * Tree built from the filtered set: a matching child whose parent is
   * filtered out is promoted to a root so it is never hidden by the filter.
   */
  const tree = useMemo(() => buildMissionTree(filteredMissions, compareMissions), [filteredMissions]);

  /** Status counts for filter badges. */
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: missions.length };
    for (const m of missions) {
      counts[m.status] = (counts[m.status] || 0) + 1;
    }
    return counts;
  }, [missions]);

  /** Pending-approval count for the header hint. */
  const pendingCount = useMemo(
    () => missions.filter((m) => m.approval?.state === 'pending_approval').length,
    [missions],
  );

  /** Merge an approve/reject decision into local state and refresh roll-ups. */
  const handleDecided = useCallback(
    (updated: Mission) => {
      setMissions((prev) => {
        const next = prev.map((m) => (m.id === updated.id ? { ...m, ...updated } : m));
        void loadCascades(next);
        return next;
      });
    },
    [loadCascades],
  );

  const filterButtons: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'paused', label: 'Paused' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  const rowCtx: MissionRowContext = { missionsById, cascadeById, teamNames, onDecided: handleDecided, navigate };

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
            <Button
              variant="secondary"
              size="sm"
              icon={RefreshCw}
              onClick={loadMissions}
              loading={loading}
              data-testid="missions-refresh"
            >
              Refresh
            </Button>
          </div>
        </div>
        <p className="text-sm text-text-secondary-dark">
          Strategic missions driving autonomous team performance — company → team → project OKR cascade.
          {pendingCount > 0 && (
            <span className="ml-2 text-yellow-400" data-testid="missions-pending-hint">
              {pendingCount} proposal{pendingCount === 1 ? '' : 's'} awaiting your approval.
            </span>
          )}
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

      {/* Missions tree */}
      {!loading && !error && filteredMissions.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="missions-list">
          {tree.map((node) => (
            <MissionRow key={node.mission.id} node={node} depth={0} ctx={rowCtx} />
          ))}
        </div>
      )}
      {/* Create Mission Modal */}
      <CreateMissionModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={() => { setShowCreateModal(false); loadMissions(); }}
        parentOptions={missions.map((m) => ({
          id: m.id,
          objective: m.objective,
          level: resolveLevel(m, missionsById),
        }))}
        teams={teams}
        projects={projects}
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
  /** Missions available as a potential parent in the hierarchy (with level). */
  parentOptions: { id: string; objective: string; level: MissionLevel }[];
  /** Known teams (for the owner picker); falls back to a free-text id input when empty. */
  teams: Pick<Team, 'id' | 'name'>[];
  /** Known projects (required picker when level = project). */
  projects: Pick<Project, 'id' | 'name'>[];
}

/** Default review cadence (weekly, Monday 09:00). */
const DEFAULT_CADENCE = '0 9 * * 1';

const CreateMissionModal: React.FC<CreateMissionModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  parentOptions,
  teams,
  projects,
}) => {
  const [objective, setObjective] = useState('');
  const [ownerTeamId, setOwnerTeamId] = useState('');
  const [cadence, setCadence] = useState(DEFAULT_CADENCE);
  const [successCriteria, setSuccessCriteria] = useState('');
  const [priority, setPriority] = useState<MissionPriority>('medium');
  const [level, setLevel] = useState<MissionLevel>('company');
  const [parentMissionId, setParentMissionId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const requiredParentLevel = PARENT_LEVEL[level];
  const validParents = useMemo(
    () => (requiredParentLevel ? parentOptions.filter((p) => p.level === requiredParentLevel) : []),
    [parentOptions, requiredParentLevel],
  );

  const resetForm = (): void => {
    setObjective('');
    setOwnerTeamId('');
    setCadence(DEFAULT_CADENCE);
    setSuccessCriteria('');
    setPriority('medium');
    setLevel('company');
    setParentMissionId('');
    setProjectId('');
  };

  const handleLevelChange = (next: MissionLevel): void => {
    setLevel(next);
    // A parent chosen for another level is never valid for the new one.
    setParentMissionId('');
    if (next !== 'project') setProjectId('');
  };

  const handleSubmit = async () => {
    setFormError('');
    if (!objective.trim()) { setFormError('Objective is required'); return; }
    if (!ownerTeamId.trim()) { setFormError('Team ID is required'); return; }
    if (requiredParentLevel && !parentMissionId) {
      setFormError(`A ${LEVEL_LABEL[level].toLowerCase()} mission requires a ${LEVEL_LABEL[requiredParentLevel].toLowerCase()} parent`);
      return;
    }
    if (level === 'project' && !projectId) { setFormError('A project-level mission requires a project'); return; }

    try {
      setSubmitting(true);
      await apiService.createMission({
        objective: objective.trim(),
        ownerTeamId: ownerTeamId.trim(),
        cadence: cadence.trim() || DEFAULT_CADENCE,
        successCriteria: successCriteria.trim()
          ? successCriteria.split('\n').map(s => s.trim()).filter(Boolean)
          : [],
        priority,
        level,
        ...(parentMissionId ? { parentMissionId } : {}),
        ...(level === 'project' && projectId ? { projectId } : {}),
      });
      resetForm();
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
            <FormInput
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="What should this team achieve?"
              data-testid="create-mission-objective"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Level</label>
            <FormSelect
              value={level}
              onChange={(e) => handleLevelChange(e.target.value as MissionLevel)}
              data-testid="create-mission-level"
            >
              {MISSION_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{LEVEL_LABEL[lvl]}</option>
              ))}
            </FormSelect>
            <p className="mt-1 text-xs text-text-secondary-dark">
              Company missions are roots; team missions cascade from a company mission; project missions from a team mission.
            </p>
          </div>

          {requiredParentLevel && (
            <div>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">
                Parent {LEVEL_LABEL[requiredParentLevel]} Mission
              </label>
              <FormSelect
                value={parentMissionId}
                onChange={(e) => setParentMissionId(e.target.value)}
                data-testid="create-mission-parent"
              >
                <option value="">— Select a {LEVEL_LABEL[requiredParentLevel].toLowerCase()} mission —</option>
                {validParents.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.objective.length > 80 ? opt.objective.slice(0, 80) + '…' : opt.objective}
                  </option>
                ))}
              </FormSelect>
              {validParents.length === 0 && (
                <p className="mt-1 text-xs text-yellow-400">
                  No {LEVEL_LABEL[requiredParentLevel].toLowerCase()} missions exist yet — create one first.
                </p>
              )}
            </div>
          )}

          {level === 'project' && (
            <div>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Project</label>
              <FormSelect
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                data-testid="create-mission-project"
              >
                <option value="">— Select a project —</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </FormSelect>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Owner Team</label>
            {teams.length > 0 ? (
              <FormSelect
                value={ownerTeamId}
                onChange={(e) => setOwnerTeamId(e.target.value)}
                data-testid="create-mission-team"
              >
                <option value="">— Select a team —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </FormSelect>
            ) : (
              <FormInput
                className="font-mono"
                value={ownerTeamId}
                onChange={(e) => setOwnerTeamId(e.target.value)}
                placeholder="e.g. crewly-product-leo"
                data-testid="create-mission-team"
              />
            )}
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
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Review Cadence (cron)</label>
            <FormInput
              className="font-mono"
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
              placeholder={DEFAULT_CADENCE}
            />
            <p className="mt-1 text-xs text-text-secondary-dark">How often the system reviews progress (default: weekly Monday 9am)</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">Success Criteria (one per line)</label>
            <FormTextarea
              rows={3}
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder={"All tests passing\nDeployed to staging\n95% code coverage"}
            />
          </div>

          {formError && (
            <div data-testid="create-mission-error">
              <Alert variant="error">{formError}</Alert>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={handleSubmit} loading={submitting} data-testid="create-mission-submit">
          {submitting ? 'Creating...' : 'Create Mission'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default Missions;
