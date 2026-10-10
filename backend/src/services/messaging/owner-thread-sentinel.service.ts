/**
 * Owner-thread sentinel: an owner Slack thread is never left silent.
 *
 * The failure it closes (2026-10-08, Atlas in #pro-think-tank): an agent says
 * in the owner's thread "I'm reading the attachments, ~15 min", then gets
 * stuck — a browser approval card goes top-level in the channel, Crewly
 * restarts, the card expires, the agent is stopped to free a slot — and the
 * thread says nothing until the owner asks "why no reply?".
 *
 * A thread is watched while the owner's last message there is unanswered, the
 * agent's last post there is a promise ("I'm doing…", "~N min", 「马上」), the
 * agent has owner work from that thread, or a card the agent waits on is open.
 * On any blocking event for that agent — card posted / expired, work blocked,
 * agent stopped, start failed or deferred, delivery held, Crewly restarted —
 * ONE short status line goes into the thread. A promise of "~N min" that
 * passes N×1.5 with no post gets one line saying what the agent is doing now,
 * and the agent is nudged once.
 *
 * Dedupe: one line per state change per thread; the same state is never
 * repeated within REPEAT_STATE_MS; informational lines are at least
 * MIN_INFO_GAP_MS apart. Any post by the agent in the thread resets it.
 *
 * Transport-free: posting, nudging and lookups are injected (see the wiring).
 *
 * @module services/messaging/owner-thread-sentinel.service
 * @see specs/2026-10-08-owner-thread-sentinel.md
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import * as path from 'path';
import { ORCHESTRATOR_SESSION_NAME, OWNER_THREAD_SENTINEL_CONSTANTS as C } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { reportAgentPostForFollowThrough } from '../agent/follow-through.service.js';

/** A Slack place: a thread, or a DM / channel top level. */
export interface SlackThreadRef {
  slackChannelId: string;
  threadTs?: string;
}

/** What happened to an agent that may leave an owner thread waiting. */
export type SentinelEvent =
  /** A decision / approval card the agent waits on was posted (`place`: where it went) */
  | { kind: 'card_posted'; decisionId: string; question: string; link?: string; place?: SlackThreadRef; browser?: boolean }
  /** The card expired before the owner answered (`browser`: a held browser action) */
  | { kind: 'card_expired'; decisionId: string; question: string; link?: string; browser?: boolean; why?: string }
  /** No answer even after a re-ask: the card is parked */
  | { kind: 'card_parked'; decisionId: string; question: string; link?: string }
  /** Answered / withdrawn: the agent no longer waits on it (no line) */
  | { kind: 'card_settled'; decisionId: string }
  /** The agent blocked its work item (`thread`: the item's owner thread, when known) */
  | { kind: 'work_blocked'; reason?: string; thread?: SlackThreadRef }
  /** The agent was stopped by the harness */
  | { kind: 'stopped'; why: 'slot' | 'idle' | 'pressure' }
  /** The agent could not be started */
  | { kind: 'start_failed'; detail?: string }
  /** The start waits behind the running-agent cap */
  | { kind: 'start_deferred' }
  /** Messages to the agent are held (input box unreadable / foreign text / looks busy for long) */
  | { kind: 'delivery_held'; why: 'unreadable' | 'foreign' | 'busy' | 'blocked' };

/** One watched thread. */
export interface OwnerThreadEntry {
  key: string;
  slackChannelId: string;
  threadTs?: string;
  /** The agent the thread waits on (last one made responsible or that posted) */
  agent: string;
  /** Owner's latest message here (epoch ms) */
  ownerAt?: number;
  /** Agent's latest post here */
  agentPostAt?: number;
  /** Clipped text of that post */
  agentPreview?: string;
  /** The agent's latest post was a promise */
  promise?: { at: number; minutes?: number; deadlineAt?: number; firedAt?: number };
  /** The agent has owner work from this thread */
  workOrigin?: boolean;
  /** Open cards the agent waits on (decision ids) */
  cards: Array<{ id: string; at: number }>;
  /** A browser approval expired: the agent is nudged once if it does not ask again */
  reask?: { decisionId: string; dueAt: number; done?: boolean };
  /** When a card the agent waited on last closed (the promise clock gets a grace after it) */
  cardClosedAt?: number;
  /** Last status line posted */
  lastStatus?: { state: string; at: number };
  /** state → when it was last posted (flapping guard) */
  recentStates: Record<string, number>;
  /** Loaded after a restart while active: one line on the first tick */
  restartPending?: boolean;
  updatedAt: number;
}

