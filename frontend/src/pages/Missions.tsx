/**
 * Goals — the Goals tab of the Teams page (former Missions page,
 * specs/2026-10-02-ui-redesign.md §Teams, simplify level).
 *
 * One job: which goals exist, how far along they are, and which proposals
 * wait for the owner. Each goal is one compact row (level + objective; team ·
 * priority · period · key results · updated), nested company → team →
 * project. Proposals show Approve / Reject inline. Strategy, every key
 * result, success criteria, cadence and the reference id live on the goal
 * page. Status / priority / period / team are one Filter button.
 *
 * The header actions (New goal, Refresh) live in TeamsHub and drive this
 * panel through `createOpen` / `onCreateOpenChange` / `refreshKey`.
 *
 * @module pages/Missions
 */

import { LINKS } from '../constants/routes.constants';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Alert } from '@crewly/ui/Alert';
import { Modal, ModalBody, ModalFooter } from '@crewly/ui/Modal';
import { SkeletonRows } from '@crewly/ui/SkeletonRows';
import { FormSelect, FormInput, FormTextarea } from '@crewly/ui/Form';
import { CompactRow, FilterButton, StatusLabel, statusTone, type FilterValue, type OverflowMenuItem } from '@crewly/ui';
import { ApprovalActions } from '../components/Missions/ApprovalActions';
import { ListSearch } from '../components/common/ListSearch';
import { apiService } from '../services/api.service';
import { formatRelativeTimeCompact } from '../utils/time';
import type { Project, Team } from '../types';
import {
  PRIORITY_RANK,
  PRIORITY_LABEL,
  LEVEL_LABEL,
  MISSION_LEVELS,
  PARENT_LEVEL,
  PROPOSAL_STATE_LABEL,
  getMissionStatusLabel,
  buildMissionTree,
  resolveLevel,
  computeKrProgressPercent,
  countKrStatuses,
  summaryToKrStatusCounts,
  flattenCascadeSummary,
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

// =============================================================================
// Sub-components
// =============================================================================

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

/** Counts the Goals tab reports to the page header. */
export interface GoalCounts {
  /** All goals */
  total: number;
  /** Proposals waiting for the owner's approval */
  pending: number;
}

/**
 * Human name of a goal's owner team. Once the team list is known, an id
 * that is not in it reads "Deleted team" (the id stays in the tooltip).
 *
 * @param teamId - Owner team id
 * @param teamNames - Known teams (id → name); empty while loading / on error
 * @returns Display name
 */
export function ownerTeamLabel(teamId: string, teamNames: ReadonlyMap<string, string>): string {
  const name = teamNames.get(teamId);
  if (name) return name;
  return teamNames.size > 0 ? 'Deleted team' : teamId;
}

/**
 * The status a goal row shows: a proposal state wins over the run status
 * while it is not approved.
 *
 * @param mission - Goal
 * @returns Label + tone
 */
export function goalStatus(mission: Mission): { label: string; tone: ReturnType<typeof statusTone> } {
  const approval = mission.approval?.state;
  if (approval === 'pending_approval') return { label: 'Needs your approval', tone: 'attention' };
  if (approval === 'rejected') return { label: PROPOSAL_STATE_LABEL.rejected, tone: 'danger' };
  if (approval === 'draft') return { label: PROPOSAL_STATE_LABEL.draft, tone: 'neutral' };
  const label = getMissionStatusLabel(mission.status);
  const tone = mission.status === 'active' ? 'success' : mission.status === 'paused' ? 'attention' : mission.status === 'completed' ? 'primary' : 'neutral';
  return { label, tone };
}

// =============================================================================
// Goal row (recursive)
// =============================================================================

/**
 * One goal as a compact row, followed by its nested children.
 */
const MissionRow: React.FC<{ node: MissionTreeNode<Mission>; depth: number; ctx: MissionRowContext }> = ({
  node,
  depth,
  ctx,
}) => {
  const { mission } = node;
  const { missionsById, cascadeById, teamNames, onDecided, navigate } = ctx;
  const parentInTree = mission.parentMissionId ? missionsById.get(mission.parentMissionId) : undefined;
  const showParent = depth === 0 && !!mission.parentMissionId;
  const krs = mission.keyResults ?? [];
  const level = resolveLevel(mission, missionsById);
  const cascade = cascadeById.get(mission.id);
  const rolledUp = cascade ? cascade.rolledUpProgress : ownProgressFromKrs(krs);
  const pending = mission.approval?.state === 'pending_approval';
  const status = goalStatus(mission);
  const teamName = ownerTeamLabel(mission.ownerTeamId, teamNames);
  const open = () => navigate(LINKS.goal(mission.id));

  const meta: React.ReactNode[] = [
    <span key="team" data-testid={`mission-team-${mission.id}`} title={teamNames.has(mission.ownerTeamId) ? undefined : `Team id ${mission.ownerTeamId} (not found)`}>
      {teamName}
    </span>,
  ];
  if (mission.priority) {
    meta.push(<span key="prio" data-testid={`mission-priority-${mission.id}`}>{PRIORITY_LABEL[mission.priority]} priority</span>);
  }
  if (mission.period) {
    meta.push(<span key="period" data-testid={`mission-period-${mission.id}`}>{mission.period.label ?? mission.period.type}</span>);
  }
  const children = cascade?.childMissionCount ?? 0;
  if (krs.length > 0 || children > 0 || (cascade?.totalKRs ?? 0) > 0) {
    const counts = cascade && cascade.totalKRs > 0 ? summaryToKrStatusCounts(cascade) : countKrStatuses(krs);
    // Only the abnormal KR counts are worth a word on the row.
    const trouble = counts.at_risk + counts.off_track;
    meta.push(
      <span key="krs" data-testid={`mission-rollup-${mission.id}`}>
        <span data-testid={`mission-progress-${mission.id}`}>{Math.round(rolledUp ?? 0)}%</span>
        {children > 0
          ? ` rolled up from ${children} child goal${children === 1 ? '' : 's'}`
          : ` of ${krs.length} KR${krs.length === 1 ? '' : 's'}`}
        {trouble > 0 && <span className="text-attention"> · {trouble} KR{trouble === 1 ? '' : 's'} at risk</span>}
      </span>,
    );
  }
  if (mission.activeProjectTaskIds.length > 0) {
    meta.push(<span key="tasks">{mission.activeProjectTaskIds.length} active tasks</span>);
  }
  meta.push(<span key="upd">updated {formatRelativeTimeCompact(mission.updatedAt)}</span>);

  const overflow: OverflowMenuItem[] = [{ label: 'Open goal', onClick: open }];
  if (mission.parentMissionId) {
    overflow.push({ label: 'Open parent goal', onClick: () => navigate(LINKS.goal(mission.parentMissionId as string)) });
  }

  return (
    <div data-testid={`mission-node-${mission.id}`}>
      <div style={{ paddingLeft: depth * TREE_INDENT_PX }} className={depth > 0 ? 'bg-surface-2/40' : undefined}>
        <CompactRow
          data-testid={`mission-row-${mission.id}`}
          onClick={open}
          leading={
            <span className="w-16 shrink-0 text-[12px] font-semibold uppercase tracking-wide text-text-3" data-testid={`level-badge-${level}`}>
              {LEVEL_LABEL[level]}
            </span>
          }
          primary={mission.objective}
          meta={
            <>
              {showParent && (
                <span data-testid={`mission-parent-${mission.id}`}>
                  under {parentInTree?.objective ?? mission.parentMissionId?.slice(0, 8)}
                  <span className="text-text-3"> · </span>
                </span>
              )}
              {meta.map((m, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className="text-text-3"> · </span>}
                  {m}
                </React.Fragment>
              ))}
            </>
          }
          trailing={
            <StatusLabel tone={status.tone} data-testid={`mission-status-${mission.id}`}>
              {status.label}
            </StatusLabel>
          }
          actions={pending ? [<ApprovalActions key="decide" missionId={mission.id} onDecided={onDecided} size="sm" />] : undefined}
          overflow={overflow}
          overflowLabel={`More actions for ${mission.objective}`}
        />
      </div>

      {node.children.length > 0 && (
        <div data-testid={`mission-children-${mission.id}`}>
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

export interface MissionsProps {
  /** Controlled "New goal" modal (the header button lives in TeamsHub) */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  /** Bump to reload (the header's Refresh) */
  refreshKey?: number;
  /** Reports total / pending-approval counts for the tab pill */
  onCounts?: (counts: GoalCounts) => void;
}

/**
 * Goals list: a company → team → project tree of compact rows, with one
 * Filter button (status / priority / period / team) and search.
 *
 * @param props - {@link MissionsProps}
 * @returns The Goals panel
 */
export const Missions: React.FC<MissionsProps> = ({ createOpen, onCreateOpenChange, refreshKey = 0, onCounts }) => {
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [cascadeById, setCascadeById] = useState<Map<string, CascadeOKRSummary>>(new Map());
  const [teams, setTeams] = useState<Team[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterValue>({ status: [], priority: [], period: [], team: [] });
  const statusFilter = (filters.status?.[0] ?? 'all') as StatusFilter;
  const priorityFilter = (filters.priority?.[0] ?? 'all') as PriorityFilter;
  const periodFilter = (filters.period?.[0] ?? 'all') as PeriodFilter;
  const teamFilter = filters.team?.[0] ?? 'all';
  const [searchQuery, setSearchQuery] = useState('');
  const [ownCreateOpen, setOwnCreateOpen] = useState(false);
  const showCreateModal = createOpen ?? ownCreateOpen;
  const setShowCreateModal = (open: boolean) => {
    if (onCreateOpenChange) onCreateOpenChange(open);
    else setOwnCreateOpen(open);
  };

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
      setError(err instanceof Error ? err.message : 'Failed to load goals');
    } finally {
      setLoading(false);
    }
  }, [loadCascades]);

  useEffect(() => {
    loadMissions();
  }, [loadMissions, refreshKey]);

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
    return Array.from(seen)
      .sort()
      .map((id) => ({ value: id, label: teamNames.has(id) ? (teamNames.get(id) as string) : `Deleted team (${id.slice(0, 8)})` }));
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

  useEffect(() => {
    if (!loading) onCounts?.({ total: missions.length, pending: pendingCount });
  }, [loading, missions.length, pendingCount, onCounts]);

  const rowCtx: MissionRowContext = { missionsById, cascadeById, teamNames, onDecided: handleDecided, navigate };

  return (
    <div data-testid="missions-page">
      {/* One Filter button + search */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="missions-toolbar">
        <FilterButton
          value={filters}
          onChange={setFilters}
          groups={[
            {
              id: 'status',
              label: 'Status',
              single: true,
              options: (['active', 'paused', 'completed', 'cancelled'] as const).map((st) => ({
                value: st,
                label: getMissionStatusLabel(st),
                count: statusCounts[st] ?? 0,
              })),
            },
            { id: 'priority', label: 'Priority', single: true, options: PRIORITY_OPTIONS.filter((o) => o.key !== 'all').map((o) => ({ value: o.key, label: o.label })) },
            { id: 'period', label: 'Period', single: true, options: PERIOD_OPTIONS.filter((o) => o.key !== 'all').map((o) => ({ value: o.key, label: o.label })) },
            ...(teamOptions.length > 1 ? [{ id: 'team', label: 'Team', single: true, options: teamOptions }] : []),
          ]}
        />
        <ListSearch
          label="Search goals"
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by goal, team, strategy, period…"
        />
      </div>

      {pendingCount > 0 && (
        <p className="mb-3 text-[13px] font-semibold text-attention" data-testid="missions-pending-hint">
          {pendingCount} proposal{pendingCount === 1 ? '' : 's'} awaiting your approval.
        </p>
      )}

      {/* Loading */}
      {loading && (
        <div data-testid="missions-loading">
          <SkeletonRows count={3} />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <Alert variant="error" title="Failed to load goals" onClose={() => setError(null)} data-testid="missions-error">
          {error}
          <Button variant="ghost" size="sm" onClick={loadMissions} className="mt-2">
            Retry
          </Button>
        </Alert>
      )}

      {/* Empty state */}
      {!loading && !error && filteredMissions.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-text-2" data-testid="missions-empty">
          <Target className="h-10 w-10 opacity-40" />
          <span className="text-sm">
            {missions.length === 0 ? 'No goals yet.' : 'No goals match the current filters.'}
          </span>
          {missions.length === 0 && (
            <Button variant="secondary" size="sm" onClick={() => setShowCreateModal(true)}>
              Create a goal
            </Button>
          )}
        </div>
      )}

      {/* Goals tree */}
      {!loading && !error && filteredMissions.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border-soft" data-testid="missions-list">
          {tree.map((node) => (
            <MissionRow key={node.mission.id} node={node} depth={0} ctx={rowCtx} />
          ))}
        </div>
      )}

      {/* Create goal modal */}
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
      setFormError(`A ${LEVEL_LABEL[level].toLowerCase()} goal requires a ${LEVEL_LABEL[requiredParentLevel].toLowerCase()} parent`);
      return;
    }
    if (level === 'project' && !projectId) { setFormError('A project-level goal requires a project'); return; }

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
      setFormError(err instanceof Error ? err.message : 'Failed to create goal');
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New goal" size="md">
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
              Company goals are roots; team goals cascade from a company goal; project goals from a team goal.
            </p>
          </div>

          {requiredParentLevel && (
            <div>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">
                Parent {LEVEL_LABEL[requiredParentLevel]} goal
              </label>
              <FormSelect
                value={parentMissionId}
                onChange={(e) => setParentMissionId(e.target.value)}
                data-testid="create-mission-parent"
              >
                <option value="">— Select a {LEVEL_LABEL[requiredParentLevel].toLowerCase()} goal —</option>
                {validParents.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.objective.length > 80 ? opt.objective.slice(0, 80) + '…' : opt.objective}
                  </option>
                ))}
              </FormSelect>
              {validParents.length === 0 && (
                <p className="mt-1 text-xs text-yellow-400">
                  No {LEVEL_LABEL[requiredParentLevel].toLowerCase()} goals exist yet — create one first.
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
          {submitting ? 'Creating...' : 'Create goal'}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default Missions;
