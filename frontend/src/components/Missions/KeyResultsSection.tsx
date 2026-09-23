/**
 * Key Results section for the Mission detail page.
 *
 * Lists the mission's KRs (title, metric type, baseline → current → target,
 * progress, status, measurement source, last measured), lets the owner record
 * a measurement inline (POST /measure), add a KR, edit the mutable fields
 * (target / current / measurement source) and delete a KR.
 *
 * Owns its own data: fetches GET /api/missions/:id/key-results on mount and
 * after every mutation, then notifies the parent via `onChanged` so the
 * cascade roll-up can refresh.
 *
 * @module components/Missions/KeyResultsSection
 */

import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Plus, Pencil, Trash2, Ruler, X, Save } from 'lucide-react';
import { Card } from '@crewly/ui/Card';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { Input } from '@crewly/ui/Input';
import { FormSelect } from '@crewly/ui/Form';
import { Alert } from '@crewly/ui/Alert';
import { ConfirmDialog } from '@crewly/ui/ConfirmDialog';
import { ProgressBar } from './OkrBadges';
import { apiService } from '../../services/api.service';
import {
  KR_METRIC_TYPES,
  KR_MEASUREMENT_SOURCES,
  KR_STATUS_LABEL,
  KR_STATUS_VARIANT,
  KR_SOURCE_LABEL,
  computeKrProgressPercent,
  formatKrValue,
  type KeyResult,
  type KRMetricType,
  type KRMeasurementSource,
  type CreateKeyResultInput,
} from '../../types/mission.types';

export interface KeyResultsSectionProps {
  /** Mission whose KRs are shown. */
  missionId: string;
  /** Called after any successful mutation (create / update / delete / measure). */
  onChanged?: () => void;
}

/** Default unit per metric type, pre-filled in the Add KR form. */
const DEFAULT_UNIT: Record<KRMetricType, string> = {
  number: 'count',
  percentage: '%',
  boolean: 'done',
  currency: '$',
};

/** Metric-type labels for selects. */
const METRIC_LABEL: Record<KRMetricType, string> = {
  number: 'Number',
  percentage: 'Percentage',
  boolean: 'Yes / No',
  currency: 'Currency',
};

/** Draft state for the Add KR form. */
interface NewKrDraft {
  title: string;
  metricType: KRMetricType;
  baseline: string;
  target: string;
  unit: string;
  measurementSource: KRMeasurementSource;
}

/** Draft state for inline KR editing. */
interface EditKrDraft {
  target: string;
  current: string;
  measurementSource: KRMeasurementSource;
}

const EMPTY_NEW_KR: NewKrDraft = {
  title: '',
  metricType: 'number',
  baseline: '0',
  target: '',
  unit: DEFAULT_UNIT.number,
  measurementSource: 'manual',
};

/**
 * Formats an ISO timestamp for the "last measured" column.
 */
function formatMeasuredAt(iso: string | undefined): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Parses a numeric form field; returns `null` when not a finite number.
 */
function parseNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Key Results table with inline measure / edit / delete and an Add form.
 *
 * @param props - See {@link KeyResultsSectionProps}
 */
