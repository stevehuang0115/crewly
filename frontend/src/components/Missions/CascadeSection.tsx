/**
 * Cascade section for the Mission detail page: the parent link (one level
 * up) and the approved children with their rolled-up progress, taken from
 * GET /api/missions/:id/okr-summary/cascade.
 *
 * Mission objectives are not part of the cascade payload, so the caller
 * passes an id → objective lookup (built from the missions list) and this
 * component falls back to the id prefix when a name is unknown.
 *
 * @module components/Missions/CascadeSection
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, ArrowUp } from 'lucide-react';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';
import { LevelBadge, ProgressBar, KrStatusCountsRow } from './OkrBadges';
import { apiService } from '../../services/api.service';
import {
  summaryToKrStatusCounts,
  type CascadeOKRSummary,
  type MissionLevel,
} from '../../types/mission.types';

export interface CascadeSectionProps {
  /** Mission at the centre of the view. */
  missionId: string;
  /** Level of this mission (for the parent-link badge fallback). */
  level: MissionLevel;
  /** Parent mission id, if any. */
  parentMissionId?: string;
  /** id → objective lookup for parent / children names. */
  missionNames: ReadonlyMap<string, string>;
  /** Bump to force a re-fetch (e.g. after a KR measurement or approval). */
  refreshKey?: number;
}

/** Recommendation labels shown next to the roll-up. */
const RECOMMENDATION_LABEL: Record<CascadeOKRSummary['recommendation'], string> = {
  continue: 'Continue',
  adjust_strategy: 'Adjust strategy',
  replan: 'Replan',
  escalate: 'Escalate',
};

/**
 * Display name for a mission id: the known objective or a short id prefix.
 */
function nameFor(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? id.slice(0, 8);
}

/**
 * Parent link + children roll-up for a mission.
 *
 * @param props - See {@link CascadeSectionProps}
 */
export const CascadeSection: React.FC<CascadeSectionProps> = ({
  missionId,
  level,
  parentMissionId,
  missionNames,
  refreshKey = 0,
}) => {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<CascadeOKRSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await apiService.getCascadeSummary(missionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cascade');
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <Card variant="default" padding="md" className="border border-border-dark" data-testid="cascade-section">
      <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <GitBranch className="h-4 w-4" />
        Cascade
      </h2>

      {/* Parent */}
      <div className="mb-3">
        <span className="text-text-secondary-dark text-xs uppercase tracking-wide block mb-1">Parent</span>
        {parentMissionId ? (
          <button
            type="button"
            onClick={() => navigate(`/missions/${parentMissionId}`)}
            className="flex items-center gap-1.5 text-sm text-primary hover:underline text-left"
            data-testid="cascade-parent-link"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {nameFor(parentMissionId, missionNames)}
          </button>
        ) : (
          <span className="text-sm text-text-secondary-dark" data-testid="cascade-parent-none">
            None — this is a {level} root.
          </span>
        )}
      </div>

      {/* Roll-up */}
      {loading ? (
        <p className="text-sm text-text-secondary-dark" data-testid="cascade-loading">Loading roll-up…</p>
      ) : error ? (
        <div data-testid="cascade-error">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : summary ? (
        <div className="space-y-3">
          <div data-testid="cascade-rollup">
            <div className="flex items-center justify-between mb-1">
              <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Rolled-up progress</span>
              <span className="text-[11px] text-text-secondary-dark" data-testid="cascade-recommendation">
                {RECOMMENDATION_LABEL[summary.recommendation] ?? summary.recommendation}
              </span>
            </div>
            <ProgressBar percent={summary.rolledUpProgress} data-testid="cascade-rollup-bar" />
            <div className="mt-1 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] text-text-secondary-dark">
                Own progress {Math.round(summary.overallProgress)}% · {summary.totalKRs} KR{summary.totalKRs === 1 ? '' : 's'}
              </span>
              <KrStatusCountsRow counts={summaryToKrStatusCounts(summary)} />
            </div>
          </div>

          <div>
            <span className="text-text-secondary-dark text-xs uppercase tracking-wide block mb-1">
              Children ({summary.childMissionCount})
            </span>
            {summary.children.length === 0 ? (
              <p className="text-sm text-text-secondary-dark" data-testid="cascade-children-empty">
                No approved child missions.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="cascade-children">
                {summary.children.map((child) => (
                  <li key={child.missionId} data-testid={`cascade-child-${child.missionId}`}>
                    <button
                      type="button"
                      onClick={() => navigate(`/missions/${child.missionId}`)}
                      className="w-full text-left rounded-lg border border-border-dark px-3 py-2 hover:border-primary/30 transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <LevelBadge level={child.level} />
                        <span className="text-sm text-text-primary-dark truncate">
                          {nameFor(child.missionId, missionNames)}
                        </span>
                        {child.childMissionCount > 0 && (
                          <span className="text-[11px] text-text-secondary-dark ml-auto flex-shrink-0">
                            {child.childMissionCount} child{child.childMissionCount === 1 ? '' : 'ren'}
                          </span>
                        )}
                      </div>
                      <ProgressBar percent={child.rolledUpProgress} data-testid={`cascade-child-progress-${child.missionId}`} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
};

export default CascadeSection;
