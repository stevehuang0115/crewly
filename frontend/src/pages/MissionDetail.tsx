/**
 * Goal page (former Mission detail; `/teams/goals/:id`,
 * specs/2026-10-02-ui-redesign.md §Teams, simplify level).
 *
 * Top: breadcrumb (Teams › Goals), the objective, one line (level · status ·
 * priority · period · owner team), Edit + "⋯" (Refresh). A pending proposal
 * shows Approve / Reject right under it.
 *
 * Visible: Key Results (measure / add / edit / delete), child proposals
 * waiting for approval, and the current strategy. Everything else is in a
 * collapsed "More": success criteria, cascade (parent + children roll-up),
 * learnings, execution progress, team & settings, OKR period, timestamps and
 * active task ids. Edit mode opens one form with every editable field
 * (objective, status, priority, team, strategy, success criteria, period,
 * parent, cadence); Save issues PUT /api/missions/:id.
 *
 * @module pages/MissionDetail
 */

import { LINKS, ROUTES } from '../constants/routes.constants';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  Target,
  ListChecks,
  Pencil,
  Save,
  X,
  ChevronRight,
  MoreHorizontal,
} from 'lucide-react';
import { Card } from '@crewly/ui/Card';
import { PageHeader, StatusLabel, CollapsibleSection, ShowAll } from '@crewly/ui';
import { OverflowMenu } from '@crewly/ui/OverflowMenu';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Button } from '@crewly/ui/Button';
import { Input } from '@crewly/ui/Input';
import { FormSelect, FormTextarea } from '@crewly/ui/Form';
import { EmptyState } from '@crewly/ui/EmptyState';
import { Alert } from '@crewly/ui/Alert';
import { ApprovalChip } from '../components/Missions/OkrBadges';
import { goalStatus, ownerTeamLabel } from './Missions';
import { formatRelativeTimeCompact } from '../utils/time';
import { ApprovalActions } from '../components/Missions/ApprovalActions';
import { KeyResultsSection } from '../components/Missions/KeyResultsSection';
import { CascadeSection } from '../components/Missions/CascadeSection';
import { ProposalsSection } from '../components/Missions/ProposalsSection';
import { MissionProgressSection } from '../components/Missions/MissionProgressSection';
import { apiService } from '../services/api.service';
import {
  PRIORITY_LABEL,
  LEVEL_LABEL,
  getMissionStatusLabel,
  resolveLevel,
  type Mission,
  type MissionStatus,
  type MissionPriority,
  type MissionPeriodType,
} from '../types/mission.types';

