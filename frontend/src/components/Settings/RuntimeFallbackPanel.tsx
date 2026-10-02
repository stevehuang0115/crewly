/**
 * Settings › Runtimes › Fallback pieces
 *
 * When a runtime runs out of usage (Claude's 5-hour limit, a DeepSeek
 * balance, a Gemini daily quota), Crewly moves the affected agents to the
 * next runtime of this order until it resets. The Runtimes tab shows the
 * order and its switch up top; the per-agent orders, the orchestrator rule
 * and the runtime test sit under Advanced. All pieces share one draft from
 * {@link useRuntimeFallback}, saved together.
 *
 * Only runtimes that are installed and signed in can be added; the others
 * are listed with the reason. A runtime whose Terms the owner did not accept
 * can still be added or tested: that asks about its Terms again.
 *
 * specs/2026-10-01-runtime-fallback.md
 *
 * @module components/Settings/RuntimeFallbackPanel
 */

import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, LogIn, Plus, Trash2 } from 'lucide-react';
import { Button } from '@crewly/ui';
import { Toggle } from '@crewly/ui/Toggle';
import type { ExhaustedRuntime, RuntimeAvailability } from '../../services/runtime-fallback.service';
import { isTestRunning, type UseRuntimeFallbackResult } from '../../hooks/useRuntimeFallback';

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
 * What is wrong with an exhausted runtime, as words.
 *
 * @param e - Exhausted runtime (`kind: 'login'` = a Claude Code account signed out)
 * @returns "is signed out" or "is out of usage"
 */
export function exhaustedPhrase(e: Pick<ExhaustedRuntime, 'kind'>): string {
  return e.kind === 'login' ? 'is signed out' : 'is out of usage';
}

/** Tone of a status word. */
export type FallbackTone = 'ok' | 'warn' | 'muted';

/**
 * Status line of a runtime.
 *
 * @param r - Availability
 * @returns Text and tone
 */
export function runtimeStatus(r: RuntimeAvailability | undefined): { text: string; tone: FallbackTone } {
  if (!r) return { text: 'Unknown runtime', tone: 'muted' };
  if (r.exhausted) return { text: 'Out of usage', tone: 'warn' };
  if (r.selectable) return { text: 'Ready', tone: 'ok' };
  return { text: r.reason ?? 'Not available', tone: r.termsBlocked ? 'warn' : 'muted' };
}

/** Text colour per tone: colour only where it needs attention. */
export const TONE_CLASS: Record<FallbackTone, string> = {
  ok: 'text-text-2',
  warn: 'text-attention',
  muted: 'text-text-3',
};

const SELECT =
  'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text focus:border-primary focus:outline-none sm:w-auto';

