/**
 * DriveBriefingSyncService — keeps this machine's Drive mode status snapshot
 * fresh on Crewly Cloud (specs/2026-10-09-drive-mode-v3.md §1), so the voice
 * answers "how is CE doing?" at once, built while work happens rather than
 * pulled when the owner starts talking.
 *
 * - On events (a ticket changed, a work item moved, an agent wrote to the
 *   owner, a card was created or settled) it gathers for 3 s, rebuilds the
 *   snapshot and uploads it when it changed — at most one upload every 5 s.
 * - Every minute it rebuilds anyway (agent states, anything an event missed)
 *   and uploads only on a change; every 5 minutes it uploads regardless, so
 *   Cloud knows the snapshot is current.
 * - Building costs no LLM call: see `drive-briefing-snapshot.ts`.
 *
 * Uses the machine's own Cloud token; signed out = nothing is sent.
 * `CREWLY_DRIVE_BRIEFING=0` turns it off. A Cloud that does not take
 * snapshots yet (404 / 400 / 503) is asked again in an hour. Never throws.
 *
 * @module services/drive/drive-briefing-sync.service
 */

import { DRIVE_BRIEFING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { accountIdOfToken } from '../cloud/conversation-cloud-sync.service.js';
import { INSTANCE_ID_PATTERN } from '../cloud/conversation-ingest.contract.js';
import type { BriefingSnapshot } from './drive-briefing.contract.js';

const C = DRIVE_BRIEFING_CONSTANTS;

/** The Cloud session (CloudClientService). */
export interface BriefingSyncCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  tryRefreshToken?(): Promise<boolean>;
}

/** Subscribe to one kind of change; returns an unsubscribe function. */
export type BriefingChangeSource = (listener: () => void) => () => void;

/** Constructor dependencies. */
export interface DriveBriefingSyncDeps {
  /** Build the snapshot now (from structured data only) */
  build: () => Promise<BriefingSnapshot>;
  cloud: BriefingSyncCloud;
  /** This machine's Cloud instance id */
  identity: () => Promise<{ instanceId: string }>;
  /** Event sources that make the snapshot stale */
  sources?: BriefingChangeSource[];
  env?: NodeJS.ProcessEnv;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: ComponentLogger;
}

/** What one pass did. */
export type BriefingSyncOutcome = 'uploaded' | 'unchanged' | 'skipped' | 'failed' | 'paused';

/**
 * Whether the snapshot push is switched off.
 *
 * @param env - Environment
 * @returns True for `CREWLY_DRIVE_BRIEFING=0|off|false|no`
 */
export function isBriefingSyncDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env[C.KILL_SWITCH_ENV];
  return typeof v === 'string' && ['0', 'off', 'false', 'no'].includes(v.trim().toLowerCase());
}

/**
 * The snapshot's identity for change detection (its build time left out).
 *
 * @param s - Snapshot
 * @returns Key
 */
export function snapshotKey(s: BriefingSnapshot): string {
  const { generatedAt: _at, ...rest } = s;
  return JSON.stringify(rest);
}

