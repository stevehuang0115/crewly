/**
 * WaitingItemsSyncService — keeps Crewly Cloud's "Waiting on you" list in
 * step with this machine (specs/unified-conversations-cloud-store.md §F,
 * Phase 5).
 *
 * "Waiting on you" = tickets in 待验收 (board column `to_review`): work an
 * agent handed back for the owner's OK. The column is derived, not stored,
 * so this service recomputes the set and uploads a text snapshot
 * (`POST /api/cloud/conversations/waiting/ingest`, `full: true`) whenever it
 * changed:
 *
 * - on a Request write (RequestService.onChange), gathered for 2 s;
 * - on a 30 s check (a WorkItem finishing can move a ticket into 待验收
 *   without touching its Request file) — uploads only when the set differs
 *   from what Cloud last took;
 * - every 5 minutes regardless (a full resync: Cloud refreshes the items'
 *   `syncedAt`, so the portal knows the machine is alive, and drops anything
 *   this machine no longer has);
 * - after an accept / send-back from the portal was carried out.
 *
 * Every upload is the whole set, so a ticket that left 待验收 disappears in
 * Cloud with the next upload. Uses the machine's own Cloud token (same as
 * the conversation uploader); signed out = nothing is sent. The conversation
 * sync kill switch (`CREWLY_CONVERSATION_SYNC=0`) turns this off too.
 *
 * @module services/cloud/waiting-items-sync.service
 */

import { WAITING_SYNC_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { TicketListItem } from '../v3/ticket-intake.service.js';
import { accountIdOfToken, isConversationSyncDisabled } from './conversation-cloud-sync.service.js';
import { INSTANCE_ID_PATTERN } from './conversation-ingest.contract.js';
import { toWaitingIngestItem, type WaitingIngestItem, type WaitingIngestRequest } from './waiting-items.contract.js';

const C = WAITING_SYNC_CONSTANTS;

/** The Cloud session (CloudClientService). */
export interface WaitingSyncCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  tryRefreshToken?(): Promise<boolean>;
}

/** `fetch` signature (injectable for tests). */
export type WaitingSyncFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Constructor dependencies. */
export interface WaitingItemsSyncDeps {
  /** Tickets in 待验收 right now (board rows, `column: 'to_review'`). */
  listWaiting: () => Promise<TicketListItem[]>;
  cloud: WaitingSyncCloud;
  /** This machine's id (device id = relay queue id = Cloud instance id) and name. */
  identity: () => Promise<{ instanceId: string; deviceName?: string }>;
  crewlyVersion?: () => Promise<string>;
  /** Display names of the machine's agents (session → name). */
  agentNames?: () => Promise<Map<string, string>>;
  /** What this machine handles right now (`waiting_actions`, …). */
  capabilities?: () => string[];
  /** Subscribe to ticket writes; returns an unsubscribe function. */
  onTicketChange?: (listener: () => void) => () => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: WaitingSyncFetch;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: ComponentLogger;
}

/** What one {@link WaitingItemsSyncService.syncNow} did (tests, logs). */
export type WaitingSyncOutcome = 'uploaded' | 'unchanged' | 'skipped' | 'failed' | 'paused';

