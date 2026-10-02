/**
 * Per-agent daily spend cap with a hard stop.
 *
 * - Caps are the owner's own limits (unlike the runtime fallback, which
 *   reacts to a provider's usage limit). All are OFF until the owner sets
 *   one: a default per-agent cap, per-agent overrides, and an optional
 *   all-agents daily total.
 * - At {@link SPEND_CAP_CONSTANTS.WARN_FRACTION} of a cap the owner gets ONE
 *   heads-up.
 * - At 100% the agent is hard-stopped: {@link stopOf} answers the delivery
 *   and wake gates, so no new turn starts (the current one may finish) and
 *   messages stay queued. The owner gets ONE decision card: "Raise to $Y
 *   today" / "Keep stopped".
 * - Local midnight resets everything; raises last for the day they were
 *   made. When a stop lifts (midnight, raise, cap change) the queued
 *   messages are released.
 *
 * Spend comes from {@link SpendLedger} (the shared token ledger and its one
 * cost computation).
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.service
 */

import { ORCHESTRATOR_SESSION_NAME, SPEND_CAP_CONSTANTS as C } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { SystemAskInput } from '../decisions/decision.service.js';
import { localDateKey, localMidnight } from '../project-tickets/ticket-autopilot-decision.js';
import { formatUsd, spendCapReason, type SpendCapGate, type SpendStop } from './spend-cap.gate.js';
import { cents, type SpendLedger, type SpendSummary } from './spend-ledger.service.js';
import { emptyDay, emptySpendCapFile, type SpendCapConfig, type SpendCapFile, type SpendCapStoreLike } from './spend-cap.store.js';

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

/** Collaborators. */
export interface SpendCapServiceDeps {
  store: SpendCapStoreLike;
  ledger: Pick<SpendLedger, 'spentToday' | 'totalToday' | 'summarize' | 'invalidate'>;
  /** One line to the owner (Slack DM from this machine's orc bot); false/throw = not sent */
  notifyOwner: (text: string) => Promise<unknown>;
  /** Decision cards (null before they are wired: the stop is then a plain notice) */
  decisions?: () => SpendCapDecisions | null;
  /** Owner-facing name of a session ("Orc", "Ella") */
  displayNameOf?: (session: string) => string;
  /** Sessions the owner configured (orc + team members), for the caps view */
  knownSessions?: () => Promise<string[]>;
  /** Stops lifted: deliver what was queued for these sessions */
  onReleased?: (sessions: string[]) => Promise<void>;
  now?: () => Date;
  logger?: SpendCapLogger;
}

/** Body of `PUT /api/system/spend/caps`. */
export interface SpendCapPatch {
  /** Default per-agent cap (USD); null turns it off */
  defaultAgentCapUsd?: number | null;
  /** All-agents total cap (USD); null turns it off */
  totalCapUsd?: number | null;
  /** Session → cap (USD), `null` = no cap for this agent, `"default"` = drop the override */
  agents?: Record<string, number | null | 'default'>;
}

/** A rejected cap change. */
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

/** One agent in the view. */
export interface SpendCapAgentView {
  session: string;
  name: string;
  runtimes: string[];
  todayUsd: number;
  windowUsd: number;
  daily: number[];
  /** Cap in force today (USD), null = none */
  capUsd: number | null;
  /** Where the cap comes from */
  capSource: 'override' | 'default' | 'raised' | 'none' | 'exempt';
  /** Stopped right now, and why */
  stopped: boolean;
  stopReason?: string;
}

