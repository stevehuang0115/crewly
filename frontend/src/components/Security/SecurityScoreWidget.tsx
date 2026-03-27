/**
 * SecurityScoreWidget Component
 *
 * Displays an aggregated security score based on PTY isolation,
 * tool approval enforcement, and data sovereignty status.
 *
 * @module components/Security/SecurityScoreWidget
 */
import React, { useMemo } from 'react';
import { Shield } from 'lucide-react';
import { Card } from '../UI/Card';

export interface SecurityScoreInput {
  /** PTY status: healthy = all isolated, partial = some shared */
  ptyStatus: string;
  /** Number of total agents */
  ptyTotalAgents: number;
  /** Number of isolated agents */
  ptyIsolatedCount: number;
  /** Approval status: enforced = policy active */
  approvalStatus: string;
  /** Number of approvals denied today */
  approvalsDeniedToday: number;
  /** Number of approvals bypassed today */
  approvalsBypassedToday: number;
  /** Storage status: secure = local only */
  storageStatus: string;
}

/**
 * Calculate a 0-100 security score from component statuses.
 *
 * Weights: PTY isolation (40), Approvals (35), Storage (25).
 *
 * @param input - Aggregated security data
 * @returns Score 0-100
 */
export function calculateSecurityScore(input: SecurityScoreInput): number {
  let score = 0;

  // PTY isolation (40 points)
  if (input.ptyTotalAgents === 0) {
    score += 40; // No agents = no risk
  } else {
    const isolationRate = input.ptyIsolatedCount / input.ptyTotalAgents;
    score += Math.round(isolationRate * 40);
  }

  // Approval enforcement (35 points)
  if (input.approvalStatus === 'enforced') {
    score += 35;
    // Deduct for bypasses (up to 15 points)
    const bypassPenalty = Math.min(input.approvalsBypassedToday * 5, 15);
    score -= bypassPenalty;
  } else if (input.approvalStatus === 'partial') {
    score += 20;
  }
  // disabled = 0 points

  // Storage sovereignty (25 points)
  if (input.storageStatus === 'secure') {
    score += 25;
  } else if (input.storageStatus === 'partial') {
    score += 15;
  }
  // compromised = 0 points

  return Math.max(0, Math.min(100, score));
}

/**
 * Get grade label and color for a score.
 *
 * @param score - 0-100 score
 * @returns Object with label and color class
 */
export function getScoreGrade(score: number): { label: string; color: string; bgColor: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-emerald-400', bgColor: 'bg-emerald-400' };
  if (score >= 70) return { label: 'Good', color: 'text-blue-400', bgColor: 'bg-blue-400' };
  if (score >= 50) return { label: 'Fair', color: 'text-amber-400', bgColor: 'bg-amber-400' };
  return { label: 'Needs Attention', color: 'text-red-400', bgColor: 'bg-red-400' };
}

export interface SecurityScoreWidgetProps {
  /** Aggregated security data */
  data: SecurityScoreInput;
  /** Whether data is still loading */
  loading?: boolean;
}

/**
 * Security score widget with donut-style visual and grade.
 *
 * @param props - {@link SecurityScoreWidgetProps}
 * @returns SecurityScoreWidget JSX
 */
export const SecurityScoreWidget: React.FC<SecurityScoreWidgetProps> = ({ data, loading = false }) => {
  const score = useMemo(() => calculateSecurityScore(data), [data]);
  const grade = useMemo(() => getScoreGrade(score), [score]);

  /** Brief explanation lines */
  const details = useMemo(() => {
    const lines: string[] = [];
    if (data.ptyTotalAgents > 0) {
      lines.push(`${data.ptyIsolatedCount}/${data.ptyTotalAgents} agents isolated`);
    }
    if (data.approvalStatus === 'enforced') {
      lines.push('Tool approval enforced');
    } else if (data.approvalStatus === 'disabled') {
      lines.push('Tool approval disabled');
    }
    if (data.approvalsBypassedToday > 0) {
      lines.push(`${data.approvalsBypassedToday} bypass${data.approvalsBypassedToday !== 1 ? 'es' : ''} today`);
    }
    if (data.storageStatus === 'secure') {
      lines.push('Data stored locally');
    }
    return lines;
  }, [data]);

  if (loading) {
    return (
      <Card padding="lg" data-testid="security-score-widget">
        <div className="text-text-secondary-dark text-sm" role="status">Calculating score...</div>
      </Card>
    );
  }

  return (
    <Card padding="lg" data-testid="security-score-widget">
      <div className="flex items-start gap-4">
        {/* Score circle */}
        <div className="relative flex-shrink-0">
          <svg width="80" height="80" viewBox="0 0 80 80" data-testid="score-ring">
            <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" strokeWidth="6" className="text-border-dark" />
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="currentColor"
              strokeWidth="6"
              className={grade.color}
              strokeDasharray={`${(score / 100) * 213.6} 213.6`}
              strokeLinecap="round"
              transform="rotate(-90 40 40)"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xl font-bold" data-testid="score-value">{score}</span>
          </div>
        </div>

        {/* Grade and details */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Security Score</h3>
          </div>
          <p className={`text-sm font-medium ${grade.color} mb-2`} data-testid="score-grade">
            {grade.label}
          </p>
          <ul className="space-y-0.5">
            {details.map((line, i) => (
              <li key={i} className="text-xs text-text-secondary-dark">{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
};

export default SecurityScoreWidget;
