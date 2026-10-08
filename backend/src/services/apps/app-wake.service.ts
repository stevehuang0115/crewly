/**
 * AppWakeService — polls the change feed of every app this instance
 * published and wakes the agent that published it when the owner changes
 * something (specs/2026-10-04-crewly-apps-p2.md §5).
 *
 * - Every POLL_INTERVAL_MS, the apps that are due are polled with
 *   `GET changes?since=<cursor>&wait=0`, POLL_CONCURRENCY at a time, each
 *   request capped at POLL_REQUEST_TIMEOUT_MS. A failing app backs off on
 *   its own (×2 up to POLL_MAX_BACKOFF_MS); the others keep their cadence.
 * - Only owner changes wake (data written in the app, `notify` / `ask`,
 *   and comments: a new comment, a reply, a reopen — crewly#1056),
 *   plus anonymous submissions on a public app (`actor.kind === 'visitor'`,
 *   P3), which are labelled apart; every agent write — the agent's own
 *   included — is skipped.
 * - Visitor submissions never START an agent (P3 §3): a batch holding only
 *   visitor submissions waits, pending, until the publisher is running
 *   (checked every VISITOR_WAKE.PENDING_RECHECK_MS), then is delivered. An
 *   owner change joining the batch brings back P2's behaviour (start it).
 * - At most VISITOR_WAKE.MAX_PER_DAY visitor-triggered wakes per app per
 *   UTC day (persisted in the registry). Past it, visitor submissions are
 *   counted, not delivered; the next message delivered for the app states
 *   how many were skipped (on a new UTC day a short notice goes out even if
 *   nothing new arrived).
 * - The first change for (app, recipient) opens a BATCH_WINDOW_MS window; a
 *   successful wake starts a COOLDOWN_MS quiet period (persisted, so it
 *   survives a restart) during which changes keep collecting.
 * - A failed delivery keeps the batch (and the cursor before it) and is
 *   retried with backoff; after WAKE_FAILS_BEFORE_ORC_NOTICE failures the
 *   orchestrator is told once.
 * - Nothing may stall the loop (2026-10-05, 科技晨报: one poll pass never
 *   finished, the self-rescheduling loop stopped for good, and five owner
 *   comments sat in Cloud for hours with nothing logged). Each app's poll
 *   has a deadline (POLL_APP_DEADLINE_MS; a late result is discarded), a
 *   pass that still has not finished after POLL_PASS_STALL_MS is abandoned
 *   and a fresh one starts, and a delivery that has not settled after
 *   WAKE_DELIVER_TIMEOUT_MS counts as failed and is retried (a late success
 *   still settles the batch).
 * - A batch being delivered is detached: changes arriving meanwhile open the
 *   next batch instead of being marked delivered without being in the
 *   message.
 * - A watchdog on every scheduled pass re-arms a batch whose timer is gone
 *   and, once per batch, logs and tells the orchestrator about owner changes
 *   that have not reached their agent after WAKE_STUCK_NOTICE_MS.
 * - Owner changes are delivered as owner-authored (`owner: true`, crewly#1105
 *   queue priority): a busy agent gets them queued ahead of system traffic,
 *   not after it goes idle.
 * - Batches live in memory; the persisted cursor stays before the first
 *   change of every batch not yet delivered, so after a restart the same
 *   changes are read again and batched again.
 * - An `ask` reaches a named agent only when it is in the publisher's team
 *   and already running; it never starts a stopped agent.
 * - @mentions (crewly-services apps/SPEC.md §12.1): every pass also reads
 *   this instance's mention inbox (`GET /mentions`, any app of the account,
 *   wherever it was published; bounded by POLL_APP_DEADLINE_MS like an app
 *   poll) and wakes each mentioned agent that runs here (starting it like
 *   the publisher; the orchestrator for "@Orc"), with the same untrusted
 *   marking and anchor, through the same batches, delivery timeout, retries,
 *   watchdog and owner-priority tag. The publisher still gets the comment
 *   from the app feed, noting who was mentioned, unless it was mentioned
 *   itself (then the mention is the one message). A mention of an agent that
 *   is gone from this machine goes to the orchestrator. The roster Cloud
 *   offers the owner is pushed first (`AppRosterService`, only when changed).
 * - App owners (crewly-services apps/SPEC.md §15): a comment change Cloud
 *   routed to the app's explicit owner (`ownerRouted`) is skipped in the app
 *   feed; it arrives through the inbox instead (`reason: 'owner'`). An agent
 *   owner is woken like a mentioned agent ("you own its comments"). A team or
 *   channel owner's entry is posted into that room (`deliverRoom`, through the
 *   same batches, retries and cursor; no cooldown); members @mentioned in it
 *   are addressed there, and @mentioned agents of this machine outside the
 *   room are woken as mentions. A room that is not on this machine any more
 *   falls back to its lead (`roomFallback`), else the orchestrator.
 *
 * @module services/apps/app-wake.service
 */

import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppsRegistryService, AppRegistryEntry, VisitorWakeState } from './apps-registry.service.js';
import { buildAppWakeMessage, mentionsOf, safeAppName, type AppChange, type AppCommentThread } from './app-wake-message.js';
import type { CommentRoomRef } from './app-comments-slack.service.js';
import type { RoomDelivery } from './app-comment-room.service.js';
import type { VoiceFiles } from './app-comment-audio.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

const C = CREWLY_APPS_CONSTANTS;

/** The Apps API slice the poller needs. */
export interface AppWakeClient {
  isAvailable(): boolean;
  request<T>(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; timeoutMs?: number }): Promise<T>;
}

/** One entry of this instance's mention inbox (`GET /mentions`). */
export interface MentionItem {
  seq: number;
  appId: string;
  appName?: string | null;
  session: string;
  name?: string;
  op: 'add' | 'reply' | string;
  commentId: string;
  replyId?: string | null;
  at?: string;
  thread: AppCommentThread | null;
  /** `owner`: the app's owner (agent or room) gets it (SPEC §15); `collaborator`: the agent was added to the app (no thread); default a mention */
  reason?: 'mention' | 'owner' | 'collaborator' | string;
  /** Who added a collaborator: an agent session or `owner` */
  addedBy?: string;
  /** Team / channel owner of the app (session is '') */
  room?: CommentRoomRef;
  /** The owner wrote this reply in Slack */
  via?: 'slack' | string;
}

interface MentionsPage {
  mentions: MentionItem[];
  seq: number;
}

/** How a wake is delivered. */
export interface WakeDeliveryOptions {
  /** Start the agent when its session is down (only for the app's publisher) */
  activate: boolean;
  /** The owner made (some of) these changes: queue ahead of system traffic (crewly#1105) */
  owner?: boolean;
  /** Identity of this batch (`app:<id>:<first>-<last>`): a second queued copy is a duplicate */
  ref?: string;
}

