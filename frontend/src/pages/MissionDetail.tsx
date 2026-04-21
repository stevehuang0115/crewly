/**
 * Mission Detail Page
 *
 * Displays the full details of a single Mission and supports inline editing
 * of the key mutable fields (objective, status, priority, team, strategy,
 * success criteria, period, parent). Save issues PUT /api/missions/:id.
 *
 * @module pages/MissionDetail
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  Target,
  Calendar,
  Clock,
  Users,
  CheckCircle2,
  BookOpen,
  ListChecks,
  Pencil,
  Save,
  X,
} from 'lucide-react';
import { Card } from '../components/UI/Card';
import { Badge } from '../components/UI/Badge';
import { StatusBadge } from '../components/UI/StatusBadge';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import { Button } from '../components/UI/Button';
import { Input } from '../components/UI/Input';
import { FormSelect } from '../components/UI/Form';
import { Alert } from '../components/UI/Alert';
import { apiService } from '../services/api.service';
import {
  PRIORITY_LABEL,
  PRIORITY_VARIANT,
  getMissionStatusType,
  getMissionStatusLabel,
  type MissionStatus,
  type MissionPriority,
  type MissionPeriodType,
  type MissionPeriod,
} from '../types/mission.types';

// =============================================================================
// Types (KR summaries are only used on this page)
// =============================================================================

/** KR metric type (mirrors backend). */
type KRMetricType = 'number' | 'percentage' | 'boolean' | 'currency';

/** KR progress status (mirrors backend). */
type KRStatus = 'not_started' | 'on_track' | 'at_risk' | 'off_track' | 'achieved';

interface KeyResultSummary {
  id: string;
  title: string;
  metricType: KRMetricType;
  baseline: number;
  target: number;
  current: number;
  unit: string;
  status: KRStatus;
}

/** Full Mission object returned by the API. */
interface Mission {
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
  keyResults?: KeyResultSummary[];
}

/**
 * Form draft shape — a subset of Mission fields that are user-editable.
 * `successCriteria` is edited as a single newline-joined string.
 */
interface MissionDraft {
  objective: string;
  status: MissionStatus;
  priority: MissionPriority;
  ownerTeamId: string;
  currentStrategy: string;
  cadence: string;
  successCriteriaText: string;
  periodLabel: string;
  periodType: MissionPeriodType | '';
  periodStart: string;
  periodEnd: string;
  parentMissionId: string;
}

// =============================================================================
// Utility Functions
// =============================================================================

function formatDateTime(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoDate;
  }
}

/**
 * Builds an editable draft from a server-side Mission.
 */
function buildDraft(m: Mission): MissionDraft {
  return {
    objective: m.objective,
    status: m.status,
    priority: m.priority ?? 'medium',
    ownerTeamId: m.ownerTeamId,
    currentStrategy: m.currentStrategy ?? '',
    cadence: m.cadence ?? '',
    successCriteriaText: (m.successCriteria ?? []).join('\n'),
    periodLabel: m.period?.label ?? '',
    periodType: m.period?.type ?? '',
    periodStart: m.period?.startDate ? m.period.startDate.slice(0, 10) : '',
    periodEnd: m.period?.endDate ? m.period.endDate.slice(0, 10) : '',
    parentMissionId: m.parentMissionId ?? '',
  };
}

/**
 * Converts a draft into the PATCH body sent to the server.
 * Empty strings are normalised to either `undefined` (cleared field) or
 * retained — see inline notes for each field.
 */
function draftToPatch(draft: MissionDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    objective: draft.objective.trim(),
    status: draft.status,
    priority: draft.priority,
    ownerTeamId: draft.ownerTeamId.trim(),
    currentStrategy: draft.currentStrategy,
    cadence: draft.cadence.trim(),
    successCriteria: draft.successCriteriaText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    // Explicitly clear parent when the draft is empty (server treats '' as undefined).
    parentMissionId: draft.parentMissionId || '',
  };

  // Include `period` only when the user has filled the required parts.
  if (draft.periodType && draft.periodStart && draft.periodEnd) {
    patch.period = {
      type: draft.periodType,
      startDate: new Date(draft.periodStart).toISOString(),
      endDate: new Date(draft.periodEnd).toISOString(),
      ...(draft.periodLabel ? { label: draft.periodLabel } : {}),
    };
  } else if (!draft.periodType && !draft.periodStart && !draft.periodEnd) {
    // Clearing the period entirely
    patch.period = null;
  }
  return patch;
}

