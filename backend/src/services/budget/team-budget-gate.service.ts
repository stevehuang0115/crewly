/**
 * Team Budget Gate
 *
 * Evaluates a team's `Team.budget` (`maxTokensPerDay`, `maxUsdPerMonth`,
 * `alertThreshold`) against the live token ledger in
 * {@link TokenUsageService}. The budget was stored and injected into agent
 * prompts but never evaluated anywhere — this service is the single
 * evaluator, consulted by:
 *
 *   - `WorkItemDispatchSubscriber.dispatchTo` — skip pushing a brief to an
 *     agent whose team is over budget.
 *   - `TaskPoolService.claimFromPool` — refuse the claim with
 *     `reason: 'team_budget_exceeded'`.
 *
 * and it is the single notifier: crossing `alertThreshold` (warn) or 100 %
 * (blocked) publishes one `team:budget_exceeded` event per team per UTC day
 * per level and enqueues an owner-facing `[BUDGET]` message to the
 * orchestrator queue (`source: 'system_event'`).
 *
 * Cost: one `getTeams()` + one ledger scan per member session, cached per
 * team for {@link TEAM_BUDGET_CACHE_TTL_MS} so the claim/dispatch hot paths
 * stay cheap.
 *
 * @module services/budget/team-budget-gate.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import type { Team, TeamBudget } from '../../types/index.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import { MESSAGE_SOURCES, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { formatError } from '../../utils/format-error.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long a team's computed usage is reused before re-scanning the ledger. */
export const TEAM_BUDGET_CACHE_TTL_MS = 60_000;

/** Refusal reason surfaced by the claim / dispatch gates. */
export const TEAM_BUDGET_EXCEEDED_REASON = 'team_budget_exceeded' as const;

/** Envelope prefix for the owner-facing queue message. */
export const BUDGET_ENVELOPE_PREFIX = '[BUDGET]';

/** Conversation id stamped on `[BUDGET]` queue messages. */
export const BUDGET_CONVERSATION_ID = 'system_budget';

/** Default alert threshold (percent) when `Team.budget.alertThreshold` is unset. */
export const DEFAULT_ALERT_THRESHOLD_PCT = 80;

/** Fully-consumed budget, in percent. */
const FULL_BUDGET_PCT = 100;

/** Bounded size of the per-day notification dedup list. */
const NOTIFY_DEDUP_CAPACITY = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Budget consumption level. */
export type TeamBudgetLevel = 'ok' | 'warn' | 'blocked';

/** Computed usage for a team over the budget windows. */
export interface TeamBudgetUsage {
  /** Input + output tokens consumed by the team's sessions since UTC midnight. */
  tokensToday: number;
  /** USD spent by the team's sessions since the first of the UTC month. */
  usdThisMonth: number;
  /** Configured daily token cap (undefined = none). */
  maxTokensPerDay?: number;
  /** Configured monthly USD cap (undefined = none). */
  maxUsdPerMonth?: number;
  /** Percent of the daily token cap used (undefined when no cap). */
  tokenPct?: number;
  /** Percent of the monthly USD cap used (undefined when no cap). */
  usdPct?: number;
  /** Member sessions the usage was aggregated over. */
  sessions: string[];
}

/** Result of {@link TeamBudgetGateService.check}. */
export interface TeamBudgetCheck {
  /** `false` when any configured cap is at/over 100 %. */
  allowed: boolean;
  /** Set when `allowed === false`. */
  reason?: typeof TEAM_BUDGET_EXCEEDED_REASON;
  /** Human-readable explanation of the level. */
  detail?: string;
  level: TeamBudgetLevel;
  usage: TeamBudgetUsage;
  teamId: string;
  teamName: string;
}

/** Ledger surface the gate needs (see {@link TokenUsageService.getSessionUsageSince}). */
export interface BudgetUsageLedger {
  getSessionUsageSince(
    sessionName: string,
    since: Date,
    until?: Date,
  ): { inputTokens: number; outputTokens: number; cost: number };
}

