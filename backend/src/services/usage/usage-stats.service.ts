/**
 * Usage stats — tokens grouped by agent, team, project, work item, runtime,
 * model or day, over the last N local days (`GET /api/system/usage`).
 *
 * Every row and both totals also carry `costUsd`: the estimated
 * API-equivalent cost of the same events, priced by {@link eventCostUsd}
 * (the one cache-aware cost formula the ledger already uses). It is an
 * estimate at API list prices; caps and boosts stay in tokens.
 *
 * The unit is the token unit ({@link eventTokens}: input incl. cached +
 * output); cached input is reported beside it. Every event lands in exactly
 * one row of a grouping (unattributable usage gets its own row), so each
 * grouping sums to the same total — `workItem` too, unless more than
 * `MAX_WORK_ITEM_ROWS` items used tokens (only the top ones are listed).
 *
 * Attribution:
 * - team: the session's team membership (the orc and unknown sessions are
 *   "(unattributed)");
 * - work item: each event goes to the work item that was active for its
 *   session at the event's time ({@link activeWorkItemOf}: same bounds as
 *   `computeWorkItemUsage`, the most recently started item wins an overlap),
 *   or to the "(no work item)" row (#953);
 * - project: the work item running when the event happened, if it names a
 *   project (`metadata.projectId`) or its agent's team works on exactly one
 *   project; otherwise the session's team when it works on exactly one
 *   project; otherwise "(unattributed)".
 *
 * specs/2026-10-02-spend-cap.md §Stats
 *
 * @module services/usage/usage-stats.service
 */

