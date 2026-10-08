/**
 * The usage report a team lead reads in a model-tier review (crewly#1173).
 *
 * Per member, over the report window: model turns, average context per turn,
 * output tokens, estimated cost by model (API list price — an
 * API-equivalent, not a bill), the work it handled (titles + kinds), and its
 * send-back rate. Pure: the service passes ledger events and work items in.
 *
 * @module services/model-tiers/tier-usage-report
 */

import { MODEL_TIER_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { ModelTier, Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { effectiveMemberModelId } from '../../utils/member-default-model.utils.js';
import { tierMapFor } from '../../utils/model-tier.utils.js';
import { isTeamLead } from '../../utils/team.utils.js';
import { eventCostUsd, eventTokens, type TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { memberLedgerKeys } from '../tl-delegation/lead-share.js';
import { settledItemsOf, statsOf, type QualityStats } from './tier-quality.js';

/** One member's row. */
export interface MemberUsageRow {
  memberId: string;
  name: string;
  session: string;
  role: string;
  isLead: boolean;
  runtime: string;
  tier: ModelTier | null;
  /** Model it launches with now (`runtime default` when none is passed) */
  model: string;
  /** Model round-trips in the window */
  turns: number;
  /** Mean input context per turn (fresh + cached tokens) */
  avgContext: number;
  outputTokens: number;
  /** Estimated USD at list price */
  costUsd: number;
  /** Estimated USD per model id the ledger recorded */
  costByModel: Record<string, number>;
  /** Work items it was the target of in the window */
  work: { count: number; titles: string[]; kinds: Record<string, number> };
  /** Send-back rate over the work items that settled in the window */
  quality: QualityStats;
}

/** The whole report. */
export interface TeamTierReport {
  teamId: string;
  teamName: string;
  windowDays: number;
  from: string;
  to: string;
  rows: MemberUsageRow[];
  totalCostUsd: number;
  /** Tier → model per runtime used by this team's members */
  tierMaps: Record<string, Partial<Record<ModelTier, string>>>;
}

/** Inputs of {@link buildTierReport}. */
export interface TierReportInput {
  team: Team;
  /** Ledger visitor (TokenUsageService.forEachEvent) */
  forEachEvent: (visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date) => void;
  workItems: readonly WorkItem[];
  now: Date;
  windowDays?: number;
}

/**
 * Build the report for a team.
 *
 * @param input - Team, ledger, work items, clock
 * @returns The report (members in team order, the orchestrator excluded)
 */
export function buildTierReport(input: TierReportInput): TeamTierReport {
  const windowDays = input.windowDays ?? MODEL_TIER_CONSTANTS.REPORT_WINDOW_DAYS;
  const since = new Date(input.now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const members = (input.team.members ?? []).filter((m) => m.role !== 'orchestrator');
  const keyToMember = new Map<string, TeamMember>();
  for (const m of members) for (const k of memberLedgerKeys(m)) keyToMember.set(k, m);

  type Acc = { turns: number; context: number; output: number; cost: number; byModel: Record<string, number> };
  const acc = new Map<string, Acc>();
  input.forEachEvent((session, event) => {
    const m = keyToMember.get(session);
    if (!m) return;
    const a = acc.get(m.id) ?? { turns: 0, context: 0, output: 0, cost: 0, byModel: {} };
    const t = eventTokens(event);
    const cost = eventCostUsd(event);
    a.turns += 1;
    a.context += t.input;
    a.output += t.output;
    a.cost += cost;
    const model = event.model || 'unknown';
    a.byModel[model] = (a.byModel[model] ?? 0) + cost;
    acc.set(m.id, a);
  }, since);

  const sinceMs = since.getTime();
  const tierMaps: Record<string, Partial<Record<ModelTier, string>>> = {};
  const rows: MemberUsageRow[] = members.map((m) => {
    const runtime = m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE;
    if (!tierMaps[runtime]) tierMaps[runtime] = tierMapFor(runtime, input.team.tierModels);
    const a = acc.get(m.id) ?? { turns: 0, context: 0, output: 0, cost: 0, byModel: {} };
    const keys = memberLedgerKeys(m);
    const keySet = new Set(keys);
    const recent = input.workItems
      .filter((wi) => !!wi.target && keySet.has(wi.target) && Date.parse(wi.statusChangedAt ?? wi.createdAt) >= sinceMs)
      .sort((x, y) => Date.parse(y.statusChangedAt ?? y.createdAt) - Date.parse(x.statusChangedAt ?? x.createdAt));
    const kinds: Record<string, number> = {};
    for (const wi of recent) kinds[wi.type] = (kinds[wi.type] ?? 0) + 1;
    const settled = settledItemsOf(input.workItems, keys).filter((wi) => Date.parse(wi.completedAt ?? wi.statusChangedAt ?? wi.createdAt) >= sinceMs);
    return {
      memberId: m.id,
      name: m.name,
      session: m.sessionName || m.agentId || '',
      role: String(m.role),
      isLead: isTeamLead(input.team, m),
      runtime,
      tier: m.tier ?? null,
      model: effectiveMemberModelId(input.team, { ...m, runtimeType: runtime }) ?? 'runtime default',
      turns: a.turns,
      avgContext: a.turns ? Math.round(a.context / a.turns) : 0,
      outputTokens: a.output,
      costUsd: round2(a.cost),
      costByModel: Object.fromEntries(Object.entries(a.byModel).map(([k, v]) => [k, round2(v)])),
      work: { count: recent.length, titles: recent.slice(0, MODEL_TIER_CONSTANTS.REPORT_MAX_TITLES).map((wi) => oneLine(wi.title)), kinds },
      quality: statsOf(settled),
    };
  });

  return {
    teamId: input.team.id,
    teamName: input.team.name,
    windowDays,
    from: since.toISOString(),
    to: input.now.toISOString(),
    rows,
    totalCostUsd: round2(rows.reduce((s, r) => s + r.costUsd, 0)),
    tierMaps,
  };
}

/**
 * Short token count ("480k", "1.2M").
 *
 * @param n - Tokens
 * @returns Text
 */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/**
 * The report as compact Markdown for the lead.
 *
 * @param r - Report
 * @returns Markdown
 */
export function renderTierReport(r: TeamTierReport): string {
  const lines: string[] = [];
  lines.push(`Usage of team ${r.teamName}, last ${r.windowDays} days (estimated at API list price; not a bill). Total ≈ $${r.totalCostUsd.toFixed(2)}.`);
  const maps = Object.entries(r.tierMaps)
    .map(([runtime, m]) => `${runtime}: strong=${m.strong ?? '(runtime default)'}, mid=${m.mid ?? '(runtime default)'}, weak=${m.weak ?? m.mid ?? '(runtime default)'}`)
    .join('; ');
  if (maps) lines.push(`Tiers → models: ${maps}.`);
  lines.push('');
  lines.push('| Member | Tier → model | Turns | Avg context | Output | Est. cost | Sent back | Work handled |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of r.rows) {
    const who = `${row.name}${row.isLead ? ' (lead)' : ''}`;
    const tier = `${row.tier ?? '–'} → ${row.model}`;
    const byModel = Object.entries(row.costByModel)
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} $${c.toFixed(2)}`)
      .join(', ');
    const cost = `$${row.costUsd.toFixed(2)}${byModel ? ` (${byModel})` : ''}`;
    const kinds = Object.entries(row.work.kinds).map(([k, n]) => `${k}×${n}`).join(' ');
    const work = row.work.count ? `${row.work.count}: ${row.work.titles.map((t) => `"${t}"`).join('; ')}${kinds ? ` [${kinds}]` : ''}` : 'none';
    const sentBack = row.quality.settled ? `${row.quality.sentBack}/${row.quality.settled}` : '–';
    lines.push(`| ${who} | ${tier} | ${row.turns} | ${shortTokens(row.avgContext)} | ${shortTokens(row.outputTokens)} | ${cost} | ${sentBack} | ${escapePipes(work)} |`);
  }
  return lines.join('\n');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneLine(text: string): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '/');
}
