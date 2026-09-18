/**
 * Small presentational OKR widgets shared by the Missions list, Mission
 * detail and Team page: level badge, approval chip, KR status counts and the
 * rolled-up progress bar.
 *
 * @module components/Missions/OkrBadges
 */

import React from 'react';
import { Badge } from '../UI/Badge';
import {
  LEVEL_LABEL,
  LEVEL_VARIANT,
  PROPOSAL_STATE_LABEL,
  PROPOSAL_STATE_VARIANT,
  KR_STATUSES,
  KR_STATUS_LABEL,
  KR_STATUS_COLOR,
  progressToStatus,
  type MissionLevel,
  type ProposalState,
  type KRStatusCounts,
  type KRStatus,
} from '../../types/mission.types';

/** Dot colour per KR status for the compact counts row. */
const KR_STATUS_DOT: Record<KRStatus, string> = KR_STATUS_COLOR;

/**
 * Cascade level badge (Company / Team / Project).
 *
 * @param props.level - Mission level to render
 */
export const LevelBadge: React.FC<{ level: MissionLevel; className?: string }> = ({ level, className }) => (
  <Badge variant={LEVEL_VARIANT[level]} size="sm" className={className} data-testid={`level-badge-${level}`}>
    {LEVEL_LABEL[level]}
  </Badge>
);

/**
 * Proposal / approval state chip. `pending_approval` is rendered in the
 * warning colour so the owner spots it at a glance.
 *
 * @param props.state - Proposal state
 */
export const ApprovalChip: React.FC<{ state: ProposalState; className?: string }> = ({ state, className }) => (
  <Badge
    variant={PROPOSAL_STATE_VARIANT[state]}
    size="sm"
    className={`${state === 'pending_approval' ? 'font-semibold' : ''} ${className ?? ''}`.trim()}
    data-testid={`approval-chip-${state}`}
  >
    {PROPOSAL_STATE_LABEL[state]}
  </Badge>
);

/**
 * Compact per-status KR counts (only non-zero statuses are shown).
 * Renders nothing when there are no KRs at all.
 *
 * @param props.counts - Count per KR status
 */
export const KrStatusCountsRow: React.FC<{ counts: KRStatusCounts; className?: string }> = ({
  counts,
  className,
}) => {
  const total = KR_STATUSES.reduce((sum, s) => sum + counts[s], 0);
  if (total === 0) return null;
  return (
    <div className={`flex items-center gap-2 flex-wrap ${className ?? ''}`} data-testid="kr-status-counts">
      {KR_STATUSES.filter((s) => counts[s] > 0).map((s) => (
        <span
          key={s}
          className="inline-flex items-center gap-1 text-[11px] text-text-secondary-dark"
          title={KR_STATUS_LABEL[s]}
          data-testid={`kr-count-${s}`}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${KR_STATUS_DOT[s]}`} />
          {counts[s]} {KR_STATUS_LABEL[s].toLowerCase()}
        </span>
      ))}
    </div>
  );
};

export interface ProgressBarProps {
  /** Progress 0–100. */
  percent: number;
  /** Optional explicit status band; derived from percent when omitted. */
  status?: KRStatus;
  /** Show the numeric percentage to the right of the bar. */
  showLabel?: boolean;
  /** Label prefix, e.g. "Rolled-up". */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Horizontal progress bar coloured by status band.
 */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  percent,
  status,
  showLabel = true,
  label,
  className,
  'data-testid': testId,
}) => {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const band = status ?? progressToStatus(pct);
  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`} data-testid={testId ?? 'progress-bar'}>
      {label && <span className="text-[11px] text-text-secondary-dark flex-shrink-0">{label}</span>}
      <div className="h-1.5 flex-1 rounded-full bg-border-dark/40 overflow-hidden min-w-[60px]">
        <div
          className={`h-full rounded-full transition-all ${KR_STATUS_COLOR[band]}`}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      {showLabel && (
        <span className="text-[11px] font-mono text-text-secondary-dark flex-shrink-0" data-testid="progress-percent">
          {pct}%
        </span>
      )}
    </div>
  );
};
