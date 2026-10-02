/**
 * Settings → System → Spend
 *
 * What each agent spent today and over the last 7 days (by agent and by
 * runtime), and the owner's daily spend caps: a default per-agent cap
 * (off until set; the last 7 days' p90 is suggested), per-agent overrides
 * and an optional all-agents total. An agent that hit its cap is stopped
 * until midnight; "Raise today" lifts it for the rest of the day.
 *
 * Costs are API-equivalent (a Claude subscription is not billed at these
 * rates). specs/2026-10-02-spend-cap.md
 *
 * @module components/Settings/SpendPanel
 */

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { Alert, Button } from '@crewly/ui';
import { FormInput, FormLabel } from '@crewly/ui/Form';
import { parseCapInput, spendService, TOTAL_TARGET, usd, type SpendAgent, type SpendCapPatch, type SpendView } from '../../services/spend.service';

/** Labels of runtimes. */
const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'crewly-agent': 'Crewly Agent',
  'codex-cli': 'Codex',
  'gemini-cli': 'Gemini CLI',
  'antigravity-cli': 'Antigravity',
  'opencode-cli': 'OpenCode',
  other: 'Other',
};

/**
 * The "Raise to $Y today" amount: twice the cap, rounded up, above the spend.
 *
 * @param capUsd - Cap in force
 * @param spentUsd - Spent today
 * @returns USD
 */
export function raiseAmount(capUsd: number, spentUsd: number): number {
  return Math.max(Math.ceil(capUsd * 2), Math.ceil(spentUsd) + 1);
}

/**
 * Text of an agent's cap cell.
 *
 * @param a - Agent row
 * @returns e.g. `$5.00 (default)`, `No cap`
 */
export function capLabel(a: Pick<SpendAgent, 'capUsd' | 'capSource'>): string {
  if (a.capUsd === null) return a.capSource === 'exempt' ? 'No cap (exempt)' : 'No cap';
  const from = a.capSource === 'raised' ? 'raised today' : a.capSource === 'override' ? 'own' : 'default';
  return `${usd(a.capUsd)} (${from})`;
}

/**
 * Spend + caps panel.
 *
 * @returns Panel
 */