// =============================================================================
// Component
// =============================================================================

/**
 * MissionDetail page -- displays and edits a single mission.
 */
export const MissionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [mission, setMission] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<MissionDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Fetches the mission from the backend API.
   */
  const loadMission = useCallback(
    async (showLoadingSpinner = true) => {
      if (!id) return;
      if (showLoadingSpinner) setLoading(true);
      else setRefreshing(true);
      setError(null);

      try {
        const data = await apiService.getMission(id);
        setMission(data as Mission);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load mission';
        setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id],
  );

  useEffect(() => {
    loadMission();
  }, [loadMission]);

  const beginEdit = useCallback(() => {
    if (!mission) return;
    setDraft(buildDraft(mission));
    setSaveError(null);
    setIsEditing(true);
  }, [mission]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setDraft(null);
    setSaveError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!id || !draft) return;
    if (!draft.objective.trim()) {
      setSaveError('Objective cannot be empty.');
      return;
    }
    if (!draft.ownerTeamId.trim()) {
      setSaveError('Owner team cannot be empty.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const updated = (await apiService.updateMission(id, draftToPatch(draft))) as Mission;
      setMission(updated);
      setIsEditing(false);
      setDraft(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save mission';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [id, draft]);

  /**
   * Typed helper to patch a single draft field without widening it to `unknown`.
   */
  const setField = useMemo(
    () =>
      <K extends keyof MissionDraft>(key: K, value: MissionDraft[K]): void => {
        setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
      },
    [],
  );

  // ---------------------------------------------------------------------------
  // Loading / error / not-found states
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="xl" text="Loading mission..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto" data-testid="mission-detail-error">
        <button
          onClick={() => navigate('/missions')}
          className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Missions
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8">
            <p className="text-red-400 mb-2">{error}</p>
            <button
              onClick={() => loadMission()}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              Retry
            </button>
          </div>
        </Card>
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto">
        <button
          onClick={() => navigate('/missions')}
          className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Missions
        </button>
        <Card variant="default" padding="lg">
          <div className="text-center py-8 text-text-secondary-dark">
            <Target className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>Mission not found.</p>
          </div>
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render (view + edit modes share the layout)
  // ---------------------------------------------------------------------------
  return (
    <div className="p-6 max-w-[1000px] mx-auto" data-testid="mission-detail-page">
      <button
        onClick={() => navigate('/missions')}
        className="flex items-center gap-1.5 text-sm text-text-secondary-dark hover:text-text-primary-dark mb-6 transition-colors"
        data-testid="mission-detail-back"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Missions
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="flex-1 min-w-0">
          {isEditing && draft ? (
            <Input
              aria-label="Objective"
              value={draft.objective}
              onChange={(e) => setField('objective', e.target.value)}
              fullWidth
              data-testid="edit-objective"
            />
          ) : (
            <h1 className="text-2xl font-bold text-text-primary-dark mb-2">
              {mission.objective}
            </h1>
          )}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <StatusBadge status={getMissionStatusType(mission.status)}>
              {getMissionStatusLabel(mission.status)}
            </StatusBadge>
            {mission.priority && (
              <Badge variant={PRIORITY_VARIANT[mission.priority]} size="sm">
                {PRIORITY_LABEL[mission.priority]}
              </Badge>
            )}
            {mission.period?.label && (
              <Badge variant="info" size="sm">{mission.period.label}</Badge>
            )}
            <Badge variant="default" size="sm">{mission.id.slice(0, 12)}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={Save}
                onClick={saveEdit}
                disabled={saving}
                data-testid="mission-save"
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={X}
                onClick={cancelEdit}
                disabled={saving}
                data-testid="mission-cancel"
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="sm"
                icon={Pencil}
                onClick={beginEdit}
                data-testid="mission-edit"
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                onClick={() => loadMission(false)}
                disabled={refreshing}
                className={refreshing ? 'animate-spin' : ''}
                aria-label="Refresh mission"
              >
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {saveError && (
        <div data-testid="mission-save-error" className="mb-4">
          <Alert variant="error" onClose={() => setSaveError(null)}>
            {saveError}
          </Alert>
        </div>
      )}

      {/* Content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main content */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Strategy */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Target className="h-4 w-4" />
              Current Strategy
            </h2>
            {isEditing && draft ? (
              <textarea
                aria-label="Current Strategy"
                className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark resize-y focus:outline-none focus:border-accent-blue/50"
                rows={4}
                value={draft.currentStrategy}
                onChange={(e) => setField('currentStrategy', e.target.value)}
                data-testid="edit-strategy"
              />
            ) : (
              <p className="text-sm text-text-primary-dark leading-relaxed whitespace-pre-wrap">
                {mission.currentStrategy || 'No strategy defined.'}
              </p>
            )}
          </Card>

          {/* Success Criteria */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" />
              Success Criteria ({mission.successCriteria.length})
            </h2>
            {isEditing && draft ? (
              <textarea
                aria-label="Success Criteria (one per line)"
                className="w-full bg-background-dark border border-border-dark rounded-lg px-3 py-2 text-sm text-text-primary-dark resize-y focus:outline-none focus:border-accent-blue/50"
                rows={5}
                placeholder="One criterion per line"
                value={draft.successCriteriaText}
                onChange={(e) => setField('successCriteriaText', e.target.value)}
                data-testid="edit-success-criteria"
              />
            ) : mission.successCriteria.length === 0 ? (
              <p className="text-sm text-text-secondary-dark">No success criteria defined.</p>
            ) : (
              <ul className="space-y-2">
                {mission.successCriteria.map((criterion, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-text-primary-dark">
                    <span className="text-primary mt-0.5 flex-shrink-0">
                      <ListChecks className="h-4 w-4" />
                    </span>
                    {criterion}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Learnings (view-only for now) */}
          {!isEditing && mission.learnings && mission.learnings.length > 0 && (
            <Card variant="default" padding="md" className="border border-border-dark">
              <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <BookOpen className="h-4 w-4" />
                Learnings ({mission.learnings.length})
              </h2>
              <ul className="space-y-2">
                {mission.learnings.map((learning, idx) => (
                  <li key={idx} className="text-sm text-text-primary-dark pl-4 border-l-2 border-border-dark">
                    {learning}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          {/* Team & Tasks */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Users className="h-4 w-4" />
              Team & Settings
            </h2>
            <div className="space-y-3 text-sm">
              {/* Owner Team */}
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Owner Team</span>
                {isEditing && draft ? (
                  <Input
                    aria-label="Owner Team"
                    value={draft.ownerTeamId}
                    onChange={(e) => setField('ownerTeamId', e.target.value)}
                    fullWidth
                    data-testid="edit-owner-team"
                  />
                ) : (
                  <span className="text-text-primary-dark font-mono text-xs">{mission.ownerTeamId}</span>
                )}
              </div>

              {/* Status */}
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Status</span>
                {isEditing && draft ? (
                  <FormSelect
                    value={draft.status}
                    onChange={(e) => setField('status', e.target.value as MissionStatus)}
                    data-testid="edit-status"
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                  </FormSelect>
                ) : (
                  <span className="text-text-primary-dark">{getMissionStatusLabel(mission.status)}</span>
                )}
              </div>

              {/* Priority */}
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Priority</span>
                {isEditing && draft ? (
                  <FormSelect
                    value={draft.priority}
                    onChange={(e) => setField('priority', e.target.value as MissionPriority)}
                    data-testid="edit-priority"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </FormSelect>
                ) : (
                  <span className="text-text-primary-dark">{PRIORITY_LABEL[mission.priority ?? 'medium']}</span>
                )}
              </div>

              {/* Parent mission */}
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Parent Mission</span>
                {isEditing && draft ? (
                  <Input
                    aria-label="Parent Mission ID"
                    placeholder="(none)"
                    value={draft.parentMissionId}
                    onChange={(e) => setField('parentMissionId', e.target.value)}
                    fullWidth
                    data-testid="edit-parent"
                  />
                ) : (
                  <span className="text-text-primary-dark font-mono text-xs">
                    {mission.parentMissionId ?? '—'}
                  </span>
                )}
              </div>

              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Active Tasks</span>
                <span className="text-text-primary-dark">{mission.activeProjectTaskIds.length}</span>
              </div>

              {/* Cadence */}
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary-dark text-xs uppercase tracking-wide">Cadence (cron)</span>
                {isEditing && draft ? (
                  <Input
                    aria-label="Cadence"
                    value={draft.cadence}
                    onChange={(e) => setField('cadence', e.target.value)}
                    fullWidth
                    data-testid="edit-cadence"
                  />
                ) : (
                  <span className="text-text-primary-dark font-mono text-xs">{mission.cadence || 'N/A'}</span>
                )}
              </div>
            </div>
          </Card>

          {/* Period */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              OKR Period
            </h2>
            {isEditing && draft ? (
              <div className="space-y-2">
                <FormSelect
                  value={draft.periodType}
                  onChange={(e) => setField('periodType', e.target.value as MissionPeriodType | '')}
                  data-testid="edit-period-type"
                >
                  <option value="">— No period —</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="custom">Custom</option>
                </FormSelect>
                <Input
                  type="date"
                  aria-label="Period start"
                  value={draft.periodStart}
                  onChange={(e) => setField('periodStart', e.target.value)}
                  fullWidth
                  data-testid="edit-period-start"
                />
                <Input
                  type="date"
                  aria-label="Period end"
                  value={draft.periodEnd}
                  onChange={(e) => setField('periodEnd', e.target.value)}
                  fullWidth
                  data-testid="edit-period-end"
                />
                <Input
                  aria-label="Period label"
                  placeholder="Label (optional)"
                  value={draft.periodLabel}
                  onChange={(e) => setField('periodLabel', e.target.value)}
                  fullWidth
                  data-testid="edit-period-label"
                />
              </div>
            ) : mission.period ? (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Type</span>
                  <span className="text-text-primary-dark">{mission.period.type}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Start</span>
                  <span className="text-text-primary-dark text-xs">{formatDateTime(mission.period.startDate)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">End</span>
                  <span className="text-text-primary-dark text-xs">{formatDateTime(mission.period.endDate)}</span>
                </div>
                {mission.period.label && (
                  <div className="flex justify-between">
                    <span className="text-text-secondary-dark">Label</span>
                    <span className="text-text-primary-dark text-xs">{mission.period.label}</span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-text-secondary-dark">No period defined.</p>
            )}
          </Card>

          {/* Timestamps */}
          <Card variant="default" padding="md" className="border border-border-dark">
            <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <Calendar className="h-4 w-4" />
              Timestamps
            </h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Created</span>
                <span className="text-text-primary-dark text-xs">{formatDateTime(mission.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary-dark">Updated</span>
                <span className="text-text-primary-dark text-xs">{formatDateTime(mission.updatedAt)}</span>
              </div>
              {mission.lastReviewAt && (
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Last Review</span>
                  <span className="text-text-primary-dark text-xs">{formatDateTime(mission.lastReviewAt)}</span>
                </div>
              )}
              {mission.nextReviewAt && (
                <div className="flex justify-between">
                  <span className="text-text-secondary-dark">Next Review</span>
                  <span className="text-text-primary-dark text-xs">{formatDateTime(mission.nextReviewAt)}</span>
                </div>
              )}
            </div>
          </Card>

          {/* Active Task IDs (view-only) */}
          {!isEditing && mission.activeProjectTaskIds.length > 0 && (
            <Card variant="default" padding="md" className="border border-border-dark">
              <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide mb-3 flex items-center gap-1.5">
                <Clock className="h-4 w-4" />
                Active Task IDs
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {mission.activeProjectTaskIds.map((taskId) => (
                  <Badge key={taskId} variant="default" size="sm">{taskId.slice(0, 12)}</Badge>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

MissionDetail.displayName = 'MissionDetail';

export default MissionDetail;
