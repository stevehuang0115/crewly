/**
 * Shared mission types + presentation tables for the frontend.
 *
 * Both `Missions.tsx` (list) and `MissionDetail.tsx` (detail/edit) reach
 * for the same priority/status labels, badge variants, and rank ordering.
 * Keeping them in one module prevents drift — adding a new priority or
 * retheming a badge happens in a single place.
 *
 * The string unions here mirror the backend `MissionStatus` / `MissionPriority`
 * definitions in `backend/src/types/v2/mission.types.ts`; keep the two in
 * sync manually (they're too small to be worth sharing across the FE/BE
 * boundary).
 */

import type { BadgeVariant } from '@crewly/ui/Badge';
import type { StatusType } from '@crewly/ui/StatusBadge';

/** Mission lifecycle statuses (mirrors backend). */
export type MissionStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/** Priority ordered from most → least important (mirrors backend). */
export type MissionPriority = 'critical' | 'high' | 'medium' | 'low';

/** Period types (mirrors backend). */
export type MissionPeriodType = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';

export interface MissionPeriod {
  type: MissionPeriodType;
  startDate: string;
  endDate: string;
  label?: string;
}

/** Numeric rank for priority sorting (lower = higher priority). */
export const PRIORITY_RANK: Record<MissionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Human-readable priority labels. */
export const PRIORITY_LABEL: Record<MissionPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** Badge color variant per priority level. */
export const PRIORITY_VARIANT: Record<MissionPriority, BadgeVariant> = {
  critical: 'error',
  high: 'warning',
  medium: 'info',
  low: 'default',
};

const STATUS_TYPE: Record<MissionStatus, StatusType> = {
  active: 'active',
  paused: 'paused',
  completed: 'completed',
  cancelled: 'inactive',
};

const STATUS_LABEL: Record<MissionStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Maps a mission status to a StatusBadge-compatible StatusType.
 */
export function getMissionStatusType(status: MissionStatus): StatusType {
  return STATUS_TYPE[status] ?? 'pending';
}

/**
 * Returns a human-readable label for a mission status.
 */
export function getMissionStatusLabel(status: MissionStatus): string {
  return STATUS_LABEL[status] ?? status;
}

// =============================================================================
// OKR cascade: levels, approval, Key Results, roll-ups
// (mirrors backend/src/types/v2/mission.types.ts + key-result.types.ts)
// =============================================================================

/** Cascade tier of a mission: company → team → project. */
export type MissionLevel = 'company' | 'team' | 'project';

/** All cascade levels, ordered top → bottom. */
export const MISSION_LEVELS: readonly MissionLevel[] = ['company', 'team', 'project'] as const;

/** Human-readable level labels. */
export const LEVEL_LABEL: Record<MissionLevel, string> = {
  company: 'Company',
  team: 'Team',
  project: 'Project',
};

/** Badge variant per level (company most prominent). */
export const LEVEL_VARIANT: Record<MissionLevel, BadgeVariant> = {
  company: 'primary',
  team: 'info',
  project: 'default',
};

/**
 * Required parent level for a given child level (`null` = must be a root).
 * Mirrors the backend adjacency matrix in `validateLevelLink`.
 */
export const PARENT_LEVEL: Record<MissionLevel, MissionLevel | null> = {
  company: null,
  team: 'company',
  project: 'team',
};

/** Decomposition proposal lifecycle state (mirrors backend `ProposalState`). */
export type ProposalState = 'draft' | 'pending_approval' | 'approved' | 'rejected';

/** Governance metadata attached to a mission that arose from a proposal. */
export interface ApprovalState {
  state: ProposalState;
  proposedBy?: string;
  proposedAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  rejectionReason?: string;
}

/** Human-readable proposal-state labels. */
export const PROPOSAL_STATE_LABEL: Record<ProposalState, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Badge variant per proposal state (pending is highlighted). */
export const PROPOSAL_STATE_VARIANT: Record<ProposalState, BadgeVariant> = {
  draft: 'default',
  pending_approval: 'warning',
  approved: 'success',
  rejected: 'error',
};

