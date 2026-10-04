/**
 * AppWakeService — polls the change feed of every app this instance
 * published and wakes the agent that published it when the owner changes
 * something (specs/2026-10-04-crewly-apps-p2.md §5).
 *
 * - One poller, every POLL_INTERVAL_MS, `GET changes?since=<cursor>&wait=0`
 *   per app; errors back off ×2 up to POLL_MAX_BACKOFF_MS.
 * - Only owner changes wake (data written in the app, `notify` / `ask`);
 *   every agent write — the agent's own included — is skipped.
 * - The first change for (app, agent) opens a BATCH_WINDOW_MS window; a
 *   wake is followed by a COOLDOWN_MS quiet period for that pair, during
 *   which changes keep collecting into the next message.
 *
 * @module services/apps/app-wake.service
 */

import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { AppsCloudError } from './apps-cloud.client.js';
import type { AppsRegistryService, AppRegistryEntry } from './apps-registry.service.js';
import { buildAppWakeMessage, type AppChange } from './app-wake-message.js';

const C = CREWLY_APPS_CONSTANTS;

/** The Apps API slice the poller needs. */
export interface AppWakeClient {
  isAvailable(): boolean;
  request<T>(method: string, path: string, opts?: { query?: Record<string, string | number | undefined> }): Promise<T>;
}

/** Constructor dependencies. */
export interface AppWakeServiceDeps {
  client: AppWakeClient;
  registry: AppsRegistryService;
  /** Deliver a wake; `null` session = the orchestrator. Resolves true when delivered. */
  deliver: (session: string | null, text: string) => Promise<boolean>;
  /** Map an `ask` target name to an agent session on this instance (null = unknown) */
  resolveAgent?: (name: string) => Promise<string | null>;
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
  dataChanges: AppChange[];
  events: AppChange[];
  firstSeq: number;
  timer: ReturnType<typeof setTimeout>;
}

const ORC_KEY = '\u0000orchestrator';

/**
 * Change poller and agent waker for Crewly Apps.
 */
export class AppWakeService {
  private readonly now: () => number;
  private readonly logger: ComponentLogger;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking: Promise<void> | null = null;
  private delayMs: number = C.POLL_INTERVAL_MS;
  private readonly batches = new Map<string, Batch>();
  private readonly lastWakeAt = new Map<string, number>();
  /** Highest seq read per app (in memory; the registry holds what is safe to persist) */
  private readonly fetched = new Map<string, number>();

  constructor(private readonly deps: AppWakeServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('AppWake');
  }