export const SpendPanel: React.FC = () => {
  const [view, setView] = useState<SpendView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaultCap, setDefaultCap] = useState('');
  const [totalCap, setTotalCap] = useState('');
  const [agentCaps, setAgentCaps] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const next = await spendService.get(7);
      setView(next);
      setDefaultCap(next.caps.defaultAgentCapUsd === null ? '' : String(next.caps.defaultAgentCapUsd));
      setTotalCap(next.caps.totalCapUsd === null ? '' : String(next.caps.totalCapUsd));
      setAgentCaps({});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      setNote(await action());
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (): Promise<void> =>
    run(async () => {
      const patch: SpendCapPatch = {};
      const d = parseCapInput(defaultCap);
      const t = parseCapInput(totalCap);
      if (d === undefined || t === undefined) throw new Error('Caps must be a positive amount in USD, or empty for off.');
      patch.defaultAgentCapUsd = d;
      patch.totalCapUsd = t;
      const agents: Record<string, number | 'default'> = {};
      for (const [session, text] of Object.entries(agentCaps)) {
        const v = parseCapInput(text);
        if (v === undefined) throw new Error(`The cap for ${session} must be a positive amount in USD, or empty for the default.`);
        agents[session] = v === null ? 'default' : v;
      }
      if (Object.keys(agents).length > 0) patch.agents = agents;
      await spendService.setCaps(patch);
      return 'Caps saved. They apply right away and reset each day at midnight.';
    });

  const raise = (session: string, name: string, amount: number): Promise<void> =>
    run(async () => {
      const out = await spendService.raise(session, amount);
      return `${name} raised to ${usd(out.capUsd)} for today. Queued messages are being delivered.`;
    });

  if (!view) {
    return error ? (
      <Alert variant="error" size="sm">
        {error}{' '}
        <button type="button" className="underline" onClick={() => void load()}>
          Retry
        </button>
      </Alert>
    ) : null;
  }

  const runtimes = Object.entries(view.byRuntime).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const todayRuntimes = Object.entries(view.days[view.days.length - 1]?.byRuntime ?? {}).filter(([, v]) => v > 0);
  const agents = view.agents.filter((a) => a.windowUsd > 0 || a.capUsd !== null || a.stopped);
  const totalSpentToday = view.todayUsd;

  return (
    <div className="space-y-4" data-testid="spend-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Wallet className="h-5 w-5 shrink-0 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Spend</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} icon={RefreshCw}>
          Refresh
        </Button>
      </div>
      <p className="text-xs text-text-secondary-dark">
        API-equivalent cost from the token ledger, by local day. Claude on a subscription is not billed at these rates.
      </p>

      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      {note && <p className="text-xs text-emerald-400" data-testid="spend-note">{note}</p>}
      {view.totalStopped && view.totalCapTodayUsd !== null && (
        <Alert variant="warning" size="sm">
          All agents together hit the daily total spend cap ({usd(view.totalCapTodayUsd)}). Every agent is stopped until midnight.{' '}
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={() => void raise(TOTAL_TARGET, 'The daily total cap', raiseAmount(view.totalCapTodayUsd ?? 0, totalSpentToday))}
          >
            Raise to ${raiseAmount(view.totalCapTodayUsd, totalSpentToday)} today
          </button>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border-dark p-3">
          <div className="text-xs text-text-secondary-dark">Today</div>
          <div className="text-xl font-semibold text-text-primary-dark" data-testid="spend-today">{usd(view.todayUsd)}</div>
          <div className="mt-1 text-xs text-text-secondary-dark">
            {todayRuntimes.map(([rt, v]) => `${RUNTIME_LABELS[rt] ?? rt} ${usd(v)}`).join(' · ') || 'Nothing yet'}
          </div>
        </div>
        <div className="rounded-lg border border-border-dark p-3">
          <div className="text-xs text-text-secondary-dark">Last {view.days.length} days</div>
          <div className="text-xl font-semibold text-text-primary-dark" data-testid="spend-window">{usd(view.totalUsd)}</div>
          <div className="mt-1 text-xs text-text-secondary-dark">{runtimes.map(([rt, v]) => `${RUNTIME_LABELS[rt] ?? rt} ${usd(v)}`).join(' · ') || 'Nothing yet'}</div>
        </div>
      </div>

      <div className="space-y-2" data-testid="spend-agents">
        {agents.length === 0 && <p className="text-sm text-text-secondary-dark">No agent spend recorded in the last {view.days.length} days.</p>}
        {agents.map((a) => {
          const raiseTo = a.capUsd !== null ? raiseAmount(a.capUsd, a.todayUsd) : null;
          return (
            <div key={a.session} className="rounded-lg border border-border-dark p-3" data-testid={`spend-agent-${a.session}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-text-primary-dark">{a.name}</span>{' '}
                  <span className="text-xs text-text-secondary-dark">{a.runtimes.map((r) => RUNTIME_LABELS[r] ?? r).join(', ')}</span>
                </div>
                <div className="text-sm text-text-primary-dark">
                  {usd(a.todayUsd)} <span className="text-xs text-text-secondary-dark">today · {usd(a.windowUsd)} 7d</span>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary-dark">
                <span>Cap: {capLabel(a)}</span>
                {a.stopped && <span className="text-yellow-400" data-testid={`spend-stopped-${a.session}`}>{a.stopReason ?? 'Stopped'} — stopped until midnight</span>}
              </div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <FormInput
                  size="sm"
                  inputMode="decimal"
                  aria-label={`Daily cap for ${a.name}`}
                  placeholder={a.capSource === 'override' ? '' : view.caps.defaultAgentCapUsd !== null ? `Default ${usd(view.caps.defaultAgentCapUsd)}` : 'No cap'}
                  value={agentCaps[a.session] ?? (a.capSource === 'override' && view.caps.agentCapsUsd[a.session] != null ? String(view.caps.agentCapsUsd[a.session]) : '')}
                  onChange={(e) => setAgentCaps((c) => ({ ...c, [a.session]: e.target.value }))}
                  className="sm:max-w-[10rem]"
                />
                {a.stopped && raiseTo !== null && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void raise(a.session, a.name, raiseTo)}>
                    Raise to ${raiseTo} today
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <FormLabel htmlFor="spend-default-cap">Daily cap per agent (USD)</FormLabel>
          <FormInput id="spend-default-cap" inputMode="decimal" placeholder="Off" value={defaultCap} onChange={(e) => setDefaultCap(e.target.value)} />
          <p className="mt-1 text-xs text-text-secondary-dark" data-testid="spend-suggestion">
            {view.suggestedAgentCapUsd !== null
              ? `Suggested: $${view.suggestedAgentCapUsd} (90% of agent-days in the last ${view.days.length} days spent less).`
              : 'No spend recorded yet to suggest a cap from.'}{' '}
            Empty = off.
          </p>
        </div>
        <div>
          <FormLabel htmlFor="spend-total-cap">Daily total cap, all agents (USD)</FormLabel>
          <FormInput id="spend-total-cap" inputMode="decimal" placeholder="Off" value={totalCap} onChange={(e) => setTotalCap(e.target.value)} />
          <p className="mt-1 text-xs text-text-secondary-dark">Optional. When reached, every agent stops until midnight.</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          Save caps
        </Button>
        {view.suggestedAgentCapUsd !== null && defaultCap === '' && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setDefaultCap(String(view.suggestedAgentCapUsd))}>
            Use suggested ${view.suggestedAgentCapUsd}
          </Button>
        )}
      </div>
      <p className="text-xs text-text-secondary-dark">
        At 80% of a cap you get one heads-up. At 100% the agent finishes its current turn and starts no new one until midnight; its messages wait in
        its queue. You can also DM the orc: <code>set daily cap for crewly-orc to $5</code>.
      </p>
    </div>
  );
};

export default SpendPanel;
