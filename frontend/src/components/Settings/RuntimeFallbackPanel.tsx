/**
 * Settings → Runtimes → Fallback
 *
 * When a runtime runs out of usage (Claude's 5-hour limit, a DeepSeek
 * balance, a Gemini daily quota), Crewly moves the affected agents to the
 * next runtime of this order until it resets. The owner edits the order
 * (global, plus per-agent overrides), sees which runtimes are out of usage
 * and which agents run on a fallback, and can test any runtime end to end.
 *
 * Only runtimes that are installed and signed in can be added; the others
 * are listed with the reason. A runtime whose Terms the owner did not accept
 * can still be added or tested: that asks about its Terms again. Phone-friendly: one column, full-width
 * controls on small screens.
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module components/Settings/RuntimeFallbackPanel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Alert, Button, LoadingSpinner } from '@crewly/ui';
import { Toggle } from '@crewly/ui/Toggle';
import {
  runtimeFallbackService,
  type RuntimeAvailability,
  type RuntimeFallbackSettings,
  type RuntimeFallbackState,
  type SmokeTestJob,
} from '../../services/runtime-fallback.service';
import { apiService } from '../../services/api.service';

/** How often a running smoke test is polled. */
const SMOKE_POLL_MS = 3000;

/** A member that can get its own order. */
interface MemberOption {
  id: string;
  label: string;
}

/**
 * Format an ISO time for the owner.
 *
 * @param iso - ISO time
 * @returns e.g. "3:00 PM" or "Oct 6, 9:00 AM"
 */
export function formatResetTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString('en-US', { ...(sameDay ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}

/**
 * Status line of a runtime.
 *
 * @param r - Availability
 * @returns Text and tone
 */
function runtimeStatus(r: RuntimeAvailability | undefined): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!r) return { text: 'Unknown runtime', tone: 'muted' };
  if (r.exhausted) return { text: 'Out of usage', tone: 'warn' };
  if (r.selectable) return { text: 'Ready', tone: 'ok' };
  return { text: r.reason ?? 'Not available', tone: r.termsBlocked ? 'warn' : 'muted' };
}

const TONE_CLASS: Record<'ok' | 'warn' | 'muted', string> = {
  ok: 'text-emerald-400',
  warn: 'text-yellow-400',
  muted: 'text-text-secondary-dark',
};

/** Props of {@link ChainEditor}. */
interface ChainEditorProps {
  chain: string[];
  runtimes: RuntimeAvailability[];
  onChange: (chain: string[]) => void;
  testIdPrefix: string;
}

/**
 * An ordered list of runtimes with move / remove / add.
 *
 * @param props - Chain, availability, change handler
 * @returns Editor
 */
