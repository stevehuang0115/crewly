/**
 * Lead share of a team's tokens (crewly#1083, specs/2026-10-04-tl-delegation.md §3).
 *
 * A team whose lead burns most of its tokens is a team whose lead does the
 * work. Per team: the lead sessions' tokens over the whole team's, today and
 * over the last week, flagged above {@link TL_DELEGATION_CONSTANTS.FLAG_SHARE}.
 *
 * Pure functions only: the token ledger is passed in as a visitor.
 *
 * @module services/tl-delegation/lead-share
 */

import { TL_DELEGATION_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember } from '../../types/index.js';
import { getTeamLeads } from '../../utils/team.utils.js';
import { eventTokens, type TokenUsageEvent } from '../monitoring/token-usage.service.js';

/** One period's numbers. */
export interface LeadSharePeriod {
  /** Tokens of the lead session(s) */
  lead: number;
  /** Tokens of every member session of the team, leads included */
  team: number;
  /** lead / team, or null when the team used nothing */
  share: number | null;
  /** Share above the flag line, with enough team tokens to judge */
  flagged: boolean;
  /**
   * The team's cost-weighted (budget) tokens, shown beside the raw {@link team}.
   * The share and the flag stay on RAW tokens (a report, calibrated to them);
   * only budgets and caps compare the weighted unit (crewly#1090).
   */
  teamBudget?: number;
}

/** One team's lead share. */
export interface LeadShareRow {
  teamId: string;
  teamName: string;
  /** Lead display names */
  leads: string[];
  /** Lead session names (ledger keys) */
  leadSessions: string[];
  /** Since local midnight */
  today: LeadSharePeriod;
  /** The last {@link TL_DELEGATION_CONSTANTS.WEEK_DAYS} days */
  week: LeadSharePeriod;
}

/** Visits ledger events at or after `since` (TokenUsageService.forEachEvent). */
export type LedgerVisitor = (visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date) => void;

/**
 * The ledger keys a member's usage is recorded under: its session name and
 * its permanent agent id (a stopped member has no session name).
 *
 * @param m - Team member
 * @returns Non-empty keys
 */
export function memberLedgerKeys(m: Pick<TeamMember, 'sessionName'> & { agentId?: string }): string[] {
  return [...new Set([m.sessionName, m.agentId].filter((k): k is string => typeof k === 'string' && k.length > 0))];
}

/**
 * Local midnight of a date.
 *
 * @param now - Clock
 * @returns Midnight (local time) of the same day
 */
export function startOfLocalDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Build a period from its totals.
 *
 * @param lead - Lead tokens
 * @param team - Team tokens
 * @param teamBudget - Team cost-weighted tokens, for display
 * @returns The period
 */
export function sharePeriod(lead: number, team: number, teamBudget?: number): LeadSharePeriod {
  const share = team > 0 ? lead / team : null;
  return {
    lead,
    team,
    share,
    flagged: share !== null && share > TL_DELEGATION_CONSTANTS.FLAG_SHARE && team >= TL_DELEGATION_CONSTANTS.MIN_TEAM_TOKENS,
    ...(teamBudget !== undefined ? { teamBudget: Math.round(teamBudget) } : {}),
  };
}

/**
 * Lead share per team. Teams that are archived, have no lead, or have no
 * other member are left out (a one-person team has no one to delegate to).
 *
 * @param teams - Teams
 * @param forEachEvent - Ledger visitor
 * @param now - Clock
 * @returns One row per team with a lead and at least one other member
 */