/** KR metric type (mirrors backend). */
export type KRMetricType = 'number' | 'percentage' | 'boolean' | 'currency';

/** All KR metric types. */
export const KR_METRIC_TYPES: readonly KRMetricType[] = ['number', 'percentage', 'boolean', 'currency'] as const;

/** KR progress status (mirrors backend). */
export type KRStatus = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'achieved';

/** All KR statuses, in display order. */
export const KR_STATUSES: readonly KRStatus[] = ['achieved', 'on_track', 'at_risk', 'off_track', 'not_started'] as const;

/** How a KR is measured (mirrors backend). */
export type KRMeasurementSource = 'manual' | 'task_completion' | 'skill_output';

/** All KR measurement sources. */
export const KR_MEASUREMENT_SOURCES: readonly KRMeasurementSource[] = ['manual', 'task_completion', 'skill_output'] as const;

/** Human-readable KR status labels. */
export const KR_STATUS_LABEL: Record<KRStatus, string> = {
  not_started: 'Not started',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  achieved: 'Achieved',
};

/** Badge variant per KR status. */
export const KR_STATUS_VARIANT: Record<KRStatus, BadgeVariant> = {
  not_started: 'default',
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'error',
  achieved: 'success',
};

/** Tailwind colour class for a KR / roll-up progress bar based on status. */
export const KR_STATUS_COLOR: Record<KRStatus, string> = {
  not_started: 'bg-border-dark',
  on_track: 'bg-emerald-500',
  at_risk: 'bg-amber-500',
  off_track: 'bg-rose-500',
  achieved: 'bg-emerald-500',
};

/** Human-readable measurement-source labels. */
export const KR_SOURCE_LABEL: Record<KRMeasurementSource, string> = {
  manual: 'Manual',
  task_completion: 'Task completion',
  skill_output: 'Skill output',
};

/** A single measurement reading for a Key Result. */
export interface KRMeasurement {
  value: number;
  measuredAt: string;
  source: string;
  note?: string;
}

/** Inline KR summary returned alongside each mission by GET /api/missions. */
export interface KeyResultSummary {
  id: string;
  title: string;
  metricType: KRMetricType;
  baseline: number;
  target: number;
  current: number;
  unit: string;
  status: KRStatus;
}

/** Full Key Result as returned by GET /api/missions/:id/key-results. */
export interface KeyResult extends KeyResultSummary {
  missionId: string;
  measurementSource: KRMeasurementSource;
  measurementConfig?: Record<string, unknown>;
  linkedWorkItemIds: string[];
  measurements: KRMeasurement[];
  createdAt: string;
  updatedAt: string;
}

/** Body for POST /api/missions/:id/key-results (`unit` is required by the backend validator). */
export interface CreateKeyResultInput {
  title: string;
  metricType: KRMetricType;
  baseline: number;
  target: number;
  unit: string;
  measurementSource?: KRMeasurementSource;
  measurementConfig?: Record<string, unknown>;
}

/**
 * Body for PUT /api/missions/:id/key-results/:krId. The backend only merges
 * these fields (title / unit / baseline are immutable after creation).
 */
export interface UpdateKeyResultInput {
  current?: number;
  status?: KRStatus;
  target?: number;
  measurementSource?: KRMeasurementSource;
  measurementConfig?: Record<string, unknown>;
}

/** Body for POST /api/missions/:id/key-results/:krId/measure. */
export interface MeasureKeyResultInput {
  value: number;
  source?: string;
  note?: string;
}

/** OKR review recommendation (mirrors backend). */
export type OKRRecommendation = 'continue' | 'adjust_strategy' | 'replan' | 'escalate';

/** Aggregated OKR progress for a single mission (GET /:id/okr-summary). */
export interface MissionOKRSummary {
  missionId: string;
  totalKRs: number;
  achieved: number;
  onTrack: number;
  atRisk: number;
  offTrack: number;
  notStarted: number;
  /** 0-100 */
  overallProgress: number;
  recommendation: OKRRecommendation;
}