/** Uploads the machine's "waiting on you" set to Crewly Cloud. */
export class WaitingItemsSyncService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: WaitingSyncFetch;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private started = false;
  private running: Promise<WaitingSyncOutcome> | null = null;
  private rerun = false;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Snapshot Cloud last took (items + capabilities), per account. */
  private lastKey: string | null = null;
  private lastAccount: string | null = null;
  private lastFullAt = 0;
  private failures = 0;
  private pausedUntil = 0;
  private pauseLogged = false;

  constructor(private readonly deps: WaitingItemsSyncDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('WaitingItemsSync');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /** Start watching tickets and the periodic check. Idempotent; never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.unsubscribe = this.deps.onTicketChange?.(() => this.requestSync()) ?? null;
    } catch {
      this.unsubscribe = null;
    }
    this.scheduleCheck(0);
  }

  /** Stop timers and the ticket subscription. */
  stop(): void {
    this.started = false;
    if (this.checkTimer) this.clearTimer(this.checkTimer);
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.checkTimer = null;
    this.debounceTimer = null;
    try {
      this.unsubscribe?.();
    } catch {
      // ignore
    }
    this.unsubscribe = null;
  }

  /**
   * Upload soon (after the 2 s gather) — a ticket changed, or an action from
   * the portal was carried out.
   */
  requestSync(): void {
    if (!this.started || this.debounceTimer) return;
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, C.DEBOUNCE_MS);
  }

  /** Keep the periodic check going. */
  private scheduleCheck(delayMs: number = C.CHECK_INTERVAL_MS): void {
    if (!this.started) return;
    this.checkTimer = this.setTimer(() => {
      this.checkTimer = null;
      void this.syncNow().finally(() => this.scheduleCheck());
    }, delayMs);
  }

  /**
   * Recompute the set and upload it when it changed (or a full resync is
   * due). One upload at a time; a call during one runs again after it.
   * Never throws.
   *
   * @param force - Upload even when nothing changed
   * @returns What happened
   */
  async syncNow(force = false): Promise<WaitingSyncOutcome> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let outcome: WaitingSyncOutcome = 'skipped';
      try {
        do {
          this.rerun = false;
          outcome = await this.pass(force);
        } while (this.rerun);
      } catch (error) {
        this.logger.warn('Waiting items sync failed', { error: error instanceof Error ? error.message : String(error) });
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

  private async pass(force: boolean): Promise<WaitingSyncOutcome> {
    if (isConversationSyncDisabled(this.deps.env ?? process.env)) return 'skipped';
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) return 'skipped';
    if (this.now() < this.pausedUntil) return 'paused';

    const account = accountIdOfToken(token);
    if (account !== this.lastAccount) {
      // New sign-in or another account: the first upload is a full one.
      this.lastAccount = account;
      this.lastKey = null;
      this.lastFullAt = 0;
    }

    const { instanceId, deviceName } = await this.deps.identity();
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return 'skipped';

    const rows = await this.deps.listWaiting();
    const names = await this.deps.agentNames?.().catch(() => new Map<string, string>());
    const items: WaitingIngestItem[] = rows
      .filter((r) => r.column === 'to_review')
      .map((r) => toWaitingIngestItem(r, (s) => names?.get(s)))
      .sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    let capabilities: string[] = [];
    try {
      capabilities = this.deps.capabilities?.() ?? [];
    } catch {
      capabilities = [];
    }
    const key = JSON.stringify([items, capabilities, deviceName ?? null]);
    const fullDue = this.now() - this.lastFullAt >= C.FULL_SYNC_INTERVAL_MS;
    if (!force && !fullDue && key === this.lastKey) return 'unchanged';

    const version = (await this.deps.crewlyVersion?.().catch(() => undefined)) ?? undefined;
    const body: WaitingIngestRequest = {
      instanceId,
      ...(deviceName ? { deviceName } : {}),
      ...(version ? { crewlyVersion: version } : {}),
      full: true,
      items,
      capabilities,
    };
    return this.upload(base, token, body, key);
  }

  /** POST the snapshot and book the outcome. */
  private async upload(base: string, token: string, body: WaitingIngestRequest, key: string): Promise<WaitingSyncOutcome> {
    const url = `${base.replace(/\/$/, '')}${C.INGEST_PATH}`;
    let status = 0;
    let code: string | null = null;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      if (response.ok) {
        this.lastKey = key;
        this.lastFullAt = this.now();
        this.failures = 0;
        if (this.pauseLogged) {
          this.pauseLogged = false;
          this.logger.info('Crewly Cloud is taking "waiting on you" updates again');
        }
        this.logger.debug('Waiting items uploaded', { count: body.items.length });
        return 'uploaded';
      }
      const parsed = (await response.json().catch(() => null)) as { code?: unknown } | null;
      code = typeof parsed?.code === 'string' ? parsed.code : null;
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }

    if (status === 404 || status === 400 || status === 503 || (status === 403 && code === 'sync_disabled')) {
      // Not deployed yet, refused, key missing or switched off: check again in an hour.
      this.pausedUntil = this.now() + C.UNAVAILABLE_RETRY_MS;
      if (!this.pauseLogged) {
        this.pauseLogged = true;
        this.logger.info('Crewly Cloud is not taking "waiting on you" updates right now; checking again in an hour', { status, code });
      }
      return 'paused';
    }
    if (status === 401) void this.deps.cloud.tryRefreshToken?.().catch(() => false);
    this.failures += 1;
    const delay = Math.min(C.BACKOFF_INITIAL_MS * 2 ** (this.failures - 1), C.BACKOFF_MAX_MS);
    this.pausedUntil = this.now() + delay;
    if (this.failures === 1) this.logger.warn('Waiting items upload failed; will retry', { status, code, retryInMs: delay });
    return 'failed';
  }
}

let instance: WaitingItemsSyncService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service, or null
 */
export function setWaitingItemsSyncService(service: WaitingItemsSyncService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getWaitingItemsSyncService(): WaitingItemsSyncService | null {
  return instance;
}
