/**
 * Daily token caps with a hard stop: per agent, per team and all agents
 * together, plus temporary boosts.
 *
 * - The unit is tokens (input incl. cached + output, see `eventTokens`).
 * - Caps are the owner's own limits (unlike the runtime fallback, which
 *   reacts to a provider's usage limit). All are OFF until the owner sets
 *   one: a default per-agent cap, per-agent overrides, per-team caps, and an
 *   optional all-agents total.
 * - At {@link SPEND_CAP_CONSTANTS.WARN_FRACTION} of a cap the owner gets ONE
 *   heads-up.
 * - At 100% the agent is hard-stopped: {@link stopOf} answers the delivery
 *   and wake gates, so no new turn starts (the current one may finish) and
 *   messages stay queued. The owner gets ONE decision card: "Boost +X
 *   today" / "Unlimited today" / "Keep stopped".
 * - A boost covers an agent, a team (its members) or everyone. For every
 *   agent it covers, it adds `extraTokens` to EVERY cap checked for that
 *   agent (its own, its team's, the total), or lifts them all
 *   (`unlimited`). It ends at `until` — by default the next local midnight.
 * - Local midnight resets the day; when a stop lifts (midnight, boost, cap
 *   change) the queued messages are released.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.service
 */

import { randomUUID } from 'crypto';
import { ORCHESTRATOR_SESSION_NAME, SPEND_CAP_CONSTANTS as C } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import { localDateKey, localMidnight } from '../project-tickets/ticket-autopilot-decision.js';
import { compactTokens, formatTokens, parseTokenAmount } from '../usage/token-format.js';
import { spendCapReason, type SpendCapGate, type SpendStop } from './spend-cap.gate.js';
import type { SpendLedger, SpendSummary } from './spend-ledger.service.js';
import { emptyDay, emptySpendCapFile, type SpendCapConfig, type SpendCapFile, type SpendCapStoreLike, type UsageBoost } from './spend-cap.store.js';

/** Minimal logger. */
export interface SpendCapLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** The decision-card calls the service makes. */
export interface SpendCapDecisions {
  askSystem(input: SystemAskInput): Promise<OwnerDecision>;
  replyInThread(id: string, text: string): Promise<boolean>;
}

/** A team, as caps need it. */
export interface CapTeam {
  id: string;
  name: string;
  /** Member sessions */
  members: string[];
}

/** Collaborators. */
export interface SpendCapServiceDeps {
  store: SpendCapStoreLike;
  ledger: Pick<SpendLedger, 'usedToday' | 'groupToday' | 'totalToday' | 'summarize' | 'invalidate'>;
  /** One line to the owner (Slack DM from this machine's orc bot); false/throw = not sent */
  notifyOwner: (text: string) => Promise<unknown>;
  /** Decision cards (null before they are wired: the stop is then a plain notice) */
  decisions?: () => SpendCapDecisions | null;
  /** Owner-facing name of a session ("Orc", "Ella") */
  displayNameOf?: (session: string) => string;
  /** Sessions the owner configured (orc + team members), for the caps view */
  knownSessions?: () => Promise<string[]>;
  /** Teams and their member sessions */
  teams?: () => Promise<CapTeam[]>;
  /** Stops lifted: deliver what was queued for these sessions */
  onReleased?: (sessions: string[]) => Promise<void>;
  now?: () => Date;
  logger?: SpendCapLogger;
}

/** Body of `PUT /api/system/usage/caps`. Amounts are tokens (a number, or text like "20M"). */
export interface SpendCapPatch {
  /** Default per-agent cap; null turns it off */
  defaultAgentCapTokens?: unknown;
  /** All-agents total cap; null turns it off */
  totalCapTokens?: unknown;
  /** Session → cap, `null` = no cap for this agent, `"default"` = drop the override */
  agents?: Record<string, unknown>;
  /** Team id → cap, `null` = drop the team's cap */
  teams?: Record<string, unknown>;
}

/** Body of `POST /api/system/usage/boost`. */
export interface BoostInput {
  scope: 'team' | 'agent' | 'all';
  /** Team id / name, or agent session / name (not for `all`) */
  id?: string;
  /** Extra tokens today (number or "20M") */
  extraTokens?: unknown;
  /** No cap at all */
  unlimited?: boolean;
  /** ISO end time; default the next local midnight */
  until?: string;
  by?: string;
}

