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
  /** Member ID who owns this KR (optional) */
  ownerId?: string;
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
  ownerId?: string;
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
  ownerId?: string;
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

  if (obj.ownerId !== undefined && typeof obj.ownerId !== 'string') {
    errors.push('ownerId must be a string');
  }

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
    (obj.ownerId === undefined || typeof obj.ownerId === 'string') &&
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
 * Derive KR status from progress percentage.
 *
 * - achieved: progress >= 100%
 * - on_track: progress >= 50%
 * - at_risk: progress >= 25%
 * - off_track: progress > 0%
 * - not_started: progress === 0% and current === baseline
 */
export function deriveKRStatus(progress: number, current: number, baseline: number): KRStatus {
  if (progress >= 100) return 'achieved';
  if (current === baseline) return 'not_started';
  if (progress >= 50) return 'on_track';
  if (progress >= 25) return 'at_risk';
  return 'off_track';
}

/**
 * Create a new KeyResult from validated input.
 */
export function createKeyResult(input: CreateKeyResultInput): KeyResult {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    missionId: input.missionId,
    ownerId: input.ownerId,
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
