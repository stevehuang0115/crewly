/**
 * Execution progress section for the Mission detail page: WorkItems by
 * status for this mission, from GET /api/missions/:id/progress.
 *
 * @module components/Missions/MissionProgressSection
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';
import { ProgressBar } from './OkrBadges';
import { apiService } from '../../services/api.service';
import type { MissionProgress } from '../../types/mission.types';

export interface MissionProgressSectionProps {
  missionId: string;
  /** Bump to force a re-fetch. */
  refreshKey?: number;
}

/** Status rows rendered in order, with the field that holds each count. */
const STATUS_ROWS: ReadonlyArray<{ key: keyof MissionProgress; label: string; dot: string }> = [
  { key: 'completedTasks', label: 'Done', dot: 'bg-emerald-500' },
  { key: 'runningTasks', label: 'Running', dot: 'bg-blue-500' },
  { key: 'queuedTasks', label: 'Queued', dot: 'bg-border-dark' },
  { key: 'blockedTasks', label: 'Blocked', dot: 'bg-amber-500' },
  { key: 'failedTasks', label: 'Failed', dot: 'bg-rose-500' },
];

/**
 * WorkItem counts by status plus the overall completion bar.
 *
 * @param props - See {@link MissionProgressSectionProps}
 */
export const MissionProgressSection: React.FC<MissionProgressSectionProps> = ({ missionId, refreshKey = 0 }) => {
  const [progress, setProgress] = useState<MissionProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProgress(await apiService.getMissionProgress(missionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <Card variant="default" padding="md" className="border border-border-dark" data-testid="mission-progress-section">
      <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
        <Activity className="h-4 w-4" />
        Execution Progress
      </h2>
      {loading ? (
        <p className="text-sm text-text-secondary-dark" data-testid="mission-progress-loading">Loading progress…</p>
      ) : error ? (
        <div data-testid="mission-progress-error">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : progress ? (
        <div className="space-y-3 text-sm">
          <ProgressBar
            percent={progress.progressPercent}
            label={`${progress.completedTasks}/${progress.totalTasks} tasks`}
            data-testid="mission-progress-bar"
          />
          {progress.totalTasks === 0 ? (
            <p className="text-xs text-text-secondary-dark" data-testid="mission-progress-empty">
              No work items under this mission yet.
            </p>
          ) : (
            <ul className="space-y-1.5" data-testid="mission-progress-rows">
              {STATUS_ROWS.map((row) => (
                <li key={row.key} className="flex items-center justify-between" data-testid={`mission-progress-${row.key}`}>
                  <span className="flex items-center gap-2 text-text-secondary-dark">
                    <span className={`inline-block h-2 w-2 rounded-full ${row.dot}`} />
                    {row.label}
                  </span>
                  <span className="text-text-primary-dark font-mono text-xs">{progress[row.key]}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-border-dark pt-2">
            <span className="text-text-secondary-dark">Phase</span>
            <span className="text-text-primary-dark font-mono text-xs">{progress.phase}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-text-secondary-dark">Cost</span>
            <span className="text-text-primary-dark font-mono text-xs" data-testid="mission-progress-cost">
              ${progress.totalCost.toFixed(2)}
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
};

export default MissionProgressSection;