export function computeLeadShares(teams: readonly Team[], forEachEvent: LedgerVisitor, now: Date): LeadShareRow[] {
  const dayStart = startOfLocalDay(now).getTime();
  const weekStart = startOfLocalDay(new Date(now.getTime() - (TL_DELEGATION_CONSTANTS.WEEK_DAYS - 1) * 24 * 60 * 60 * 1000)).getTime();
  type Acc = { row: Omit<LeadShareRow, 'today' | 'week'>; day: { lead: number; team: number; budget: number }; week: { lead: number; team: number; budget: number } };
  const accs: Acc[] = [];
  // ledger key → (team accumulator, is lead)
  const owners = new Map<string, { acc: Acc; lead: boolean }>();
  for (const team of teams) {
    if ((team as Team & { archived?: boolean }).archived) continue;
    const members = (team.members ?? []).filter((m) => m.role !== 'orchestrator');
    const leads = getTeamLeads(team);
    if (leads.length === 0 || members.length < 2) continue;
    const leadIds = new Set(leads.map((l) => l.id));
    const acc: Acc = {
      row: {
        teamId: team.id,
        teamName: team.name,
        leads: leads.map((l) => l.name),
        leadSessions: leads.flatMap((l) => memberLedgerKeys(l)),
      },
      day: { lead: 0, team: 0, budget: 0 },
      week: { lead: 0, team: 0, budget: 0 },
    };
    accs.push(acc);
    for (const m of members) {
      for (const key of memberLedgerKeys(m)) {
        if (!owners.has(key)) owners.set(key, { acc, lead: leadIds.has(m.id) });
      }
    }
  }
  if (accs.length === 0) return [];
  forEachEvent((session, event) => {
    const owner = owners.get(session);
    if (!owner) return;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at < weekStart || at > now.getTime()) return;
    const et = eventTokens(event);
    const tokens = et.total;
    owner.acc.week.budget += et.budget;
    owner.acc.week.team += tokens;
    if (owner.lead) owner.acc.week.lead += tokens;
    if (at >= dayStart) {
      owner.acc.day.budget += et.budget;
      owner.acc.day.team += tokens;
      if (owner.lead) owner.acc.day.lead += tokens;
    }
  }, new Date(weekStart));
  return accs.map((a) => ({ ...a.row, today: sharePeriod(a.day.lead, a.day.team, a.day.budget), week: sharePeriod(a.week.lead, a.week.team, a.week.budget) }));
}

/**
 * A share as a whole percentage.
 *
 * @param share - 0..1 or null
 * @returns "63%" or "–"
 */
export function formatShare(share: number | null): string {
  return share === null ? '–' : `${Math.round(share * 100)}%`;
}

/**
 * Token count, short.
 *
 * @param n - Tokens
 * @returns "306M", "4.2M", "12k", "800"
 */
export function formatTokens(n: number): string {
  if (n >= 100_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** Per-lead extras for the digest: nudges and kept-work reasons today. */
export interface LeadDigestExtras {
  /** Nudges today and how many were followed by a delegation */
  nudges?: { count: number; followed: number };
  /** Reasons recorded today for keeping work ("no member fits") */
  keptReasons?: string[];
}

/**
 * The "Team leads" block of the evening digest. Teams with no tokens today
 * and no records are left out.
 *
 * @param rows - Lead shares
 * @param extras - Team id → nudges / kept-work reasons
 * @returns Block text, or null when there is nothing to say
 */
export function buildLeadShareDigest(rows: readonly LeadShareRow[], extras: ReadonlyMap<string, LeadDigestExtras> = new Map()): string | null {
  const lines: string[] = [];
  for (const r of rows) {
    const x = extras.get(r.teamId) ?? {};
    const kept = x.keptReasons ?? [];
    if (r.today.team === 0 && kept.length === 0 && !x.nudges?.count) continue;
    const flag = r.today.flagged || r.week.flagged ? ' — over half: the lead is doing the work' : '';
    const parts = [
      `- *${r.teamName}* (${r.leads.join(', ')}): ${formatShare(r.today.share)} of ${formatTokens(r.today.team)} today${r.today.teamBudget !== undefined ? ` (${formatTokens(r.today.teamBudget)} weighted)` : ''}, ${formatShare(r.week.share)} this week${flag}`,
    ];
    if (x.nudges && x.nudges.count > 0) parts.push(`  nudged to delegate ${x.nudges.count}×, delegated after ${x.nudges.followed}`);
    if (kept.length > 0) {
      const max = 3;
      const shown = kept.slice(0, max).map((k) => `"${k}"`).join('; ');
      parts.push(`  kept work, no member fits: ${shown}${kept.length > max ? `; +${kept.length - max} more` : ''}`);
    }
    lines.push(parts.join('\n'));
  }
  if (lines.length === 0) return null;
  return ['*Team leads* (lead share of team tokens)', ...lines].join('\n');
}
