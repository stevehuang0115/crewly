/**
 * Usage ledger — how many tokens each agent used, per local day.
 *
 * Reads the shared token ledger (`~/.crewly/token-usage.json`, held in
 * memory by {@link TokenUsageService}). Every source of agent usage lands
 * there: the in-process Crewly Agent runtime (DeepSeek etc.), the Claude
 * transcript sync, the Codex rollout sync and the Antigravity sync.
 *
 * The unit is TOKENS (owner, 2026-10-02): {@link eventTokens} is the one
 * formula — input (fresh + cached) + output. Subscription and API billing
 * are not told apart. The USD figure ({@link eventCostUsd}) stays available
 * to code that needs it but nothing owner-facing shows it.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-ledger.service
 */

import { SPEND_CAP_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { eventTokens, type TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { localDateKey, localMidnight } from '../project-tickets/ticket-autopilot-decision.js';

/** The part of {@link TokenUsageService} the ledger reads. */
export interface SpendEventSource {
  forEachEvent(visit: (sessionName: string, event: TokenUsageEvent) => void, since?: Date): void;
  getSessionUsageSince(sessionName: string, since: Date, until?: Date): { totalTokens: number };
}

/** One local day of usage. */
export interface SpendDay {
  /** `YYYY-MM-DD`, local */
  date: string;
  totalTokens: number;
  /** Session → tokens */
  byAgent: Record<string, number>;
  /** Runtime → tokens */
  byRuntime: Record<string, number>;
}

/** One agent across the window. */
export interface SpendAgentRow {
  session: string;
  /** Runtimes its usage came from */
  runtimes: string[];
  todayTokens: number;
  windowTokens: number;
  /** Of {@link windowTokens}, the cached input */
  windowCachedTokens: number;
  /** Tokens per day, oldest first, aligned with {@link SpendSummary.days} */
  daily: number[];
}

/** What the ledger summarises (before cap info is added). */
export interface SpendSummary {
  /** Local day of `now` */
  today: string;
  /** Oldest first; the last one is today */
  days: SpendDay[];
  /** Most tokens first */
  agents: SpendAgentRow[];
  /** Runtime → tokens over the window */
  byRuntime: Record<string, number>;
  totalTokens: number;
  /** Of {@link totalTokens}, the cached input */
  cachedTokens: number;
  todayTokens: number;
  /** 90th percentile of per-agent daily tokens (agent-days with any usage) */
  p90AgentDayTokens: number;
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
 * The runtime of an event: the one its source recorded, else inferred.
 *
 * @param event - Usage event
 * @returns Runtime id
 */
export function runtimeOfEvent(event: Pick<TokenUsageEvent, 'model' | 'runtime'>): string {
  return event.runtime || runtimeOfModel(event.model);
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
 * Local day keys of the last `days` days (today last), and the start of the first.
 *
 * @param now - Clock reading
 * @param days - Window length (clamped to 1…MAX_DAYS)
 * @returns Keys and the window start
 */
export function windowDays(now: Date, days: number): { keys: string[]; since: Date } {
  const n = Math.min(SPEND_CAP_CONSTANTS.MAX_DAYS, Math.max(1, Math.floor(Number.isFinite(days) ? days : SPEND_CAP_CONSTANTS.DEFAULT_DAYS)));
  const keys: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    keys.push(localDateKey(d));
  }
  const first = new Date(now.getTime());
  first.setDate(first.getDate() - (n - 1));
  return { keys, since: localMidnight(first) };
}

/**
 * Per-agent / per-runtime / per-day token usage.
 */
export class SpendLedger {
  private totalCache: { at: number; dayStart: number; tokens: number } | null = null;

  /**
   * @param source - Token ledger
   * @param now - Clock
   */
  constructor(
    private readonly source: SpendEventSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Tokens a session used since local midnight.
   *
   * @param session - Agent session
   * @returns Tokens
   */
  usedToday(session: string): number {
    try {
      return this.source.getSessionUsageSince(session, localMidnight(this.now())).totalTokens;
    } catch {
      return 0;
    }
  }

  /**
   * Tokens a group of sessions (a team) used since local midnight.
   *
   * @param sessions - Agent sessions
   * @returns Tokens
   */
  groupToday(sessions: readonly string[]): number {
    let n = 0;
    for (const s of new Set(sessions)) n += this.usedToday(s);
    return n;
  }

  /**
   * Tokens every agent together used since local midnight. Cached briefly:
   * the delivery gate asks on every message.
   *
   * @returns Tokens
   */
  totalToday(): number {
    const now = this.now();
    const dayStart = localMidnight(now).getTime();
    const c = this.totalCache;
    if (c && c.dayStart === dayStart && now.getTime() - c.at < SPEND_CAP_CONSTANTS.TOTAL_CACHE_MS) return c.tokens;
    let tokens = 0;
    try {
      this.source.forEachEvent((_s, e) => {
        tokens += eventTokens(e).total;
      }, new Date(dayStart));
    } catch {
      tokens = 0;
    }
    this.totalCache = { at: now.getTime(), dayStart, tokens };
    return tokens;
  }

  /** Forget the cached total (after new usage is known). */
  invalidate(): void {
    this.totalCache = null;
  }

  /**
   * Usage over the last `days` local days, today included.
   *
   * @param days - Window length (clamped to 1…MAX_DAYS)
   * @returns Summary
   */
  summarize(days: number = SPEND_CAP_CONSTANTS.DEFAULT_DAYS): SpendSummary {
    const { keys, since } = windowDays(this.now(), days);
    const index = new Map(keys.map((k, i) => [k, i]));
    const dayRows: SpendDay[] = keys.map((date) => ({ date, totalTokens: 0, byAgent: {}, byRuntime: {} }));
    const agents = new Map<string, { runtimes: Set<string>; daily: number[]; cached: number }>();
    const byRuntime: Record<string, number> = {};
    let cachedTokens = 0;

    this.source.forEachEvent((session, e) => {
      const i = index.get(localDateKey(new Date(e.timestamp)));
      if (i === undefined) return;
      const t = eventTokens(e);
      const runtime = runtimeOfEvent(e);
      const day = dayRows[i];
      day.totalTokens += t.total;
      day.byAgent[session] = (day.byAgent[session] ?? 0) + t.total;
      day.byRuntime[runtime] = (day.byRuntime[runtime] ?? 0) + t.total;
      byRuntime[runtime] = (byRuntime[runtime] ?? 0) + t.total;
      cachedTokens += t.cachedInput;
      let a = agents.get(session);
      if (!a) {
        a = { runtimes: new Set(), daily: keys.map(() => 0), cached: 0 };
        agents.set(session, a);
      }
      a.runtimes.add(runtime);
      a.daily[i] += t.total;
      a.cached += t.cachedInput;
    }, since);

    const rows: SpendAgentRow[] = [...agents].map(([session, a]) => ({
      session,
      runtimes: [...a.runtimes].sort(),
      todayTokens: a.daily[a.daily.length - 1],
      windowTokens: a.daily.reduce((s, v) => s + v, 0),
      windowCachedTokens: a.cached,
      daily: a.daily,
    }));
    rows.sort((x, y) => y.windowTokens - x.windowTokens);
    const agentDays = rows.flatMap((r) => r.daily.filter((v) => v > 0));
    return {
      today: keys[keys.length - 1],
      days: dayRows,
      agents: rows,
      byRuntime,
      totalTokens: dayRows.reduce((s, d) => s + d.totalTokens, 0),
      cachedTokens,
      todayTokens: dayRows[dayRows.length - 1].totalTokens,
      p90AgentDayTokens: percentile(agentDays, 90),
    };
  }
}
