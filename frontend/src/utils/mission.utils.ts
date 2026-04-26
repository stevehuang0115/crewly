/**
 * Mission and Key Result Utilities
 *
 * Shared logic for progress computation, formatting, and data transformation.
 */

import { type KeyResultSummary, type KRMetricType, type KRStatus } from '../types/mission.types';

/**
 * Computes progress for a KR on a 0–1 scale.
 *
 * Handles the "lower is better" case where target < baseline
 * (e.g. latency reduction). Returns 0 if baseline equals target
 * (avoiding divide-by-zero) and clamps to [0, 1].
 *
 * @param kr - Key Result summary with baseline, target, current
 * @returns Progress as a number between 0 and 1 inclusive
 */
export function computeKrProgress(kr: Pick<KeyResultSummary, 'baseline' | 'target' | 'current'>): number {
  const span = kr.target - kr.baseline;
  if (span === 0) return kr.current >= kr.target ? 1 : 0;
  const raw = (kr.current - kr.baseline) / span;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Formats a KR metric value for display based on its metricType.
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

/** Tailwind colour class for a KR progress bar based on KR status. */
export const KR_STATUS_COLOR: Record<KRStatus, string> = {
  not_started: 'bg-border-dark',
  on_track: 'bg-emerald-500',
  at_risk: 'bg-amber-500',
  off_track: 'bg-rose-500',
  achieved: 'bg-emerald-500',
};