/** Constructor dependencies. */
export interface AppWakeServiceDeps {
  client: AppWakeClient;
  registry: AppsRegistryService;
  /** Deliver a wake; `null` session = the orchestrator. Resolves true when delivered. */
  deliver: (session: string | null, text: string, opts: WakeDeliveryOptions) => Promise<boolean>;
  /** An `ask` target name → a session in the publisher's team (null = not found there) */
  resolveAgent?: (name: string, publisher: string) => Promise<string | null>;
  /** Whether an agent's session is running now */
  isRunning?: (session: string) => boolean;
  /** Whether a session is one of this instance's mentionable agents (roster) */
  isLocalAgent?: (session: string) => Promise<boolean>;
  /** This instance's Cloud id (to tell its mentions from another machine's) */
  instanceId?: () => Promise<string | null>;
  /** The owner's comment changes were delivered to `session` (Slack mirror; never awaited, never fails delivery) */
  onCommentsDelivered?: (info: { session: string; appId: string; appName: string; comments: AppChange[]; voiceFiles?: VoiceFiles }) => void;
  /** Download the voice comment recordings of a batch (SPEC §16); never throws */
  fetchVoice?: (appId: string, comments: AppChange[]) => Promise<VoiceFiles>;
  /** Pushes this instance's agent roster to Cloud when it changed */
  roster?: { pushIfChanged(): Promise<boolean> };
  /** Members of a team / channel that owns an app, on this machine (null: the room is not here) */
  roomMembers?: (room: CommentRoomRef) => Promise<string[] | null>;
  /** Post a room-owned batch into the room; resolves true when posted */
  deliverRoom?: (input: RoomDelivery) => Promise<boolean>;
  /** Who gets a room-owned comment when the room is not here (a team's lead); null = the orchestrator */
  roomFallback?: (room: CommentRoomRef) => Promise<string | null>;
  /** Agent skills root, for the command named in the message */
  skillsPath: string;
  now?: () => number;
  logger?: ComponentLogger;
}

interface ChangesPage {
  changes: AppChange[];
  seq: number;
}

interface Batch {
  appId: string;
  session: string | null;
  activate: boolean;
  dataChanges: AppChange[];
  events: AppChange[];
  visitorChanges: AppChange[];
  comments: AppChange[];
  dataTotal: number;
  eventsTotal: number;
  visitorTotal: number;
  commentsTotal: number;
  seqs: number[];
  firstSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  orcNotified: boolean;
  /** Opened only to report visitor submissions skipped over the daily cap */
  skippedNotice: boolean;
  /** When the batch was opened (epoch ms) — the stuck watchdog's clock */
  openedAt: number;
  /** A delivery of this batch is running */
  inFlight: boolean;
  /** Skipped visitor submissions this batch reports (fixed when it is first sent) */
  reportSkipped: number | null;
  /** The stuck watchdog already logged / told the orchestrator */
  stuckNotified: boolean;
  /** The recipient was @mentioned (the batch holds mention-inbox entries) */
  mentioned: boolean;
  /** Mention-inbox seqs in the batch, and the first one (+Infinity when none) */
  mentionSeqs: number[];
  mentionFirstSeq: number;
  /** App name from the mention inbox (the app may not be in this instance's registry) */
  appName?: string;
  /** Mentioned agents that are not on this machine any more (sent to the orchestrator) */
  goneMentions: string[];
  /** A team / channel owner's batch: posted into that room, not sent to an agent */
  room?: CommentRoomRef;
  /** The recipient owns the app's comments (SPEC §15) */
  owns?: boolean;
  /** Voice recordings downloaded for this batch (SPEC §16) */
  voiceFiles?: VoiceFiles;
}

/** Outcome of one delivery attempt. */
type DeliverOutcome = 'ok' | 'failed' | 'timeout';

/** Settles like `promise`, or like `onTimeout()` (its value, or what it throws) after `ms` — whichever comes first. */
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Thrown when one app's poll misses its deadline. */
class PollDeadlineError extends Error {
  constructor(ms: number) {
    super(`poll did not finish within ${Math.round(ms / 1000)} s`);
    this.name = 'PollDeadlineError';
  }
}

interface AppBackoff {
  failures: number;
  nextAt: number;
}

/** Recipient key for the orchestrator (never a valid session name). */
export const ORC_RECIPIENT = '\u0000orchestrator';

/**
 * Change poller and agent waker for Crewly Apps.
 */
export class AppWakeService {
  private readonly now: () => number;
  private readonly logger: ComponentLogger;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking: Promise<void> | null = null;
  /** When the running pass started, and its generation (an abandoned pass stops at its next step) */
  private tickStartedAt = 0;
  private generation = 0;
  private passStallNotified = false;
  /** Current poll of each app; a poll whose token was replaced or dropped discards its result */
  private readonly pollTokens = new Map<string, symbol>();
  /** Batches collecting changes, by `appId\0recipient` */
  private readonly batches = new Map<string, Batch>();
  /** Batches handed to `deliver` and not yet confirmed (in flight, or failed and waiting to retry) */
  private readonly outgoing = new Map<string, Batch>();
  private readonly lastWakeAt = new Map<string, number>();
  /** Highest seq read per app (the registry holds what is safe to persist) */
  private readonly fetched = new Map<string, number>();
  /** Seqs above the safe cursor already delivered, per app */
  private readonly delivered = new Map<string, Set<number>>();
  private readonly backoff = new Map<string, AppBackoff>();
  /** Visitor-wake cap state per app (the registry holds the persisted copy) */
  private readonly visitorWakes = new Map<string, VisitorWakeState>();
  private readonly visitorDirty = new Set<string>();
  /** Highest mention-inbox seq read, and seqs above the safe cursor already delivered */
  private mentionFetched: number | null = null;
  private mentionDelivered: Set<number> | null = null;
  private mentionBackoff: AppBackoff | null = null;
  private myInstance: string | null | undefined = undefined;
  /** Current mention-inbox read; one that missed its deadline discards its result */
  private mentionToken: symbol | null = null;

  constructor(private readonly deps: AppWakeServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('AppWake');
  }