const ChainEditor: React.FC<ChainEditorProps> = ({ chain, runtimes, onChange, testIdPrefix }) => {
  const byId = useMemo(() => new Map(runtimes.map((r) => [r.runtime, r])), [runtimes]);
  const addable = runtimes.filter((r) => !chain.includes(r.runtime));
  const move = (i: number, d: -1 | 1): void => {
    const next = [...chain];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <ol className="space-y-2" data-testid={`${testIdPrefix}-chain`}>
        {chain.map((runtime, i) => {
          const r = byId.get(runtime);
          const status = runtimeStatus(r);
          return (
            <li
              key={runtime}
              className="flex items-center gap-2 rounded-lg border border-border-dark bg-surface-dark px-3 py-2"
              data-testid={`${testIdPrefix}-item-${runtime}`}
            >
              <span className="w-5 text-sm text-text-secondary-dark">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary-dark">{r?.label ?? runtime}</div>
                <div className={`truncate text-xs ${TONE_CLASS[status.tone]}`}>{status.text}</div>
              </div>
              <button type="button" className="p-2 text-text-secondary-dark hover:text-primary disabled:opacity-30" aria-label={`Move ${r?.label ?? runtime} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="p-2 text-text-secondary-dark hover:text-primary disabled:opacity-30"
                aria-label={`Move ${r?.label ?? runtime} down`}
                disabled={i === chain.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="p-2 text-text-secondary-dark hover:text-red-400"
                aria-label={`Remove ${r?.label ?? runtime}`}
                onClick={() => onChange(chain.filter((x) => x !== runtime))}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ol>
      {addable.length > 0 && (
        <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
          <span className="flex items-center gap-1 text-text-secondary-dark">
            <Plus className="h-4 w-4" /> Add
          </span>
          <select
            className="w-full rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark sm:w-auto"
            value=""
            aria-label="Add a runtime"
            data-testid={`${testIdPrefix}-add`}
            onChange={(e) => e.target.value && onChange([...chain, e.target.value])}
          >
            <option value="">Choose a runtime…</option>
            {addable.map((r) => (
              <option key={r.runtime} value={r.runtime} disabled={!r.selectable && !r.termsBlocked}>
                {r.selectable
                  ? r.label
                  : r.termsBlocked
                    ? `${r.label} — terms not accepted (adding it asks you again)`
                    : `${r.label} — ${r.reason ?? 'not available'}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
};

/** Props of {@link RuntimeFallbackPanel}. */
export interface RuntimeFallbackPanelProps {
  /** Poll interval of a running smoke test (tests shorten it) */
  smokePollMs?: number;
}

/**
 * Fallback settings, live state and runtime tests.
 *
 * @param props - Props
 * @returns Panel
 */
export const RuntimeFallbackPanel: React.FC<RuntimeFallbackPanelProps> = ({ smokePollMs = SMOKE_POLL_MS }) => {
  const [state, setState] = useState<RuntimeFallbackState | null>(null);
  const [draft, setDraft] = useState<RuntimeFallbackSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [newMember, setNewMember] = useState('');
  const [tests, setTests] = useState<Record<string, SmokeTestJob | { error: string }>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      const next = await runtimeFallbackService.getState();
      setState(next);
      setDraft(next.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    apiService
      .getTeams()
      .then((teams) =>
        setMembers(
          teams.flatMap((t) => (t.members ?? []).filter((m) => m.id !== 'orchestrator-member').map((m) => ({ id: m.id, label: `${m.name} (${t.name})` }))),
        ),
      )
      .catch(() => setMembers([]));
    const pending = timers.current;
    return () => Object.values(pending).forEach(clearTimeout);
  }, [load]);

  const dirty = useMemo(() => Boolean(state && draft && JSON.stringify(state.settings) !== JSON.stringify(draft)), [state, draft]);

  const save = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    try {
      const next = await runtimeFallbackService.updateSettings(draft);
      setState(next);
      setDraft(next.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const poll = useCallback(
    (runtime: string, jobId: string) => {
      timers.current[runtime] = setTimeout(async () => {
        try {
          const job = await runtimeFallbackService.getSmokeTest(jobId);
          setTests((t) => ({ ...t, [runtime]: job }));
          if (job.state === 'running') poll(runtime, jobId);
        } catch (err) {
          setTests((t) => ({ ...t, [runtime]: { error: err instanceof Error ? err.message : String(err) } }));
        }
      }, smokePollMs);
    },
    [smokePollMs],
  );

  const runTest = async (runtime: string): Promise<void> => {
    try {
      const job = await runtimeFallbackService.startSmokeTest(runtime);
      setTests((t) => ({ ...t, [runtime]: job }));
      if (job.state === 'running') poll(runtime, job.jobId);
    } catch (err) {
      setTests((t) => ({ ...t, [runtime]: { error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  if (!state || !draft) {
    return error ? (
      <Alert variant="error" title="Couldn't load the fallback settings">
        <div className="space-y-2">
          <p>{error}</p>
          <Button type="button" size="sm" variant="secondary" icon={RefreshCw} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Alert>
    ) : (
      <LoadingSpinner centered text="Loading fallback settings…" />
    );
  }

  const memberName = (id: string): string => members.find((m) => m.id === id)?.label ?? id;
  const labelOf = (runtime: string): string => state.runtimes.find((r) => r.runtime === runtime)?.label ?? runtime;

  return (
    <div className="space-y-6" data-testid="runtime-fallback-panel">
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}

      {state.exhausted.length > 0 && (
        <div className="space-y-2" data-testid="runtime-fallback-exhausted">
          {state.exhausted.map((e) => {
            const on = state.overrides.filter((o) => o.primary === e.runtime);
            return (
              <Alert key={e.runtime} variant="warning" size="sm">
                {labelOf(e.runtime)} is out of usage{e.until ? ` (resets ~${formatResetTime(e.until)})` : ''}.{' '}
                {on.length > 0
                  ? `${on.length} agent${on.length === 1 ? '' : 's'} on ${[...new Set(on.map((o) => o.runtimeLabel))].join(' / ')} until then.`
                  : e.noFallback
                    ? 'No fallback runtime is available.'
                    : 'Agents switch when they next get work.'}
              </Alert>
            );
          })}
        </div>
      )}

      {state.overrides.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="runtime-fallback-overrides">
          {state.overrides.map((o) => (
            <li key={o.sessionName} className="text-text-secondary-dark">
              <span className="text-text-primary-dark">{o.sessionName}</span> — {o.badge}
              {o.revertPending ? ' · switching back when idle' : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-3">
        <Toggle
          label="Switch runtimes automatically when one runs out of usage"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          data-testid="runtime-fallback-enabled"
        />
        <Toggle
          label="The orchestrator switches too"
          checked={draft.orcFollows}
          onChange={(e) => setDraft({ ...draft, orcFollows: e.target.checked })}
          data-testid="runtime-fallback-orc"
        />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-text-primary-dark">Fallback order</h3>
        <p className="mb-2 text-xs text-text-secondary-dark">An agent moves to the first runtime in this order that is not its own and still has usage.</p>
        <ChainEditor chain={draft.chain} runtimes={state.runtimes} onChange={(chain) => setDraft({ ...draft, chain })} testIdPrefix="fallback-global" />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-text-primary-dark">Per-agent order</h3>
        <p className="mb-2 text-xs text-text-secondary-dark">Optional. An agent listed here uses its own order instead.</p>
        <div className="space-y-4">
          {Object.entries(draft.memberChains).map(([memberId, chain]) => (
            <div key={memberId} className="space-y-2 rounded-lg border border-border-dark p-3" data-testid={`fallback-member-${memberId}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-text-primary-dark">{memberName(memberId)}</span>
                <button
                  type="button"
                  className="text-xs text-text-secondary-dark hover:text-red-400"
                  onClick={() => {
                    const next = { ...draft.memberChains };
                    delete next[memberId];
                    setDraft({ ...draft, memberChains: next });
                  }}
                >
                  Use the global order
                </button>
              </div>
              <ChainEditor
                chain={chain}
                runtimes={state.runtimes}
                onChange={(c) => setDraft({ ...draft, memberChains: { ...draft.memberChains, [memberId]: c } })}
                testIdPrefix={`fallback-member-${memberId}`}
              />
            </div>
          ))}
          <div className="flex flex-col gap-2 sm:flex-row">
            <select
              className="w-full rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark sm:w-auto"
              value={newMember}
              aria-label="Agent for its own order"
              onChange={(e) => setNewMember(e.target.value)}
            >
              <option value="">Choose an agent…</option>
              {members
                .filter((m) => !(m.id in draft.memberChains))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              icon={Plus}
              disabled={!newMember}
              onClick={() => {
                setDraft({ ...draft, memberChains: { ...draft.memberChains, [newMember]: [...draft.chain] } });
                setNewMember('');
              }}
            >
              Give it its own order
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" onClick={() => void save()} disabled={!dirty || saving} data-testid="runtime-fallback-save">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => setDraft(state.settings)}>
            Discard changes
          </Button>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-text-primary-dark">Test a runtime</h3>
        <p className="mb-2 text-xs text-text-secondary-dark">
          Starts a temporary one-agent team on the runtime, asks it to run a bash command and reply, then deletes the team. Takes up to 5 minutes.
        </p>
        <ul className="space-y-2">
          {state.runtimes
            // A runtime whose Terms were not accepted can be tested: that asks again.
            .filter((r) => r.selectable || r.exhausted || r.termsBlocked)
            .map((r) => {
              const t = tests[r.runtime];
              const running = Boolean(t && 'state' in t && t.state === 'running');
              const result = t && 'result' in t ? t.result : undefined;
              return (
                <li key={r.runtime} className="rounded-lg border border-border-dark p-3" data-testid={`runtime-test-${r.runtime}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-text-primary-dark">{r.label}</span>
                    <Button type="button" size="sm" variant="secondary" icon={FlaskConical} disabled={running} onClick={() => void runTest(r.runtime)}>
                      {running ? 'Testing…' : 'Test'}
                    </Button>
                  </div>
                  {t && 'error' in t && <p className="mt-2 text-xs text-red-400">{t.error}</p>}
                  {result && (
                    <div className="mt-2 text-xs" data-testid={`runtime-test-result-${r.runtime}`}>
                      {result.passed ? (
                        <p className="text-emerald-400">Passed in {Math.round(result.durationMs / 1000)}s — it ran bash and replied.</p>
                      ) : (
                        <p className="text-red-400">
                          Failed at “{result.failedStep?.replace(/_/g, ' ')}”: {result.error}
                        </p>
                      )}
                      {result.screen && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-text-secondary-dark">Screen</summary>
                          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background-dark p-2 text-[11px]">{result.screen}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
};