/** Injected behaviour. */
export interface OwnerThreadSentinelDeps {
  /** Post every status line, not only the owner-facing ones (tests / diagnostics). Default false. */
  postAllStates?: boolean;
  /** Post a status line in the thread. False when it could not be posted. */
  postStatus: (thread: SlackThreadRef, agent: string, text: string) => Promise<boolean>;
  /** Deliver a reminder to the agent (waking it when stopped). False when it could not. */
  nudgeAgent: (agent: string, text: string) => Promise<boolean>;
  /** Display name ("Atlas"); defaults to the session name */
  displayNameOf?: (agent: string) => string;
  /** The owner thread of the agent's open work item, if its work came from one */
  ownerWorkThread?: (agent: string) => Promise<SlackThreadRef | null>;
  /** What the agent is doing now, in a few words ("working on “X”"), if known */
  currentActivity?: (agent: string) => Promise<string | null>;
  /** Persisted state; omitted in tests that do not exercise restarts */
  storePath?: string;
  now?: () => number;
}

/** A detected promise in an agent's post. */
export interface DetectedPromise {
  /** Minutes promised ("~15 min" → 15), when stated */
  minutes?: number;
}

const EN_PROMISE: readonly RegExp[] = [
  /\b(?:i'?m|i am|we'?re|we are)\s+(?:now\s+|currently\s+|still\s+|just\s+)?(?:[a-z]+ing\b|on it|going to|about to)/i,
  /\b(?:i'?ll|i will|we'?ll|we will|let me|i'?m going to|will (?:report|update|follow up|get back|post|send|share|let you know|ping))\b/i,
  /\b(?:on it|eta|shortly|be right back|brb|in a (?:few|bit|moment|minute|sec(?:ond)?))\b/i,
  /\bwaiting (?:for|on)\b/i,
];
const ZH_PROMISE = /(正在|在做|在查|在看|在读|在写|马上|稍等|等(?:我|一下|下|会|你)|预计|一会|待会|稍后|这就|我来|我去|我先|做完|弄好|搞定后|完成后|回头)/;
const DURATION =
  /(?:~|～|约|大约|大概|about|around|approx\.?|roughly|in|within|需要|要)?\s*(\d+(?:\.\d+)?)\s*(?:[-–~～到至]\s*(\d+(?:\.\d+)?)\s*)?(minutes?|mins?|m\b|分钟|分|hours?|hrs?|h\b|小时)/i;
const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * A Chinese numeral up to 99 ("十五" → 15, "二十" → 20, "五" → 5).
 *
 * @param s - Numeral
 * @returns The number, or undefined
 */
function cnNumber(s: string): number | undefined {
  if (!s) return undefined;
  if (s === '十') return 10;
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (!m) return undefined;
  if (!m[2]) return m[1] ? CN_DIGITS[m[1]] : undefined;
  return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[3] ? CN_DIGITS[m[3]] : 0);
}

/**
 * Minutes stated in a text ("~15 min", "10-20 minutes" → 20, "1.5h" → 90,
 * 「半小时」 → 30, 「十五分钟」 → 15, 「几分钟」 → 5).
 *
 * @param text - The post
 * @returns Minutes, or undefined when none is stated
 */