  /** Start polling (first tick after one interval). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  /** Stop polling and drop timers. Unsent batches stay behind the persisted cursor and are re-read next start. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    for (const b of [...this.batches.values(), ...this.outgoing.values()]) if (b.timer) clearTimeout(b.timer);
    this.batches.clear();
    this.outgoing.clear();
    this.pollTokens.clear();
  }

  /**
   * Per-app backoff state (tests).
   *
   * @param appId - App id
   * @returns Failures in a row and when the app is next due, or null when healthy
   */
  appBackoff(appId: string): AppBackoff | null {
    const b = this.backoff.get(appId);
    return b ? { ...b } : null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.watchdog();
      // The loop never waits on a pass for longer than the stall limit: the
      // next scheduled pass then abandons it and starts afresh.
      void withDeadline<void>(this.tick(), C.POLL_PASS_STALL_MS, () => undefined)
        .catch((err) => this.logger.warn('App change poll pass failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => this.schedule());
    }, C.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * One pass over the apps that are due. Exposed for tests and for an immediate poll.
   * A pass still running after POLL_PASS_STALL_MS is abandoned and a fresh one starts.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      const runningFor = this.now() - this.tickStartedAt;
      if (runningFor < C.POLL_PASS_STALL_MS) return this.ticking;
      this.logger.warn('App change poll pass did not finish; abandoning it and starting a fresh one', { runningForMs: runningFor });
      if (!this.passStallNotified) {
        this.passStallNotified = true;
        this.notifyOrc(
          `[APP CHANGES] Crewly's poll of app changes stalled for ${Math.round(runningFor / 60_000)} min and was restarted. ` +
            'Owner changes made in that time are being read again now. If this repeats, the backend may need a restart.',
        );
      }
      this.generation++;
      this.ticking = null;
    }
    const gen = this.generation;
    this.tickStartedAt = this.now();
    const pass: Promise<void> = this.runTick(gen).finally(() => {
      if (this.ticking === pass) this.ticking = null;
    });
    this.ticking = pass;
    await pass;
    if (gen === this.generation) this.passStallNotified = false;
  }