/** Pushes the machine's status snapshot to Crewly Cloud — see module docs. */
export class DriveBriefingSyncService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: (input: string, init: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private started = false;
  private running: Promise<BriefingSyncOutcome> | null = null;
  private rerun = false;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];

  private lastKey: string | null = null;
  private lastAccount: string | null = null;
  private lastUploadAt = 0;
  private failures = 0;
  private pausedUntil = 0;
  private pauseLogged = false;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: DriveBriefingSyncDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('DriveBriefingSync');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /** Subscribe to the event sources and start the periodic check. Idempotent; never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const source of this.deps.sources ?? []) {
      try {
        this.unsubscribers.push(source(() => this.requestSync()));
      } catch (error) {
        this.logger.warn('Drive briefing: an event source could not be watched', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.scheduleCheck(0);
  }

  /** Stop timers and subscriptions. */
  stop(): void {
    this.started = false;
    if (this.checkTimer) this.clearTimer(this.checkTimer);
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.checkTimer = null;
    this.debounceTimer = null;
    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    this.unsubscribers = [];
  }

  /**
   * Something changed: rebuild after the gather window (and no sooner than
   * the minimum interval after the last upload).
   */
  requestSync(): void {
    if (!this.started || this.debounceTimer) return;
    const sinceUpload = this.now() - this.lastUploadAt;
    const delay = Math.max(C.DEBOUNCE_MS, C.MIN_INTERVAL_MS - sinceUpload);
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, delay);
  }

  private scheduleCheck(delayMs: number = C.CHECK_INTERVAL_MS): void {
    if (!this.started) return;
    this.checkTimer = this.setTimer(() => {
      this.checkTimer = null;
      void this.syncNow().finally(() => this.scheduleCheck());
    }, delayMs);
  }

  /**
   * Rebuild and upload when it changed (or the full resync is due). One pass
   * at a time; a call during one runs again after it. Never throws.
   *
   * @param force - Upload even when unchanged
   * @returns What happened
   */
  async syncNow(force = false): Promise<BriefingSyncOutcome> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let outcome: BriefingSyncOutcome = 'skipped';
      try {
        do {
          this.rerun = false;
          outcome = await this.pass(force);
        } while (this.rerun);
      } catch (error) {
        this.logger.warn('Drive briefing sync failed', { error: error instanceof Error ? error.message : String(error) });
        outcome = 'failed';
      }
      return outcome;
    })();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async pass(force: boolean): Promise<BriefingSyncOutcome> {
    if (isBriefingSyncDisabled(this.deps.env ?? process.env)) return 'skipped';
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) return 'skipped';
    if (this.now() < this.pausedUntil) return 'paused';
    const account = accountIdOfToken(token);
    if (account !== this.lastAccount) {
      this.lastAccount = account;
      this.lastKey = null;
      this.lastUploadAt = 0;
    }
    const { instanceId } = await this.deps.identity();
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return 'skipped';
    const snapshot = await this.deps.build();
    const key = snapshotKey(snapshot);
    const fullDue = this.now() - this.lastUploadAt >= C.FULL_SYNC_INTERVAL_MS;
    if (!force && !fullDue && key === this.lastKey) return 'unchanged';
    return this.upload(base, token, instanceId, snapshot, key);
  }

  private async upload(base: string, token: string, instanceId: string, snapshot: BriefingSnapshot, key: string, refreshed = false): Promise<BriefingSyncOutcome> {
    const url = `${base.replace(/\/+$/, '')}${C.PUT_PATH.replace(':instanceId', encodeURIComponent(instanceId))}`;
    let status = 0;
    let code: string | null = null;
    try {
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot }),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) {
        this.lastKey = key;
        this.lastUploadAt = this.now();
        this.failures = 0;
        if (this.pauseLogged) {
          this.pauseLogged = false;
          this.logger.info('Crewly Cloud is taking Drive mode status updates again');
        }
        return 'uploaded';
      }
      const parsed = (await res.json().catch(() => null)) as { code?: unknown } | null;
      code = typeof parsed?.code === 'string' ? parsed.code : null;
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }
    if (status === 401 && !refreshed && this.deps.cloud.tryRefreshToken && (await this.deps.cloud.tryRefreshToken().catch(() => false))) {
      const fresh = this.deps.cloud.getToken();
      if (fresh) return this.upload(base, fresh, instanceId, snapshot, key, true);
    }
    if (status === 404 || status === 400 || status === 503) {
      this.pausedUntil = this.now() + C.UNAVAILABLE_RETRY_MS;
      if (!this.pauseLogged) {
        this.pauseLogged = true;
        this.logger.info('Crewly Cloud is not taking Drive mode status updates; checking again in an hour', { status, code });
      }
      return 'paused';
    }
    this.failures += 1;
    const delay = Math.min(C.BACKOFF_INITIAL_MS * 2 ** (this.failures - 1), C.BACKOFF_MAX_MS);
    this.pausedUntil = this.now() + delay;
    if (this.failures === 1) this.logger.warn('Drive mode status upload failed; will retry', { status, code, retryInMs: delay });
    return 'failed';
  }
}
