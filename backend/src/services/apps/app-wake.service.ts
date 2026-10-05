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
 * - An `ask` reaches a named agent only when it is in the publisher's team
 *   and already running; it never starts a stopped agent.
 *
 * @module services/apps/app-wake.service
 */

import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppsRegistryService, AppRegistryEntry, VisitorWakeState } from './apps-registry.service.js';
import { buildAppWakeMessage, safeAppName, type AppChange } from './app-wake-message.js';

const C = CREWLY_APPS_CONSTANTS;

/** The Apps API slice the poller needs. */
export interface AppWakeClient {
  isAvailable(): boolean;
  request<T>(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; timeoutMs?: number }): Promise<T>;
}

/** How a wake is delivered. */
export interface WakeDeliveryOptions {
  /** Start the agent when its session is down (only for the app's publisher) */
  activate: boolean;
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
  private readonly batches = new Map<string, Batch>();
  private readonly lastWakeAt = new Map<string, number>();
  /** Highest seq read per app (the registry holds what is safe to persist) */
  private readonly fetched = new Map<string, number>();
  /** Seqs above the safe cursor already delivered, per app */
  private readonly delivered = new Map<string, Set<number>>();
  private readonly backoff = new Map<string, AppBackoff>();
  /** Visitor-wake cap state per app (the registry holds the persisted copy) */
  private readonly visitorWakes = new Map<string, VisitorWakeState>();
  private readonly visitorDirty = new Set<string>();

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
    for (const b of this.batches.values()) if (b.timer) clearTimeout(b.timer);
    this.batches.clear();
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
      void this.tick().finally(() => this.schedule());
    }, C.POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  /**
   * One pass over the apps that are due. Exposed for tests and for an immediate poll.
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (!this.deps.client.isAvailable()) return;
    const now = this.now();
    const due = (await this.deps.registry.list()).filter((e) => !e.deleted && (this.backoff.get(e.appId)?.nextAt ?? 0) <= now);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const app = due[next++];
        await this.pollOne(app);
      }
    };
    await Promise.all(Array.from({ length: Math.min(C.POLL_CONCURRENCY, due.length) }, worker));
  }

  private async pollOne(app: AppRegistryEntry): Promise<void> {
    try {
      await this.pollApp(app);
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
    }
  }

  private deliveredSet(app: AppRegistryEntry): Set<number> {
    let set = this.delivered.get(app.appId);
    if (!set) {
      set = new Set(app.delivered ?? []);
      this.delivered.set(app.appId, set);
    }
    return set;
  }

  private async pollApp(app: AppRegistryEntry): Promise<void> {
    const opts = { timeoutMs: C.POLL_REQUEST_TIMEOUT_MS };
    if (app.cursor === null || app.cursor === undefined) {
      // Never polled: start from now, never replay history.
      const head = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`, opts);
      this.fetched.set(app.appId, head.seq);
      await this.deps.registry.setProgress(app.appId, head.seq, []);
      return;
    }
    const done = this.deliveredSet(app);
    this.maybeOpenSkippedNotice(app);
    let since = Math.max(app.cursor, this.fetched.get(app.appId) ?? app.cursor);
    for (let page = 0; page < C.POLL_MAX_PAGES; page++) {
      const res = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`, { ...opts, query: { since, wait: 0 } });
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
    for (const b of this.batches.values()) {
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
    if (this.batches.has(key)) return;
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
    };
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
      if (batch.skippedNotice) batch.firstSeq = Math.min(batch.firstSeq, change.seq);
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
    batch.timer = setTimeout(() => void this.flush(key), delay);
    batch.timer.unref?.();
  }

  /**
   * Send one batch now (timer callback; tests). On failure the batch stays
   * pending and is retried with backoff.
   *
   * @param key - Batch key
   * @returns Whether a message was delivered
   */
  async flush(key: string): Promise<boolean> {
    const batch = this.batches.get(key);
    if (!batch) return false;
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = null;
    const app = await this.deps.registry.get(batch.appId);
    const recipient = batch.session ?? ORC_RECIPIENT;

    // Visitor submissions alone never start the agent: wait until it runs.
    const visitorOnly = batch.dataTotal === 0 && batch.eventsTotal === 0 && batch.commentsTotal === 0;
    if (visitorOnly && batch.session !== null && this.deps.isRunning && !this.deps.isRunning(batch.session)) {
      if (this.batches.get(key) === batch) this.arm(key, batch, C.VISITOR_WAKE.PENDING_RECHECK_MS);
      return false;
    }

    // Skipped visitor submissions are reported in the next message to the
    // agent visitors wake (the publisher, else the orchestrator).
    const isVisitorRecipient = (app?.agentSession ?? null) === batch.session;
    const vstate = app && isVisitorRecipient ? this.visitorState(app) : null;
    const skipped = vstate?.skipped ?? 0;
    if (visitorOnly && batch.visitorTotal === 0 && skipped === 0) {
      // A notice-only batch with nothing left to report.
      this.batches.delete(key);
      return false;
    }
    const text = buildAppWakeMessage({
      appId: batch.appId,
      appName: app?.name ?? batch.appId,
      isPublisher: (app?.agentSession ?? null) === batch.session,
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
    });
    let ok = false;
    try {
      ok = await this.deps.deliver(batch.session, text, { activate: batch.activate });
    } catch (err) {
      this.logger.warn('App change wake failed', { appId: batch.appId, session: batch.session, error: err instanceof Error ? err.message : String(err) });
    }

    if (!ok) {
      batch.failures++;
      const retry = Math.min(C.WAKE_RETRY_BASE_MS * 2 ** (batch.failures - 1), C.WAKE_RETRY_MAX_MS);
      this.logger.warn('App change wake was not delivered; will retry', { appId: batch.appId, session: batch.session ?? 'orchestrator', failures: batch.failures, retryInMs: retry });
      if (batch.failures >= C.WAKE_FAILS_BEFORE_ORC_NOTICE && !batch.orcNotified && batch.session !== null) {
        batch.orcNotified = true;
        const notice =
          `[APP CHANGES] Changes in app "${safeAppName(app?.name ?? batch.appId)}" (${batch.appId}) could not be delivered to ` +
          `${batch.session} after ${batch.failures} tries. Crewly keeps retrying. Check whether that agent is stuck or signed out.`;
        await this.deps.deliver(null, notice, { activate: false }).catch(() => false);
      }
      if (this.batches.get(key) === batch) this.arm(key, batch, retry);
      return false;
    }

    this.batches.delete(key);
    const at = this.now();
    this.lastWakeAt.set(key, at);
    await this.deps.registry.setLastWake(batch.appId, recipient, at).catch(() => undefined);
    if (vstate) {
      if (batch.visitorTotal > 0 || batch.skippedNotice) vstate.count++;
      vstate.skipped = Math.max(0, vstate.skipped - skipped);
      this.visitorDirty.add(batch.appId);
      await this.persistVisitorWakes(batch.appId).catch(() => undefined);
    }
    const set = this.delivered.get(batch.appId) ?? new Set<number>();
    for (const seq of batch.seqs) set.add(seq);
    this.delivered.set(batch.appId, set);
    this.logger.info('Woke agent for app changes', {
      appId: batch.appId,
      session: batch.session ?? 'orchestrator',
      dataChanges: batch.dataTotal,
      events: batch.eventsTotal,
      comments: batch.commentsTotal,
      visitorSubmissions: batch.visitorTotal,
      ...(skipped > 0 ? { visitorSkippedReported: skipped } : {}),
    });
    await this.persistProgress(batch.appId).catch(() => undefined);
    return true;
  }

  /** @returns Keys of batches waiting to be sent (tests) */
  pendingKeys(): string[] {
    return [...this.batches.keys()];
  }
}
