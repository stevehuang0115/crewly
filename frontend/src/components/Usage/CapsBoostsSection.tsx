/**
 * CapsBoostsSection
 *
 * "Caps & boosts" on the Usage page, collapsed by default with a one-line
 * summary and a "Boost a team" action beside it. Open, it shows the two caps
 * people change (all agents together, each agent), today's boosts with End
 * boost, and — one click further — the per-team and per-agent caps with their
 * one-tap boosts ("+XM today", "Unlimited today").
 *
 * Same behaviour as the former Settings › System usage panel; per-agent caps
 * and boosts are new here (the API already had them).
 *
 * @module components/Usage/CapsBoostsSection
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, MoreHorizontal, Zap } from 'lucide-react';
import { Button, OverflowMenu, ShowAll, type OverflowMenuItem } from '@crewly/ui';
import { boostAmount, compactTokens, type BoostRequest, type CapAgent, type CapTeam, type CapsView, type UsageRow } from '../../services/usage.service';
import type { CapsDraft } from '../../hooks/useUsage';
import { agentCapLabel, boostLabel, boostTargetName, teamCapLabel } from './usage.utils';

/** Props of {@link CapsBoostsSection}. */
export interface CapsBoostsSectionProps {
  caps: CapsView;
  /** Team rows of the stats (for the order: teams with usage first) */
  teamRows: UsageRow[];
  busy: boolean;
  onBoost: (req: BoostRequest, who: string) => Promise<void>;
  onEndBoost: (id: string) => Promise<void>;
  onSaveCaps: (draft: CapsDraft) => Promise<boolean>;
  /** Controlled open state */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Per-team / per-agent caps shown (controlled, so "Boost a team" can open them) */
  perOpen: boolean;
  onPerOpenChange: (open: boolean) => void;
}

const INPUT =
  'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm text-text placeholder:text-text-3 focus:border-primary focus:outline-none';

/**
 * One-line summary of the caps and boosts.
 *
 * @param caps - Caps view
 * @returns e.g. "200M a day for all agents · 1 boost today"
 */