/** A rejected change. */
export class SpendCapError extends Error {
  /**
   * @param status - HTTP status
   * @param message - Owner-facing reason
   */
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SpendCapError';
  }
}

/** Where an agent's own cap comes from. */
export type CapSource = 'override' | 'default' | 'none' | 'exempt';

/** One agent in the caps view. */
export interface SpendCapAgentView {
  session: string;
  name: string;
  teamId?: string;
  runtimes: string[];
  todayTokens: number;
  windowTokens: number;
  daily: number[];
  /** Own cap in force today (boosts included), null = none */
  capTokens: number | null;
  /** Own cap before boosts */
  baseCapTokens: number | null;
  capSource: CapSource;
  /** Boosts covering it */
  boosted: boolean;
  unlimited: boolean;
  stopped: boolean;
  stopReason?: string;
}

/** One team in the caps view. */
export interface SpendCapTeamView {
  teamId: string;
  name: string;
  members: string[];
  todayTokens: number;
  baseCapTokens: number | null;
  /** Cap in force today (team / everyone boosts included), null = none */
  capTokens: number | null;
  extraTokens: number;
  unlimited: boolean;
  /** Boosts on this team (not counting everyone-boosts) */
  boosts: UsageBoost[];
  stopped: boolean;
}

/** What `GET /api/system/usage/caps` returns. */
export interface SpendView extends Omit<SpendSummary, 'agents'> {
  agents: SpendCapAgentView[];
  teams: SpendCapTeamView[];
  caps: SpendCapConfig;
  /** Boosts in force */
  boosts: UsageBoost[];
  /** Total cap in force today (everyone boosts included), null = off */
  totalCapTodayTokens: number | null;
  /** Suggested default per-agent cap: the window's p90 agent-day, rounded up to a whole million (null = no data) */
  suggestedAgentCapTokens: number | null;
  /** All agents together stopped by the total cap */
  totalStopped: boolean;
}

/**
 * Whether a cap value is usable.
 *
 * @param v - Value
 * @returns True for a finite positive number
 */
function isCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Validate a cap from the API.
 *
 * @param v - Value (number or "20M")
 * @param what - Field name for the error
 * @returns The cap (whole tokens) or null
 * @throws SpendCapError
 */
function parseCap(v: unknown, what: string): number | null {
  if (v === null || v === '') return null;
  const n = parseTokenAmount(v);
  if (n === null) throw new SpendCapError(400, `${what} must be a positive number of tokens (e.g. 5000000 or "5M"), or null to turn it off`);
  return n;
}

/**
 * Round up to a whole million (at least 1M).
 *
 * @param tokens - Tokens
 * @returns Rounded tokens
 */
export function roundUpMillions(tokens: number): number {
  return Math.max(1_000_000, Math.ceil(tokens / 1_000_000) * 1_000_000);
}

/**
 * The "Boost +X today" amount on a cap card: the cap times BOOST_FACTOR,
 * rounded up to a whole million.
 *
 * @param capTokens - Cap in force
 * @returns Tokens
 */
export function suggestedBoost(capTokens: number): number {
  return roundUpMillions(capTokens * C.BOOST_FACTOR);
}

/**
 * Read the amount out of a "Boost +X tokens today" option label.
 *
 * @param label - Option label
 * @returns Tokens, `unlimited`, or null when the label is not a boost
 */
export function boostOfLabel(label: string | undefined): number | 'unlimited' | null {
  const text = (label ?? '').trim();
  if (text.toLowerCase().startsWith(C.OPTIONS.UNLIMITED.toLowerCase())) return 'unlimited';
  const m = /^Boost \+(\S+?)(?: tokens)? today/i.exec(text);
  return m ? parseTokenAmount(m[1]) : null;
}

/** Team target key. */
export function teamTarget(teamId: string): string {
  return `${C.TEAM_TARGET_PREFIX}${teamId}`;
}

/**
 * Daily token cap service.
 */