export function parsePromisedMinutes(text: string): number | undefined {
  const t = text ?? '';
  if (/半(?:个)?小时/.test(t)) return 30;
  if (/几分钟/.test(t)) return 5;
  const cn = /([一二两三四五六七八九十]{1,3})\s*(?:个)?(分钟|小时)/.exec(t);
  if (cn) {
    const n = cnNumber(cn[1]);
    if (n !== undefined) return cn[2] === '小时' ? n * 60 : n;
  }
  const m = DURATION.exec(t);
  if (!m) return undefined;
  const n = Number(m[2] ?? m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[3].toLowerCase();
  const minutes = /^(h|hours?|hrs?|小时)$/.test(unit) ? n * 60 : n;
  return Math.round(minutes);
}

/**
 * Whether an agent's post is a promise / in-progress statement, and the
 * minutes it states. A post that only reports what was done is not one.
 *
 * @param text - The agent's post
 * @returns The promise, or null
 *
 * @example
 * ```typescript
 * detectPromise("I'm reading the attachments now, ~15 min"); // { minutes: 15 }
 * detectPromise('Done — the report is attached.');           // null
 * ```
 */
export function detectPromise(text: string): DetectedPromise | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const minutes = parsePromisedMinutes(t);
  const explicitEta = /(?:~|～|约|大约|预计|\beta\b)\s*\d/i.test(t) || /\b(?:in|within)\s+\d+\s*(?:min|minutes?|h|hours?)\b/i.test(t);
  const said = explicitEta || EN_PROMISE.some((re) => re.test(t)) || ZH_PROMISE.test(t);
  if (!said) return null;
  return minutes !== undefined && minutes <= C.MAX_PROMISE_MINUTES ? { minutes } : {};
}

/**
 * Key of a thread.
 *
 * @param ref - The place
 * @returns `<channel>:<threadTs or ''>`
 */
export function threadKey(ref: SlackThreadRef): string {
  return `${ref.slackChannelId}:${ref.threadTs ?? ''}`;
}

/**
 * A Slack DM (its top level is the conversation).
 *
 * @param slackChannelId - Channel id
 * @returns True for a DM id
 */
function isDm(slackChannelId: string): boolean {
  return slackChannelId.startsWith('D');
}

/**
 * Clip text to one line.
 *
 * @param text - Text
 * @param max - Limit
 * @returns Clipped text
 */
function clip(text: string | undefined, max: number = C.QUOTE_CHARS): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The status line for an event, in plain English (harness text).
 *
 * @param event - What happened
 * @param name - Agent display name
 * @returns The line, or null when the event posts nothing
 */
export function statusLineFor(event: SentinelEvent, name: string): string | null {
  const link = (url: string | undefined, label: string): string => (url ? ` — <${url}|${label}>` : '');
  switch (event.kind) {
    case 'card_posted':
      return `⏳ ${name} is waiting for your OK: ${clip(event.question)}${link(event.link, 'Approve here')}`;
    case 'card_expired':
      return event.browser
        ? `⚠️ ${name}'s approval request expired before you answered${event.why ? ` (${event.why})` : ''}. ${name} is asking again — the new card will show up here.`
        : `⚠️ ${name}'s question expired before you answered: ${clip(event.question)}${link(event.link, 'see the card')}. Reply here if it is still needed.`;
    case 'card_parked':
      return `⏸ ${name} is still waiting for your OK and has parked this until you answer: ${clip(event.question)}${link(event.link, 'Answer here')}`;
    case 'card_settled':
      return null;
    case 'work_blocked':
      return `⏸ ${name} is blocked${event.reason ? `: ${clip(event.reason)}` : '.'} Your request is kept.`;
    case 'stopped':
      if (event.why === 'slot') return `⏸ ${name} was paused to free a slot for another agent; it resumes automatically when one frees (your request is kept).`;
      return `⏸ ${name} was stopped to save memory while it looked idle; your request is kept and ${name} is woken when you reply here or its work moves.`;
    case 'start_failed':
      return `⚠️ ${name} could not start${event.detail ? `: ${clip(event.detail)}` : '.'} Your request is kept — reply here to try again.`;
    case 'start_deferred':
      return `⏳ ${name} is queued to start: this machine is at its running-agent limit. It starts when a slot frees (your request is kept).`;
    case 'delivery_held': {
      const why =
        event.why === 'unreadable'
          ? "Crewly can't read its input box and is recovering it"
          : event.why === 'foreign'
            ? 'its input box has text Crewly did not type — check its terminal'
            : event.why === 'busy'
              ? 'it has looked busy for a long time and may be stuck'
              : 'its input is blocked';
      return `⚠️ Messages to ${name} are on hold: ${why}. Your request is kept.`;
    }
  }
}