/** Props of {@link ChainEditor}. */
export interface ChainEditorProps {
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
export const ChainEditor: React.FC<ChainEditorProps> = ({ chain, runtimes, onChange, testIdPrefix }) => {
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
    <div className="flex flex-col gap-2">
      <ol aria-label="Fallback order" className="flex flex-col" data-testid={`${testIdPrefix}-chain`}>
        {chain.map((runtime, i) => {
          const r = byId.get(runtime);
          const status = runtimeStatus(r);
          return (
            <li key={runtime} className="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0" data-testid={`${testIdPrefix}-item-${runtime}`}>
              <span className="w-5 text-[13px] tabular-nums text-text-3">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text">{r?.label ?? runtime}</span>
              {status.tone !== 'ok' && <span className={`truncate text-[13px] ${TONE_CLASS[status.tone]}`}>{status.text}</span>}
              <button type="button" className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-30" aria-label={`Move ${r?.label ?? runtime} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-30"
                aria-label={`Move ${r?.label ?? runtime} down`}
                disabled={i === chain.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-danger"
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
          <span className="flex items-center gap-1 text-[13px] font-semibold text-primary-text">
            <Plus className="h-4 w-4" /> Add a runtime
          </span>
          <select className={SELECT} value="" aria-label="Add a runtime" data-testid={`${testIdPrefix}-add`} onChange={(e) => e.target.value && onChange([...chain, e.target.value])}>
            <option value="">Choose a runtime…</option>
            {addable.map((r) => (
              <option key={r.runtime} value={r.runtime} disabled={!r.selectable && !r.termsBlocked}>
                {r.selectable ? r.label : r.termsBlocked ? `${r.label} — terms not accepted (adding it asks you again)` : `${r.label} — ${r.reason ?? 'not available'}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
};

/** Props shared by the fallback pieces. */
export interface FallbackPieceProps {
  fb: UseRuntimeFallbackResult;
}

/**
 * Save / Discard for the shared draft.
 *
 * @param props - Hook result, and whether to hide while clean
 * @returns Buttons
 */
export const FallbackSaveBar: React.FC<FallbackPieceProps & { onlyWhenDirty?: boolean; testId?: string }> = ({ fb, onlyWhenDirty = false, testId = 'runtime-fallback-save' }) => {
  if (onlyWhenDirty && !fb.dirty) return null;
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button type="button" size="sm" onClick={() => void fb.save()} disabled={!fb.dirty || fb.saving} data-testid={testId}>
        {fb.saving ? 'Saving…' : 'Save'}
      </Button>
      {fb.dirty && (
        <Button type="button" size="sm" variant="ghost" onClick={fb.discard}>
          Discard changes
        </Button>
      )}
    </div>
  );
};

/**
 * Runtimes out of usage, and the agents running on a fallback.
 *
 * @param props - Hook result
 * @returns Lines, or nothing when all is well
 */
export const FallbackStatus: React.FC<FallbackPieceProps> = ({ fb }) => {
  const { state } = fb;
  if (!state || (state.exhausted.length === 0 && state.overrides.length === 0)) return null;
  return (
    <div className="flex flex-col gap-2">
      {state.exhausted.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="runtime-fallback-exhausted">
          {state.exhausted.map((e) => {
            const on = state.overrides.filter((o) => o.primary === e.runtime);
            return (
              <p key={e.runtime} className="text-[13px] text-attention" role="status">
                {fb.labelOf(e.runtime)} {exhaustedPhrase(e)}{e.until ? ` (resets ~${formatResetTime(e.until)})` : ''}.{' '}
                {on.length > 0
                  ? `${on.length} agent${on.length === 1 ? '' : 's'} on ${[...new Set(on.map((o) => o.runtimeLabel))].join(' / ')} until then.`
                  : e.noFallback
                    ? 'No fallback runtime is available.'
                    : 'Agents switch when they next get work.'}
              </p>
            );
          })}
        </div>
      )}
      {state.overrides.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-[13px]" data-testid="runtime-fallback-overrides">
          {state.overrides.map((o) => (
            <li key={o.sessionName} className="text-text-2">
              <span className="text-text">{o.sessionName}</span> — {o.badge}
              {o.revertPending ? ' · switching back when idle' : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * The fallback switch and the global order.
 *
 * @param props - Hook result
 * @returns Section body
 */
export const FallbackOrderSection: React.FC<FallbackPieceProps> = ({ fb }) => {
  const { state, draft, setDraft } = fb;
  if (!state || !draft) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="runtime-fallback-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="fallback-heading" className="text-[15px] font-semibold text-text">
            When one runs out, switch to the next
          </h2>
          <p className="text-[13px] text-text-2">Agents move back when the limit resets.</p>
        </div>
        <Toggle
          aria-labelledby="fallback-heading"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          data-testid="runtime-fallback-enabled"
        />
      </div>
      <FallbackStatus fb={fb} />
      <ChainEditor chain={draft.chain} runtimes={state.runtimes} onChange={(chain) => setDraft({ ...draft, chain })} testIdPrefix="fallback-global" />
      <FallbackSaveBar fb={fb} />
    </div>
  );
};

/**
 * Whether the orchestrator follows the fallback.
 *
 * @param props - Hook result
 * @returns Row
 */
export const OrcFollowsToggle: React.FC<FallbackPieceProps> = ({ fb }) => {
  const { draft, setDraft } = fb;
  if (!draft) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <span id="fallback-orc-label" className="text-[15px] font-semibold text-text">
        The orchestrator switches too
      </span>
      <Toggle aria-labelledby="fallback-orc-label" checked={draft.orcFollows} onChange={(e) => setDraft({ ...draft, orcFollows: e.target.checked })} data-testid="runtime-fallback-orc" />
    </div>
  );
};

/**
 * Per-agent orders.
 *
 * @param props - Hook result
 * @returns Section body
 */
export const PerAgentOrderSection: React.FC<FallbackPieceProps> = ({ fb }) => {
  const { state, draft, setDraft, members, memberName } = fb;
  const [newMember, setNewMember] = useState('');
  if (!state || !draft) return null;
  const count = Object.keys(draft.memberChains).length;
  return (
    <div className="flex flex-col gap-3" data-testid="fallback-per-agent">
      <div>
        <p className="text-[15px] font-semibold text-text">Per-agent order</p>
        <p className="text-[13px] text-text-2">{count === 0 ? 'No agent has its own order.' : 'An agent listed here uses its own order instead.'}</p>
      </div>
      {Object.entries(draft.memberChains).map(([memberId, chain]) => (
        <div key={memberId} className="flex flex-col gap-2 border-l-2 border-border-soft pl-3" data-testid={`fallback-member-${memberId}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-text">{memberName(memberId)}</span>
            <button
              type="button"
              className="text-[13px] text-text-2 hover:text-danger"
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
        <select className={SELECT} value={newMember} aria-label="Agent for its own order" onChange={(e) => setNewMember(e.target.value)}>
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
  );
};

/**
 * Result of one runtime's smoke test.
 *
 * @param props - Hook result and runtime
 * @returns Lines, or nothing before a test
 */
export const SmokeTestResult: React.FC<FallbackPieceProps & { runtime: string; testId?: string }> = ({ fb, runtime, testId = `runtime-test-result-${runtime}` }) => {
  const t = fb.tests[runtime];
  if (!t) return null;
  if ('error' in t) return <p className="text-[13px] text-danger">{t.error}</p>;
  if (t.state === 'running' || !t.result) return <p className="text-[13px] text-text-2">Testing {fb.labelOf(runtime)}… up to 5 minutes.</p>;
  const result = t.result;
  return (
    <div className="text-[13px]" data-testid={testId}>
      {result.passed ? (
        <p className="text-success">
          {fb.labelOf(runtime)} passed in {Math.round(result.durationMs / 1000)}s — it ran bash and replied.
        </p>
      ) : (
        <p className="text-danger">
          Failed at “{result.failedStep?.replace(/_/g, ' ')}”: {result.error}
        </p>
      )}
      {result.screen && (
        <details className="mt-1">
          <summary className="cursor-pointer text-text-2">Screen</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 text-[11px] text-text-2">{result.screen}</pre>
        </details>
      )}
    </div>
  );
};

/**
 * Runtimes that can be tested: ready, out of usage, or with Terms not accepted (testing asks again).
 * A second Claude Code account (`claude-code@…`) is the same runtime: test Claude Code instead.
 *
 * @param runtimes - Availability
 * @returns Testable runtimes
 */
export function testableRuntimes(runtimes: RuntimeAvailability[]): RuntimeAvailability[] {
  return runtimes.filter((r) => !r.runtime.includes('@') && (r.selectable || r.exhausted || r.termsBlocked));
}

/** Account names the backend accepts. */
const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * The owner's other Claude Code accounts (issue #942): add one (its sign-in
 * link goes to the owner's Slack DM), sign it in again, remove it. An added
 * account appears in the fallback order's "Add a runtime" list as
 * "Claude Code (name)".
 *
 * @param props - Hook result
 * @returns Section body
 */
export const ClaudeAccountsSection: React.FC<FallbackPieceProps> = ({ fb }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const accounts = fb.state?.claudeAccounts ?? [];
  const normalised = name.trim().toLowerCase();
  const valid = ACCOUNT_NAME.test(normalised) && !accounts.some((a) => a.name === normalised);
  const run = async (action: () => Promise<string | null | void>): Promise<void> => {
    setBusy(true);
    try {
      const next = await action();
      setNotice(typeof next === 'string' ? next : null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="claude-accounts">
      <div>
        <p className="text-[15px] font-semibold text-text">More Claude Code accounts</p>
        <p className="text-[13px] text-text-2">
          Your own other Claude Code accounts on this machine, each with its own login. Add one to the order above (e.g. right after Claude Code) and agents move to
          it when Claude Code runs out. Only use accounts that are yours — sharing an account with someone else is against Anthropic&apos;s terms.
        </p>
      </div>
      {accounts.length > 0 && (
        <ul className="flex flex-col" aria-label="Claude Code accounts">
          {accounts.map((a) => (
            <li key={a.name} className="flex items-center gap-3 border-b border-border-soft py-2 last:border-b-0" data-testid={`claude-account-${a.name}`}>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{a.name}</span>
              <span className={`text-[13px] ${a.signedIn ? TONE_CLASS.ok : TONE_CLASS.warn}`}>{a.signedIn ? 'Signed in' : 'Not signed in'}</span>
              <button
                type="button"
                className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-30"
                aria-label={`Sign in ${a.name} again`}
                disabled={busy}
                onClick={() => void run(() => fb.signInClaudeAccount(a.name))}
              >
                <LogIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-danger disabled:opacity-30"
                aria-label={`Remove ${a.name}`}
                disabled={busy}
                onClick={() => void run(() => fb.removeClaudeAccount(a.name))}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void run(async () => {
            const next = await fb.addClaudeAccount(normalised);
            if (next) setName('');
            return next;
          });
        }}
      >
        <input
          className={`${SELECT} sm:w-56`}
          value={name}
          placeholder="Account name, e.g. work"
          aria-label="New Claude Code account name"
          maxLength={32}
          onChange={(e) => setName(e.target.value)}
          data-testid="claude-account-name"
        />
        <Button type="submit" size="sm" variant="secondary" icon={Plus} disabled={!valid || busy} data-testid="claude-account-add">
          Add and sign in
        </Button>
      </form>
      {notice && (
        <p className="text-[13px] text-text-2" role="status" data-testid="claude-account-notice">
          {notice}
        </p>
      )}
    </div>
  );
};

/**
 * Test a runtime end to end: pick one, Test, see the result.
 *
 * @param props - Hook result
 * @returns Section body
 */
export const RuntimeSmokeTest: React.FC<FallbackPieceProps> = ({ fb }) => {
  const runtimes = testableRuntimes(fb.state?.runtimes ?? []);
  const [picked, setPicked] = useState('');
  const runtime = picked || runtimes[0]?.runtime || '';
  if (runtimes.length === 0) return null;
  const tested = runtimes.filter((r) => fb.tests[r.runtime]);
  return (
    <div className="flex flex-col gap-2" data-testid="runtime-smoke-test">
      <div>
        <p className="text-[15px] font-semibold text-text">Test a runtime</p>
        <p className="text-[13px] text-text-2">Runs one throwaway agent and checks it replies. Up to 5 minutes.</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select className={SELECT} value={runtime} aria-label="Runtime to test" data-testid="runtime-test-select" onChange={(e) => setPicked(e.target.value)}>
          {runtimes.map((r) => (
            <option key={r.runtime} value={r.runtime}>
              {r.label}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="secondary" icon={FlaskConical} disabled={!runtime || isTestRunning(fb.tests[runtime])} onClick={() => void fb.runTest(runtime)} data-testid="runtime-test-button">
          {isTestRunning(fb.tests[runtime]) ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {tested.map((r) => (
        <div key={r.runtime} data-testid={`runtime-test-${r.runtime}`}>
          <SmokeTestResult fb={fb} runtime={r.runtime} />
        </div>
      ))}
    </div>
  );
};
