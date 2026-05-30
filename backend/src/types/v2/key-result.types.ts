/**
 * Key Result Types for OKR Closed-Loop Execution
 *
 * Defines structured, measurable Key Results that attach to Missions.
 * Each KR tracks a quantifiable target with baseline/current/target values,
 * measurement history, and linked WorkItems.
 *
 * @module types/v2/key-result
 */

import { randomUUID } from 'crypto';
import type { MissionLevel } from './mission.types.js';

// ---------------------------------------------------------------------------
// Core Enums & Constants
// ---------------------------------------------------------------------------

/** How the KR value is interpreted. */
export type KRMetricType = 'number' | 'percentage' | 'boolean' | 'currency';

/** All valid KR metric types. */
export const KR_METRIC_TYPES: readonly KRMetricType[] = [
  'number',
  'percentage',
  'boolean',
  'currency',
] as const;

/** KR progress status derived from current vs target. */
export type KRStatus = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'achieved';

/** All valid KR statuses. */
export const KR_STATUSES: readonly KRStatus[] = [
  'not_started',
  'on_track',
  'at_risk',
  'off_track',
  'achieved',
] as const;

/** How the KR is measured. */
export type KRMeasurementSource = 'manual' | 'task_completion' | 'skill_output';

/** All valid measurement sources. */
export const KR_MEASUREMENT_SOURCES: readonly KRMeasurementSource[] = [
  'manual',
  'task_completion',
  'skill_output',
] as const;

/** How a WorkItem contributes to a KR. */
export type KRContribution = 'direct' | 'indirect' | 'measurement';

// ---------------------------------------------------------------------------
// Data Types
// ---------------------------------------------------------------------------

/**
 * A single measurement reading for a Key Result.
 */
export interface KRMeasurement {
  /** The measured value */
  value: number;
  /** ISO8601 timestamp */
  measuredAt: string;
  /** Who/what took the measurement (agent session, skill name, or 'user') */
  source: string;
  /** Optional context note */
  note?: string;
}

/**
 * A structured, measurable Key Result attached to a Mission.
 *
 * Progress is computed as: `(current - baseline) / (target - baseline)`.
 * For "lower is better" KRs (e.g. latency), `target < baseline` and the
 * formula still works: progress increases as current decreases toward target.
 */
export interface KeyResult {
  /** UUID v4 */
  id: string;
  /** Parent Mission ID */
  missionId: string;
  /** Human-readable description (e.g. "Reduce P95 latency to <200ms") */
  title: string;
  /** How the value is interpreted */
  metricType: KRMetricType;
  /** Starting value when the KR was created */
  baseline: number;
  /** Target value that defines "achieved" */
  target: number;
  /** Latest measured value */
  current: number;
  /** Unit label for display (e.g. "ms", "%", "count", "$") */
  unit: string;
  /** Derived progress status */
  status: KRStatus;
  /** How measurements are collected */
  measurementSource: KRMeasurementSource;
  /** Source-specific config (skill name, API endpoint, etc.) */
  measurementConfig?: Record<string, unknown>;
  /** WorkItem IDs that contribute to this KR */
  linkedWorkItemIds: string[];
  /** Time-series measurement history (most recent first, capped at 50) */
  measurements: KRMeasurement[];
  /** ISO8601 timestamps */
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new Key Result.
 */
export interface CreateKeyResultInput {
  missionId: string;
  title: string;
  metricType: KRMetricType;
  baseline: number;
  target: number;
  unit: string;
  measurementSource?: KRMeasurementSource;
  measurementConfig?: Record<string, unknown>;
}

/**
 * Input for updating an existing Key Result.
 */
export interface UpdateKeyResultInput {
  current?: number;
  status?: KRStatus;
  target?: number;
  measurementSource?: KRMeasurementSource;
  measurementConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Aggregation Types
// ---------------------------------------------------------------------------

/** OKR review recommendation — derived from pure math, no LLM. */
export type OKRRecommendation = 'continue' | 'adjust_strategy' | 'replan' | 'escalate';

/**
 * Aggregated OKR progress for a Mission.
 */
export interface MissionOKRSummary {
  missionId: string;
  totalKRs: number;
  achieved: number;
  onTrack: number;
  atRisk: number;
  offTrack: number;
  notStarted: number;
  /** 0-100 weighted average of all KR progress */
  overallProgress: number;
  /** Recommendation for next action */
  recommendation: OKRRecommendation;
}

/**
 * Cross-level (cascade) roll-up of OKR progress for a Mission and its approved
 * children, walking the `Mission.parentMissionId` tree (company → team →
 * project).
 *
 * Extends {@link MissionOKRSummary} with the recursive subtree so a parent's
 * progress reflects its children's progress. Only approved children are
 * included (draft/pending_approval/rejected children are excluded from the
 * roll-up per spec §4.2).
 */
export interface CascadeOKRSummary extends MissionOKRSummary {
  /** Cascade tier of this mission within company → team → project. */
  level: MissionLevel;
  /** Number of approved children that contributed to the roll-up. */
  childMissionCount: number;
  /**
   * Rolled-up progress (0-100). Equal-weight average of this mission's own
   * `overallProgress` and each approved child's `rolledUpProgress`. For a leaf
   * (no approved children) this equals `overallProgress`. See
   * {@link computeRolledUpProgress}.
   */
  rolledUpProgress: number;
  /** Recursive roll-up summaries for each approved child mission. */
  children: CascadeOKRSummary[];
}

/**
 * Result of an OKR review cycle.
 */
export interface OKRReviewResult {
  missionId: string;
  reviewedAt: string;
  okrSummary: MissionOKRSummary;
  recommendation: OKRRecommendation;
  action: 'continue' | 'trigger_review_skill' | 'trigger_replan' | 'escalate';
}

/**
 * Decision output from the review-mission skill (agent reasoning).
 */
export interface ReviewDecision {
  action: 'continue' | 'adjust_strategy' | 'replan_phase' | 'add_tasks' | 'cancel_mission';
  newStrategy?: string;
  newPhase?: number;
  learnings?: string[];
  krUpdates?: Array<{ krId: string; newTarget?: number; note?: string }>;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Check if a value is a valid KRMetricType.
 */
export function isValidKRMetricType(value: unknown): value is KRMetricType {
  return typeof value === 'string' && (KR_METRIC_TYPES as readonly string[]).includes(value);
}

/**
 * Check if a value is a valid KRStatus.
 */
export function isValidKRStatus(value: unknown): value is KRStatus {
  return typeof value === 'string' && (KR_STATUSES as readonly string[]).includes(value);
}

/**
 * Check if a value is a valid KRMeasurementSource.
 */
export function isValidKRMeasurementSource(value: unknown): value is KRMeasurementSource {
  return typeof value === 'string' && (KR_MEASUREMENT_SOURCES as readonly string[]).includes(value);
}

/**
 * Validate a CreateKeyResultInput.
 *
 * @returns Array of validation error messages (empty if valid)
 */
export function validateCreateKeyResultInput(input: unknown): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return ['Input must be an object'];
  const obj = input as Record<string, unknown>;