/** State id of an event, for dedupe. */
function stateOf(event: SentinelEvent): string {
  switch (event.kind) {
    case 'card_posted':
    case 'card_expired':
    case 'card_parked':
    case 'card_settled':
      return `${event.kind}:${event.decisionId}`;
    case 'stopped':
      return `stopped:${event.why}`;
    case 'delivery_held':
      return `held:${event.why}`;
    default:
      return event.kind;
  }
}

/** Events the owner must act on: never held back by the info gap. */
function isActionable(event: SentinelEvent): boolean {
  return event.kind === 'card_posted' || event.kind === 'card_expired' || event.kind === 'card_parked' || event.kind === 'start_failed';
}

/**
 * Watches owner threads and posts one status line per blocking event.
 */
export class OwnerThreadSentinelService {
  private readonly logger: ComponentLogger;
  private readonly entries = new Map<string, OwnerThreadEntry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  /**
   * @param deps - Injected behaviour
   */
  constructor(private readonly deps: OwnerThreadSentinelDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('OwnerThreadSentinel');
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private nameOf(agent: string): string {
    return this.deps.displayNameOf?.(agent) ?? agent;
  }

  /** Start the periodic evaluation. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), C.TICK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the periodic evaluation. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** @returns Watched threads (debug, tests) */
  list(): OwnerThreadEntry[] {
    return [...this.entries.values()].map((e) => ({ ...e, cards: [...e.cards], recentStates: { ...e.recentStates } }));
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * The owner wrote in a Slack thread / DM and `agent` must answer.
   *
   * @param input - Where, who must answer, when
   */
  noteOwnerMessage(input: SlackThreadRef & { agent: string; at?: number }): void {
    if (!input.slackChannelId || !input.agent) return;
    const at = input.at ?? this.now();
    const entry = this.ensure({ slackChannelId: input.slackChannelId, threadTs: input.threadTs }, input.agent);
    entry.agent = input.agent;
    entry.ownerAt = Math.max(entry.ownerAt ?? 0, at);
    entry.updatedAt = this.now();
    this.persist();
  }

  /**
   * An agent posted in Slack. In a watched thread the post resets the
   * status state, and a promise ("~15 min") is remembered and timed.
   *
   * @param input - Who, where, what
   */
  noteAgentPost(input: SlackThreadRef & { agent: string; text: string; interim?: boolean; at?: number }): void {
    const entry = this.find(input);
    if (!entry) return;
    // The orchestrator routing or relaying in a thread an agent owns ("Atlas
    // is on it") neither takes the thread over nor settles the agent's promise.
    if (input.agent === ORCHESTRATOR_SESSION_NAME && entry.agent !== ORCHESTRATOR_SESSION_NAME) return;
    const at = input.at ?? this.now();
    entry.agent = input.agent;
    entry.agentPostAt = at;
    entry.agentPreview = clip(input.text, 120);
    entry.lastStatus = undefined;
    entry.recentStates = {};
    entry.restartPending = false;
    const promise = detectPromise(input.text) ?? (input.interim ? {} : null);
    if (promise) {
      const minutes = promise.minutes;
      entry.promise = {
        at,
        ...(minutes !== undefined ? { minutes, deadlineAt: at + Math.max(C.MIN_DEADLINE_MS, minutes * C.DEADLINE_FACTOR * 60_000) } : {}),
      };
    } else {
      entry.promise = undefined;
      entry.workOrigin = false;
    }
    entry.updatedAt = at;
    this.persist();
  }

  /**
   * Something blocked `agent`: post one status line in each owner thread
   * waiting on it (deduped).
   *
   * @param agent - The agent
   * @param event - What happened
   * @returns How many lines were posted
   */
  async noteBlocking(agent: string, event: SentinelEvent): Promise<number> {
    if (!agent) return 0;
    if (event.kind === 'card_settled') {
      let changed = false;
      for (const e of this.entries.values()) {
        if (e.agent !== agent) continue;
        const before = e.cards.length;
        e.cards = e.cards.filter((c) => c.id !== event.decisionId);
        if (e.reask?.decisionId === event.decisionId) e.reask = undefined;
        if (e.cards.length !== before) {
          changed = true;
          e.cardClosedAt = this.now();
        }
      }
      if (changed) this.persist();
      return 0;
    }
    const targets = await this.targetsFor(agent, event);
    if (targets.length === 0) return 0;
    const now = this.now();
    let posted = 0;
    for (const entry of targets) {
      if (event.kind === 'card_posted') {
        if (!entry.cards.some((c) => c.id === event.decisionId)) entry.cards.push({ id: event.decisionId, at: now });
        // The agent asked again: no re-ask nudge.
        if (entry.reask && !entry.reask.done) entry.reask = undefined;
        // The card is in this very thread: the card is the status.
        if (event.place && threadKey(event.place) === entry.key) {
          entry.lastStatus = { state: stateOf(event), at: now };
          entry.recentStates[stateOf(event)] = now;
          entry.updatedAt = now;
          continue;
        }
      }
      if (event.kind === 'card_expired' || event.kind === 'card_parked') {
        entry.cards = entry.cards.filter((c) => c.id !== event.decisionId);
        entry.cardClosedAt = now;
        if (event.kind === 'card_expired' && event.browser) {
          entry.reask = { decisionId: event.decisionId, dueAt: now + C.REASK_GRACE_MS };
        }
      }
      // A card already tells the owner why the agent waits; its answer wakes it.
      if ((event.kind === 'work_blocked' || event.kind === 'stopped') && entry.cards.length > 0) continue;
      const text = statusLineFor(event, this.nameOf(agent));
      if (text && (await this.emit(entry, stateOf(event), text, isActionable(event)))) posted++;
      entry.updatedAt = now;
    }
    this.persist();
    return posted;
  }

  /**
   * Whether the agent has an unanswered owner message or an open promise in
   * an owner thread within RECENT_PROMISE_MS — slot freeing and idle stops
   * spare it when another candidate exists.
   *
   * @param agent - The agent
   * @returns True when it owes an owner thread right now
   */
  owesRecently(agent: string): boolean {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.agent !== agent) continue;
      if (e.ownerAt && (!e.agentPostAt || e.ownerAt > e.agentPostAt) && now - e.ownerAt <= C.RECENT_PROMISE_MS) return true;
      if (e.promise && now - e.promise.at <= C.RECENT_PROMISE_MS) return true;
    }
    return false;
  }