// =============================================================================
// Types
// =============================================================================

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

  /** id → objective for every known mission (parent / children names). */
  const [missionNames, setMissionNames] = useState<Map<string, string>>(new Map());
  /** Lookup used to resolve the level of legacy missions. */
  const [missionsById, setMissionsById] = useState<Map<string, Pick<Mission, 'level' | 'parentMissionId'>>>(new Map());
  /** Team id → name, so the owner team reads as a name, not an id. */
  const [teamNames, setTeamNames] = useState<Map<string, string>>(new Map());
  /** Bumped after KR / approval changes so the roll-up sections re-fetch. */
  const [okrRefreshKey, setOkrRefreshKey] = useState(0);

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
        const message = err instanceof Error ? err.message : 'Failed to load goal';
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

  // Names for the cascade view come from the list endpoint; non-fatal.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = (await apiService.getMissions()) as Mission[];
        if (cancelled) return;
        setMissionNames(new Map(all.map((m) => [m.id, m.objective] as const)));
        setMissionsById(new Map(all.map((m) => [m.id, { level: m.level, parentMissionId: m.parentMissionId }] as const)));
      } catch {
        // Cascade falls back to id prefixes.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const teams = await apiService.getTeams();
        if (!cancelled && Array.isArray(teams)) setTeamNames(new Map(teams.map((t) => [t.id, t.name] as const)));
      } catch {
        // Falls back to the raw team id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Refresh roll-ups (and the mission header's inline KR summaries). */
  const handleOkrChanged = useCallback(() => {
    setOkrRefreshKey((k) => k + 1);
    void loadMission(false);
  }, [loadMission]);

  /** A decision on this mission (or on one of its child proposals). */
  const handleDecided = useCallback(
    (updated: Mission) => {
      setMission((prev) => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev));
      handleOkrChanged();
    },
    [handleOkrChanged],
  );

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
      const message = err instanceof Error ? err.message : 'Failed to save goal';
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
        <LoadingSpinner size="xl" text="Loading goal..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto" data-testid="mission-detail-error">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate(LINKS.goals())} className="mb-6">
          Back to Goals
        </Button>
        <Card variant="default" padding="lg">
          <div className="flex flex-col items-center text-center py-8">
            <p className="text-red-400 mb-2">{error}</p>
            <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => loadMission()}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!mission) {
    return (
      <div className="p-6 max-w-[1000px] mx-auto">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate(LINKS.goals())} className="mb-6">
          Back to Goals
        </Button>
        <Card variant="default" padding="lg">
          <EmptyState icon={Target} title="Goal not found." compact />
        </Card>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Main render (view + edit modes share the layout)
  // ---------------------------------------------------------------------------
  const level = resolveLevel(mission, missionsById);
  const approvalState = mission.approval?.state;
  const status = goalStatus(mission);
  const teamName = ownerTeamLabel(mission.ownerTeamId, teamNames);
  const editing = isEditing && !!draft;

  const row = (label: string, value: React.ReactNode, testId?: string) => (
    <div className="flex items-baseline justify-between gap-4 border-t border-border-soft py-2 text-sm first:border-t-0" data-testid={testId}>
      <dt className="shrink-0 text-text-2">{label}</dt>
      <dd className="min-w-0 text-right text-text">{value}</dd>
    </div>
  );
  const sectionTitle = 'mb-2 text-[13px] font-semibold text-text-2';

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="mission-detail-page">
      <PageHeader
        eyebrow={
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
            <Link to={ROUTES.teams} className="text-text-2 hover:text-text">Teams</Link>
            <ChevronRight className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
            <Link to={LINKS.goals()} className="text-text-2 hover:text-text" data-testid="mission-detail-back">Goals</Link>
          </nav>
        }
        title={editing ? 'Edit goal' : mission.objective}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span data-testid={`level-badge-${level}`}>{LEVEL_LABEL[level]}</span>
            <span className="text-text-3">·</span>
            <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
            {mission.priority && (
              <>
                <span className="text-text-3">·</span>
                <span>{PRIORITY_LABEL[mission.priority]} priority</span>
              </>
            )}
            {mission.period?.label && (
              <>
                <span className="text-text-3">·</span>
                <span>{mission.period.label}</span>
              </>
            )}
            <span className="text-text-3">·</span>
            <span title={teamNames.has(mission.ownerTeamId) ? undefined : `Team id ${mission.ownerTeamId}`}>{teamName}</span>
          </span>
        }
        actions={
          editing ? (
            <>
              <Button variant="primary" size="sm" icon={Save} onClick={saveEdit} disabled={saving} data-testid="mission-save">
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" size="sm" icon={X} onClick={cancelEdit} disabled={saving} data-testid="mission-cancel">
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" icon={Pencil} onClick={beginEdit} data-testid="mission-edit">
                Edit
              </Button>
              <OverflowMenu
                icon={MoreHorizontal}
                label="More goal actions"
                buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-border-soft text-text-2 transition-colors hover:bg-surface-hover hover:text-text"
                items={[{ label: refreshing ? 'Refreshing…' : 'Refresh', icon: RefreshCw, onClick: () => loadMission(false), disabled: refreshing }]}
              />
            </>
          )
        }
      />

      {approvalState && approvalState !== 'pending_approval' && mission.approval?.decidedAt && !editing && (
        <div className="mb-4">
          <ApprovalChip state={approvalState} />
        </div>
      )}
      {approvalState === 'pending_approval' && !editing && (
        <div className="mb-6 flex flex-wrap items-center gap-3" data-testid="mission-pending-banner">
          <ApprovalChip state={approvalState} />
          <span className="text-[13px] text-attention">
            Proposed{mission.approval?.proposedBy ? ` by ${mission.approval.proposedBy}` : ''}. Waiting for your decision.
          </span>
          <ApprovalActions missionId={mission.id} onDecided={handleDecided} />
        </div>
      )}
      {approvalState === 'rejected' && mission.approval?.rejectionReason && (
        <p className="mb-4 text-[13px] text-danger" data-testid="mission-rejection-reason">
          Rejected: {mission.approval.rejectionReason}
        </p>
      )}

      {saveError && (
        <div data-testid="mission-save-error" className="mb-4">
          <Alert variant="error" onClose={() => setSaveError(null)}>
            {saveError}
          </Alert>
        </div>
      )}

      {editing && draft ? (
        /* One form with every editable field */
        <div className="flex flex-col gap-4 rounded-2xl border border-border-soft p-5" data-testid="mission-edit-form">
          <label className="flex flex-col gap-1 text-sm text-text-2">
            Objective
            <Input aria-label="Objective" value={draft.objective} onChange={(e) => setField('objective', e.target.value)} fullWidth data-testid="edit-objective" />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-text-2">
              Status
              <FormSelect value={draft.status} onChange={(e) => setField('status', e.target.value as MissionStatus)} data-testid="edit-status">
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </FormSelect>
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-2">
              Priority
              <FormSelect value={draft.priority} onChange={(e) => setField('priority', e.target.value as MissionPriority)} data-testid="edit-priority">
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </FormSelect>
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-2">
              Owner team
              <Input aria-label="Owner Team" value={draft.ownerTeamId} onChange={(e) => setField('ownerTeamId', e.target.value)} fullWidth data-testid="edit-owner-team" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-2">
              Parent goal
              <Input aria-label="Parent Mission ID" placeholder="(none)" value={draft.parentMissionId} onChange={(e) => setField('parentMissionId', e.target.value)} fullWidth data-testid="edit-parent" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-2">
              Review cadence (cron)
              <Input aria-label="Cadence" value={draft.cadence} onChange={(e) => setField('cadence', e.target.value)} fullWidth data-testid="edit-cadence" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm text-text-2">
            Current strategy
            <FormTextarea aria-label="Current Strategy" rows={4} value={draft.currentStrategy} onChange={(e) => setField('currentStrategy', e.target.value)} data-testid="edit-strategy" />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-2">
            Success criteria (one per line)
            <FormTextarea aria-label="Success Criteria (one per line)" rows={5} placeholder="One criterion per line" value={draft.successCriteriaText} onChange={(e) => setField('successCriteriaText', e.target.value)} data-testid="edit-success-criteria" />
          </label>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm text-text-2">OKR period</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <FormSelect value={draft.periodType} onChange={(e) => setField('periodType', e.target.value as MissionPeriodType | '')} data-testid="edit-period-type">
                <option value="">— No period —</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="custom">Custom</option>
              </FormSelect>
              <Input type="date" aria-label="Period start" value={draft.periodStart} onChange={(e) => setField('periodStart', e.target.value)} fullWidth data-testid="edit-period-start" />
              <Input type="date" aria-label="Period end" value={draft.periodEnd} onChange={(e) => setField('periodEnd', e.target.value)} fullWidth data-testid="edit-period-end" />
              <Input aria-label="Period label" placeholder="Label (optional)" value={draft.periodLabel} onChange={(e) => setField('periodLabel', e.target.value)} fullWidth data-testid="edit-period-label" />
            </div>
          </fieldset>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {/* Key Results: measure / add / edit / delete */}
          <KeyResultsSection missionId={mission.id} onChanged={handleOkrChanged} />

          {/* Pending child proposals (renders nothing when there are none) */}
          <ProposalsSection parentMissionId={mission.id} onDecided={handleDecided} />

          {/* Strategy */}
          <section aria-labelledby="goal-strategy-h">
            <h2 id="goal-strategy-h" className={sectionTitle}>Current strategy</h2>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-text">
              {mission.currentStrategy || 'No strategy defined.'}
            </p>
          </section>

          {/* Everything else, one click away */}
          <CollapsibleSection
            title="More"
            summary="Success criteria, cascade, learnings, progress, settings, period, timestamps"
            data-testid="goal-more"
          >
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="flex flex-col gap-8 lg:col-span-2">
                <section aria-labelledby="goal-criteria-h">
                  <h2 id="goal-criteria-h" className={sectionTitle}>Success criteria ({mission.successCriteria.length})</h2>
                  {mission.successCriteria.length === 0 ? (
                    <p className="text-sm text-text-2">No success criteria defined.</p>
                  ) : (
                    <ul className="space-y-2">
                      {mission.successCriteria.map((criterion, idx) => (
                        <li key={idx} className="flex items-start gap-2 text-sm text-text">
                          <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-text-3" aria-hidden="true" />
                          {criterion}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <CascadeSection
                  missionId={mission.id}
                  level={level}
                  parentMissionId={mission.parentMissionId}
                  missionNames={missionNames}
                  refreshKey={okrRefreshKey}
                />

                {mission.learnings && mission.learnings.length > 0 && (
                  <section aria-labelledby="goal-learnings-h">
                    <h2 id="goal-learnings-h" className={sectionTitle}>Learnings ({mission.learnings.length})</h2>
                    <ShowAll as="ul" limit={6} className="space-y-2" data-testid="goal-learnings">
                      {mission.learnings.map((learning, idx) => (
                        <li key={idx} className="border-l-2 border-border-soft pl-4 text-sm text-text">
                          {learning}
                        </li>
                      ))}
                    </ShowAll>
                  </section>
                )}
              </div>

              <div className="flex flex-col gap-8">
                <MissionProgressSection missionId={mission.id} refreshKey={okrRefreshKey} />

                <section aria-labelledby="goal-settings-h">
                  <h2 id="goal-settings-h" className={sectionTitle}>Team &amp; settings</h2>
                  <dl>
                    {row('Owner team', <span title={mission.ownerTeamId}>{teamName}</span>)}
                    {row('Status', getMissionStatusLabel(mission.status))}
                    {row('Priority', PRIORITY_LABEL[mission.priority ?? 'medium'])}
                    {row(
                      'Parent goal',
                      mission.parentMissionId ? (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          onClick={() => navigate(LINKS.goal(mission.parentMissionId as string))}
                          className="max-w-full truncate"
                          data-testid="mission-parent-link"
                        >
                          {missionNames.get(mission.parentMissionId) ?? mission.parentMissionId}
                        </Button>
                      ) : (
                        '—'
                      ),
                    )}
                    {row('Level', <span data-testid="mission-level">{level}</span>)}
                    {mission.projectId &&
                      row(
                        'Project',
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          onClick={() => navigate(LINKS.project(mission.projectId as string))}
                          data-testid="mission-project-link"
                        >
                          Open project
                        </Button>,
                      )}
                    {row('Active tasks', mission.activeProjectTaskIds.length)}
                    {row('Review cadence', <span className="font-mono text-xs">{mission.cadence || 'N/A'}</span>)}
                    {row('Reference', <span className="font-mono text-xs">{mission.id.slice(0, 12)}</span>)}
                  </dl>
                </section>

                <section aria-labelledby="goal-period-h">
                  <h2 id="goal-period-h" className={sectionTitle}>OKR period</h2>
                  {mission.period ? (
                    <dl>
                      {row('Type', mission.period.type)}
                      {row('Start', formatDateTime(mission.period.startDate))}
                      {row('End', formatDateTime(mission.period.endDate))}
                      {mission.period.label && row('Label', mission.period.label)}
                    </dl>
                  ) : (
                    <p className="text-sm text-text-2">No period defined.</p>
                  )}
                </section>

                <section aria-labelledby="goal-times-h">
                  <h2 id="goal-times-h" className={sectionTitle}>Timestamps</h2>
                  <dl>
                    {row('Created', formatDateTime(mission.createdAt))}
                    {row('Updated', <span title={formatDateTime(mission.updatedAt)}>{formatRelativeTimeCompact(mission.updatedAt)}</span>)}
                    {mission.lastReviewAt && row('Last review', formatDateTime(mission.lastReviewAt))}
                    {mission.nextReviewAt && row('Next review', formatDateTime(mission.nextReviewAt))}
                  </dl>
                </section>

                {mission.activeProjectTaskIds.length > 0 && (
                  <section aria-labelledby="goal-task-ids-h">
                    <h2 id="goal-task-ids-h" className={sectionTitle}>Active task ids</h2>
                    <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-text-2">
                      {mission.activeProjectTaskIds.map((taskId) => (
                        <span key={taskId} title={taskId}>{taskId.slice(0, 12)}</span>
                      ))}
                    </p>
                  </section>
                )}
              </div>
            </div>
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
};

MissionDetail.displayName = 'MissionDetail';

export default MissionDetail;
