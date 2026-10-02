/**
 * Spend ledger — what each agent actually spent, in USD, per local day.
 *
 * Reads the shared token ledger (`~/.crewly/token-usage.json`, held in
 * memory by {@link TokenUsageService}). Both sources of agent usage land
 * there: the in-process Crewly Agent runtime records every run (DeepSeek,
 * cache-aware), and the Claude transcript sync records every Claude Code
 * turn with its cache split. Each event is priced with {@link eventCostUsd},
 * the same computation the ticket autopilot budget and the team budget gate
 * use through `getSessionUsageSince` — there is no second cost formula here.
 *
 * Claude Code under a subscription does not produce a bill at these rates;
 * its figure is the API-equivalent cost (see model-pricing).
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-ledger.service
 */

import { SPEND_CAP_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { eventCostUsd, type TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { localDateKey, localMidnight } from '../project-tickets/ticket-autopilot-decision.js';

/** The part of {@link TokenUsageService} the ledger reads. */
export interface SpendEventSource {
  forEachEvent(visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date): void;
  getSessionUsageSince(sessionName: string, since: Date, until?: Date): { cost: number };
}

/** One local day of spend. */
export interface SpendDay {
  /** `YYYY-MM-DD`, local */
  date: string;
  totalUsd: number;
  /** Session → USD */
  byAgent: Record<string, number>;
  /** Runtime → USD */
  byRuntime: Record<string, number>;
}

/** One agent across the window. */
export interface SpendAgentRow {
  session: string;
  /** Runtimes its usage came from (inferred from the model id) */
  runtimes: string[];
  todayUsd: number;
  windowUsd: number;
  /** USD per day, oldest first, aligned with {@link SpendSummary.days} */
  daily: number[];
}

/** What `GET /api/system/spend` returns (before cap info is added). */
export interface SpendSummary {
  /** Local day of `now` */
  today: string;
  /** Oldest first; the last one is today */
  days: SpendDay[];
  /** Highest window spend first */
  agents: SpendAgentRow[];
  /** Runtime → USD over the window */
  byRuntime: Record<string, number>;
  totalUsd: number;
  todayUsd: number;
  /** 90th percentile of per-agent daily spend (agent-days with any spend), USD */
  p90AgentDayUsd: number;
}

/**
 * The runtime a usage event came from, inferred from its model id.
 *
 * @param model - Model id as recorded (`deepseek/deepseek-chat`, `claude-opus-5-5`, `codex-cli-default`)
 * @returns Runtime id, or `other`
 *
 * @example
 * runtimeOfModel('deepseek/deepseek-chat') // 'crewly-agent'
 * runtimeOfModel('claude-sonnet-5') // 'claude-code'
 */
export function runtimeOfModel(model: string): string {
  const m = (model || '').toLowerCase();
  for (const rt of Object.values(RUNTIME_TYPES)) {
    if (m.startsWith(`${rt}-`)) return rt;
  }
  if (m.includes('/')) return RUNTIME_TYPES.CREWLY_AGENT;
  if (/claude|opus|sonnet|haiku|fable|synthetic/.test(m)) return RUNTIME_TYPES.CLAUDE_CODE;
  if (/gpt|codex|^o\d/.test(m)) return RUNTIME_TYPES.CODEX_CLI;
  if (/gemini/.test(m)) return RUNTIME_TYPES.GEMINI_CLI;
  return 'other';
}

/**
 * Nearest-rank percentile.
 *
 * @param values - Samples
 * @param p - Percentile (0–100)
 * @returns The value, or 0 for no samples
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * Round to whole cents.
 *
 * @param usd - Amount
 * @returns Rounded amount
 */
export function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/**
 * Per-agent / per-runtime / per-day spend.
 */
export class SpendLedger {
  private totalCache: { at: number; dayStart: number; usd: number } | null = null;

  /**
   * @param source - Token ledger
   * @param now - Clock
   */
  constructor(
    private readonly source: SpendEventSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * USD a session spent since local midnight (the autopilot's computation).
   *
   * @param session - Agent session
   * @returns USD
   */
  spentToday(session: string): number {
    try {
      return this.source.getSessionUsageSince(session, localMidnight(this.now())).cost;
    } catch {
      return 0;
    }
  }

  /**
   * USD every agent together spent since local midnight. Cached briefly:
   * the delivery gate asks on every message.
   *
   * @returns USD
   */
  totalToday(): number {
    const now = this.now();
    const dayStart = localMidnight(now).getTime();
    const c = this.totalCache;
    if (c && c.dayStart === dayStart && now.getTime() - c.at < SPEND_CAP_CONSTANTS.TOTAL_CACHE_MS) return c.usd;
    let usd = 0;
    try {
      this.source.forEachEvent((_s, e) => {
        usd += eventCostUsd(e);
      }, new Date(dayStart));
    } catch {
      usd = 0;
    }
    this.totalCache = { at: now.getTime(), dayStart, usd };
    return usd;
  }

  /** Forget the cached total (after new usage is known). */
  invalidate(): void {
    this.totalCache = null;
  }

  /**
   * Spend over the last `days` local days, today included.
   *
   * @param days - Window length (clamped to 1…MAX_DAYS)
   * @returns Summary
   */
  summarize(days: number = SPEND_CAP_CONSTANTS.DEFAULT_DAYS): SpendSummary {
    const n = Math.min(SPEND_CAP_CONSTANTS.MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : SPEND_CAP_CONSTANTS.DEFAULT_DAYS)));
    const now = this.now();
    const keys: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() - i);
      keys.push(localDateKey(d));
    }
    const first = new Date(now.getTime());
    first.setDate(first.getDate() - (n - 1));
    const since = localMidnight(first);
    const index = new Map(keys.map((k, i) => [k, i]));
    const dayRows: SpendDay[] = keys.map((date) => ({ date, totalUsd: 0, byAgent: {}, byRuntime: {} }));
    const agents = new Map<string, { runtimes: Set<string>; daily: number[] }>();
    const byRuntime: Record<string, number> = {};

    this.source.forEachEvent((session, e) => {
      const i = index.get(localDateKey(new Date(e.timestamp)));
      if (i === undefined) return;
      const usd = eventCostUsd(e);
      const runtime = runtimeOfModel(e.model);
      const day = dayRows[i];
      day.totalUsd += usd;
      day.byAgent[session] = (day.byAgent[session] ?? 0) + usd;
      day.byRuntime[runtime] = (day.byRuntime[runtime] ?? 0) + usd;
      byRuntime[runtime] = (byRuntime[runtime] ?? 0) + usd;
      let a = agents.get(session);
      if (!a) {
        a = { runtimes: new Set(), daily: keys.map(() => 0) };
        agents.set(session, a);
      }
      a.runtimes.add(runtime);
      a.daily[i] += usd;
    }, since);

    const rows: SpendAgentRow[] = [...agents].map(([session, a]) => ({
      session,
      runtimes: [...a.runtimes].sort(),
      todayUsd: a.daily[a.daily.length - 1],
      windowUsd: a.daily.reduce((s, v) => s + v, 0),
      daily: a.daily,
    }));
    rows.sort((x, y) => y.windowUsd - x.windowUsd);
    const agentDays = rows.flatMap((r) => r.daily.filter((v) => v > 0));
    return {
      today: keys[keys.length - 1],
      days: dayRows,
      agents: rows,
      byRuntime,
      totalUsd: dayRows.reduce((s, d) => s + d.totalUsd, 0),
      todayUsd: dayRows[dayRows.length - 1].totalUsd,
      p90AgentDayUsd: percentile(agentDays, 90),
    };
  }
}