export function capsSummary(caps: CapsView): string {
  const parts: string[] = [];
  const c = caps.caps;
  const teamCaps = Object.values(c.teamCapsTokens).filter((v) => v !== null).length;
  const agentCaps = Object.values(c.agentCapsTokens).filter((v) => v !== null).length;
  if (c.totalCapTokens !== null) parts.push(`${compactTokens(c.totalCapTokens)} a day for all agents`);
  if (c.defaultAgentCapTokens !== null) parts.push(`${compactTokens(c.defaultAgentCapTokens)} per agent`);
  if (teamCaps > 0) parts.push(`${teamCaps} team cap${teamCaps === 1 ? '' : 's'}`);
  if (agentCaps > 0) parts.push(`${agentCaps} agent cap${agentCaps === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push('No daily caps set');
  parts.push(caps.boosts.length === 0 ? 'no boosts today' : `${caps.boosts.length} boost${caps.boosts.length === 1 ? '' : 's'} today`);
  return parts.join(' · ');
}

/** Props of a cap row. */
interface CapRowProps {
  name: string;
  meta: string;
  stopped: boolean;
  capAria: string;
  capValue: string;
  capPlaceholder: string;
  onCapChange: (v: string) => void;
  boostLabelText: string;
  onBoost: () => void;
  /** Unlimited today (disabled when already unlimited) */
  onUnlimited: () => void;
  unlimited: boolean;
  overflow: OverflowMenuItem[];
  busy: boolean;
  testId: string;
}

/**
 * One team or agent with its cap field and boosts.
 *
 * @param props - {@link CapRowProps}
 * @returns Row
 */
const CapRow: React.FC<CapRowProps> = ({ name, meta, stopped, capAria, capValue, capPlaceholder, onCapChange, boostLabelText, onBoost, onUnlimited, unlimited, overflow, busy, testId }) => (
  <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border-soft py-3 last:border-b-0 sm:flex-nowrap" data-testid={testId}>
    <div className="min-w-0 flex-1 basis-40">
      <div className="truncate text-[15px] font-semibold text-text">{name}</div>
      <div className="truncate text-[13px] text-text-2">
        {stopped && <span className="font-semibold text-attention">Stopped until midnight · </span>}
        {meta}
      </div>
    </div>
    <input type="text" aria-label={capAria} placeholder={capPlaceholder} value={capValue} onChange={(e) => onCapChange(e.target.value)} className={`${INPUT} sm:w-32`} />
    <div className="flex shrink-0 items-center gap-2">
      <Button type="button" size="xs" variant="outline" disabled={busy} onClick={onBoost}>
        {boostLabelText}
      </Button>
      <Button type="button" size="xs" variant="outline" disabled={busy || unlimited} onClick={onUnlimited}>
        Unlimited today
      </Button>
      {overflow.length > 0 && <OverflowMenu items={overflow} icon={MoreHorizontal} label={`More for ${name}`} />}
    </div>
  </div>
);

/**
 * Caps & boosts.
 *
 * @param props - {@link CapsBoostsSectionProps}
 * @returns Section
 */
export const CapsBoostsSection: React.FC<CapsBoostsSectionProps> = ({
  caps,
  teamRows,
  busy,
  onBoost,
  onEndBoost,
  onSaveCaps,
  open,
  onOpenChange,
  perOpen,
  onPerOpenChange,
}) => {
  const fmt = (v: number | null): string => (v === null ? '' : compactTokens(v));
  const [total, setTotal] = useState(fmt(caps.caps.totalCapTokens));
  const [defaultAgent, setDefaultAgent] = useState(fmt(caps.caps.defaultAgentCapTokens));
  const [teamCaps, setTeamCaps] = useState<Record<string, string>>({});
  const [agentCaps, setAgentCaps] = useState<Record<string, string>>({});
  const perRef = useRef<HTMLDivElement>(null);

  // Fresh server values replace the typed ones after a save or reload.
  const capsKey = JSON.stringify(caps.caps);
  useEffect(() => {
    setTotal(fmt(caps.caps.totalCapTokens));
    setDefaultAgent(fmt(caps.caps.defaultAgentCapTokens));
    setTeamCaps({});
    setAgentCaps({});
    // Reset only when the saved caps change (capsKey), not on every new object.
  }, [capsKey]);

  useEffect(() => {
    if (open && perOpen) perRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [open, perOpen]);

  const teamById = useMemo(() => new Map(caps.teams.map((t) => [t.teamId, t])), [caps.teams]);
  // Teams with usage first (in the stats order), then the other teams.
  const teams: CapTeam[] = useMemo(
    () => [
      ...teamRows.map((r) => teamById.get(r.key)).filter((t): t is CapTeam => Boolean(t)),
      ...caps.teams.filter((t) => !teamRows.some((r) => r.key === t.teamId)),
    ],
    [teamRows, teamById, caps.teams],
  );
  const agents: CapAgent[] = useMemo(() => [...caps.agents].sort((a, b) => b.todayTokens - a.todayTokens || b.windowTokens - a.windowTokens), [caps.agents]);
  const everyoneBoost = caps.boosts.find((b) => b.target === '*');
  const defaultCapText = caps.caps.defaultAgentCapTokens !== null ? `Default ${compactTokens(caps.caps.defaultAgentCapTokens)}` : 'Default (off)';

  const save = (): void => {
    void onSaveCaps({ total, defaultAgent, teams: teamCaps, agents: agentCaps });
  };

  const teamOverflow = (t: CapTeam): OverflowMenuItem[] => {
    return t.boosts.map((b) => ({ label: `End boost (${boostLabel(b).toLowerCase()})`, disabled: busy, onClick: () => void onEndBoost(b.id) }));
  };

  const agentOverflow = (a: CapAgent): OverflowMenuItem[] => {
    return caps.boosts
      .filter((x) => x.target === a.session)
      .map((b) => ({ label: `End boost (${boostLabel(b).toLowerCase()})`, disabled: busy, onClick: () => void onEndBoost(b.id) }));
  };

  return (
    <section className="flex flex-col border-t border-border-soft" data-testid="usage-caps">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="usage-caps-body"
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-4 text-left text-text"
        >
          <span className="text-[15px] font-semibold">Caps &amp; boosts</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-text-2" data-testid="usage-caps-summary">
            {capsSummary(caps)}
          </span>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-text-2" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 shrink-0 text-text-2" aria-hidden="true" />}
        </button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          icon={Zap}
          className="shrink-0"
          onClick={() => {
            onOpenChange(true);
            onPerOpenChange(true);
          }}
        >
          Boost a team
        </Button>
      </div>

      {open && (
        <div id="usage-caps-body" className="flex flex-col gap-6 pb-5 pt-1">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="usage-total-cap" className="text-[13px] text-text-2">
                All agents together, per day
              </label>
              <input id="usage-total-cap" type="text" placeholder="Off — try 200M" value={total} onChange={(e) => setTotal(e.target.value)} className={INPUT} />
              <p className="text-xs text-text-3">When reached, every agent stops until midnight.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="usage-default-cap" className="text-[13px] text-text-2">
                Each agent, per day
              </label>
              <input id="usage-default-cap" type="text" placeholder="Off" value={defaultAgent} onChange={(e) => setDefaultAgent(e.target.value)} className={INPUT} />
              <p className="text-xs text-text-3" data-testid="usage-suggestion">
                {caps.suggestedAgentCapTokens !== null
                  ? `Suggested: ${compactTokens(caps.suggestedAgentCapTokens)} (90% of agent-days used less).`
                  : 'No usage yet to suggest a cap from.'}{' '}
                Empty = off.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              aria-expanded={perOpen}
              onClick={() => onPerOpenChange(!perOpen)}
              className="text-[13px] font-semibold text-primary-text hover:underline underline-offset-2"
            >
              {perOpen ? 'Hide per-team and per-agent caps' : 'Per-team and per-agent caps'}
            </button>
            <Button type="button" size="sm" disabled={busy} onClick={save}>
              Save caps
            </Button>
          </div>
          <p className="text-xs text-text-3">
            Amounts like <code>5M</code> or <code>500k</code>. At 80% of a cap you get one heads-up; at 100% the agent finishes its current turn and starts no new one until
            midnight, and its messages wait. Boosts end at midnight. From Slack, DM the orc: <code>boost CE by 20M today</code> or <code>unlimited today for everyone</code>.
          </p>

          <div className="flex flex-col" data-testid="usage-boosts">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-text-2">Today&apos;s boosts</h3>
              {everyoneBoost ? (
                <button type="button" className="text-[13px] font-semibold text-primary-text hover:underline" disabled={busy} onClick={() => void onEndBoost(everyoneBoost.id)}>
                  End everyone boost
                </button>
              ) : (
                <button type="button" className="text-[13px] font-semibold text-primary-text hover:underline" disabled={busy} onClick={() => void onBoost({ scope: 'all', unlimited: true }, 'Everyone')}>
                  Unlimited today for everyone
                </button>
              )}
            </div>
            {caps.boosts.length === 0 ? (
              <p className="py-2 text-sm text-text-2">No boosts today.</p>
            ) : (
              caps.boosts.map((b) => (
                <div key={b.id} className="flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0" data-testid={`usage-boost-${b.id}`}>
                  <span className="min-w-0 flex-1 truncate text-sm text-text">
                    <span className="font-semibold">{boostTargetName(b.target, caps.teams, caps.agents)}</span>
                    <span className="text-text-2"> · {boostLabel(b)}</span>
                  </span>
                  <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void onEndBoost(b.id)}>
                    End boost
                  </Button>
                </div>
              ))
            )}
          </div>

          {perOpen && (
            <div ref={perRef} className="flex flex-col gap-6" data-testid="usage-per-caps">
              <div className="flex flex-col">
                <h3 className="text-[13px] font-semibold text-text-2">Per team</h3>
                <p className="text-xs text-text-3">A team cap counts all its members together. Empty = no team cap.</p>
                <ShowAll limit={5} data-testid="usage-team-caps">
                  {teams.map((t) => {
                    const extra = boostAmount(t.baseCapTokens);
                    return (
                      <CapRow
                        key={t.teamId}
                        testId={`usage-cap-team-${t.teamId}`}
                        name={t.name}
                        meta={`${compactTokens(t.todayTokens)} today · ${teamCapLabel(t)}`}
                        stopped={t.stopped}
                        capAria={`Daily cap for team ${t.name}`}
                        capPlaceholder="No team cap"
                        capValue={teamCaps[t.teamId] ?? fmt(t.baseCapTokens)}
                        onCapChange={(v) => setTeamCaps((c) => ({ ...c, [t.teamId]: v }))}
                        boostLabelText={`+${compactTokens(extra)} today`}
                        onBoost={() => void onBoost({ scope: 'team', id: t.teamId, extraTokens: extra }, t.name)}
                        onUnlimited={() => void onBoost({ scope: 'team', id: t.teamId, unlimited: true }, t.name)}
                        unlimited={t.unlimited}
                        overflow={teamOverflow(t)}
                        busy={busy}
                      />
                    );
                  })}
                </ShowAll>
              </div>
              <div className="flex flex-col">
                <h3 className="text-[13px] font-semibold text-text-2">Per agent</h3>
                <p className="text-xs text-text-3">Empty = the default per-agent cap.</p>
                <ShowAll limit={5} data-testid="usage-agent-caps">
                  {agents.map((a) => {
                    const extra = boostAmount(a.capTokens);
                    return (
                      <CapRow
                        key={a.session}
                        testId={`usage-cap-agent-${a.session}`}
                        name={a.name}
                        meta={`${compactTokens(a.todayTokens)} today · ${agentCapLabel(a)}`}
                        stopped={a.stopped}
                        capAria={`Daily cap for agent ${a.name}`}
                        capPlaceholder={defaultCapText}
                        capValue={agentCaps[a.session] ?? (a.capSource === 'override' ? fmt(a.baseCapTokens) : '')}
                        onCapChange={(v) => setAgentCaps((c) => ({ ...c, [a.session]: v }))}
                        boostLabelText={`+${compactTokens(extra)} today`}
                        onBoost={() => void onBoost({ scope: 'agent', id: a.session, extraTokens: extra }, a.name)}
                        onUnlimited={() => void onBoost({ scope: 'agent', id: a.session, unlimited: true }, a.name)}
                        unlimited={a.unlimited}
                        overflow={agentOverflow(a)}
                        busy={busy}
                      />
                    );
                  })}
                </ShowAll>
              </div>
              <div>
                <Button type="button" size="sm" disabled={busy} onClick={save}>
                  Save caps
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default CapsBoostsSection;