/** What `GET /api/system/spend` returns. */
export interface SpendView extends Omit<SpendSummary, 'agents'> {
  agents: SpendCapAgentView[];
  caps: SpendCapConfig;
  /** Raises in force today: target → USD */
  raisedToday: Record<string, number>;
  /** Total cap in force today (raise included), null = off */
  totalCapTodayUsd: number | null;
  /** Suggested default per-agent cap: last window's p90 agent-day, rounded up to whole dollars (null = no data) */
  suggestedAgentCapUsd: number | null;
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
 * @param v - Value
 * @param what - Field name for the error
 * @returns The cap (whole cents) or null
 * @throws SpendCapError
 */
function parseCap(v: unknown, what: string): number | null {
  if (v === null) return null;
  const n = typeof v === 'string' ? Number(v.replace(/^\$/, '')) : v;
  if (!isCap(n)) throw new SpendCapError(400, `${what} must be a positive amount in USD (e.g. 5) or null to turn it off`);
  return cents(n);
}

/**
 * The "Raise to $Y today" amount: the cap times RAISE_FACTOR, rounded up to
 * whole dollars, and always above what was already spent.
 *
 * @param capUsd - Cap in force
 * @param spentUsd - Spent today
 * @returns USD
 */
export function suggestedRaise(capUsd: number, spentUsd: number): number {
  return Math.max(Math.ceil(capUsd * C.RAISE_FACTOR), Math.ceil(spentUsd) + 1);
}

/**
 * Read the amount out of a "Raise to $Y today" option label.
 *
 * @param label - Option label
 * @returns USD, or null when the label is not a raise
 */
export function raiseAmountOf(label: string | undefined): number | null {
  const m = /^Raise to \$(\d+(?:\.\d+)?) today/i.exec(label ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * Per-agent daily spend cap service.
 */
export class SpendCapService implements SpendCapGate {
  private file: SpendCapFile;
  private readonly now: () => Date;
  private readonly logger: SpendCapLogger | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Sessions stopped at the last evaluation (to release them when the stop lifts) */
  private lastStopped = new Set<string>();
  /** Evaluation passes run one after another */
  private chain: Promise<void> = Promise.resolve();
  private queuedPass: Promise<void> | null = null;

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
    if ('defaultAgentCapUsd' in patch) next.defaultAgentCapUsd = parseCap(patch.defaultAgentCapUsd, 'defaultAgentCapUsd');
    if ('totalCapUsd' in patch) next.totalCapUsd = parseCap(patch.totalCapUsd, 'totalCapUsd');
    if (patch.agents !== undefined) {
      if (!patch.agents || typeof patch.agents !== 'object') throw new SpendCapError(400, 'agents must be an object: { "<session>": 5 | null | "default" }');
      for (const [session, value] of Object.entries(patch.agents)) {
        if (!session.trim()) throw new SpendCapError(400, 'agents keys must be agent session names');
        if (value === 'default') delete next.agentCapsUsd[session];
        else next.agentCapsUsd[session] = parseCap(value, `agents.${session}`);
      }
    }
    next.updatedAt = this.now().toISOString();
    this.file.config = next;
    this.persist();
    this.logger?.info('Spend caps changed', { caps: next });
    await this.evaluate();
    return this.getConfig();
  }

  /**
   * Lift a cap for today only.
   *
   * @param target - Agent session, or `*` for the all-agents total
   * @param usd - New cap for today (must be above today's spend)
   * @returns The new cap for today
   * @throws SpendCapError when the amount is not above today's spend
   */
  async raiseToday(target: string, usd: unknown): Promise<number> {
    const cap = parseCap(usd, 'capUsd');
    if (cap === null) throw new SpendCapError(400, 'capUsd must be a positive amount in USD');
    this.rollDay();
    const spent = target === C.TOTAL_TARGET ? this.deps.ledger.totalToday() : this.deps.ledger.spentToday(target);
    if (cap <= spent) {
      throw new SpendCapError(400, `${formatUsd(cap)} is not above what ${this.nameOf(target)} already spent today (${formatUsd(spent)}); pick a higher amount`);
    }
    this.file.day.raised[target] = cap;
    this.persist();
    this.logger?.info('Spend cap raised for today', { target, capUsd: cap, spentUsd: cents(spent) });
    await this.evaluate();
    return cap;
  }

  // ---------------------------------------------------------------- gate

  /**
   * The stop in force for a session (the delivery / wake gate). Synchronous
   * and live: it reads today's spend now, not at the last tick.
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
   * Cap in force today for a target, and where it comes from.
   *
   * @param target - Agent session, or `*`
   * @returns Cap (null = none) and source
   */
  capOf(target: string): { capUsd: number | null; source: SpendCapAgentView['capSource'] } {
    const raised = this.file.day.raised[target];
    if (isCap(raised)) return { capUsd: raised, source: 'raised' };
    const cfg = this.file.config;
    if (target === C.TOTAL_TARGET) return isCap(cfg.totalCapUsd) ? { capUsd: cfg.totalCapUsd, source: 'default' } : { capUsd: null, source: 'none' };
    if (Object.prototype.hasOwnProperty.call(cfg.agentCapsUsd, target)) {
      const v = cfg.agentCapsUsd[target];
      return isCap(v) ? { capUsd: v, source: 'override' } : { capUsd: null, source: 'exempt' };
    }
    return isCap(cfg.defaultAgentCapUsd) ? { capUsd: cfg.defaultAgentCapUsd, source: 'default' } : { capUsd: null, source: 'none' };
  }

  // ---------------------------------------------------------------- view

  /**
   * Spend plus caps for the API / Settings panel.
   *
   * @param days - Window
   * @returns View
   */
  async view(days: number = C.DEFAULT_DAYS): Promise<SpendView> {
    this.rollDay();
    const summary = this.deps.ledger.summarize(days);
    const known = (await this.deps.knownSessions?.().catch(() => [] as string[])) ?? [];
    const rows = new Map(summary.agents.map((a) => [a.session, a]));
    for (const s of known) {
      if (!rows.has(s)) rows.set(s, { session: s, runtimes: [], todayUsd: 0, windowUsd: 0, daily: summary.days.map(() => 0) });
    }
    const agents: SpendCapAgentView[] = [...rows.values()].map((a) => {
      const cap = this.capOf(a.session);
      const stop = this.computeStop(a.session);
      return {
        ...a,
        name: this.nameOf(a.session),
        capUsd: cap.capUsd,
        capSource: cap.source,
        stopped: !!stop,
        ...(stop ? { stopReason: spendCapReason(stop, this.nameOf(a.session)) } : {}),
      };
    });
    const total = this.capOf(C.TOTAL_TARGET).capUsd;
    return {
      ...summary,
      agents,
      caps: this.getConfig(),
      raisedToday: { ...this.file.day.raised },
      totalCapTodayUsd: total,
      suggestedAgentCapUsd: summary.p90AgentDayUsd > 0 ? Math.max(1, Math.ceil(summary.p90AgentDayUsd)) : null,
      totalStopped: total !== null && this.deps.ledger.totalToday() >= total,
    };
  }

  // ---------------------------------------------------------------- enforcement

  /**
   * One enforcement pass: day roll, 80% notices, stop announcements (one
   * card per stop), and releasing agents whose stop lifted. Passes run
   * one at a time; a call during a pass gets another pass after it.
   */
  evaluate(): Promise<void> {
    // Coalesce: a pass not yet started is shared; a call during a running
    // pass gets a fresh pass after it (so it sees the latest change).
    if (this.queuedPass) return this.queuedPass;
    const pass = this.chain.then(async () => {
      this.queuedPass = null;
      try {
        await this.evaluateOnce();
      } catch (err) {
        this.logger?.warn('Spend cap evaluation failed', { error: err instanceof Error ? err.message : String(err) });
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
    const name = this.nameOf(target);
    if (d.status !== 'resolved') return null;
    const label = d.options.find((o) => o.key === d.chosenKey)?.label;
    const amount = raiseAmountOf(label);
    if (amount === null) {
      await this.reply(d.id, `OK, ${name} stays stopped until midnight. Its messages stay queued.`);
      return null;
    }
    try {
      const cap = await this.raiseToday(target, amount);
      await this.reply(d.id, `Raised ${name}'s cap to ${formatUsd(cap)} for today. Queued messages are being delivered.`);
    } catch (err) {
      await this.reply(d.id, `Could not raise the cap: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  // ---------------------------------------------------------------- internals

  private async evaluateOnce(): Promise<void> {
    this.rollDay();
    if (!this.anyCap() && this.lastStopped.size === 0) return;
    this.deps.ledger.invalidate();
    const summary = this.deps.ledger.summarize(1);
    const known = (await this.deps.knownSessions?.().catch(() => [] as string[])) ?? [];
    const sessions = new Set<string>([...known, ...summary.agents.map((a) => a.session), ...Object.keys(this.file.day.raised).filter((t) => t !== C.TOTAL_TARGET)]);
    if (this.lastStopped.size > 0) for (const s of this.lastStopped) sessions.add(s);

    const stoppedNow = new Set<string>();
    // The all-agents total first: its notice names the whole crew once.
    const total = this.capOf(C.TOTAL_TARGET).capUsd;
    if (total !== null) {
      const spent = this.deps.ledger.totalToday();
      await this.checkThresholds(C.TOTAL_TARGET, total, spent);
    }
    for (const session of sessions) {
      const cap = this.capOf(session).capUsd;
      if (cap !== null) await this.checkThresholds(session, cap, this.deps.ledger.spentToday(session));
      if (this.computeStop(session)) stoppedNow.add(session);
    }

    const released = [...this.lastStopped].filter((s) => !stoppedNow.has(s));
    this.lastStopped = stoppedNow;
    if (released.length > 0) {
      this.logger?.info('Spend cap stop lifted — releasing queued messages', { sessions: released });
      await this.deps.onReleased?.(released).catch((err) =>
        this.logger?.warn('Releasing queued messages failed', { sessions: released, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  private async checkThresholds(target: string, cap: number, spent: number): Promise<void> {
    const key = `${target}@${cap}`;
    const day = this.file.day;
    const name = this.nameOf(target);
    if (spent >= cap) {
      if (day.stopped.includes(key)) return;
      day.stopped.push(key);
      if (!day.warned.includes(key)) day.warned.push(key);
      this.persist();
      this.logger?.warn('Daily spend cap reached — hard stop (no new turns until midnight)', { target, capUsd: cap, spentUsd: cents(spent) });
      await this.announceStop(target, name, cap, spent);
      return;
    }
    if (spent >= cap * C.WARN_FRACTION && !day.warned.includes(key)) {
      day.warned.push(key);
      this.persist();
      const pct = Math.floor((spent / cap) * 100);
      const who = target === C.TOTAL_TARGET ? 'All agents together have' : `${name} has`;
      const its = target === C.TOTAL_TARGET ? 'the' : 'its';
      const stops = target === C.TOTAL_TARGET ? 'every agent stops' : 'it stops';
      await this.notify(
        `Heads-up: ${who} spent ${formatUsd(spent)} of ${its} ${formatUsd(cap)} daily spend cap today (${pct}%). At ${formatUsd(cap)} ${stops} taking new turns until midnight.`,
      );
    }
  }

  private async announceStop(target: string, name: string, cap: number, spent: number): Promise<void> {
    const raise = suggestedRaise(cap, spent);
    const who = target === C.TOTAL_TARGET ? 'total' : target === ORCHESTRATOR_SESSION_NAME ? 'orc' : name;
    const headline =
      target === C.TOTAL_TARGET
        ? `All agents together hit the daily total spend cap (${formatUsd(cap)}); every agent is stopped until midnight.`
        : `${name} hit its daily spend cap (${formatUsd(cap)}) and is stopped until midnight.`;
    const decisions = this.deps.decisions?.() ?? null;
    if (decisions) {
      try {
        const d = await decisions.askSystem({
          kind: C.DECISION_KIND,
          system: { key: target, defaultIsDecline: true },
          title: 'Daily spend cap reached',
          question: `${headline} Raise it for today?`,
          body: [
            `Spent today: ${formatUsd(spent)}. The current turn was allowed to finish; no new turns start. Messages are kept and delivered when it runs again.`,
          ],
          options: [`Raise to $${raise} today — runs again until midnight`, `${C.OPTIONS.KEEP} — resets at midnight`],
          default: C.OPTIONS.KEEP,
          deadline: this.nextMidnight(),
          sensitive: 'spend',
        });
        this.file.day.cards[target] = d.id;
        this.persist();
        return;
      } catch (err) {
        this.logger?.warn('Could not post the spend cap card — sending a notice instead', { target, error: err instanceof Error ? err.message : String(err) });
      }
    }
    await this.notify(`${headline} Its messages are queued. Reply \`raise cap for ${who} to $${raise} today\` to raise it.`);
  }

  private anyCap(): boolean {
    const cfg = this.file.config;
    return (
      isCap(cfg.defaultAgentCapUsd) ||
      isCap(cfg.totalCapUsd) ||
      Object.values(cfg.agentCapsUsd).some(isCap) ||
      Object.values(this.file.day.raised).some(isCap)
    );
  }

  private computeStop(session: string): SpendStop | null {
    const own = this.capOf(session).capUsd;
    if (own !== null) {
      const spent = this.deps.ledger.spentToday(session);
      if (spent >= own) return { session, scope: 'agent', capUsd: own, spentUsd: spent };
    }
    const total = this.capOf(C.TOTAL_TARGET).capUsd;
    if (total !== null) {
      const spent = this.deps.ledger.totalToday();
      if (spent >= total) return { session, scope: 'total', capUsd: total, spentUsd: spent };
    }
    return null;
  }

  private stopKey(stop: SpendStop): string {
    return `${stop.scope === 'total' ? C.TOTAL_TARGET : stop.session}@${stop.capUsd}`;
  }

  private scheduleEvaluate(): void {
    void this.evaluate();
  }

  /** Reset today's bookkeeping when the local day changed. */
  private rollDay(): void {
    const today = localDateKey(this.now());
    if (this.file.day.date === today) return;
    const had = Object.keys(this.file.day.raised).length + this.file.day.stopped.length;
    this.file.day = emptyDay(today);
    this.deps.ledger.invalidate();
    this.persist();
    if (had > 0) this.logger?.info('Spend caps reset for the new day', { date: today });
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
      this.logger?.warn('Could not send the spend cap notice', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async reply(decisionId: string, text: string): Promise<void> {
    await this.deps.decisions?.()?.replyInThread(decisionId, text).catch(() => undefined);
  }

  private persist(): void {
    try {
      this.deps.store.write(this.file);
    } catch (err) {
      this.logger?.warn('Could not save spend caps', { error: err instanceof Error ? err.message : String(err) });
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