/** Cross-level roll-up for a mission and its approved children (GET /:id/okr-summary/cascade). */
export interface CascadeOKRSummary extends MissionOKRSummary {
  level: MissionLevel;
  childMissionCount: number;
  /** 0-100 equal-weight average of own progress and each child's roll-up. */
  rolledUpProgress: number;
  children: CascadeOKRSummary[];
}

/** WorkItem-level execution snapshot for a mission (GET /:id/progress). */
export interface MissionProgress {
  missionId: string;
  status: string;
  phase: number;
  totalTasks: number;
  completedTasks: number;
  runningTasks: number;
  queuedTasks: number;
  blockedTasks: number;
  failedTasks: number;
  progressPercent: number;
  totalCost: number;
}

/** Mission as returned by the API (list + detail). */
export interface Mission {
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
  learnings?: string[];
  priority?: MissionPriority;
  period?: MissionPeriod;
  parentMissionId?: string;
  level?: MissionLevel;
  projectId?: string;
  approval?: ApprovalState;
  keyResults?: KeyResultSummary[];
}

/** Body for POST /api/missions. */
export interface CreateMissionInput {
  objective: string;
  ownerTeamId: string;
  cadence?: string;
  successCriteria?: string[];
  priority?: MissionPriority;
  period?: MissionPeriod;
  parentMissionId?: string;
  level?: MissionLevel;
  projectId?: string;
}

/** Per-status KR counts, used by the list, detail and team panels. */
export type KRStatusCounts = Record<KRStatus, number>;

/** A mission with its children resolved from `parentMissionId`. */
export interface MissionTreeNode<M extends { id: string; parentMissionId?: string }> {
  mission: M;
  children: MissionTreeNode<M>[];
}

/**
 * Resolves the effective cascade level of a mission. Missions from the API
 * always carry `level`; the fallback derives it from parent depth so legacy
 * payloads (or test fixtures) still render a badge.
 *
 * @param mission - Mission whose level to resolve
 * @param byId - Lookup of every known mission (for parent-chain depth)
 * @returns The resolved level
 */
export function resolveLevel(
  mission: Pick<Mission, 'level' | 'parentMissionId'>,
  byId: ReadonlyMap<string, Pick<Mission, 'level' | 'parentMissionId'>>,
): MissionLevel {
  if (mission.level) return mission.level;
  let depth = 0;
  let cursor = mission.parentMissionId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parentMissionId;
  }
  return MISSION_LEVELS[Math.min(depth, MISSION_LEVELS.length - 1)];
}

/**
 * Builds a forest from a flat mission list using `parentMissionId`. A mission
 * whose parent is not in the list becomes a root (so filtered views still
 * render every matching mission). Sibling order follows `sortFn` when given,
 * otherwise input order.
 *
 * @param missions - Flat list of missions
 * @param sortFn - Optional comparator applied to every sibling group
 * @returns Root nodes with nested children
 */
export function buildMissionTree<M extends { id: string; parentMissionId?: string }>(
  missions: readonly M[],
  sortFn?: (a: M, b: M) => number,
): MissionTreeNode<M>[] {
  const ids = new Set(missions.map((m) => m.id));
  const childrenOf = new Map<string, M[]>();
  const roots: M[] = [];
  for (const m of missions) {
    if (m.parentMissionId && ids.has(m.parentMissionId) && m.parentMissionId !== m.id) {
      const list = childrenOf.get(m.parentMissionId) ?? [];
      list.push(m);
      childrenOf.set(m.parentMissionId, list);
    } else {
      roots.push(m);
    }
  }
  const visited = new Set<string>();
  const toNode = (m: M): MissionTreeNode<M> => {
    visited.add(m.id);
    const kids = (childrenOf.get(m.id) ?? []).filter((c) => !visited.has(c.id));
    if (sortFn) kids.sort(sortFn);
    return { mission: m, children: kids.map(toNode) };
  };
  if (sortFn) roots.sort(sortFn);
  return roots.map(toNode);
}