  private async runTick(gen: number): Promise<void> {
    if (!this.deps.client.isAvailable()) return;
    if (this.deps.roster) await withDeadline<boolean>(this.deps.roster.pushIfChanged().catch(() => false), C.POLL_APP_DEADLINE_MS, () => false);
    const now = this.now();
    const all = await withDeadline<AppRegistryEntry[] | null>(this.deps.registry.list(), C.POLL_APP_DEADLINE_MS, () => null);
    if (!all) {
      this.logger.warn('Reading the apps registry did not finish; skipping this poll pass');
      return;
    }
    const due = all.filter((e) => !e.deleted && (this.backoff.get(e.appId)?.nextAt ?? 0) <= now);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (gen === this.generation && next < due.length) {
        const app = due[next++];
        await this.pollOne(app);
      }
    };
    await Promise.all(Array.from({ length: Math.min(C.POLL_CONCURRENCY, due.length) }, worker));
    if (gen === this.generation) await this.pollMentionsSafely(gen);
  }

  private async pollOne(app: AppRegistryEntry): Promise<void> {
    const token = Symbol(app.appId);
    this.pollTokens.set(app.appId, token);
    try {
      await withDeadline<void>(this.pollApp(app, token), C.POLL_APP_DEADLINE_MS, () => {
        throw new PollDeadlineError(C.POLL_APP_DEADLINE_MS);
      });
      this.backoff.delete(app.appId);
    } catch (err) {
      if (err instanceof AppsCloudError && err.status === 404) {
        this.logger.info('App no longer exists in Crewly Cloud; stopped polling it', { appId: app.appId });
        await this.deps.registry.markDeleted(app.appId);
        this.backoff.delete(app.appId);
        return;
      }
      const failures = (this.backoff.get(app.appId)?.failures ?? 0) + 1;
      const wait = Math.min(C.POLL_INTERVAL_MS * 2 ** failures, C.POLL_MAX_BACKOFF_MS);
      this.backoff.set(app.appId, { failures, nextAt: this.now() + wait });
      this.logger.warn('Polling app changes failed', { appId: app.appId, failures, retryInMs: wait, error: err instanceof Error ? err.message : String(err) });
    } finally {
      // A poll that missed its deadline may still finish later: its token is gone, so it changes nothing.
      if (this.pollTokens.get(app.appId) === token) this.pollTokens.delete(app.appId);
    }
  }

  private isCurrentPoll(appId: string, token: symbol): boolean {
    return this.pollTokens.get(appId) === token;
  }

  private deliveredSet(app: AppRegistryEntry): Set<number> {
    let set = this.delivered.get(app.appId);
    if (!set) {
      set = new Set(app.delivered ?? []);
      this.delivered.set(app.appId, set);
    }
    return set;
  }

  private async pollApp(app: AppRegistryEntry, token: symbol): Promise<void> {
    const opts = { timeoutMs: C.POLL_REQUEST_TIMEOUT_MS };
    if (app.cursor === null || app.cursor === undefined) {
      // Never polled: start from now, never replay history.
      const head = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`, opts);
      if (!this.isCurrentPoll(app.appId, token)) return;
      this.fetched.set(app.appId, head.seq);
      await this.deps.registry.setProgress(app.appId, head.seq, []);
      return;
    }
    const done = this.deliveredSet(app);
    this.maybeOpenSkippedNotice(app);
    let since = Math.max(app.cursor, this.fetched.get(app.appId) ?? app.cursor);
    for (let page = 0; page < C.POLL_MAX_PAGES; page++) {
      const res = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`, { ...opts, query: { since, wait: 0 } });
      // Missed its deadline (or a newer poll of this app started): discard.
      if (!this.isCurrentPoll(app.appId, token)) return;
      const changes = Array.isArray(res.changes) ? res.changes : [];
      for (const change of changes) {
        if (typeof change.seq === 'number' && change.seq > since && !done.has(change.seq)) await this.handle(app, change);
      }
      since = Math.max(since, typeof res.seq === 'number' ? res.seq : since);
      this.fetched.set(app.appId, since);
      if (changes.length < C.CHANGES_PAGE) break;
    }
    await this.persistProgress(app.appId);
  }

  /**
   * Persist the safe cursor — before the first change of any unsent batch
   * for the app — plus the seqs above it that were already delivered, so a
   * restart neither loses a pending batch nor repeats a delivered one.
   */
  private async persistProgress(appId: string): Promise<void> {
    const fetched = this.fetched.get(appId);
    if (fetched === undefined) return;
    let safe = fetched;
    for (const b of [...this.batches.values(), ...this.outgoing.values()]) {
      if (b.appId === appId) safe = Math.min(safe, b.firstSeq - 1);
    }
    const set = this.delivered.get(appId) ?? new Set<number>();
    for (const seq of set) if (seq <= safe) set.delete(seq);
    while (set.size > C.MAX_DELIVERED_SEQS) set.delete(Math.min(...set));
    this.delivered.set(appId, set);
    await this.deps.registry.setProgress(appId, safe, [...set]);
    await this.persistVisitorWakes(appId);
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  /**
   * The app's visitor-wake cap state for today: a new UTC day resets the
   * count but keeps the skipped submissions not yet reported.
   */
  private visitorState(app: Pick<AppRegistryEntry, 'appId' | 'visitorWakes'>): VisitorWakeState {
    const today = this.today();
    let st = this.visitorWakes.get(app.appId);
    if (!st) {
      const p = app.visitorWakes;
      st = p && typeof p.day === 'string' ? { day: p.day, count: Number(p.count) || 0, skipped: Number(p.skipped) || 0 } : { day: today, count: 0, skipped: 0 };
      this.visitorWakes.set(app.appId, st);
    }
    if (st.day !== today) {
      st.day = today;
      st.count = 0;
      this.visitorDirty.add(app.appId);
    }
    return st;
  }

  private async persistVisitorWakes(appId: string): Promise<void> {
    if (!this.visitorDirty.has(appId)) return;
    const st = this.visitorWakes.get(appId);
    if (!st) return;
    this.visitorDirty.delete(appId);
    await this.deps.registry.setVisitorWakes(appId, { ...st });
  }

  /**
   * On a new UTC day, submissions skipped over yesterday's cap are reported
   * even if nothing new arrives: open a notice-only batch for the publisher.
   */
  private maybeOpenSkippedNotice(app: AppRegistryEntry): void {
    const st = this.visitorState(app);
    if (st.skipped <= 0 || st.count >= C.VISITOR_WAKE.MAX_PER_DAY) return;
    const session = app.agentSession ?? null;
    const key = `${app.appId}\u0000${session ?? ORC_RECIPIENT}`;
    if (this.batches.has(key) || this.outgoing.has(key)) return;
    const batch = this.newBatch(app.appId, session, false, Number.POSITIVE_INFINITY);
    batch.skippedNotice = true;
    this.batches.set(key, batch);
    const last = this.lastWakeAt.get(key) ?? app.wakes?.[session ?? ORC_RECIPIENT] ?? -Infinity;
    this.arm(key, batch, Math.max(C.BATCH_WINDOW_MS, last + C.COOLDOWN_MS - this.now()));
  }

  private newBatch(appId: string, session: string | null, activate: boolean, firstSeq: number): Batch {
    return {
      appId,
      session,
      activate,
      dataChanges: [],
      events: [],
      visitorChanges: [],
      comments: [],
      dataTotal: 0,
      eventsTotal: 0,
      visitorTotal: 0,
      commentsTotal: 0,
      seqs: [],
      firstSeq,
      timer: null,
      failures: 0,
      orcNotified: false,
      skippedNotice: false,
      openedAt: this.now(),
      inFlight: false,
      reportSkipped: null,
      stuckNotified: false,
      mentioned: false,
      mentionSeqs: [],
      mentionFirstSeq: Number.POSITIVE_INFINITY,
      goneMentions: [],
    };
  }

  // -------------------------------------------------------------------------
  // @mention inbox
  // -------------------------------------------------------------------------

  private async instance(): Promise<string | null> {
    if (this.myInstance === undefined || this.myInstance === null) {
      this.myInstance = this.deps.instanceId ? await this.deps.instanceId().catch(() => null) : null;
    }
    return this.myInstance;
  }

  /**
   * Whether a comment change @mentions `session` on this instance (an agent
   * with the same session on another machine is someone else).
   */
  private async mentionsHere(change: AppChange, session: string): Promise<boolean> {
    const list = mentionsOf(change);
    if (list.length === 0) return false;
    const mine = await this.instance();
    return list.some((m) => m.session === session && (!m.instanceId || !mine || m.instanceId === mine));
  }

  private async pollMentionsSafely(gen: number): Promise<void> {
    if (this.mentionBackoff && this.mentionBackoff.nextAt > this.now()) return;
    try {
      // Bounded like an app poll: a hung inbox read never holds the pass.
      const token = Symbol('mentions');
      this.mentionToken = token;
      await withDeadline<void>(this.pollMentions(gen, token), C.POLL_APP_DEADLINE_MS, () => {
        if (this.mentionToken === token) this.mentionToken = null;
        throw new PollDeadlineError(C.POLL_APP_DEADLINE_MS);
      });
      this.mentionBackoff = null;
    } catch (err) {
      const failures = (this.mentionBackoff?.failures ?? 0) + 1;
      // An older Cloud without the inbox answers 404: check back rarely.
      const wait = err instanceof AppsCloudError && err.status === 404 ? C.POLL_MAX_BACKOFF_MS : Math.min(C.POLL_INTERVAL_MS * 2 ** failures, C.POLL_MAX_BACKOFF_MS);
      this.mentionBackoff = { failures, nextAt: this.now() + wait };
      if (!(err instanceof AppsCloudError && err.status === 404)) {
        this.logger.warn('Reading the app mention inbox failed', { failures, retryInMs: wait, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Mention-inbox backoff state (tests).
   *
   * @returns Failures in a row and when it is next due, or null when healthy
   */
  mentionsBackoff(): AppBackoff | null {
    return this.mentionBackoff ? { ...this.mentionBackoff } : null;
  }

  private async pollMentions(gen: number, token: symbol): Promise<void> {
    const stale = (): boolean => gen !== this.generation || this.mentionToken !== token;
    const opts = { timeoutMs: C.POLL_REQUEST_TIMEOUT_MS };
    const progress = await this.deps.registry.getMentionProgress();
    if (!this.mentionDelivered) this.mentionDelivered = new Set(progress.delivered);
    if (progress.cursor === null && this.mentionFetched === null) {
      // Never read: start from now, never replay history.
      const head = await this.deps.client.request<MentionsPage>('GET', '/mentions', opts);
      if (stale()) return;
      const seq = typeof head.seq === 'number' ? head.seq : 0;
      this.mentionFetched = seq;
      await this.deps.registry.setMentionProgress(seq, []);
      return;
    }
    const done = this.mentionDelivered;
    let since = Math.max(progress.cursor ?? 0, this.mentionFetched ?? 0);
    for (let page = 0; page < C.MENTIONS.MAX_PAGES; page++) {
      const res = await this.deps.client.request<MentionsPage>('GET', '/mentions', { ...opts, query: { since } });
      // Missed its deadline, or the pass was abandoned: discard.
      if (stale()) return;
      const items = Array.isArray(res.mentions) ? res.mentions : [];
      for (const item of items) {
        if (typeof item?.seq === 'number' && item.seq > since && !done.has(item.seq)) await this.handleMention(item);
      }
      since = Math.max(since, typeof res.seq === 'number' ? res.seq : since);
      this.mentionFetched = since;
      if (items.length < C.MENTIONS.PAGE) break;
    }
    await this.persistMentionProgress();
  }

  private async persistMentionProgress(): Promise<void> {
    if (this.mentionFetched === null) return;
    let safe = this.mentionFetched;
    for (const b of [...this.batches.values(), ...this.outgoing.values()]) safe = Math.min(safe, b.mentionFirstSeq - 1);
    const set = this.mentionDelivered ?? new Set<number>();
    for (const seq of set) if (seq <= safe) set.delete(seq);
    while (set.size > C.MAX_DELIVERED_SEQS) set.delete(Math.min(...set));
    this.mentionDelivered = set;
    await this.deps.registry.setMentionProgress(safe, [...set]);
  }

  private async handleMention(item: MentionItem): Promise<void> {
    const done = this.mentionDelivered ?? new Set<number>();
    this.mentionDelivered = done;
    if (item.reason === 'collaborator') {
      await this.deliverCollaboratorNotice(item);
      done.add(item.seq);
      return;
    }
    // The comment or the app is gone: nothing to say.
    if (!item.thread || typeof item.appId !== 'string' || typeof item.commentId !== 'string') {
      done.add(item.seq);
      return;
    }
    const change: AppChange = {
      seq: item.seq,
      kind: 'comment',
      comment: { id: item.commentId, op: item.op, ...(item.replyId ? { replyId: item.replyId } : {}), thread: item.thread },
      actor: { kind: 'owner', ...(item.via === 'slack' ? { via: 'slack' } : {}) } as AppChange['actor'],
      ...(item.at ? { at: item.at } : {}),
    };
    if (item.reason === 'owner' && item.room) {
      await this.handleRoomItem(item, item.room, change);
      return;
    }
    await this.addToAgentBatch(item, item.session, change, item.reason === 'owner');
  }

  /**
   * "You were added to app X" for an agent of this machine — the added agent
   * may run on another machine than the app's (crewly-services apps SPEC §14).
   * One message, never a wake of a stopped agent; an agent that is not here
   * any more is skipped.
   */
  private async deliverCollaboratorNotice(item: MentionItem): Promise<void> {
    const session = typeof item.session === 'string' ? item.session : '';
    if (!session || typeof item.appId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.appId)) return;
    const local = session === ORCHESTRATOR_SESSION_NAME || (this.deps.isLocalAgent ? await this.deps.isLocalAgent(session).catch(() => false) : true);
    if (!local) {
      this.logger.info('Collaborator notice for an agent not on this machine; skipped', { appId: item.appId, session });
      return;
    }
    const app = safeAppName(item.appName ?? item.appId);
    const by = typeof item.addedBy === 'string' && /^[A-Za-z0-9_.@:-]{1,128}$/.test(item.addedBy) ? (item.addedBy === 'owner' ? 'The owner' : item.addedBy) : 'The owner';
    const cmd = `bash ${this.deps.skillsPath}/core/app-data/execute.sh --app ${item.appId}`;
    const text =
      `[APP ACCESS] ${by} added you as a collaborator to the app "${app}" (app id ${item.appId}). ` +
      `You can read and write its data (${cmd} --list <collection>) and its comments (bash ${this.deps.skillsPath}/core/app-comments/execute.sh --app ${item.appId}). ` +
      `You cannot republish or change the app itself.`;
    const ok = await this.deps.deliver(session, text, { activate: false }).catch(() => false);
    this.logger.info('Collaborator notice delivered', { appId: item.appId, session, delivered: ok });
  }

  /**
   * A comment for an app owned by a team or channel: into the room's batch
   * when the room is here, else to its fallback agent.
   */
  private async handleRoomItem(item: MentionItem, room: CommentRoomRef, change: AppChange): Promise<void> {
    const members = this.deps.roomMembers && this.deps.deliverRoom ? await this.deps.roomMembers(room).catch(() => null) : null;
    if (!members) {
      const fallback = this.deps.roomFallback ? await this.deps.roomFallback(room).catch(() => null) : null;
      this.logger.info('App comment owner room is not on this machine; delivering to its fallback', { appId: item.appId, room: room.name, fallback: fallback ?? 'orchestrator' });
      await this.addToAgentBatch(item, fallback ?? ORCHESTRATOR_SESSION_NAME, { ...change, roomOwned: true }, true);
      return;
    }
    const key = `${item.appId}\u0000\u0001room:${room.kind}:${room.id}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = this.newBatch(item.appId, null, false, Number.POSITIVE_INFINITY);
      batch.room = { ...room };
      this.batches.set(key, batch);
      this.arm(key, batch, C.COMMENTS.ROOM_BATCH_WINDOW_MS);
    }
    if (typeof item.appName === 'string' && item.appName) batch.appName = item.appName;
    batch.mentionSeqs.push(item.seq);
    if (batch.mentionSeqs.length > C.MAX_DELIVERED_SEQS) batch.mentionSeqs.shift();
    batch.mentionFirstSeq = Math.min(batch.mentionFirstSeq, item.seq);
    batch.commentsTotal++;
    batch.comments.push(change);
    if (batch.comments.length > C.COMMENTS.MAX_PER_WAKE) batch.comments.shift();
    // @mentioned agents of this machine that are not in the room still get it.
    const mine = await this.instance();
    for (const m of mentionsOf(change)) {
      if (typeof m.session !== 'string' || members.includes(m.session)) continue;
      if (m.instanceId && mine && m.instanceId !== mine) continue;
      const local = m.session === ORCHESTRATOR_SESSION_NAME || (this.deps.isLocalAgent ? await this.deps.isLocalAgent(m.session).catch(() => false) : false);
      if (local) await this.addToAgentBatch(item, m.session, { ...change, roomOwned: true }, false);
    }
  }

  /** Add an inbox item to an agent's (or the orchestrator's) batch. */
  private async addToAgentBatch(item: MentionItem, target: string, change: AppChange, owns: boolean): Promise<void> {
    const isOrc = target === ORCHESTRATOR_SESSION_NAME;
    const here = isOrc || (this.deps.isLocalAgent ? await this.deps.isLocalAgent(target).catch(() => false) : true);
    const session = isOrc || !here ? null : target;
    const recipient = session ?? ORC_RECIPIENT;
    const key = `${item.appId}\u0000${recipient}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const app = await this.deps.registry.get(item.appId);
      const last = this.lastWakeAt.get(key) ?? app?.wakes?.[recipient] ?? -Infinity;
      const delay = Math.max(C.BATCH_WINDOW_MS, last + C.COOLDOWN_MS - this.now());
      batch = this.newBatch(item.appId, session, session !== null, Number.POSITIVE_INFINITY);
      this.batches.set(key, batch);
      this.arm(key, batch, delay);
    } else if (session !== null) {
      batch.activate = true;
    }
    if (owns) batch.owns = true;
    else batch.mentioned = true;
    if (typeof item.appName === 'string' && item.appName) batch.appName = item.appName;
    if (!here && !isOrc) {
      const name = typeof item.name === 'string' && item.name ? item.name : target;
      if (!batch.goneMentions.includes(name)) batch.goneMentions.push(name);
    }
    batch.mentionSeqs.push(item.seq);
    if (batch.mentionSeqs.length > C.MAX_DELIVERED_SEQS) batch.mentionSeqs.shift();
    batch.mentionFirstSeq = Math.min(batch.mentionFirstSeq, item.seq);
    batch.commentsTotal++;
    batch.comments.push(change);
    if (batch.comments.length > C.COMMENTS.MAX_PER_WAKE) batch.comments.shift();
  }

  private async recipientFor(app: AppRegistryEntry, change: AppChange): Promise<{ session: string | null; activate: boolean }> {
    const publisher = app.agentSession ?? null;
    const named = change.kind === 'event' && change.event?.type === 'ask' ? change.event.agent : undefined;
    if (publisher && typeof named === 'string' && this.deps.resolveAgent) {
      const target = await this.deps.resolveAgent(named, publisher).catch(() => null);
      // Only a running teammate; an ask never starts a stopped agent.
      if (target && target !== publisher && this.deps.isRunning?.(target)) return { session: target, activate: false };
    }
    return { session: publisher, activate: true };
  }

  private async handle(app: AppRegistryEntry, change: AppChange): Promise<void> {
    // The owner's changes and anonymous visitors' submissions wake; any agent
    // write (its own included) does not.
    const visitor = change.actor?.kind === 'visitor';
    if (change.actor?.kind !== 'owner' && !visitor) return;
    // A visitor can only add data (P3); anything else from one is ignored.
    if (visitor && change.kind !== 'data') return;
    if (change.kind === 'event') {
      if (change.event?.type !== 'notify' && change.event?.type !== 'ask') return;
    } else if (change.kind === 'comment') {
      // The owner's new comment, reply or reopen; resolving needs no wake.
      const op = change.comment?.op;
      if (op !== 'add' && op !== 'reply' && op !== 'reopen') return;
      // The app has an explicit owner: Cloud sent this to it through the inbox.
      if (change.ownerRouted) return;
    } else if (change.kind !== 'data') {
      return;
    }
    if (visitor) {
      // Daily cap on visitor-triggered wakes: past it, count, do not deliver.
      const st = this.visitorState(app);
      if (st.count >= C.VISITOR_WAKE.MAX_PER_DAY) {
        st.skipped++;
        this.visitorDirty.add(app.appId);
        // Handled: a re-read after a restart must not count it twice.
        this.deliveredSet(app).add(change.seq);
        return;
      }
    }
    const recipientInfo = await this.recipientFor(app, change);
    const session = recipientInfo.session;
    // The recipient was @mentioned in this comment: the mention inbox delivers it (one message, not two).
    if (change.kind === 'comment' && (await this.mentionsHere(change, session ?? ORCHESTRATOR_SESSION_NAME))) return;
    // A visitor never starts a stopped agent; only the owner's changes may.
    const activate = visitor ? false : recipientInfo.activate;
    const recipient = session ?? ORC_RECIPIENT;
    const key = `${app.appId}\u0000${recipient}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const last = this.lastWakeAt.get(key) ?? app.wakes?.[recipient] ?? -Infinity;
      const delay = Math.max(C.BATCH_WINDOW_MS, last + C.COOLDOWN_MS - this.now());
      batch = this.newBatch(app.appId, session, activate, change.seq);
      this.batches.set(key, batch);
      this.arm(key, batch, delay);
    } else {
      batch.activate = batch.activate || activate;
      // A batch opened by a skipped-visitor notice or a mention has no app seq yet.
      batch.firstSeq = Math.min(batch.firstSeq, change.seq);
    }
    batch.seqs.push(change.seq);
    if (batch.seqs.length > C.MAX_DELIVERED_SEQS) batch.seqs.shift();
    if (visitor) {
      batch.visitorTotal++;
      batch.visitorChanges.push(change);
      if (batch.visitorChanges.length > C.MAX_BATCH_DATA_CHANGES) batch.visitorChanges.shift();
    } else if (change.kind === 'comment') {
      batch.commentsTotal++;
      batch.comments.push(change);
      if (batch.comments.length > C.COMMENTS.MAX_PER_WAKE) batch.comments.shift();
    } else if (change.kind === 'event') {
      batch.eventsTotal++;
      batch.events.push(change);
      if (batch.events.length > C.MAX_EVENTS_PER_WAKE) batch.events.shift();
    } else {
      batch.dataTotal++;
      batch.dataChanges.push(change);
      if (batch.dataChanges.length > C.MAX_BATCH_DATA_CHANGES) batch.dataChanges.shift();
    }
  }

  private arm(key: string, batch: Batch, delay: number): void {
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      batch.timer = null;
      if (this.outgoing.get(key) === batch) void this.retry(key);
      else void this.flush(key);
    }, Math.max(0, delay));
    batch.timer.unref?.();
  }

  /** Whether a batch holds only visitor submissions (or only a skipped-submissions notice). */
  private static visitorOnly(batch: Batch): boolean {
    return batch.dataTotal === 0 && batch.eventsTotal === 0 && batch.commentsTotal === 0;
  }

  /** Fold `from` (newer) into `into` (older): one message covers both. */
  private static merge(into: Batch, from: Batch): void {
    const keep = <T>(list: T[], max: number): T[] => (list.length > max ? list.slice(list.length - max) : list);
    into.activate = into.activate || from.activate;
    into.dataChanges = keep([...into.dataChanges, ...from.dataChanges], C.MAX_BATCH_DATA_CHANGES);
    into.events = keep([...into.events, ...from.events], C.MAX_EVENTS_PER_WAKE);
    into.visitorChanges = keep([...into.visitorChanges, ...from.visitorChanges], C.MAX_BATCH_DATA_CHANGES);
    into.comments = keep([...into.comments, ...from.comments], C.COMMENTS.MAX_PER_WAKE);
    into.dataTotal += from.dataTotal;
    into.eventsTotal += from.eventsTotal;
    into.visitorTotal += from.visitorTotal;
    into.commentsTotal += from.commentsTotal;
    into.seqs = keep([...into.seqs, ...from.seqs], C.MAX_DELIVERED_SEQS);
    into.firstSeq = Math.min(into.firstSeq, from.firstSeq);
    into.skippedNotice = into.skippedNotice && from.skippedNotice;
    into.openedAt = Math.min(into.openedAt, from.openedAt);
    into.mentioned = into.mentioned || from.mentioned;
    into.mentionSeqs = keep([...into.mentionSeqs, ...from.mentionSeqs], C.MAX_DELIVERED_SEQS);
    into.mentionFirstSeq = Math.min(into.mentionFirstSeq, from.mentionFirstSeq);
    into.appName = into.appName ?? from.appName;
    into.goneMentions = [...new Set([...into.goneMentions, ...from.goneMentions])];
    into.owns = into.owns || from.owns;
  }

  /**
   * Send one collecting batch now (timer callback; tests). On failure the
   * batch stays pending and is retried with backoff.
   *
   * @param key - Batch key
   * @returns Whether a message was delivered
   */
  async flush(key: string): Promise<boolean> {
    const batch = this.batches.get(key);
    if (!batch) return false;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;

    // The previous batch for this agent is still out: fold this one into it
    // when it is waiting to retry (its retry carries both), else check again
    // shortly.
    const out = this.outgoing.get(key);
    if (out) {
      if (out.inFlight) {
        this.arm(key, batch, C.WAKE_INFLIGHT_RECHECK_MS);
        return false;
      }
      this.batches.delete(key);
      AppWakeService.merge(out, batch);
      if (!out.timer) this.arm(key, out, 0);
      return false;
    }

    // Visitor submissions alone never start the agent: wait until it runs.
    if (AppWakeService.visitorOnly(batch) && batch.session !== null && this.deps.isRunning && !this.deps.isRunning(batch.session)) {
      if (this.batches.get(key) === batch) this.arm(key, batch, C.VISITOR_WAKE.PENDING_RECHECK_MS);
      return false;
    }

    // Detach: changes arriving while this one is delivered open the next batch.
    this.batches.delete(key);
    this.outgoing.set(key, batch);
    return this.send(key, batch);
  }

  /** Retry an outgoing batch (its retry timer), folding in whatever collected meanwhile. */
  private async retry(key: string): Promise<boolean> {
    const batch = this.outgoing.get(key);
    if (!batch || batch.inFlight) return false;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    const newer = this.batches.get(key);
    if (newer) {
      if (newer.timer) clearTimeout(newer.timer);
      this.batches.delete(key);
      AppWakeService.merge(batch, newer);
    }
    return this.send(key, batch);
  }

  /**
   * Deliver an outgoing batch once, bounded by WAKE_DELIVER_TIMEOUT_MS.
   *
   * @param key - Batch key
   * @param batch - The batch (already in `outgoing`)
   * @returns Whether it was delivered
   */
  private async send(key: string, batch: Batch): Promise<boolean> {
    batch.inFlight = true;
    const app = await this.deps.registry.get(batch.appId).catch(() => null);
    // Voice comments: download the recordings first so the message can name the local file.
    if (batch.comments.length > 0 && this.deps.fetchVoice) {
      const fetchVoice = this.deps.fetchVoice;
      batch.voiceFiles = await withDeadline(
        fetchVoice(batch.appId, batch.comments).catch(() => ({}) as VoiceFiles),
        C.VOICE.DOWNLOAD_TIMEOUT_MS,
        () => batch.voiceFiles ?? {},
      );
    }

    // Skipped visitor submissions are reported in the next message to the
    // agent visitors wake (the publisher, else the orchestrator).
    const isVisitorRecipient = !!app && (app.agentSession ?? null) === batch.session;
    const vstate = app && isVisitorRecipient ? this.visitorState(app) : null;
    if (batch.reportSkipped === null) batch.reportSkipped = vstate?.skipped ?? 0;
    const skipped = batch.reportSkipped;
    if (AppWakeService.visitorOnly(batch) && batch.visitorTotal === 0 && skipped === 0) {
      // A notice-only batch with nothing left to report.
      batch.inFlight = false;
      if (this.outgoing.get(key) === batch) this.outgoing.delete(key);
      return false;
    }
    const text = buildAppWakeMessage({
      appId: batch.appId,
      appName: app?.name ?? batch.appName ?? batch.appId,
      isPublisher: !!app && !app.deleted && (app.agentSession ?? null) === batch.session,
      mentioned: batch.mentioned,
      owns: batch.owns === true,
      goneMentions: batch.goneMentions,
      dataChanges: batch.dataChanges,
      events: batch.events,
      dataTotal: batch.dataTotal,
      eventsTotal: batch.eventsTotal,
      comments: batch.comments,
      commentsTotal: batch.commentsTotal,
      visitorChanges: batch.visitorChanges,
      visitorTotal: batch.visitorTotal,
      visitorSkipped: skipped,
      skillsPath: this.deps.skillsPath,
      ...(batch.voiceFiles ? { voiceFiles: batch.voiceFiles } : {}),
    });
    const owner = !AppWakeService.visitorOnly(batch);
    const seqs = batch.seqs.filter((n) => Number.isFinite(n));
    const mseqs = batch.mentionSeqs.filter((n) => Number.isFinite(n));
    const refParts = [
      ...(seqs.length > 0 ? [`${Math.min(...seqs)}-${Math.max(...seqs)}:${seqs.length}`] : []),
      ...(mseqs.length > 0 ? [`m${Math.min(...mseqs)}-${Math.max(...mseqs)}:${mseqs.length}`] : []),
    ];
    const ref = refParts.length > 0 ? `app:${batch.appId}:${refParts.join(':')}` : undefined;
    const sentSeqs = new Set(batch.seqs);
    const sentMentions = new Set(batch.mentionSeqs);

    const room = batch.room;
    const attempt: Promise<boolean> = Promise.resolve()
      .then(() =>
        room
          ? this.deps.deliverRoom
            ? this.deps.deliverRoom({ appId: batch.appId, appName: app?.name ?? batch.appName ?? batch.appId, room, comments: [...batch.comments], ...(batch.voiceFiles ? { voiceFiles: batch.voiceFiles } : {}) })
            : false
          : this.deps.deliver(batch.session, text, { activate: batch.activate, ...(owner ? { owner: true } : {}), ...(ref ? { ref } : {}) }),
      )
      .catch((err) => {
        this.logger.warn('App change wake failed', { appId: batch.appId, session: batch.session, error: err instanceof Error ? err.message : String(err) });
        return false;
      });
    const outcome = await withDeadline<DeliverOutcome>(
      attempt.then((ok) => (ok ? 'ok' : 'failed')),
      C.WAKE_DELIVER_TIMEOUT_MS,
      () => 'timeout',
    );
    batch.inFlight = false;
    if (this.outgoing.get(key) !== batch) return false; // stopped meanwhile

    if (outcome === 'ok') return this.succeeded(key, batch, app, vstate, skipped);

    if (outcome === 'timeout') {
      this.logger.warn('App change wake did not finish in time; will retry', {
        appId: batch.appId,
        session: batch.session ?? 'orchestrator',
        timeoutMs: C.WAKE_DELIVER_TIMEOUT_MS,
      });
      // A late success still settles the batch, unless a retry is already out
      // or the batch has grown since (then the retry carries everything).
      void attempt.then((ok) => {
        if (!ok || this.outgoing.get(key) !== batch || batch.inFlight) return;
        if (!batch.seqs.every((n) => sentSeqs.has(n)) || !batch.mentionSeqs.every((n) => sentMentions.has(n))) return;
        this.logger.info('A timed-out app change wake arrived after all', { appId: batch.appId, session: batch.session ?? 'orchestrator' });
        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = null;
        void this.succeeded(key, batch, app, vstate, skipped);
      });
    }

    batch.failures++;
    const retry = Math.min(C.WAKE_RETRY_BASE_MS * 2 ** (batch.failures - 1), C.WAKE_RETRY_MAX_MS);
    this.logger.warn('App change wake was not delivered; will retry', { appId: batch.appId, session: batch.session ?? 'orchestrator', failures: batch.failures, retryInMs: retry });
    if (batch.failures >= C.WAKE_FAILS_BEFORE_ORC_NOTICE && !batch.orcNotified && (batch.session !== null || batch.room)) {
      batch.orcNotified = true;
      this.notifyOrc(
        `[APP CHANGES] Changes in app "${safeAppName(app?.name ?? batch.appId)}" (${batch.appId}) could not be delivered to ` +
          `${batch.room ? `the ${batch.room.kind} "${safeAppName(batch.room.name)}" that owns it` : batch.session} after ${batch.failures} tries. ` +
          'Crewly keeps retrying. Check whether that agent or room is stuck or signed out.',
      );
    }
    this.arm(key, batch, retry);
    return false;
  }

  private async succeeded(key: string, batch: Batch, app: AppRegistryEntry | null, vstate: VisitorWakeState | null, skipped: number): Promise<boolean> {
    if (this.outgoing.get(key) !== batch) return false;
    this.outgoing.delete(key);
    const recipient = batch.session ?? ORC_RECIPIENT;
    const at = this.now();
    this.lastWakeAt.set(key, at);
    await this.deps.registry.setLastWake(batch.appId, recipient, at).catch(() => undefined);
    if (vstate && app) {
      if (batch.visitorTotal > 0 || batch.skippedNotice) vstate.count++;
      vstate.skipped = Math.max(0, vstate.skipped - skipped);
      this.visitorDirty.add(batch.appId);
      await this.persistVisitorWakes(batch.appId).catch(() => undefined);
    }
    const set = this.delivered.get(batch.appId) ?? new Set<number>();
    for (const seq of batch.seqs) set.add(seq);
    this.delivered.set(batch.appId, set);
    if (batch.mentionSeqs.length > 0) {
      const mset = this.mentionDelivered ?? new Set<number>();
      for (const seq of batch.mentionSeqs) mset.add(seq);
      this.mentionDelivered = mset;
    }
    if (batch.comments.length > 0 && this.deps.onCommentsDelivered && !batch.room) {
      try {
        this.deps.onCommentsDelivered({ session: batch.session ?? ORCHESTRATOR_SESSION_NAME, appId: batch.appId, appName: app?.name ?? batch.appName ?? batch.appId, comments: batch.comments, ...(batch.voiceFiles ? { voiceFiles: batch.voiceFiles } : {}) });
      } catch {
        /* a mirror problem never fails delivery */
      }
    }
    this.logger.info(batch.room ? 'Posted app comments to the room that owns the app' : 'Woke agent for app changes', {
      appId: batch.appId,
      session: batch.room ? `${batch.room.kind}:${batch.room.name}` : (batch.session ?? 'orchestrator'),
      dataChanges: batch.dataTotal,
      events: batch.eventsTotal,
      comments: batch.commentsTotal,
      visitorSubmissions: batch.visitorTotal,
      ...(batch.mentioned ? { mentioned: true } : {}),
      ...(skipped > 0 ? { visitorSkippedReported: skipped } : {}),
      ...(batch.failures > 0 ? { afterFailures: batch.failures } : {}),
    });
    // Changes that arrived during the delivery wait for the cooldown it started
    // (a room has none: each comment is its own thread there).
    const next = this.batches.get(key);
    if (next) this.arm(key, next, batch.room ? C.COMMENTS.ROOM_BATCH_WINDOW_MS : C.COOLDOWN_MS);
    await this.persistProgress(batch.appId).catch(() => undefined);
    if (batch.mentionSeqs.length > 0) await this.persistMentionProgress().catch(() => undefined);
    return true;
  }

  /** Tell the orchestrator something, without waiting on it for long. */
  private notifyOrc(text: string): void {
    void withDeadline<boolean>(
      Promise.resolve()
        .then(() => this.deps.deliver(null, text, { activate: false }))
        .catch(() => false),
      C.WAKE_DELIVER_TIMEOUT_MS,
      () => false,
    );
  }

  /**
   * Runs before every scheduled pass: a batch with no timer and no delivery
   * running is re-armed (it would otherwise wait forever), and owner changes
   * that have not reached their agent after WAKE_STUCK_NOTICE_MS are logged
   * and reported to the orchestrator, once per batch. Visitor-only batches
   * waiting for their agent to run are expected to wait and are left alone.
   */
  watchdog(): void {
    const now = this.now();
    for (const [key, batch] of [...this.batches.entries(), ...this.outgoing.entries()]) {
      if (!batch.timer && !batch.inFlight) {
        this.logger.warn('App change batch had no timer; re-armed', { appId: batch.appId, session: batch.session ?? 'orchestrator' });
        this.arm(key, batch, 0);
      }
      if (AppWakeService.visitorOnly(batch) || batch.stuckNotified) continue;
      const ageMs = now - batch.openedAt;
      if (ageMs < C.WAKE_STUCK_NOTICE_MS) continue;
      batch.stuckNotified = true;
      const minutes = Math.round(ageMs / 60_000);
      this.logger.warn('Owner changes in an app have not reached their agent', {
        appId: batch.appId,
        session: batch.session ?? 'orchestrator',
        minutes,
        inFlight: batch.inFlight,
        failures: batch.failures,
        comments: batch.commentsTotal,
        dataChanges: batch.dataTotal,
        events: batch.eventsTotal,
      });
      if (batch.session !== null) {
        this.notifyOrc(
          `[APP CHANGES] The owner's changes in an app (${batch.appId}: ${batch.commentsTotal} comment(s), ${batch.dataTotal} data change(s), ` +
            `${batch.eventsTotal} message(s)) have waited ${minutes} min to reach ${batch.session}. Crewly keeps trying. ` +
            'Check whether that agent is stuck.',
        );
      }
    }
  }

  /** @returns Keys of batches waiting to be sent (tests) */
  pendingKeys(): string[] {
    return [...new Set([...this.batches.keys(), ...this.outgoing.keys()])];
  }
}