/** Minimal MessageQueueService surface for the `[BUDGET]` notification. */
export interface BudgetMessageQueueLike {
  enqueue(input: {
    content: string;
    conversationId: string;
    source: typeof MESSAGE_SOURCES.SYSTEM_EVENT;
    targetSession?: string;
    sourceMetadata?: Record<string, unknown>;
  }): unknown;
}

/** Injectable dependencies (production defaults resolve the singletons). */
export interface TeamBudgetGateDependencies {
  getTeams?: () => Promise<Team[]>;
  ledger?: BudgetUsageLedger;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** Thrown by `claimFromPool` when the claiming agent's team is over budget. */
export class TeamBudgetExceededError extends Error {
  readonly reason = TEAM_BUDGET_EXCEEDED_REASON;
  readonly check: TeamBudgetCheck;

  constructor(check: TeamBudgetCheck) {
    super(check.detail ?? `Team ${check.teamId} budget exceeded`);
    this.name = 'TeamBudgetExceededError';
    this.check = check;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC midnight of the given instant. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** First instant of the given instant's UTC month. */
function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** `YYYY-MM-DD` in UTC. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Percentage of `used` against `cap`, rounded to one decimal. */
function pct(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.round((used / cap) * 1000) / 10;
}

/** Whether a budget carries at least one enforceable cap. */
function hasCaps(budget: TeamBudget | undefined): budget is TeamBudget {
  if (!budget) return false;
  return (
    (typeof budget.maxTokensPerDay === 'number' && budget.maxTokensPerDay > 0) ||
    (typeof budget.maxUsdPerMonth === 'number' && budget.maxUsdPerMonth > 0)
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Evaluates and enforces per-team token / USD budgets. See module docs.
 */
export class TeamBudgetGateService {
  private static instance: TeamBudgetGateService | null = null;

  private readonly logger: ComponentLogger;
  private readonly getTeams: () => Promise<Team[]>;
  private readonly ledger: BudgetUsageLedger;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; check: TeamBudgetCheck }>();
  /** Teams snapshot shared by check()/checkForSession(), same TTL as the per-team cache. */
  private teamsSnapshot: { at: number; teams: Team[] } | null = null;
  /** `<teamId>:<level>:<YYYY-MM-DD>` notifications already sent (FIFO-bounded). */
  private readonly notified: string[] = [];
  private eventBus: EventBusService | null = null;
  private messageQueue: BudgetMessageQueueLike | null = null;

  constructor(deps: TeamBudgetGateDependencies = {}) {
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('TeamBudgetGate');
    this.getTeams = deps.getTeams ?? (() => StorageService.getInstance().getTeams());
    this.ledger = deps.ledger ?? TokenUsageService.getInstance();
    this.now = deps.now ?? (() => new Date());
  }

  /** Singleton accessor (production). Tests construct directly. */
  static getInstance(): TeamBudgetGateService {
    if (!TeamBudgetGateService.instance) {
      TeamBudgetGateService.instance = new TeamBudgetGateService();
    }
    return TeamBudgetGateService.instance;
  }

  /** Drop the singleton (tests). */
  static resetInstance(): void {
    TeamBudgetGateService.instance = null;
  }

  /**
   * Wire the notification legs. Either may be null; the gate still
   * enforces without them.
   *
   * @param deps - EventBus for `team:budget_exceeded`, queue for `[BUDGET]`
   */
  setNotifiers(deps: {
    eventBus?: EventBusService | null;
    messageQueue?: BudgetMessageQueueLike | null;
  }): void {
    if (deps.eventBus !== undefined) this.eventBus = deps.eventBus;
    if (deps.messageQueue !== undefined) this.messageQueue = deps.messageQueue;
  }

  /** Forget cached usage + teams snapshot (tests / after a budget edit). */
  invalidate(teamId?: string): void {
    if (teamId) this.cache.delete(teamId);
    else this.cache.clear();
    this.teamsSnapshot = null;
  }

  /** Teams list, re-read at most once per {@link TEAM_BUDGET_CACHE_TTL_MS}. */
  private async loadTeams(): Promise<Team[]> {
    const nowMs = this.now().getTime();
    if (this.teamsSnapshot && nowMs - this.teamsSnapshot.at < TEAM_BUDGET_CACHE_TTL_MS) {
      return this.teamsSnapshot.teams;
    }
    const teams = await this.getTeams();
    this.teamsSnapshot = { at: nowMs, teams };
    return teams;
  }

  /**
   * Check a team's budget. Cached per team for {@link TEAM_BUDGET_CACHE_TTL_MS}.
   *
   * @param teamId - Team to evaluate
   * @returns The check; `allowed: true` when the team is unknown or has no caps
   */
  async check(teamId: string): Promise<TeamBudgetCheck> {
    const nowMs = this.now().getTime();
    const cached = this.cache.get(teamId);
    if (cached && nowMs - cached.at < TEAM_BUDGET_CACHE_TTL_MS) {
      return cached.check;
    }

    let check: TeamBudgetCheck;
    try {
      const teams = await this.loadTeams();
      const team = teams.find((t) => t.id === teamId);
      check = team ? this.evaluate(team) : this.allowedFor(teamId, '', []);
    } catch (err) {
      // Fail OPEN: a ledger/storage hiccup must never freeze every team.
      this.logger.warn('Team budget check failed — allowing (fail-open)', {
        teamId,
        error: formatError(err),
      });
      check = this.allowedFor(teamId, '', []);
    }

    this.cache.set(teamId, { at: nowMs, check });
    if (check.level !== 'ok') {
      this.notify(check);
    }
    return check;
  }

  /**
   * Check the budget of the team that owns `sessionName`. Sessions that map
   * to no team (orchestrator, unknown) are always allowed.
   *
   * @param sessionName - Agent PTY session name
   * @returns The team's check, or an allowed check when unresolvable
   */
  async checkForSession(sessionName: string): Promise<TeamBudgetCheck> {
    let teamId: string | null = null;
    try {
      const teams = await this.loadTeams();
      const team = teams.find((t) => t.members.some((m) => m.sessionName === sessionName));
      teamId = team?.id ?? null;
    } catch (err) {
      this.logger.warn('Team lookup for budget check failed — allowing (fail-open)', {
        sessionName,
        error: formatError(err),
      });
    }
    if (!teamId) return this.allowedFor('', '', [sessionName]);
    return this.check(teamId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private allowedFor(teamId: string, teamName: string, sessions: string[]): TeamBudgetCheck {
    return {
      allowed: true,
      level: 'ok',
      teamId,
      teamName,
      usage: { tokensToday: 0, usdThisMonth: 0, sessions },
    };
  }

  /** Aggregate the team's sessions over the two windows and grade the result. */
  private evaluate(team: Team): TeamBudgetCheck {
    const sessions = team.members.map((m) => m.sessionName).filter((s) => !!s);
    if (!hasCaps(team.budget)) {
      return this.allowedFor(team.id, team.name, sessions);
    }
    const now = this.now();
    const dayStart = startOfUtcDay(now);
    const monthStart = startOfUtcMonth(now);

    let tokensToday = 0;
    let usdThisMonth = 0;
    for (const session of sessions) {
      const day = this.ledger.getSessionUsageSince(session, dayStart, now);
      tokensToday += day.inputTokens + day.outputTokens;
      const month = this.ledger.getSessionUsageSince(session, monthStart, now);
      usdThisMonth += month.cost;
    }

    const budget = team.budget;
    const maxTokensPerDay =
      typeof budget.maxTokensPerDay === 'number' && budget.maxTokensPerDay > 0
        ? budget.maxTokensPerDay
        : undefined;
    const maxUsdPerMonth =
      typeof budget.maxUsdPerMonth === 'number' && budget.maxUsdPerMonth > 0
        ? budget.maxUsdPerMonth
        : undefined;
    const tokenPct = maxTokensPerDay !== undefined ? pct(tokensToday, maxTokensPerDay) : undefined;
    const usdPct = maxUsdPerMonth !== undefined ? pct(usdThisMonth, maxUsdPerMonth) : undefined;
    const alertThreshold =
      typeof budget.alertThreshold === 'number' && budget.alertThreshold > 0
        ? budget.alertThreshold
        : DEFAULT_ALERT_THRESHOLD_PCT;

    const worstPct = Math.max(tokenPct ?? 0, usdPct ?? 0);
    const usage: TeamBudgetUsage = {
      tokensToday,
      usdThisMonth,
      maxTokensPerDay,
      maxUsdPerMonth,
      tokenPct,
      usdPct,
      sessions,
    };

    if (worstPct >= FULL_BUDGET_PCT) {
      const which =
        tokenPct !== undefined && tokenPct >= FULL_BUDGET_PCT
          ? `${tokensToday} tokens today ≥ ${maxTokensPerDay}/day`
          : `$${usdThisMonth.toFixed(2)} this month ≥ $${maxUsdPerMonth}/month`;
      return {
        allowed: false,
        reason: TEAM_BUDGET_EXCEEDED_REASON,
        detail: `Team "${team.name}" (${team.id}) is over budget: ${which}`,
        level: 'blocked',
        usage,
        teamId: team.id,
        teamName: team.name,
      };
    }
    if (worstPct >= alertThreshold) {
      return {
        allowed: true,
        detail:
          `Team "${team.name}" (${team.id}) has used ${worstPct}% of its budget ` +
          `(alert threshold ${alertThreshold}%)`,
        level: 'warn',
        usage,
        teamId: team.id,
        teamName: team.name,
      };
    }
    return {
      allowed: true,
      level: 'ok',
      usage,
      teamId: team.id,
      teamName: team.name,
    };
  }

  /**
   * Publish `team:budget_exceeded` + enqueue `[BUDGET]` once per team per
   * level per UTC day. `warn` and `blocked` are separate keys so a team
   * that crosses the alert line and later the hard cap gets both notices.
   */
  private notify(check: TeamBudgetCheck): void {
    const now = this.now();
    const key = `${check.teamId}:${check.level}:${dayKey(now)}`;
    if (this.notified.includes(key)) return;
    this.notified.push(key);
    if (this.notified.length > NOTIFY_DEDUP_CAPACITY) this.notified.shift();

    const content = this.formatEnvelope(check);

    if (this.eventBus) {
      try {
        this.eventBus.publish({
          id: `team:budget_exceeded:${key}`,
          type: 'team:budget_exceeded',
          timestamp: now.toISOString(),
          teamId: check.teamId,
          teamName: check.teamName,
          memberId: '',
          memberName: '',
          sessionName: '',
          previousValue: 'ok',
          newValue: check.level,
          changedField: 'taskStatus',
        });
      } catch (err) {
        this.logger.warn('team:budget_exceeded publish threw', { error: formatError(err) });
      }
    }

    if (this.messageQueue) {
      try {
        this.messageQueue.enqueue({
          content,
          conversationId: BUDGET_CONVERSATION_ID,
          source: MESSAGE_SOURCES.SYSTEM_EVENT,
          targetSession: ORCHESTRATOR_SESSION_NAME,
          sourceMetadata: {
            teamId: check.teamId,
            level: check.level,
            tokensToday: check.usage.tokensToday,
            usdThisMonth: check.usage.usdThisMonth,
          },
        });
      } catch (err) {
        this.logger.warn('[BUDGET] enqueue failed (non-fatal)', { error: formatError(err) });
      }
    }

    this.logger.info('Team budget notification', { teamId: check.teamId, level: check.level });
  }

  /** Owner-facing one-liner. */
  private formatEnvelope(check: TeamBudgetCheck): string {
    const u = check.usage;
    const parts: string[] = [];
    if (u.maxTokensPerDay !== undefined) {
      parts.push(`${u.tokensToday}/${u.maxTokensPerDay} tokens today (${u.tokenPct}%)`);
    }
    if (u.maxUsdPerMonth !== undefined) {
      parts.push(`$${u.usdThisMonth.toFixed(2)}/$${u.maxUsdPerMonth} this month (${u.usdPct}%)`);
    }
    const state =
      check.level === 'blocked'
        ? 'BLOCKED — new work will not be dispatched or claimed until the window resets or the budget is raised.'
        : 'WARNING — approaching the cap.';
    return `${BUDGET_ENVELOPE_PREFIX} Team "${check.teamName}" (${check.teamId}) ${state} ${parts.join('; ')}`;
  }
}
