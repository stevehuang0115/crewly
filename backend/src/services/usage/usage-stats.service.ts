/**
 * Usage stats — tokens grouped by agent, team, project, work item, runtime
 * or day, over the last N local days (`GET /api/system/usage`).
 *
 * The unit is the token unit ({@link eventTokens}: input incl. cached +
 * output); cached input is reported beside it. Every event lands in exactly
 * one row of a grouping (unattributable usage gets its own row), so each
 * grouping sums to the same total — except `workItem`, which lists the top
 * work items only.
 *
 * Attribution:
 * - team: the session's team membership (the orc and unknown sessions are
 *   "(unattributed)");
 * - work item: {@link computeWorkItemUsage} — the agent's usage between the
 *   item's start and completion (clipped to the window);
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
import { eventTokens, type TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { localDateKey } from '../project-tickets/ticket-autopilot-decision.js';
import { runtimeOfEvent, windowDays } from '../spend/spend-ledger.service.js';
import { computeWorkItemUsage, type SessionUsageWindowSource } from '../task-pool/work-item-usage.js';

/** A grouping. */
export type UsageGroupBy = 'agent' | 'team' | 'project' | 'workItem' | 'runtime' | 'day';

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
  /** Extra facts: `team` / `agent` / `status` / `runtimes` */
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
  return { input: 0, cachedInput: 0, output: 0, total: 0, events: 0 };
}

/** Add one event's tokens. */
function add(into: UsageTokens, e: TokenUsageEvent): void {
  const t = eventTokens(e);
  into.input += t.input;
  into.cachedInput += t.cachedInput;
  into.output += t.output;
  into.total += t.total;
  into.events += 1;
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
    const eventGroupings = groupBy.filter((g) => g !== 'workItem');
    const runtimesOf = new Map<string, Set<string>>();

    this.deps.ledger.forEachEvent((session, e) => {
      const ms = new Date(e.timestamp).getTime();
      if (!Number.isFinite(ms) || ms > now.getTime()) return;
      add(totals, e);
      const day = localDateKey(new Date(ms));
      if (day === today) add(todayTotals, e);
      const runtime = runtimeOfEvent(e);
      runtimesOf.set(session, (runtimesOf.get(session) ?? new Set()).add(runtime));
      for (const g of eventGroupings) {
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
        } else {
          const pid = projectOfEvent(session, ms);
          row = pid ? bucketOf(g, pid, projectName.get(pid) ?? pid) : bucketOf(g, U.UNATTRIBUTED, U.UNATTRIBUTED);
        }
        add(row, e);
      }
    }, since);

    const groups: Partial<Record<UsageGroupBy, UsageRow[]>> = {};
    for (const g of groupBy) {
      let rows: UsageRow[];
      if (g === 'workItem') {
        rows = this.workItemRows(items, since, now, teamOf, nameOf);
      } else {
        rows = [...(buckets.get(g)?.values() ?? [])];
        if (g === 'agent') for (const r of rows) r.meta = { ...(r.meta ?? {}), runtimes: [...(runtimesOf.get(r.key) ?? [])].sort() };
        if (g === 'day') rows.sort((a, b) => a.key.localeCompare(b.key));
        else rows.sort((a, b) => b.total - a.total);
      }
      for (const r of rows) r.share = totals.total > 0 ? r.total / totals.total : 0;
      groups[g] = rows;
    }
    return { days: n, since: since.toISOString(), today, totals, todayTotals, groupBy, rows: groups[groupBy[0]] ?? [], groups };
  }

  /**
   * Top work items in the window by tokens.
   */
  private workItemRows(items: UsageWorkItem[], since: Date, now: Date, teamOf: Map<string, UsageTeam>, nameOf: Map<string, string>): UsageRow[] {
    const rows: UsageRow[] = [];
    for (const wi of items) {
      if (!wi.target) continue;
      const startMs = new Date(wi.startedAt ?? wi.createdAt).getTime();
      const endMs = wi.completedAt ? new Date(wi.completedAt).getTime() : now.getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < since.getTime() || startMs > now.getTime()) continue;
      const clipped = { createdAt: wi.createdAt, startedAt: new Date(Math.max(startMs, since.getTime())).toISOString(), completedAt: wi.completedAt };
      const usage = computeWorkItemUsage(clipped, wi.target, this.deps.ledger, now);
      if (!usage || usage.totalTokens <= 0) continue;
      const team = teamOf.get(wi.target);
      rows.push({
        key: wi.id,
        label: wi.title || wi.id,
        share: 0,
        input: usage.totalTokens - usage.outputTokens,
        cachedInput: usage.cachedInputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
        events: 0,
        link: `/workitems/${wi.id}`,
        meta: { agent: nameOf.get(wi.target) ?? wi.target, status: wi.status, ...(team ? { team: team.name } : {}) },
      });
    }
    rows.sort((a, b) => b.total - a.total);
    return rows.slice(0, U.MAX_WORK_ITEM_ROWS);
  }
}