  if (!obj.missionId || typeof obj.missionId !== 'string') errors.push('missionId is required');
  if (!obj.title || typeof obj.title !== 'string') errors.push('title is required');
  if (!isValidKRMetricType(obj.metricType)) errors.push(`metricType must be one of: ${KR_METRIC_TYPES.join(', ')}`);
  if (typeof obj.baseline !== 'number') errors.push('baseline must be a number');
  if (typeof obj.target !== 'number') errors.push('target must be a number');
  if (!obj.unit || typeof obj.unit !== 'string') errors.push('unit is required');
  if (obj.baseline === obj.target) errors.push('baseline and target must be different');

  if (obj.measurementSource !== undefined && !isValidKRMeasurementSource(obj.measurementSource)) {
    errors.push(`measurementSource must be one of: ${KR_MEASUREMENT_SOURCES.join(', ')}`);
  }

  return errors;
}

/**
 * Type guard for KeyResult.
 */
export function isKeyResult(value: unknown): value is KeyResult {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.missionId === 'string' &&
    typeof obj.title === 'string' &&
    isValidKRMetricType(obj.metricType) &&
    typeof obj.baseline === 'number' &&
    typeof obj.target === 'number' &&
    typeof obj.current === 'number' &&
    typeof obj.unit === 'string' &&
    isValidKRStatus(obj.status) &&
    Array.isArray(obj.linkedWorkItemIds) &&
    Array.isArray(obj.measurements)
  );
}

// ---------------------------------------------------------------------------
// Factory & Computation
// ---------------------------------------------------------------------------

/** Maximum measurement history entries to retain per KR. */
export const MAX_MEASUREMENT_HISTORY = 50;

/**
 * Compute the progress percentage for a Key Result.
 *
 * Works for both "higher is better" (target > baseline) and
 * "lower is better" (target < baseline) metrics.
 *
 * @returns Progress as 0-100 (clamped)
 */
export function computeKRProgress(kr: Pick<KeyResult, 'baseline' | 'target' | 'current'>): number {
  const range = kr.target - kr.baseline;
  if (range === 0) return 100;
  const progress = ((kr.current - kr.baseline) / range) * 100;
  return Math.max(0, Math.min(100, progress));
}

/**
 * Progress thresholds (0-100) that delimit the KR status bands. A progress at or
 * above a threshold maps to the associated status (checked high → low).
 */
export const KR_STATUS_THRESHOLDS = {
  /** At/above this progress the KR is fully achieved. */
  ACHIEVED: 100,
  /** At/above this progress the KR is healthy / on track. */
  ON_TRACK: 50,
  /** At/above this progress the KR is at risk (but not off track). */
  AT_RISK: 25,
} as const;

/**
 * Derive KR status from progress percentage.
 *
 * - achieved: progress >= 100%
 * - on_track: progress >= 50%
 * - at_risk: progress >= 25%
 * - off_track: progress > 0%
 * - not_started: progress === 0% and current === baseline
 */
export function deriveKRStatus(progress: number, current: number, baseline: number): KRStatus {
  if (progress >= KR_STATUS_THRESHOLDS.ACHIEVED) return 'achieved';
  if (current === baseline) return 'not_started';
  if (progress >= KR_STATUS_THRESHOLDS.ON_TRACK) return 'on_track';
  if (progress >= KR_STATUS_THRESHOLDS.AT_RISK) return 'at_risk';
  return 'off_track';
}

/**
 * Map a cascade child's rolled-up progress to a single synthetic KR status used
 * to fold the child into its parent's roll-up recommendation.
 *
 * Unlike {@link deriveKRStatus}, this mapper deliberately has NO
 * `current === baseline` short-circuit: a child stalled at `0` progress is a
 * genuine "in trouble" signal (`off_track`), NOT `not_started`. Treating an
 * all-children-at-zero parent as `not_started` would suppress the
 * escalate/replan recommendation the cascade is meant to surface (spec §4.2).
 *
 * Banding mirrors {@link deriveKRStatus}:
 * - achieved: progress >= 100%
 * - on_track: progress >= 50%
 * - at_risk: progress >= 25%
 * - off_track: progress < 25% (including exactly 0%)
 *
 * @param rolledUpProgress - The child's rolled-up progress (0-100)
 * @returns The synthetic {@link KRStatus} for the child
 *
 * @example
 * ```ts
 * deriveCascadeChildStatus(0);  // 'off_track' (a stalled child escalates)
 * deriveCascadeChildStatus(75); // 'on_track'
 * ```
 */
export function deriveCascadeChildStatus(rolledUpProgress: number): KRStatus {
  if (rolledUpProgress >= KR_STATUS_THRESHOLDS.ACHIEVED) return 'achieved';
  if (rolledUpProgress >= KR_STATUS_THRESHOLDS.ON_TRACK) return 'on_track';
  if (rolledUpProgress >= KR_STATUS_THRESHOLDS.AT_RISK) return 'at_risk';
  return 'off_track';
}

/**
 * Compute an equal-weight rolled-up progress for a cascade node.
 *
 * v1 weighting is intentionally equal-weight: the node's own progress counts
 * the same as each approved child's rolled-up progress. Future ownership /
 * complexity weighting is a documented hook (spec §4.2) — pass per-input
 * weights here when that lands; do NOT implement weighting now.
 *
 * @param ownProgress - This mission's own `overallProgress` (0-100)
 * @param childProgresses - Each approved child's `rolledUpProgress` (0-100)
 * @returns Equal-weight average rounded to an integer 0-100; for a leaf
 *   (no children) this equals `ownProgress` (rounded)
 *
 * @example
 * ```ts
 * computeRolledUpProgress(40, [80, 60]); // round((40 + 80 + 60) / 3) = 60
 * computeRolledUpProgress(40, []);       // 40 (leaf)
 * ```
 */
export function computeRolledUpProgress(ownProgress: number, childProgresses: number[]): number {
  const values = [ownProgress, ...childProgresses];
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round(total / values.length);
}

/**
 * Create a new KeyResult from validated input.
 */
export function createKeyResult(input: CreateKeyResultInput): KeyResult {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    missionId: input.missionId,
    title: input.title,
    metricType: input.metricType,
    baseline: input.baseline,
    target: input.target,
    current: input.baseline,
    unit: input.unit,
    status: 'not_started',
    measurementSource: input.measurementSource ?? 'manual',
    measurementConfig: input.measurementConfig,
    linkedWorkItemIds: [],
    measurements: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Derive the OKR recommendation from KR status distribution.
 *
 * @param statuses - Array of KR statuses for a mission
 * @param staleCycles - Number of consecutive review cycles with no progress
 * @returns Recommendation for next action
 */
export function deriveOKRRecommendation(
  statuses: KRStatus[],
  staleCycles: number = 0,
): OKRRecommendation {
  if (statuses.length === 0) return 'continue';
  if (staleCycles >= 2) return 'escalate';

  const counts: Record<KRStatus, number> = {
    not_started: 0,
    on_track: 0,
    at_risk: 0,
    off_track: 0,
    achieved: 0,
  };
  for (const s of statuses) counts[s]++;

  const total = statuses.length;
  const healthyRatio = (counts.on_track + counts.achieved) / total;
  const offTrackRatio = counts.off_track / total;

  if (healthyRatio >= 0.6) return 'continue';
  if (offTrackRatio > 0.4) return 'replan';
  return 'adjust_strategy';
}