import { ORCHESTRATOR_SESSION_NAME, SPEND_CAP_CONSTANTS, USAGE_CONSTANTS as U } from '../../constants.js';
import { eventCostRateSource, eventCostUsd, eventTokens, type TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { localDateKey } from '../project-tickets/ticket-autopilot-decision.js';
import { runtimeOfEvent, windowDays } from '../spend/spend-ledger.service.js';
import type { SessionUsageWindowSource } from '../task-pool/work-item-usage.js';

/** A grouping. */
export type UsageGroupBy = 'agent' | 'team' | 'project' | 'workItem' | 'runtime' | 'day' | 'model';

/** Token figures. */
export interface UsageTokens {
  /** Input tokens, cached included */
  input: number;
  /** Of `input`, the cached part */
  cachedInput: number;
  output: number;
  /** input + output — the unit caps count */
  total: number;
  /** Usage events (model calls / turns) */
  events: number;
  /** Estimated API-equivalent cost in USD (cache-aware list prices) */
  costUsd: number;
}

/** One row of a grouping. */
export interface UsageRow extends UsageTokens {
  /** Session / team id / project id / work item id / runtime / `YYYY-MM-DD` */
  key: string;
  label: string;
  /** Share of the window total (0–1) */
  share: number;
  /** Dashboard link (work items) */
  link?: string;
  /** Extra facts: `team` / `agent` / `status` / `runtimes`; model rows: `family` / `runtime` / `rate` (exact|family|default) */
  meta?: Record<string, string | string[]>;
}

/** What `GET /api/system/usage` returns. */
export interface UsageStats {
  days: number;
  /** Window start (local midnight), ISO */
  since: string;
  /** Local day of now */
  today: string;
  totals: UsageTokens;
  todayTotals: UsageTokens;
  groupBy: UsageGroupBy[];
  /** Rows of the first grouping */
  rows: UsageRow[];
  /** Rows of every requested grouping */
  groups: Partial<Record<UsageGroupBy, UsageRow[]>>;
}

/** A team as stats need it. */
export interface UsageTeam {
  id: string;
  name: string;
  members: Array<{ session: string; name: string }>;
  projectIds: string[];
}

/** A work item as stats need it. */
export interface UsageWorkItem {
  id: string;
  title: string;
  status: string;
  /** Agent session that ran it */
  target?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

/** Collaborators. */
export interface UsageStatsDeps {
  /** The token ledger (TokenUsageService) */
  ledger: SessionUsageWindowSource & {
    forEachEvent(visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date): void;
  };
  teams: () => Promise<UsageTeam[]>;
  projects: () => Promise<Array<{ id: string; name: string }>>;
  workItems: () => Promise<UsageWorkItem[]>;
  now?: () => Date;
}

/** Zero figures. */
function zero(): UsageTokens {
  return { input: 0, cachedInput: 0, output: 0, total: 0, events: 0, costUsd: 0 };
}

/** Add one event's tokens. */
function add(into: UsageTokens, e: TokenUsageEvent): void {
  const t = eventTokens(e);
  into.input += t.input;
  into.cachedInput += t.cachedInput;
  into.output += t.output;
  into.total += t.total;
  into.events += 1;
  into.costUsd += eventCostUsd(e);
}

/**
 * The model a usage event is grouped under: its recorded id, or the
 * "Unknown model" row when the source recorded none or only a
 * `<runtime>-default` placeholder.
 *
 * @param model - Recorded model id
 * @returns Row key (the model id, or {@link U.UNKNOWN_MODEL_KEY})
 */
export function modelKeyOf(model: string | undefined): string {
  const m = (model || '').trim();
  if (!m || /-default$/i.test(m) || /^unknown$/i.test(m)) return U.UNKNOWN_MODEL_KEY;
  return m;
}

/**
 * The family a model belongs to, for the "By model" breakdown.
 *
 * @param model - Model id
 * @returns e.g. `Claude Opus`, `DeepSeek`, `GPT`, `Gemini`, `Other`
 */
export function modelFamily(model: string): string {
  const m = model.toLowerCase();
  if (m === U.UNKNOWN_MODEL_KEY) return 'Unknown';
  if (/opus|fable/.test(m)) return 'Claude Opus';
  if (/sonnet/.test(m)) return 'Claude Sonnet';
  if (/haiku/.test(m)) return 'Claude Haiku';
  if (/claude/.test(m)) return 'Claude';
  if (/deepseek/.test(m)) return 'DeepSeek';
  if (/gpt|codex|^o\d/.test(m)) return 'GPT';
  if (/gemini/.test(m)) return 'Gemini';
  return 'Other';
}

/** A work item's running span, as the workItem grouping attributes it. */
export interface WorkItemSpan {
  item: UsageWorkItem;
  /** Start (ms): `startedAt`, else `createdAt` */
  start: number;
  /** End (ms): `completedAt`, else now */
  end: number;
}

/**
 * Running spans of the work items, per agent session, for the workItem
 * grouping.
 *
 * Bounds match `computeWorkItemUsage`: from `startedAt` (falling back to
 * `createdAt` for an item completed without a claim) to `completedAt`
 * (falling back to `now`). An item that has neither `startedAt` nor
 * `completedAt` never ran, so it gets no span (otherwise a long-queued item
 * would claim every later event of its agent). Items without a target or
 * with unusable timestamps are skipped; an id listed twice counts once (the
 * last copy wins). Each session's spans are sorted most recently started
 * first, ties by id, so {@link activeWorkItemOf} is deterministic.
 *
 * @param items - Work items
 * @param now - Now (end of still-open spans)
 * @returns Spans per session
 */
export function workItemSpans(items: UsageWorkItem[], now: Date): Map<string, WorkItemSpan[]> {
  const byId = new Map<string, UsageWorkItem>();
  for (const wi of items) byId.set(wi.id, wi);
  const spans = new Map<string, WorkItemSpan[]>();
  for (const item of byId.values()) {
    if (!item.target || (!item.startedAt && !item.completedAt)) continue;
    const start = new Date(item.startedAt ?? item.createdAt).getTime();
    const end = item.completedAt ? new Date(item.completedAt).getTime() : now.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const list = spans.get(item.target) ?? [];
    list.push({ item, start, end });
    spans.set(item.target, list);
  }
  for (const list of spans.values()) list.sort((a, b) => b.start - a.start || a.item.id.localeCompare(b.item.id));
  return spans;
}

/**
 * The work item active for a session at a moment.
 *
 * When several of the session's items span the moment (bounds inclusive),
 * the most recently started one wins (ties: lowest id) — the item the agent
 * most plausibly moved on to.
 *
 * @param spans - Output of {@link workItemSpans}
 * @param session - Agent session of the event
 * @param ms - Event time (ms)
 * @returns The item, or null when none was running
 */
export function activeWorkItemOf(spans: Map<string, WorkItemSpan[]>, session: string, ms: number): UsageWorkItem | null {
  return spans.get(session)?.find((s) => s.start <= ms && ms <= s.end)?.item ?? null;
}

/**
 * Parse `groupBy` (one value or a comma list).
 *
 * @param raw - Query value
 * @returns Valid groupings (default `agent`)
 */
export function parseGroupBy(raw: unknown): UsageGroupBy[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is UsageGroupBy => U.GROUP_BY.includes(s));
  return parts.length > 0 ? [...new Set(parts)] : ['agent'];
}

/**
 * Token usage stats.
 */
export class UsageStatsService {
  private readonly now: () => Date;

  /** @param deps - Collaborators */
  constructor(private readonly deps: UsageStatsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Aggregate the window.
   *
   * @param days - Local days, today included (clamped to 1…MAX_DAYS)
   * @param groupBy - Groupings
   * @returns Stats
   */
  async query(days: number, groupBy: UsageGroupBy[]): Promise<UsageStats> {
    const now = this.now();
    const n = Math.min(SPEND_CAP_CONSTANTS.MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : SPEND_CAP_CONSTANTS.DEFAULT_DAYS)));
    const { since } = windowDays(now, n);
    const today = localDateKey(now);
    const [teams, projects, items] = await Promise.all([
      this.deps.teams().catch(() => [] as UsageTeam[]),
      this.deps.projects().catch(() => [] as Array<{ id: string; name: string }>),
      groupBy.includes('workItem') || groupBy.includes('project') ? this.deps.workItems().catch(() => [] as UsageWorkItem[]) : Promise.resolve([] as UsageWorkItem[]),
    ]);

    const teamOf = new Map<string, UsageTeam>();
    const nameOf = new Map<string, string>([[ORCHESTRATOR_SESSION_NAME, 'Orc']]);
    for (const t of teams) {
      for (const m of t.members) {
        if (!m.session) continue;
        if (!teamOf.has(m.session)) teamOf.set(m.session, t);
        nameOf.set(m.session, m.name || m.session);
      }
    }
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const teamProject = (t: UsageTeam | undefined): string | null => (t && t.projectIds.length === 1 ? t.projectIds[0] : null);

    // Work item windows per session, for project attribution.
    const windows = new Map<string, Array<{ start: number; end: number; projectId: string }>>();
    for (const wi of items) {
      if (!wi.target) continue;
      const pid = typeof wi.metadata?.projectId === 'string' ? (wi.metadata.projectId as string) : teamProject(teamOf.get(wi.target));
      if (!pid) continue;
      const start = new Date(wi.startedAt ?? wi.createdAt).getTime();
      const end = wi.completedAt ? new Date(wi.completedAt).getTime() : now.getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      const list = windows.get(wi.target) ?? [];
      list.push({ start, end, projectId: pid });
      windows.set(wi.target, list);
    }
    for (const list of windows.values()) list.sort((a, b) => b.start - a.start);
    const projectOfEvent = (session: string, ms: number): string | null => {
      const hit = windows.get(session)?.find((w) => w.start <= ms && ms <= w.end);
      return hit?.projectId ?? teamProject(teamOf.get(session));
    };

    const totals = zero();
    const todayTotals = zero();
    const buckets = new Map<UsageGroupBy, Map<string, UsageRow>>();
    const bucketOf = (g: UsageGroupBy, key: string, label: string, meta?: UsageRow['meta']): UsageRow => {
      let map = buckets.get(g);
      if (!map) {
        map = new Map();
        buckets.set(g, map);
      }
      let row = map.get(key);
      if (!row) {
        row = { key, label, share: 0, ...zero(), ...(meta ? { meta } : {}) };
        map.set(key, row);
      }
      return row;
    };
    const spans = groupBy.includes('workItem') ? workItemSpans(items, now) : new Map<string, WorkItemSpan[]>();
    const runtimesOf = new Map<string, Set<string>>();

    this.deps.ledger.forEachEvent((session, e) => {
      const ms = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ms) || ms > now.getTime()) return;
      add(totals, e);
      const day = localDateKey(new Date(ms));
      if (day === today) add(todayTotals, e);
      const runtime = runtimeOfEvent(e);
      runtimesOf.set(session, (runtimesOf.get(session) ?? new Set()).add(runtime));
      for (const g of groupBy) {
        let row: UsageRow;
        if (g === 'agent') {
          const team = teamOf.get(session);
          row = bucketOf(g, session, nameOf.get(session) ?? session, team ? { team: team.name } : undefined);
        } else if (g === 'team') {
          const team = teamOf.get(session);
          row = team ? bucketOf(g, team.id, team.name) : bucketOf(g, U.UNATTRIBUTED, session === ORCHESTRATOR_SESSION_NAME ? 'Orc (no team)' : U.UNATTRIBUTED);
        } else if (g === 'runtime') {
          row = bucketOf(g, runtime, runtime);
        } else if (g === 'day') {
          row = bucketOf(g, day, day);
        } else if (g === 'model') {
          const key = modelKeyOf(e.model);
          const label = key === U.UNKNOWN_MODEL_KEY ? U.UNKNOWN_MODEL_LABEL : key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
          row = bucketOf(g, key, label, { family: modelFamily(key), runtime, rate: key === U.UNKNOWN_MODEL_KEY ? 'default' : eventCostRateSource(key) });
        } else if (g === 'workItem') {
          const wi = activeWorkItemOf(spans, session, ms);
          if (wi?.target) {
            const team = teamOf.get(wi.target);
            row = bucketOf(g, wi.id, wi.title || wi.id, { agent: nameOf.get(wi.target) ?? wi.target, status: wi.status, ...(team ? { team: team.name } : {}) });
            row.link = `/workitems/${wi.id}`;
          } else {
            row = bucketOf(g, U.NO_WORK_ITEM_KEY, U.NO_WORK_ITEM_LABEL);
          }
        } else {
          const pid = projectOfEvent(session, ms);
          row = pid ? bucketOf(g, pid, projectName.get(pid) ?? pid) : bucketOf(g, U.UNATTRIBUTED, U.UNATTRIBUTED);
        }
        add(row, e);
      }
    }, since);

    const groups: Partial<Record<UsageGroupBy, UsageRow[]>> = {};
    for (const g of groupBy) {
      let rows = [...(buckets.get(g)?.values() ?? [])];
      if (g === 'agent') for (const r of rows) r.meta = { ...(r.meta ?? {}), runtimes: [...(runtimesOf.get(r.key) ?? [])].sort() };
      if (g === 'day') rows.sort((a, b) => a.key.localeCompare(b.key));
      else rows.sort((a, b) => b.total - a.total);
      if (g === 'workItem') {
        // Top work items only; the "(no work item)" row is always kept.
        let kept = 0;
        rows = rows.filter((r) => r.key === U.NO_WORK_ITEM_KEY || kept++ < U.MAX_WORK_ITEM_ROWS);
      }
      for (const r of rows) r.share = totals.total > 0 ? r.total / totals.total : 0;
      groups[g] = rows;
    }
    return { days: n, since: since.toISOString(), today, totals, todayTotals, groupBy, rows: groups[groupBy[0]] ?? [], groups };
  }
}