export const KeyResultsSection: React.FC<KeyResultsSectionProps> = ({ missionId, onChanged }) => {
  const [krs, setKrs] = useState<KeyResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [newKr, setNewKr] = useState<NewKrDraft>(EMPTY_NEW_KR);

  const [measuringId, setMeasuringId] = useState<string | null>(null);
  const [measureValue, setMeasureValue] = useState('');
  const [measureNote, setMeasureNote] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditKrDraft | null>(null);

  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await apiService.getKeyResults(missionId);
      setKrs(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load key results');
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  /** Runs a mutation, then reloads and notifies the parent. */
  const mutate = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        await load();
        onChanged?.();
        return true;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Request failed');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  // ---------------------------------------------------------------------------
  // Add
  // ---------------------------------------------------------------------------
  const submitNew = async (): Promise<void> => {
    const baseline = parseNumber(newKr.baseline);
    const target = parseNumber(newKr.target);
    if (!newKr.title.trim()) { setActionError('Title is required'); return; }
    if (baseline === null || target === null) { setActionError('Baseline and target must be numbers'); return; }
    if (baseline === target) { setActionError('Baseline and target must be different'); return; }
    if (!newKr.unit.trim()) { setActionError('Unit is required'); return; }
    const input: CreateKeyResultInput = {
      title: newKr.title.trim(),
      metricType: newKr.metricType,
      baseline,
      target,
      unit: newKr.unit.trim(),
      measurementSource: newKr.measurementSource,
    };
    const ok = await mutate(async () => { await apiService.createKeyResult(missionId, input); });
    if (ok) {
      setNewKr(EMPTY_NEW_KR);
      setShowAdd(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Measure
  // ---------------------------------------------------------------------------
  const beginMeasure = (kr: KeyResult): void => {
    setActionError(null);
    setEditingId(null);
    setMeasuringId(kr.id);
    setMeasureValue(String(kr.current));
    setMeasureNote('');
  };

  const submitMeasure = async (krId: string): Promise<void> => {
    const value = parseNumber(measureValue);
    if (value === null) { setActionError('Measurement value must be a number'); return; }
    const ok = await mutate(async () => {
      await apiService.measureKeyResult(missionId, krId, {
        value,
        source: 'user',
        ...(measureNote.trim() ? { note: measureNote.trim() } : {}),
      });
    });
    if (ok) setMeasuringId(null);
  };

  // ---------------------------------------------------------------------------
  // Edit
  // ---------------------------------------------------------------------------
  const beginEdit = (kr: KeyResult): void => {
    setActionError(null);
    setMeasuringId(null);
    setEditingId(kr.id);
    setEditDraft({ target: String(kr.target), current: String(kr.current), measurementSource: kr.measurementSource });
  };

  const submitEdit = async (kr: KeyResult): Promise<void> => {
    if (!editDraft) return;
    const target = parseNumber(editDraft.target);
    const current = parseNumber(editDraft.current);
    if (target === null || current === null) { setActionError('Target and current must be numbers'); return; }
    if (target === kr.baseline) { setActionError('Target must differ from the baseline'); return; }
    const ok = await mutate(async () => {
      await apiService.updateKeyResult(missionId, kr.id, {
        ...(target !== kr.target ? { target } : {}),
        ...(current !== kr.current ? { current } : {}),
        ...(editDraft.measurementSource !== kr.measurementSource
          ? { measurementSource: editDraft.measurementSource }
          : {}),
      });
    });
    if (ok) { setEditingId(null); setEditDraft(null); }
  };

  // ---------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------
  const confirmDelete = async (): Promise<void> => {
    if (!deletingId) return;
    const id = deletingId;
    const ok = await mutate(async () => { await apiService.deleteKeyResult(missionId, id); });
    if (ok) setDeletingId(null);
  };

  return (
    <Card variant="default" padding="md" className="border border-border-dark" data-testid="key-results-section">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide flex items-center gap-1.5">
          <BarChart3 className="h-4 w-4" />
          Key Results ({krs.length})
        </h2>
        <Button
          variant="ghost"
          size="sm"
          icon={showAdd ? X : Plus}
          onClick={() => { setShowAdd((v) => !v); setActionError(null); }}
          data-testid="kr-add-toggle"
        >
          {showAdd ? 'Cancel' : 'Add KR'}
        </Button>
      </div>

      {actionError && (
        <div className="mb-3" data-testid="kr-action-error">
          <Alert variant="error" onClose={() => setActionError(null)}>{actionError}</Alert>
        </div>
      )}

      {/* Add form */}
      {showAdd && (
        <div className="mb-4 rounded-lg border border-border-dark bg-background-dark/60 p-3 space-y-2" data-testid="kr-add-form">
          <Input
            aria-label="KR title"
            placeholder="e.g. Reach $5k MRR"
            value={newKr.title}
            onChange={(e) => setNewKr((d) => ({ ...d, title: e.target.value }))}
            fullWidth
            data-testid="kr-new-title"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <FormSelect
              aria-label="Metric type"
              value={newKr.metricType}
              onChange={(e) => {
                const metricType = e.target.value as KRMetricType;
                setNewKr((d) => ({ ...d, metricType, unit: DEFAULT_UNIT[metricType] }));
              }}
              data-testid="kr-new-metric"
            >
              {KR_METRIC_TYPES.map((t) => <option key={t} value={t}>{METRIC_LABEL[t]}</option>)}
            </FormSelect>
            <Input
              aria-label="Baseline"
              type="number"
              placeholder="Baseline"
              value={newKr.baseline}
              onChange={(e) => setNewKr((d) => ({ ...d, baseline: e.target.value }))}
              data-testid="kr-new-baseline"
            />
            <Input
              aria-label="Target"
              type="number"
              placeholder="Target"
              value={newKr.target}
              onChange={(e) => setNewKr((d) => ({ ...d, target: e.target.value }))}
              data-testid="kr-new-target"
            />
            <Input
              aria-label="Unit"
              placeholder="Unit"
              value={newKr.unit}
              onChange={(e) => setNewKr((d) => ({ ...d, unit: e.target.value }))}
              data-testid="kr-new-unit"
            />
          </div>
          <div className="flex items-center gap-2">
            <FormSelect
              aria-label="Measurement source"
              value={newKr.measurementSource}
              onChange={(e) => setNewKr((d) => ({ ...d, measurementSource: e.target.value as KRMeasurementSource }))}
              data-testid="kr-new-source"
            >
              {KR_MEASUREMENT_SOURCES.map((s) => <option key={s} value={s}>{KR_SOURCE_LABEL[s]}</option>)}
            </FormSelect>
            <Button variant="primary" size="sm" onClick={submitNew} disabled={busy} data-testid="kr-new-submit">
              {busy ? 'Saving…' : 'Create KR'}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-secondary-dark" data-testid="kr-loading">Loading key results…</p>
      ) : error ? (
        <div data-testid="kr-error">
          <Alert variant="error">
            {error}
            <Button variant="ghost" size="sm" onClick={() => { setLoading(true); void load(); }} className="mt-2">Retry</Button>
          </Alert>
        </div>
      ) : krs.length === 0 ? (
        <p className="text-sm text-text-secondary-dark" data-testid="kr-empty">
          No key results yet. Add one to make this mission measurable.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="kr-table">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-text-secondary-dark border-b border-border-dark">
                <th className="py-2 pr-3 font-medium">Key result</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium whitespace-nowrap">Baseline → Current → Target</th>
                <th className="py-2 pr-3 font-medium min-w-[140px]">Progress</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Source</th>
                <th className="py-2 pr-3 font-medium whitespace-nowrap">Last measured</th>
                <th className="py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {krs.map((kr) => {
                const pct = computeKrProgressPercent(kr);
                const last = kr.measurements?.[0];
                const isMeasuring = measuringId === kr.id;
                const isEditing = editingId === kr.id && editDraft !== null;
                return (
                  <React.Fragment key={kr.id}>
                    <tr className="border-b border-border-dark/60 align-top" data-testid={`kr-row-${kr.id}`}>
                      <td className="py-2 pr-3 text-text-primary-dark font-medium">{kr.title}</td>
                      <td className="py-2 pr-3 text-text-secondary-dark">{METRIC_LABEL[kr.metricType]}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-text-primary-dark whitespace-nowrap" data-testid={`kr-values-${kr.id}`}>
                        {formatKrValue(kr.baseline, kr.metricType, kr.unit)}
                        <span className="text-text-secondary-dark"> → </span>
                        <span className="font-semibold">{formatKrValue(kr.current, kr.metricType, kr.unit)}</span>
                        <span className="text-text-secondary-dark"> → </span>
                        {formatKrValue(kr.target, kr.metricType, kr.unit)}
                      </td>
                      <td className="py-2 pr-3">
                        <ProgressBar percent={pct} status={kr.status} data-testid={`kr-progress-${kr.id}`} />
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={KR_STATUS_VARIANT[kr.status]} size="sm" data-testid={`kr-status-${kr.id}`}>
                          {KR_STATUS_LABEL[kr.status]}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-xs text-text-secondary-dark">{KR_SOURCE_LABEL[kr.measurementSource] ?? kr.measurementSource}</td>
                      <td className="py-2 pr-3 text-xs text-text-secondary-dark whitespace-nowrap" data-testid={`kr-last-${kr.id}`}>
                        {formatMeasuredAt(last?.measuredAt)}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="sm" icon={Ruler} onClick={() => beginMeasure(kr)} disabled={busy} data-testid={`kr-measure-${kr.id}`} aria-label="Record measurement">
                            Measure
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" icon={Pencil} onClick={() => beginEdit(kr)} disabled={busy} data-testid={`kr-edit-${kr.id}`} aria-label="Edit key result" />
                          <Button variant="danger-ghost" size="icon" className="h-8 w-8" icon={Trash2} onClick={() => setDeletingId(kr.id)} disabled={busy} data-testid={`kr-delete-${kr.id}`} aria-label="Delete key result" />
                        </div>
                      </td>
                    </tr>

                    {isMeasuring && (
                      <tr className="border-b border-border-dark/60 bg-background-dark/40" data-testid={`kr-measure-form-${kr.id}`}>
                        <td colSpan={8} className="py-2 px-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-text-secondary-dark">Record measurement:</span>
                            <Input
                              aria-label="Measurement value"
                              type="number"
                              value={measureValue}
                              onChange={(e) => setMeasureValue(e.target.value)}
                              className="w-32"
                              data-testid={`kr-measure-value-${kr.id}`}
                            />
                            <span className="text-xs text-text-secondary-dark">{kr.unit}</span>
                            <Input
                              aria-label="Measurement note"
                              placeholder="Note (optional)"
                              value={measureNote}
                              onChange={(e) => setMeasureNote(e.target.value)}
                              className="flex-1 min-w-[160px]"
                              data-testid={`kr-measure-note-${kr.id}`}
                            />
                            <Button variant="primary" size="sm" icon={Save} onClick={() => submitMeasure(kr.id)} disabled={busy} data-testid={`kr-measure-submit-${kr.id}`}>
                              {busy ? 'Saving…' : 'Save'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setMeasuringId(null)} disabled={busy}>Cancel</Button>
                          </div>
                        </td>
                      </tr>
                    )}

                    {isEditing && editDraft && (
                      <tr className="border-b border-border-dark/60 bg-background-dark/40" data-testid={`kr-edit-form-${kr.id}`}>
                        <td colSpan={8} className="py-2 px-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-text-secondary-dark">Edit:</span>
                            <label className="text-xs text-text-secondary-dark">Target</label>
                            <Input
                              aria-label="Edit target"
                              type="number"
                              value={editDraft.target}
                              onChange={(e) => setEditDraft((d) => (d ? { ...d, target: e.target.value } : d))}
                              className="w-28"
                              data-testid={`kr-edit-target-${kr.id}`}
                            />
                            <label className="text-xs text-text-secondary-dark">Current</label>
                            <Input
                              aria-label="Edit current"
                              type="number"
                              value={editDraft.current}
                              onChange={(e) => setEditDraft((d) => (d ? { ...d, current: e.target.value } : d))}
                              className="w-28"
                              data-testid={`kr-edit-current-${kr.id}`}
                            />
                            <FormSelect
                              aria-label="Edit measurement source"
                              value={editDraft.measurementSource}
                              onChange={(e) => setEditDraft((d) => (d ? { ...d, measurementSource: e.target.value as KRMeasurementSource } : d))}
                              data-testid={`kr-edit-source-${kr.id}`}
                            >
                              {KR_MEASUREMENT_SOURCES.map((s) => <option key={s} value={s}>{KR_SOURCE_LABEL[s]}</option>)}
                            </FormSelect>
                            <Button variant="primary" size="sm" icon={Save} onClick={() => submitEdit(kr)} disabled={busy} data-testid={`kr-edit-submit-${kr.id}`}>
                              {busy ? 'Saving…' : 'Save'}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => { setEditingId(null); setEditDraft(null); }} disabled={busy}>Cancel</Button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={deletingId !== null}
        title="Delete key result"
        message="This removes the key result and its measurement history. This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        loading={busy}
        onCancel={() => setDeletingId(null)}
        onConfirm={confirmDelete}
      />
    </Card>
  );
};

export default KeyResultsSection;