/**
 * Computes KR progress on a 0–100 scale, matching the backend formula:
 * `(current - baseline) / (target - baseline)`, clamped. Works for
 * "lower is better" KRs (target < baseline). A zero span counts as achieved
 * only once `current` reaches the target.
 *
 * @param kr - Baseline / target / current values
 * @returns Progress percentage 0–100
 */
export function computeKrProgressPercent(kr: Pick<KeyResultSummary, 'baseline' | 'target' | 'current'>): number {
  const span = kr.target - kr.baseline;
  if (span === 0) return kr.current >= kr.target ? 100 : 0;
  const raw = ((kr.current - kr.baseline) / span) * 100;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Formats a KR metric value for display based on its metric type.
 *
 * @param value - Numeric value
 * @param metricType - How the value is interpreted
 * @param unit - Unit label (may be empty)
 * @returns Display string
 */
export function formatKrValue(value: number, metricType: KRMetricType, unit: string): string {
  switch (metricType) {
    case 'currency':
      return `${unit || '$'}${value.toLocaleString()}`;
    case 'percentage':
      return `${value}${unit || '%'}`;
    case 'boolean':
      return value >= 1 ? 'Yes' : 'No';
    case 'number':
    default:
      return `${value.toLocaleString()}${unit ? ` ${unit}` : ''}`;
  }
}

/** Empty KR status counts. */
export function emptyKrStatusCounts(): KRStatusCounts {
  return { not_started: 0, on_track: 0, at_risk: 0, off_track: 0, achieved: 0 };
}

/**
 * Tallies KR statuses from inline KR summaries.
 *
 * @param keyResults - KR summaries (may be undefined)
 * @returns Count per status
 */
export function countKrStatuses(keyResults: readonly Pick<KeyResultSummary, 'status'>[] | undefined): KRStatusCounts {
  const counts = emptyKrStatusCounts();
  for (const kr of keyResults ?? []) {
    if (kr.status in counts) counts[kr.status] += 1;
  }
  return counts;
}

/**
 * Converts an OKR summary (own or cascade) into per-status KR counts.
 *
 * @param summary - OKR summary from the API
 * @returns Count per status
 */
export function summaryToKrStatusCounts(summary: MissionOKRSummary): KRStatusCounts {
  return {
    achieved: summary.achieved,
    on_track: summary.onTrack,
    at_risk: summary.atRisk,
    off_track: summary.offTrack,
    not_started: summary.notStarted,
  };
}

/**
 * Flattens a cascade summary tree into a map keyed by mission id, so a single
 * root fetch yields the roll-up for every approved descendant.
 *
 * @param root - Cascade summary returned for a root mission
 * @param into - Optional map to populate (created when omitted)
 * @returns The populated map
 */
export function flattenCascadeSummary(
  root: CascadeOKRSummary,
  into: Map<string, CascadeOKRSummary> = new Map(),
): Map<string, CascadeOKRSummary> {
  into.set(root.missionId, root);
  for (const child of root.children ?? []) flattenCascadeSummary(child, into);
  return into;
}

/** Progress thresholds mirroring backend `KR_STATUS_THRESHOLDS` (0–100). */
export const PROGRESS_THRESHOLDS = { ACHIEVED: 100, ON_TRACK: 50, AT_RISK: 25 } as const;

/**
 * Maps a 0–100 progress value to the status band used for colouring roll-up bars.
 *
 * @param progress - Progress percentage
 * @returns Status band
 */
export function progressToStatus(progress: number): KRStatus {
  if (progress >= PROGRESS_THRESHOLDS.ACHIEVED) return 'achieved';
  if (progress >= PROGRESS_THRESHOLDS.ON_TRACK) return 'on_track';
  if (progress >= PROGRESS_THRESHOLDS.AT_RISK) return 'at_risk';
  return 'off_track';
}