  /**
   * Whether `agent` owes the owner an answer (unanswered for under
   * CARD_THREAD_MAX_AGE_MS) or a promised result (within ACTIVE_WINDOW_MS) in a
   * watched thread — hours, not the 30 minutes of {@link owesRecently}. An open card is not counted: then the owner owes
   * the agent. Idle stops spare such an agent unless memory is in pressure.
   *
   * @param agent - The agent
   * @returns True while it owes an owner thread
   */
  owesOwner(agent: string): boolean {
    const now = this.now();
    for (const e of this.entries.values()) {
      if (e.agent !== agent) continue;
      if (e.ownerAt && (!e.agentPostAt || e.ownerAt > e.agentPostAt) && now - e.ownerAt <= C.CARD_THREAD_MAX_AGE_MS) return true;
      if (e.promise && now - e.promise.at <= C.ACTIVE_WINDOW_MS) return true;
    }
    return false;
  }

  /**
   * The owner thread `agent` owes right now (the newest one active within
   * CARD_THREAD_MAX_AGE_MS), for placing a card it asks.
   *
   * @param agent - The agent
   * @returns The thread, or null
   */
  ownerThreadFor(agent: string): SlackThreadRef | null {
    const now = this.now();
    const mine = [...this.entries.values()]
      .filter((e) => e.agent === agent && owes(e, now) && now - e.updatedAt <= C.CARD_THREAD_MAX_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const e = mine[0];
    return e ? { slackChannelId: e.slackChannelId, ...(e.threadTs ? { threadTs: e.threadTs } : {}) } : null;
  }

  /**
   * Agents an owner thread waits on: a promised follow-up, an unanswered
   * owner message, or an open card (boot restore treats them as work in hand).
   *
   * @returns Session names
   */
  owingAgents(): string[] {
    const now = this.now();
    return [...new Set([...this.entries.values()].filter((e) => owes(e, now)).map((e) => e.agent))];
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  /**
   * One pass: restart lines, overdue promises, browser re-asks, pruning.
   *
   * @returns How many lines / nudges went out
   */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let acted = 0;
    try {
      const now = this.now();
      for (const entry of [...this.entries.values()]) {
        if (now - entry.updatedAt > C.FORGET_AFTER_MS && entry.cards.length === 0) {
          this.entries.delete(entry.key);
          continue;
        }
        if (entry.restartPending) {
          entry.restartPending = false;
          const name = this.nameOf(entry.agent);
          if (await this.emit(entry, 'restarted', `🔄 Crewly restarted while ${name} was on this. Your request is kept; ${name} picks it up when it is back — reply here if you need it sooner.`, false)) acted++;
        }
        acted += await this.checkDeadline(entry, now);
        acted += await this.checkReask(entry, now);
      }
      this.persist();
    } catch (err) {
      this.logger.warn('Owner thread sentinel tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.ticking = false;
    }
    return acted;
  }

  /** A promise of "~N min" past N×1.5 with no post: say what the agent is doing, nudge it once. */
  private async checkDeadline(entry: OwnerThreadEntry, now: number): Promise<number> {
    const p = entry.promise;
    if (!p?.deadlineAt || p.firedAt || now < p.deadlineAt) return 0;
    if (entry.agentPostAt !== undefined && entry.agentPostAt > p.at) return 0;
    // Waiting on the owner (a card is open), or a card just closed / a re-ask
    // is in flight: the owner already has a line about it; the clock waits.
    if (entry.cards.length > 0) return 0;
    if (entry.cardClosedAt !== undefined && now - entry.cardClosedAt < C.REPEAT_STATE_MS) return 0;
    p.firedAt = now;
    const name = this.nameOf(entry.agent);
    const ago = Math.max(1, Math.round((now - p.at) / 60_000));
    const activity = await this.deps.currentActivity?.(entry.agent).catch(() => null);
    const line =
      `⏱ ${name} said ~${p.minutes} min, ${ago} min ago, and hasn't posted since. ` +
      `Right now: ${activity ? clip(activity) : `no update from ${name}`}. I've asked ${name} for an update here.`;
    let acted = 0;
    if (await this.emit(entry, `deadline:${p.at}`, line, true)) acted++;
    const ref = entry.threadTs ? `${entry.slackChannelId}:${entry.threadTs}` : entry.slackChannelId;
    const nudge =
      `[OWNER THREAD ${ref}] You told the owner "~${p.minutes} min" ${ago} min ago in this Slack thread and have not posted there since. ` +
      `Post a short update there now: reply --thread ${ref} "<what is done, what is left, when>". If you are blocked, say on what.`;
    if (await this.deps.nudgeAgent(entry.agent, nudge).catch(() => false)) acted++;
    this.logger.info('Owner thread promise overdue — status posted, agent nudged', { key: entry.key, agent: entry.agent, minutes: p.minutes });
    return acted;
  }

  /** A browser approval expired and the agent did not ask again: nudge it once. */
  private async checkReask(entry: OwnerThreadEntry, now: number): Promise<number> {
    const r = entry.reask;
    if (!r || r.done || now < r.dueAt) return 0;
    r.done = true;
    if (!owes(entry, now) && !entry.workOrigin) return 0;
    const ref = entry.threadTs ? `${entry.slackChannelId}:${entry.threadTs}` : entry.slackChannelId;
    const text =
      `[OWNER THREAD ${ref}] Your browser approval card ${r.decisionId} expired before the owner answered, and the owner is still waiting in this thread. ` +
      'Redo the step now (look at the page again, then retry the action) so a new card is posted — or say in the thread why it is no longer needed.';
    const ok = await this.deps.nudgeAgent(entry.agent, text).catch(() => false);
    this.logger.info('Expired browser approval — agent asked to re-ask once', { key: entry.key, agent: entry.agent, decisionId: r.decisionId, delivered: ok });
    return ok ? 1 : 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Threads that get a line for this event. */
  private async targetsFor(agent: string, event: SentinelEvent): Promise<OwnerThreadEntry[]> {
    const now = this.now();
    if (event.kind === 'work_blocked' && event.thread) {
      const e = this.ensure(event.thread, agent);
      e.agent = agent;
      e.workOrigin = true;
      e.updatedAt = now;
      return [e];
    }
    const work = await this.deps.ownerWorkThread?.(agent).catch(() => null);
    if (work?.slackChannelId) {
      const e = this.ensure(work, agent);
      if (e.agent === agent || !owes(e, now)) {
        e.agent = agent;
        e.workOrigin = true;
        e.updatedAt = Math.max(e.updatedAt, now);
      }
    }
    return [...this.entries.values()]
      .filter((e) => e.agent === agent && (owes(e, now) || (e.workOrigin && now - e.updatedAt <= C.ACTIVE_WINDOW_MS)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, C.MAX_THREADS_PER_EVENT);
  }

  /** Post a line unless dedupe holds it back. */
  private async emit(entry: OwnerThreadEntry, state: string, text: string, actionable: boolean): Promise<boolean> {
    const now = this.now();
    // Owner rule (2026-10-08): the thread is a conversation, not a log. Only
    // a line the owner must act on (a held browser action waiting for their
    // OK) goes into it; stops, restarts, deferred starts, blocks and overdue
    // promises are handled silently (the agent is still nudged / restored) —
    // "seen / busy" is the typing placeholder's job.
    if (!this.deps.postAllStates && !state.startsWith('card_posted:')) {
      entry.lastStatus = { state, at: now };
      entry.recentStates[state] = now;
      this.logger.info('Owner thread state recorded (not posted: not owner-facing)', { key: entry.key, agent: entry.agent, state });
      return false;
    }
    if (entry.lastStatus?.state === state) return false;
    const last = entry.recentStates[state];
    if (last !== undefined && now - last < C.REPEAT_STATE_MS) return false;
    if (!actionable && entry.lastStatus && now - entry.lastStatus.at < C.MIN_INFO_GAP_MS) return false;
    let ok = false;
    try {
      ok = await this.deps.postStatus({ slackChannelId: entry.slackChannelId, ...(entry.threadTs ? { threadTs: entry.threadTs } : {}) }, entry.agent, text);
    } catch (err) {
      this.logger.warn('Could not post the owner thread status', { key: entry.key, state, error: err instanceof Error ? err.message : String(err) });
    }
    if (!ok) return false;
    entry.lastStatus = { state, at: now };
    entry.recentStates[state] = now;
    this.logger.info('Owner thread status posted', { key: entry.key, agent: entry.agent, state });
    return true;
  }

  /** The entry for a place, created when missing. */
  private ensure(ref: SlackThreadRef, agent: string): OwnerThreadEntry {
    const key = threadKey(ref);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        slackChannelId: ref.slackChannelId,
        ...(ref.threadTs ? { threadTs: ref.threadTs } : {}),
        agent,
        cards: [],
        recentStates: {},
        updatedAt: this.now(),
      };
      this.entries.set(key, entry);
      while (this.entries.size > C.MAX_THREADS) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return entry;
  }

  /** The watched entry a post belongs to (a DM's top-level post: that DM's newest entry). */
  private find(ref: SlackThreadRef & { agent: string }): OwnerThreadEntry | undefined {
    const exact = this.entries.get(threadKey(ref));
    if (exact) return exact;
    if (!ref.threadTs && isDm(ref.slackChannelId)) {
      return [...this.entries.values()]
        .filter((e) => e.slackChannelId === ref.slackChannelId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    }
    return undefined;
  }

  private persist(): void {
    const file = this.deps.storePath;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: [...this.entries.values()] }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      this.logger.warn('Could not save the owner thread sentinel state', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private load(): void {
    const now = this.now();
    for (const e of readEntries(this.deps.storePath)) {
      // Anything active when Crewly went down gets one restart line.
      e.restartPending = owes(e, now) && (!!e.promise || (!!e.ownerAt && (!e.agentPostAt || e.ownerAt > e.agentPostAt)));
      this.entries.set(e.key, e);
    }
    if (this.entries.size > 0) this.logger.info('Restored watched owner threads from before the restart', { count: this.entries.size });
  }
}

/**
 * Whether a thread waits on its agent: an open card, an unanswered owner
 * message, or a promise — within ACTIVE_WINDOW_MS.
 *
 * @param e - The entry
 * @param now - Clock
 * @returns True while it waits
 */
function owes(e: OwnerThreadEntry, now: number): boolean {
  if (e.cards.length > 0) return true;
  if (e.ownerAt && (!e.agentPostAt || e.ownerAt > e.agentPostAt) && now - e.ownerAt <= C.ACTIVE_WINDOW_MS) return true;
  if (e.promise && now - e.promise.at <= C.ACTIVE_WINDOW_MS) return true;
  return false;
}

/**
 * Read persisted entries (tolerates a missing or corrupt file).
 *
 * @param file - Store path
 * @returns Entries
 */
function readEntries(file: string | undefined): OwnerThreadEntry[] {
  if (!file || !existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { entries?: OwnerThreadEntry[] };
    return (raw.entries ?? []).filter((e) => e && typeof e.key === 'string' && typeof e.slackChannelId === 'string' && typeof e.agent === 'string').map((e) => ({
      ...e,
      cards: Array.isArray(e.cards) ? e.cards : [],
      recentStates: e.recentStates && typeof e.recentStates === 'object' ? e.recentStates : {},
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Agents an owner thread waits on, read straight from the persisted state —
 * for the boot restore, which can run before the sentinel is started.
 *
 * @param file - Store path
 * @param now - Clock
 * @returns Session names
 */
export function owingAgentsOnDisk(file: string, now: number = Date.now()): string[] {
  return [...new Set(readEntries(file).filter((e) => owes(e, now)).map((e) => e.agent))];
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: OwnerThreadSentinelService | null = null;

/** @returns The wired sentinel, or null before it started (and in tests). */
export function getOwnerThreadSentinel(): OwnerThreadSentinelService | null {
  return instance;
}

/** @param service - The sentinel to expose (null to clear) */
export function setOwnerThreadSentinel(service: OwnerThreadSentinelService | null): void {
  instance = service;
}

/**
 * Report a blocking event for an agent, if the sentinel runs. Never throws.
 *
 * @param agent - The agent
 * @param event - What happened
 */
export function reportOwnerThreadBlocking(agent: string, event: SentinelEvent): void {
  const s = instance;
  if (!s || !agent) return;
  void s.noteBlocking(agent, event).catch(() => undefined);
}

/**
 * Report an agent's Slack post, if the sentinel runs. Never throws.
 *
 * @param input - Who, where, what
 */
export function reportOwnerThreadAgentPost(input: SlackThreadRef & { agent: string; text: string; interim?: boolean }): void {
  // The follow-through guard sees every agent post, including those in threads
  // the sentinel does not watch (a decision card's thread, 2026-10-10).
  reportAgentPostForFollowThrough({ agent: input.agent, text: input.text, ...(input.interim ? { interim: true } : {}) });
  try {
    instance?.noteAgentPost(input);
  } catch {
    /* best-effort */
  }
}