export class SpendCapService implements SpendCapGate {
  private file: SpendCapFile;
  private readonly now: () => Date;
  private readonly logger: SpendCapLogger | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sessions stopped at the last evaluation (to release them when the stop lifts) */
  private lastStopped = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private queuedPass: Promise<void> | null = null;
  /** Team index, refreshed on every evaluation (the gate is synchronous) */
  private teamList: CapTeam[] = [];
  private teamsOfSession = new Map<string, string[]>();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: SpendCapServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger;
    this.file = deps.store.read() ?? emptySpendCapFile(localDateKey(this.now()));
  }

  /** Start the enforcement tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.evaluate(), C.TICK_MS);
    this.timer.unref?.();
    void this.evaluate();
  }

  /** Stop the tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read the team list now (tests; the tick does it too). */
  async refreshTeams(): Promise<void> {
    const teams = (await this.deps.teams?.().catch(() => [] as CapTeam[])) ?? [];
    this.teamList = teams;
    const index = new Map<string, string[]>();
    for (const t of teams) {
      for (const s of t.members) index.set(s, [...(index.get(s) ?? []), t.id]);
    }
    this.teamsOfSession = index;
  }

  // ---------------------------------------------------------------- caps

  /** @returns The owner's caps (a copy) */
  getConfig(): SpendCapConfig {
    return JSON.parse(JSON.stringify(this.file.config)) as SpendCapConfig;
  }

  /**
   * Change caps. Takes effect at once (a stop can lift or start).
   *
   * @param patch - Changes
   * @returns The new caps
   * @throws SpendCapError on a bad value
   */
  async setCaps(patch: SpendCapPatch): Promise<SpendCapConfig> {
    if (!patch || typeof patch !== 'object') throw new SpendCapError(400, 'Send the caps to change as JSON');
    const next: SpendCapConfig = this.getConfig();
    if ('defaultAgentCapTokens' in patch) next.defaultAgentCapTokens = parseCap(patch.defaultAgentCapTokens, 'defaultAgentCapTokens');
    if ('totalCapTokens' in patch) next.totalCapTokens = parseCap(patch.totalCapTokens, 'totalCapTokens');
    if (patch.agents !== undefined) {
      if (!patch.agents || typeof patch.agents !== 'object') throw new SpendCapError(400, 'agents must be an object: { "<session>": 5000000 | null | "default" }');
      for (const [session, value] of Object.entries(patch.agents)) {
        if (!session.trim()) throw new SpendCapError(400, 'agents keys must be agent session names');
        if (value === 'default') delete next.agentCapsTokens[session];
        else next.agentCapsTokens[session] = parseCap(value, `agents.${session}`);
      }
    }
    if (patch.teams !== undefined) {
      if (!patch.teams || typeof patch.teams !== 'object') throw new SpendCapError(400, 'teams must be an object: { "<teamId>": 50000000 | null }');
      for (const [teamId, value] of Object.entries(patch.teams)) {
        if (!teamId.trim()) throw new SpendCapError(400, 'teams keys must be team ids');
        const cap = parseCap(value, `teams.${teamId}`);
        if (cap === null) delete next.teamCapsTokens[teamId];
        else next.teamCapsTokens[teamId] = cap;
      }
    }
    next.updatedAt = this.now().toISOString();
    this.file.config = next;
    this.persist();
    this.logger?.info('Token caps changed', { caps: next });
    await this.evaluate();
    return this.getConfig();
  }

  // ---------------------------------------------------------------- boosts

  /** @returns Boosts in force (expired ones are dropped) */
  activeBoosts(): UsageBoost[] {
    this.pruneBoosts();
    return this.file.boosts.map((b) => ({ ...b }));
  }

  /**
   * Add a temporary boost.
   *
   * @param input - Scope, target, extra tokens or unlimited, optional end
   * @returns The boost
   * @throws SpendCapError on a bad request
   */
  async boost(input: BoostInput): Promise<UsageBoost> {
    if (!input || typeof input !== 'object') throw new SpendCapError(400, 'Send the boost as JSON');
    const target = await this.resolveBoostTarget(input.scope, input.id);
    const unlimited = input.unlimited === true;
    const extra = unlimited ? null : parseTokenAmount(input.extraTokens);
    if (!unlimited && extra === null) throw new SpendCapError(400, 'Send extraTokens (a positive number of tokens, e.g. 20000000 or "20M") or unlimited: true');
    const now = this.now();
    let until = this.nextMidnight();
    if (input.until !== undefined && input.until !== null && input.until !== '') {
      const t = new Date(String(input.until));
      if (Number.isNaN(t.getTime()) || t.getTime() <= now.getTime()) throw new SpendCapError(400, 'until must be a future time (ISO 8601)');
      until = t;
    }
    const boost: UsageBoost = {
      id: randomUUID(),
      target,
      ...(unlimited ? { unlimited: true } : { extraTokens: extra as number }),
      until: until.toISOString(),
      createdAt: now.toISOString(),
      ...(input.by ? { by: input.by } : {}),
    };
    this.pruneBoosts();
    this.file.boosts.push(boost);
    this.persist();
    this.logger?.info('Usage boost added', { target, extraTokens: boost.extraTokens, unlimited: boost.unlimited, until: boost.until });
    await this.evaluate();
    return { ...boost };
  }

  /**
   * End a boost early.
   *
   * @param id - Boost id
   * @returns True when it existed
   */
  async removeBoost(id: string): Promise<boolean> {
    const before = this.file.boosts.length;
    this.file.boosts = this.file.boosts.filter((b) => b.id !== id);
    if (this.file.boosts.length === before) return false;
    this.persist();
    await this.evaluate();
    return true;
  }

  /**
   * Owner-facing description of a boost target.
   *
   * @param target - Boost target
   * @returns e.g. `everyone`, `team CE`, `Ella`
   */
  describeTarget(target: string): string {
    if (target === C.TOTAL_TARGET) return 'everyone';
    if (target.startsWith(C.TEAM_TARGET_PREFIX)) {
      const id = target.slice(C.TEAM_TARGET_PREFIX.length);
      return `team ${this.teamList.find((t) => t.id === id)?.name ?? id}`;
    }
    return this.nameOf(target);
  }

  /**
   * Extra tokens / unlimited a boost set gives for one target set.
   *
   * @param covers - Which boost targets apply
   * @returns Sum of extras and whether any is unlimited
   */
  private boostFor(covers: (target: string) => boolean): { extra: number; unlimited: boolean } {
    let extra = 0;
    let unlimited = false;
    for (const b of this.activeBoostsRaw()) {
      if (!covers(b.target)) continue;
      if (b.unlimited) unlimited = true;
      else extra += b.extraTokens ?? 0;
    }
    return { extra, unlimited };
  }

  /** Boosts covering an agent: its own, its teams', everyone's. */
  private boostForSession(session: string): { extra: number; unlimited: boolean } {
    const teams = new Set((this.teamsOfSession.get(session) ?? []).map(teamTarget));
    return this.boostFor((t) => t === C.TOTAL_TARGET || t === session || teams.has(t));
  }

  /**
   * Boosts covering a team (team and everyone boosts) — what the ticket
   * autopilot budget of the team's projects honours.
   *
   * @param teamId - Team id
   * @returns Extra tokens and unlimited
   */
  boostForTeam(teamId: string): { extra: number; unlimited: boolean } {
    return this.boostForTeams([teamId]);
  }

  /**
   * Boosts covering any of several teams, each boost counted once (a
   * project worked on by two teams).
   *
   * @param teamIds - Team ids
   * @returns Extra tokens and unlimited
   */
  boostForTeams(teamIds: readonly string[]): { extra: number; unlimited: boolean } {
    const keys = new Set(teamIds.map(teamTarget));
    return this.boostFor((t) => t === C.TOTAL_TARGET || keys.has(t));
  }

  // ---------------------------------------------------------------- gate

  /**
   * The stop in force for a session (the delivery / wake gate). Synchronous
   * and live: it reads today's usage now, not at the last tick.
   *
   * @param session - Agent session
   * @returns Stop, or null when the agent may run
   */
  stopOf(session: string): SpendStop | null {
    this.rollDay();
    const stop = this.computeStop(session);
    if (stop && !this.file.day.stopped.includes(this.stopKey(stop))) this.scheduleEvaluate();
    return stop;
  }

  /**
   * Owner-facing name.
   *
   * @param session - Agent session
   * @returns Name
   */
  displayNameOf(session: string): string {
    return this.nameOf(session);
  }

  /**
   * An agent's own cap before boosts, and where it comes from.
   *
   * @param session - Agent session
   * @returns Cap (null = none) and source
   */
  ownCapOf(session: string): { capTokens: number | null; source: CapSource } {
    const cfg = this.file.config;
    if (Object.prototype.hasOwnProperty.call(cfg.agentCapsTokens, session)) {
      const v = cfg.agentCapsTokens[session];
      return isCap(v) ? { capTokens: v, source: 'override' } : { capTokens: null, source: 'exempt' };
    }
    return isCap(cfg.defaultAgentCapTokens) ? { capTokens: cfg.defaultAgentCapTokens, source: 'default' } : { capTokens: null, source: 'none' };
  }

  // ---------------------------------------------------------------- view

  /**
   * Usage plus caps for the API / Settings panel.
   *
   * @param days - Window
   * @returns View
   */
  async view(days: number = C.DEFAULT_DAYS): Promise<SpendView> {
    this.rollDay();
    await this.refreshTeams();
    const summary = this.deps.ledger.summarize(days);
    const known = (await this.deps.knownSessions?.().catch(() => [] as string[])) ?? [];
    const rows = new Map(summary.agents.map((a) => [a.session, a]));
    for (const s of [...known, ...this.teamList.flatMap((t) => t.members)]) {
      if (!rows.has(s)) rows.set(s, { session: s, runtimes: [], todayTokens: 0, windowTokens: 0, windowCachedTokens: 0, daily: summary.days.map(() => 0) });
    }
    const agents: SpendCapAgentView[] = [...rows.values()].map((a) => {
      const own = this.ownCapOf(a.session);
      const b = this.boostForSession(a.session);
      const stop = this.computeStop(a.session);
      return {
        session: a.session,
        name: this.nameOf(a.session),
        ...(this.teamsOfSession.get(a.session)?.[0] ? { teamId: this.teamsOfSession.get(a.session)?.[0] } : {}),
        runtimes: a.runtimes,
        todayTokens: a.todayTokens,
        windowTokens: a.windowTokens,
        daily: a.daily,
        baseCapTokens: own.capTokens,
        capTokens: own.capTokens === null || b.unlimited ? null : own.capTokens + b.extra,
        capSource: own.source,
        boosted: b.unlimited || b.extra > 0,
        unlimited: b.unlimited,
        stopped: !!stop,
        ...(stop ? { stopReason: spendCapReason(stop, this.nameOf(a.session)) } : {}),
      };
    });
    const teams: SpendCapTeamView[] = this.teamList.map((t) => {
      const base = this.file.config.teamCapsTokens[t.id];
      const b = this.boostForTeam(t.id);
      const cap = isCap(base) && !b.unlimited ? base + b.extra : null;
      const used = this.deps.ledger.groupToday(t.members);
      return {
        teamId: t.id,
        name: t.name,
        members: t.members,
        todayTokens: used,
        baseCapTokens: isCap(base) ? base : null,
        capTokens: cap,
        extraTokens: b.extra,
        unlimited: b.unlimited,
        boosts: this.activeBoostsRaw().filter((x) => x.target === teamTarget(t.id)),
        stopped: cap !== null && used >= cap,
      };
    });
    const totalBoost = this.boostFor((t) => t === C.TOTAL_TARGET);
    const total = isCap(this.file.config.totalCapTokens) && !totalBoost.unlimited ? this.file.config.totalCapTokens + totalBoost.extra : null;
    const { agents: _omit, ...rest } = summary;
    void _omit;
    return {
      ...rest,
      agents,
      teams,
      caps: this.getConfig(),
      boosts: this.activeBoosts(),
      totalCapTodayTokens: total,
      suggestedAgentCapTokens: summary.p90AgentDayTokens > 0 ? roundUpMillions(summary.p90AgentDayTokens) : null,
      totalStopped: total !== null && this.deps.ledger.totalToday() >= total,
    };
  }

  // ---------------------------------------------------------------- enforcement

  /**
   * One enforcement pass: day roll, boost expiry, 80% notices, stop
   * announcements (one card per stop), and releasing agents whose stop
   * lifted. Passes run one at a time; a call during a pass gets another
   * pass after it.
   */
  evaluate(): Promise<void> {
    if (this.queuedPass) return this.queuedPass;
    const pass = this.chain.then(async () => {
      this.queuedPass = null;
      try {
        await this.evaluateOnce();
      } catch (err) {
        this.logger?.warn('Token cap evaluation failed', { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.queuedPass = pass;
    this.chain = pass;
    return pass;
  }

  /**
   * React to a settled "cap reached" card (decision kind `spend_cap`).
   *
   * @param d - The settled decision
   * @returns Always null (nobody else is told)
   */
  async onSettled(d: OwnerDecision): Promise<null> {
    if (d.kind !== C.DECISION_KIND || !d.system) return null;
    const target = d.system.key;
    this.rollDay();
    if (this.file.day.cards[target] !== d.id) {
      if (d.status === 'resolved') await this.reply(d.id, 'This card is from an earlier day; the cap has already reset at midnight.');
      return null;
    }
    const who = this.describeTarget(target);
    if (d.status !== 'resolved') return null;
    const label = d.options.find((o) => o.key === d.chosenKey)?.label;
    const boost = boostOfLabel(label);
    if (boost === null) {
      await this.reply(d.id, `OK, ${who} stays stopped until midnight. Messages stay queued.`);
      return null;
    }
    try {
      const scope = target === C.TOTAL_TARGET ? 'all' : target.startsWith(C.TEAM_TARGET_PREFIX) ? 'team' : 'agent';
      const id = scope === 'team' ? target.slice(C.TEAM_TARGET_PREFIX.length) : scope === 'agent' ? target : undefined;
      await this.boost(boost === 'unlimited' ? { scope, id, unlimited: true, by: 'card' } : { scope, id, extraTokens: boost, by: 'card' });
      const what = boost === 'unlimited' ? 'no cap' : `+${formatTokens(boost)}`;
      await this.reply(d.id, `Done: ${what} for ${who} until midnight. Queued messages are being delivered.`);
    } catch (err) {
      await this.reply(d.id, `Could not boost: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  // ---------------------------------------------------------------- internals

  private async evaluateOnce(): Promise<void> {
    this.rollDay();
    const hadBoosts = this.file.boosts.length;
    this.pruneBoosts();
    if (hadBoosts !== this.file.boosts.length) this.persist();
    if (!this.anyCap() && this.lastStopped.size === 0) return;
    await this.refreshTeams();
    this.deps.ledger.invalidate();
    const summary = this.deps.ledger.summarize(1);
    const known = (await this.deps.knownSessions?.().catch(() => [] as string[])) ?? [];
    const sessions = new Set<string>([...known, ...summary.agents.map((a) => a.session), ...this.teamList.flatMap((t) => t.members)]);
    for (const s of this.lastStopped) sessions.add(s);

    // The all-agents total first: its notice names the whole crew once.
    const totalCap = this.capForTarget(C.TOTAL_TARGET);
    if (totalCap !== null) await this.checkThresholds(C.TOTAL_TARGET, totalCap, this.deps.ledger.totalToday());
    for (const t of this.teamList) {
      const cap = this.capForTarget(teamTarget(t.id));
      if (cap !== null) await this.checkThresholds(teamTarget(t.id), cap, this.deps.ledger.groupToday(t.members));
    }
    const stoppedNow = new Set<string>();
    for (const session of sessions) {
      const cap = this.capForTarget(session);
      if (cap !== null) await this.checkThresholds(session, cap, this.deps.ledger.usedToday(session));
      if (this.computeStop(session)) stoppedNow.add(session);
    }

    const released = [...this.lastStopped].filter((s) => !stoppedNow.has(s));
    this.lastStopped = stoppedNow;
    if (released.length > 0) {
      this.logger?.info('Token cap stop lifted — releasing queued messages', { sessions: released });
      await this.deps.onReleased?.(released).catch((err) =>
        this.logger?.warn('Releasing queued messages failed', { sessions: released, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  /**
   * The cap in force for a cap target, with the boosts that cover the
   * target itself (for notices and cards).
   */
  private capForTarget(target: string): number | null {
    const cfg = this.file.config;
    if (target === C.TOTAL_TARGET) {
      const b = this.boostFor((t) => t === C.TOTAL_TARGET);
      return isCap(cfg.totalCapTokens) && !b.unlimited ? cfg.totalCapTokens + b.extra : null;
    }
    if (target.startsWith(C.TEAM_TARGET_PREFIX)) {
      const id = target.slice(C.TEAM_TARGET_PREFIX.length);
      const base = cfg.teamCapsTokens[id];
      const b = this.boostForTeam(id);
      return isCap(base) && !b.unlimited ? base + b.extra : null;
    }
    const own = this.ownCapOf(target).capTokens;
    const b = this.boostForSession(target);
    return own !== null && !b.unlimited ? own + b.extra : null;
  }

  private async checkThresholds(target: string, cap: number, used: number): Promise<void> {
    const key = `${target}@${cap}`;
    const day = this.file.day;
    const who = this.describeTarget(target);
    if (used >= cap) {
      if (day.stopped.includes(key)) return;
      day.stopped.push(key);
      if (!day.warned.includes(key)) day.warned.push(key);
      this.persist();
      this.logger?.warn('Daily token cap reached — hard stop (no new turns until midnight)', { target, capTokens: cap, usedTokens: used });
      await this.announceStop(target, who, cap, used);
      return;
    }
    if (used >= cap * C.WARN_FRACTION && !day.warned.includes(key)) {
      day.warned.push(key);
      this.persist();
      const pct = Math.floor((used / cap) * 100);
      const subject = target === C.TOTAL_TARGET ? 'All agents together have' : target.startsWith(C.TEAM_TARGET_PREFIX) ? `Team ${who.replace(/^team /, '')} has` : `${who} has`;
      const stops = target === C.TOTAL_TARGET ? 'every agent stops' : target.startsWith(C.TEAM_TARGET_PREFIX) ? 'its members stop' : 'it stops';
      await this.notify(
        `Heads-up: ${subject} used ${formatTokens(used)} of the ${formatTokens(cap)} daily token cap today (${pct}%). At ${compactTokens(cap)} ${stops} taking new turns until midnight.`,
      );
    }
  }

  private async announceStop(target: string, who: string, cap: number, used: number): Promise<void> {
    const extra = suggestedBoost(cap);
    const dmWho = target === C.TOTAL_TARGET ? 'everyone' : target === ORCHESTRATOR_SESSION_NAME ? 'orc' : who.replace(/^team /, '');
    const headline =
      target === C.TOTAL_TARGET
        ? `All agents together hit the daily token cap (${formatTokens(cap)}); every agent is stopped until midnight.`
        : target.startsWith(C.TEAM_TARGET_PREFIX)
          ? `Team ${who.replace(/^team /, '')} hit its daily token cap (${formatTokens(cap)}); its members are stopped until midnight.`
          : `${who} hit its daily token cap (${formatTokens(cap)}) and is stopped until midnight.`;
    const decisions = this.deps.decisions?.() ?? null;
    if (decisions) {
      try {
        const d = await decisions.askSystem({
          kind: C.DECISION_KIND,
          system: { key: target, defaultIsDecline: true },
          title: 'Daily token cap reached',
          question: `${headline} Boost it for today?`,
          body: [
            `Used today: ${formatTokens(used)}. The current turn was allowed to finish; no new turns start. Messages are kept and delivered when it runs again.`,
          ],
          options: [
            `Boost +${compactTokens(extra)} tokens today — runs again until midnight`,
            `${C.OPTIONS.UNLIMITED} — no cap until midnight`,
            `${C.OPTIONS.KEEP} — resets at midnight`,
          ],
          default: C.OPTIONS.KEEP,
          deadline: this.nextMidnight(),
          sensitive: 'spend',
        });
        this.file.day.cards[target] = d.id;
        this.persist();
        return;
      } catch (err) {
        this.logger?.warn('Could not post the token cap card — sending a notice instead', { target, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.notify(`${headline} Messages are queued. Reply \`boost ${dmWho} by ${compactTokens(extra)} today\` or \`unlimited today for ${dmWho}\`.`);
  }

  private anyCap(): boolean {
    const cfg = this.file.config;
    return (
      isCap(cfg.defaultAgentCapTokens) ||
      isCap(cfg.totalCapTokens) ||
      Object.values(cfg.agentCapsTokens).some(isCap) ||
      Object.values(cfg.teamCapsTokens).some(isCap)
    );
  }

  private computeStop(session: string): SpendStop | null {
    const b = this.boostForSession(session);
    if (b.unlimited) return null;
    const cfg = this.file.config;
    const own = this.ownCapOf(session).capTokens;
    if (own !== null) {
      const used = this.deps.ledger.usedToday(session);
      if (used >= own + b.extra) return { session, scope: 'agent', capTokens: own + b.extra, usedTokens: used };
    }
    for (const teamId of this.teamsOfSession.get(session) ?? []) {
      const base = cfg.teamCapsTokens[teamId];
      if (!isCap(base)) continue;
      const team = this.teamList.find((t) => t.id === teamId);
      const used = this.deps.ledger.groupToday(team?.members ?? [session]);
      if (used >= base + b.extra) return { session, scope: 'team', capTokens: base + b.extra, usedTokens: used, teamId, teamName: team?.name ?? teamId };
    }
    if (isCap(cfg.totalCapTokens)) {
      const used = this.deps.ledger.totalToday();
      if (used >= cfg.totalCapTokens + b.extra) return { session, scope: 'total', capTokens: cfg.totalCapTokens + b.extra, usedTokens: used };
    }
    return null;
  }

  private stopKey(stop: SpendStop): string {
    const target = stop.scope === 'total' ? C.TOTAL_TARGET : stop.scope === 'team' ? teamTarget(stop.teamId ?? '') : stop.session;
    return `${target}@${stop.capTokens}`;
  }

  private scheduleEvaluate(): void {
    void this.evaluate();
  }

  private activeBoostsRaw(): UsageBoost[] {
    const now = this.now().getTime();
    return this.file.boosts.filter((b) => new Date(b.until).getTime() > now);
  }

  private pruneBoosts(): void {
    const live = this.activeBoostsRaw();
    if (live.length !== this.file.boosts.length) {
      const ended = this.file.boosts.filter((b) => !live.includes(b));
      this.file.boosts = live;
      this.logger?.info('Usage boosts ended', { boosts: ended.map((b) => ({ target: b.target, until: b.until })) });
    }
  }

  private async resolveBoostTarget(scope: unknown, id: unknown): Promise<string> {
    if (scope === 'all') return C.TOTAL_TARGET;
    const raw = typeof id === 'string' ? id.trim() : '';
    if (scope === 'team') {
      if (!raw) throw new SpendCapError(400, 'id is required for a team boost (team id or name)');
      await this.refreshTeams();
      const w = raw.toLowerCase();
      const hit = this.teamList.find((t) => t.id === raw) ?? this.teamList.filter((t) => t.name.toLowerCase() === w).at(0);
      if (!hit) throw new SpendCapError(404, `No team called "${raw}"`);
      return teamTarget(hit.id);
    }
    if (scope === 'agent') {
      if (!raw) throw new SpendCapError(400, 'id is required for an agent boost (session or name)');
      await this.refreshTeams();
      const known = new Set([...((await this.deps.knownSessions?.().catch(() => [] as string[])) ?? []), ...this.teamList.flatMap((t) => t.members)]);
      if (known.has(raw)) return raw;
      const byName = [...known].filter((s) => this.nameOf(s).toLowerCase() === raw.toLowerCase());
      if (byName.length === 1) return byName[0];
      if (byName.length > 1) throw new SpendCapError(400, `More than one agent is called "${raw}"; use its session name`);
      return raw;
    }
    throw new SpendCapError(400, 'scope must be team, agent or all');
  }

  /** Reset today's bookkeeping when the local day changed. */
  private rollDay(): void {
    const today = localDateKey(this.now());
    if (this.file.day.date === today) return;
    const had = this.file.day.stopped.length;
    this.file.day = emptyDay(today);
    this.pruneBoosts();
    this.deps.ledger.invalidate();
    this.persist();
    if (had > 0) this.logger?.info('Token caps reset for the new day', { date: today });
  }

  private nextMidnight(): Date {
    const next = localMidnight(this.now());
    next.setDate(next.getDate() + 1);
    // A card must have a future deadline even in the last minute of the day.
    return next.getTime() - this.now().getTime() < 60_000 ? new Date(this.now().getTime() + 60_000) : next;
  }

  private nameOf(target: string): string {
    if (target === C.TOTAL_TARGET) return 'All agents';
    try {
      return this.deps.displayNameOf?.(target) || target;
    } catch {
      return target;
    }
  }

  private async notify(text: string): Promise<void> {
    try {
      await this.deps.notifyOwner(text);
    } catch (err) {
      this.logger?.warn('Could not send the token cap notice', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async reply(decisionId: string, text: string): Promise<void> {
    await this.deps.decisions?.()?.replyInThread(decisionId, text).catch(() => undefined);
  }

  private persist(): void {
    try {
      this.deps.store.write(this.file);
    } catch (err) {
      this.logger?.warn('Could not save token caps', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

let instance: SpendCapService | null = null;

/** @returns The backend's service, or null before it is wired */
export function getSpendCapService(): SpendCapService | null {
  return instance;
}

/** @param service - Instance (null clears) */
export function setSpendCapService(service: SpendCapService | null): void {
  instance = service;
}