  /** Start polling (first tick after one interval). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(C.POLL_INTERVAL_MS);
  }

  /** Stop polling and drop pending timers (pending batches stay unsent; their changes are re-read next start). */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const b of this.batches.values()) clearTimeout(b.timer);
    this.batches.clear();
  }

  /** @returns The delay before the next tick (backoff state; tests) */
  currentDelayMs(): number {
    return this.delayMs;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.delayMs));
    }, ms);
    this.timer.unref?.();
  }

  /**
   * One pass over every app. Exposed for tests and for an immediate poll.
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (!this.deps.client.isAvailable()) {
      this.delayMs = C.POLL_INTERVAL_MS;
      return;
    }
    let failed = false;
    const apps = (await this.deps.registry.list()).filter((e) => !e.deleted);
    for (const app of apps) {
      try {
        await this.pollApp(app);
      } catch (err) {
        if (err instanceof AppsCloudError && err.status === 404) {
          this.logger.info('App no longer exists in Crewly Cloud; stopped polling it', { appId: app.appId });
          await this.deps.registry.markDeleted(app.appId);
          continue;
        }
        failed = true;
        this.logger.warn('Polling app changes failed', { appId: app.appId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.delayMs = failed ? Math.min(Math.max(this.delayMs, C.POLL_INTERVAL_MS) * 2, C.POLL_MAX_BACKOFF_MS) : C.POLL_INTERVAL_MS;
  }

  private async pollApp(app: AppRegistryEntry): Promise<void> {
    if (app.cursor === null || app.cursor === undefined) {
      // Never polled: start from now, never replay history.
      const head = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`);
      this.fetched.set(app.appId, head.seq);
      await this.deps.registry.setCursor(app.appId, head.seq);
      return;
    }
    let since = Math.max(app.cursor, this.fetched.get(app.appId) ?? app.cursor);
    for (let page = 0; page < C.POLL_MAX_PAGES; page++) {
      const res = await this.deps.client.request<ChangesPage>('GET', `/apps/${app.appId}/changes`, { query: { since, wait: 0 } });
      const changes = Array.isArray(res.changes) ? res.changes : [];
      for (const change of changes) {
        if (typeof change.seq === 'number' && change.seq > since) await this.handle(app, change);
      }
      since = Math.max(since, typeof res.seq === 'number' ? res.seq : since);
      this.fetched.set(app.appId, since);
      if (changes.length < C.CHANGES_PAGE) break;
    }
    await this.persistCursor(app.appId);
  }

  /** The cursor safe to persist: before the first change of any unsent batch for the app. */
  private async persistCursor(appId: string): Promise<void> {
    let safe = this.fetched.get(appId);
    if (safe === undefined) return;
    for (const b of this.batches.values()) {
      if (b.appId === appId) safe = Math.min(safe, b.firstSeq - 1);
    }
    await this.deps.registry.setCursor(appId, safe);
  }

  private async handle(app: AppRegistryEntry, change: AppChange): Promise<void> {
    // Only the owner's changes wake; any agent write (its own included) does not.
    if (change.actor?.kind !== 'owner') return;
    let session = app.agentSession ?? null;
    if (change.kind === 'event') {
      if (change.event?.type !== 'notify' && change.event?.type !== 'ask') return;
      if (change.event.type === 'ask' && typeof change.event.agent === 'string' && this.deps.resolveAgent) {
        const named = await this.deps.resolveAgent(change.event.agent).catch(() => null);
        if (named) session = named;
      }
    } else if (change.kind !== 'data') {
      return;
    }
    const key = `${app.appId}\u0000${session ?? ORC_KEY}`;
    let batch = this.batches.get(key);
    if (!batch) {
      const cooldownLeft = (this.lastWakeAt.get(key) ?? -Infinity) + C.COOLDOWN_MS - this.now();
      const delay = Math.max(C.BATCH_WINDOW_MS, cooldownLeft);
      const timer = setTimeout(() => void this.flush(key), delay);
      timer.unref?.();
      batch = { appId: app.appId, session, dataChanges: [], events: [], firstSeq: change.seq, timer };
      this.batches.set(key, batch);
    }
    if (change.kind === 'event') batch.events.push(change);
    else batch.dataChanges.push(change);
  }

  /**
   * Send one batch now (timer callback; tests).
   *
   * @param key - Batch key
   * @returns Whether a message was delivered
   */
  async flush(key: string): Promise<boolean> {
    const batch = this.batches.get(key);
    if (!batch) return false;
    clearTimeout(batch.timer);
    this.batches.delete(key);
    this.lastWakeAt.set(key, this.now());
    const app = await this.deps.registry.get(batch.appId);
    const text = buildAppWakeMessage({
      appId: batch.appId,
      appName: app?.name ?? batch.appId,
      isPublisher: (app?.agentSession ?? null) === batch.session,
      dataChanges: batch.dataChanges,
      events: batch.events,
      skillsPath: this.deps.skillsPath,
    });
    let ok = false;
    try {
      ok = await this.deps.deliver(batch.session, text);
    } catch (err) {
      this.logger.warn('App change wake failed', { appId: batch.appId, session: batch.session, error: err instanceof Error ? err.message : String(err) });
    }
    if (ok) {
      this.logger.info('Woke agent for app changes', {
        appId: batch.appId,
        session: batch.session ?? 'orchestrator',
        dataChanges: batch.dataChanges.length,
        events: batch.events.length,
      });
    } else {
      this.logger.warn('App change wake was not delivered', { appId: batch.appId, session: batch.session ?? 'orchestrator' });
    }
    await this.persistCursor(batch.appId).catch(() => undefined);
    return ok;
  }

  /** @returns Keys of batches waiting to be sent (tests) */
  pendingKeys(): string[] {
    return [...this.batches.keys()];
  }
}
