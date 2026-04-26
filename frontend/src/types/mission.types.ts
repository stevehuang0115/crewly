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

import type { BadgeVariant } from '../components/UI/Badge';
import type { StatusType } from '../components/UI/StatusBadge';

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

/** KR metric type (mirrors backend). */
export type KRMetricType = 'number' | 'percentage' | 'boolean' | 'currency';

/** KR progress status (mirrors backend). */
export type KRStatus = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'achieved';

/**
 * Inline KR summary returned alongside each mission.
 */
export interface KeyResultSummary {
  id: string;
  missionId: string;
  ownerId?: string;
  title: string;
  metricType: KRMetricType;
  baseline: number;
  target: number;
  current: number;
  unit: string;
  status: KRStatus;
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
