/**
 * ConversationCloudSyncService — uploads this machine's conversation log to
 * Crewly Cloud (specs/unified-conversations-cloud-store.md §B).
 *
 * - **Live:** drains `cloud_outbox` (filled by triggers on `chat_messages`)
 *   in `seq` order, one request in flight, batches of ≤ 50 messages /
 *   256 KB, gzip. Wakes on every new chat message (after a 2 s gather) and
 *   on a 10 s tick. Rows leave the outbox only once Cloud acknowledged them.
 * - **Backfill:** after first sign-in (or an account switch, or a plan
 *   upgrade that widens the window) it re-sends the history inside the
 *   plan's retention window, oldest first, at most one request a second,
 *   after the live queue.
 * - **Disconnected / signed out:** the outbox stays on disk; it is only
 *   trimmed (older than 90 days, more than 200k rows — a history gap).
 * - **Failures:** exponential backoff 1 s → 5 min. A 404 (Cloud has no
 *   conversation store yet), `403 sync_disabled`, `503` key missing or a
 *   `400` batch Cloud refuses pause sync for an hour, logged once.
 * - **O1:** on by default for a signed-in machine; the owner gets one Slack
 *   DM the first time history reaches Cloud. `CREWLY_CONVERSATION_SYNC=0`
 *   (or `CREWLY_CLOUD_CONVERSATIONS=off`) turns uploading off; the outbox
 *   still fills.
 * - **O4:** text only — attachments go as name / size / mime.
 * - **Roster (Cloud Talk, Phase 3):** every 5 minutes, and whenever the
 *   advertised capabilities change, an empty batch carries this machine's
 *   agent roster and capabilities (`talk_message`), so Cloud lists agents
 *   that have no messages yet and knows Talk can be sent here — also on
 *   machines that do not use Slack (and so never send the Slack heartbeat).
 *
 * The wire contract lives in `conversation-ingest.contract.ts`.
 *
 * @module services/cloud/conversation-cloud-sync.service
 */

import { gzipSync } from 'zlib';
import { randomUUID } from 'crypto';
import { CLOUD_TALK_CONSTANTS, CONVERSATION_SYNC_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ownerVisibleContent } from '../chat-v2/ticket-line.utils.js';
import type {
  BackfillCursor,
  OutboxEntry,
  UploadMessageRow,
} from '../chat-v2/sqlite/cloud-outbox.store.js';
import {
  CONVERSATION_DIRECTIONS,
  CONVERSATION_INGEST_PATH,
  CONVERSATION_SOURCES,
  INGEST_ERROR_CODES,
  INGEST_LIMITS,
  INSTANCE_ID_PATTERN,
  SENDER_KINDS,
  isOneOf,
  parseIngestErrorCode,
  parseIngestResponse,
  type AgentRosterEntry,
  type IngestExt,
  type IngestMessage,
  type IngestMode,
  type IngestRequest,
  type IngestResponse,
  type IngestUpsert,
} from './conversation-ingest.contract.js';

const C = CONVERSATION_SYNC_CONSTANTS;
const K = C.STATE_KEYS;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The outbox operations the uploader needs (see `CloudOutboxStore`). */
export interface ConversationOutbox {
  peek(limit: number): OutboxEntry[];
  ackThrough(seq: number): number;
  count(): number;
  clear(): void;
  trim(options: { maxRows: number; olderThanMs: number }): number;
  getMessages(ids: readonly string[]): Map<string, UploadMessageRow>;
  backfillPage(sinceMs: number, after: BackfillCursor | null, limit: number): UploadMessageRow[];
  getState(key: string): string | null;
  setState(key: string, value: string | null): void;
  clearState(keep?: readonly string[]): void;
}

/** The Cloud session the uploader rides on (see `CloudClientService`). */
export interface ConversationSyncCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  /** Refresh an expired access token; resolves true when a new one is in place. */
  tryRefreshToken?(): Promise<boolean>;
}

/** `fetch` signature (injectable for tests). */
export type SyncFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Constructor dependencies. */
export interface ConversationCloudSyncDeps {
  outbox: ConversationOutbox;
  cloud: ConversationSyncCloud;
  /** Machine id (= device id = relay queue id = Slack instance id) and display name. */
  identity: () => Promise<{ instanceId: string; deviceName?: string }>;
  /** Short id of the Crewly home (`getCrewlyHomeId`). */
  homeId?: string;
  /** Crewly version reported with each batch. */
  crewlyVersion?: () => Promise<string>;
  /** Subscribe to new chat messages (wake-up); returns an unsubscribe function. */
  onNewMessage?: (listener: () => void) => () => void;
  /** Upgrade rows written before the owner's Slack id was known (run before a backfill). */
  reclassifyOwnerRows?: () => void;
  /** O1: tell the owner once that history now syncs. Resolves true when the DM was posted. */
  notifyOwner?: (text: string) => Promise<boolean>;
  /** This machine's agents, reported every few minutes (Cloud lists them before they have messages). */
  roster?: () => Promise<AgentRosterEntry[]>;
  /** What this machine handles right now (e.g. `talk_message`); a change is reported at once. */
  capabilities?: () => string[];
  /** Environment (kill switch). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: SyncFetch;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  logger?: ComponentLogger;
}

/** Why sync is paused for an hour. */
type PauseReason = 'not_deployed' | 'sync_disabled' | 'key_missing' | 'invalid_batch';

/** Outcome of one request. */
type SendOutcome =
  | { ok: true; response: IngestResponse }
  | { ok: false; status: number; code: string | null; message: string };

/**
 * Whether the kill switch is set.
 *
 * @param env - Environment
 * @returns True when uploading is switched off
 */
export function isConversationSyncDisabled(env: NodeJS.ProcessEnv): boolean {
  const off = (v: string | undefined) => typeof v === 'string' && ['0', 'off', 'false', 'no'].includes(v.trim().toLowerCase());
  return off(env[C.ENV_SWITCH]) || off(env[C.ENV_SWITCH_ALT]);
}

/**
 * The account a Cloud access token belongs to — the JWT `sub`, read without
 * verifying. An opaque token yields a constant, so token refreshes are never
 * mistaken for an account switch.
 *
 * @param token - Access token
 * @returns The account id
 */
export function accountIdOfToken(token: string): string {
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { sub?: unknown };
      if (typeof payload.sub === 'string' && payload.sub.length > 0) return payload.sub;
    } catch {
      // not a JWT
    }
  }
  return 'opaque-token';
}

/**
 * Parse a JSON column without throwing.
 *
 * @param raw - Column value
 * @returns The value, or undefined
 */
function parseJson(raw: string | null): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Map one stored message to the wire shape.
 *
 * @param row - Message row with its channel and attachment metadata
 * @param localSeq - Outbox seq (live) or 0 (backfill)
 * @returns The upsert, or null when the row must not leave the machine
 */
export function toIngestUpsert(row: UploadMessageRow, localSeq: number): IngestUpsert | null {
  if (row.cloudSync === 0) return null;
  const mentionsRaw = parseJson(row.mentions);
  const mentions = Array.isArray(mentionsRaw) ? mentionsRaw.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  const metadata = parseJson(row.metadata);
  const md = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const extRaw = parseJson(row.extRef);
  const ext =
    extRaw && typeof extRaw === 'object' && !Array.isArray(extRaw) && Object.keys(extRaw).length > 0 ? (extRaw as IngestExt) : undefined;

  const source = isOneOf(CONVERSATION_SOURCES, row.source) ? row.source : 'crewly-chat';
  const direction = isOneOf(CONVERSATION_DIRECTIONS, row.direction)
    ? row.direction
    : row.senderType === 'agent'
      ? 'out'
      : row.senderType === 'system'
        ? 'internal'
        : 'in';
  const senderKind = isOneOf(SENDER_KINDS, row.senderKind)
    ? row.senderKind
    : row.senderType === 'user'
      ? 'owner'
      : row.senderType;
  const agentSession = row.agentSession || mentions[0] || row.leadMember || ORCHESTRATOR_SESSION_NAME;
  // A Slack person is identified by their Slack id; the display name rides along.
  const slackUserId = typeof ext?.slackUserId === 'string' ? ext.slackUserId : undefined;
  const sender =
    row.senderType === 'user' && source === 'slack' && slackUserId && slackUserId !== row.senderId
      ? { id: slackUserId, name: row.senderId }
      : { id: row.senderId || row.senderType };
  const clientMessageId = source === 'cloud-talk' && typeof md.clientMessageId === 'string' ? md.clientMessageId : undefined;

  return {
    localId: row.id,
    op: 'upsert',
    channel: { localId: row.channelId, kind: row.channelType, name: row.channelName },
    agentSession,
    ...(mentions.length > 0 ? { mentions } : {}),
    source,
    direction,
    senderKind,
    sender,
    ...(ext ? { ext } : {}),
    ...(row.threadId ? { threadLocalId: row.threadId } : {}),
    // Legacy owner rows may carry the harness ticket line; never sync it.
    text: ownerVisibleContent(row.senderType, row.content),
    contentType: row.contentType,
    attachments: row.attachments.map((a) => ({
      kind: a.kind,
      mime: a.mimeType,
      size: a.sizeBytes,
      ...(a.originalName ? { name: a.originalName } : {}),
    })),
    ...(clientMessageId ? { clientMessageId } : {}),
    createdAt: row.createdAt,
    localSeq,
  };
}

/**
 * Bytes one message adds to a request body (JSON, before gzip).
 *
 * @param message - Wire message
 * @returns Approximate byte size
 */
function sizeOf(message: IngestMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Uploads the machine's conversation log to Crewly Cloud. */
export class ConversationCloudSyncService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: SyncFetch;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private started = false;
  private running = false;
  private rerun = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Consecutive failures; drives the exponential backoff. */
  private failures = 0;
  /** No request before this time (backoff or an hour-long pause). */
  private pausedUntil = 0;
  /** Reasons already logged, so a long pause logs once. */
  private readonly loggedPauses = new Set<PauseReason>();
  /** Current live batch cap; halved on 413. */
  private batchLimit: number = C.BATCH_MAX_MESSAGES;
  private lastBackfillAt = 0;
  private lastNoticeAttemptAt = 0;
  private gapLogged = false;
  /** When the roster last reached Cloud, and the capabilities it carried. */
  private lastRosterAt = 0;
  private lastCapabilitiesKey: string | null = null;

  constructor(private readonly deps: ConversationCloudSyncDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('ConversationCloudSync');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h));
  }

  /** Start the tick and the new-message wake-up. Idempotent; never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (isConversationSyncDisabled(this.deps.env ?? process.env)) {
      this.logger.info('Conversation sync to Crewly Cloud is off (CREWLY_CONVERSATION_SYNC=0); the local log still fills');
    }
    try {
      this.unsubscribe = this.deps.onNewMessage?.(() => this.wake()) ?? null;
    } catch {
      this.unsubscribe = null;
    }
    this.scheduleTick();
    this.wake(0);
  }

  /** Stop timers and the wake-up subscription. */
  stop(): void {
    this.started = false;
    if (this.tickTimer) this.clearTimer(this.tickTimer);
    if (this.wakeTimer) this.clearTimer(this.wakeTimer);
    this.tickTimer = null;
    this.wakeTimer = null;
    try {
      this.unsubscribe?.();
    } catch {
      // ignore
    }
    this.unsubscribe = null;
  }

  /**
   * Run one sync pass now (tests, and the timers). Never throws; a pass
   * already in flight makes this one run again right after it.
   */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun);
    } catch (error) {
      this.logger.warn('Conversation sync pass failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = false;
    }
  }

  /**
   * Schedule a pass after a new message: immediately once a full batch is
   * waiting, otherwise after the gather delay.
   *
   * @param delayMs - Override the delay
   */
  private wake(delayMs?: number): void {
    if (!this.started) return;
    let delay = delayMs;
    if (delay === undefined) {
      let waiting = 0;
      try {
        waiting = this.deps.outbox.count();
      } catch {
        waiting = 0;
      }
      delay = waiting >= this.batchLimit ? 0 : C.BATCH_MAX_WAIT_MS;
    }
    if (this.wakeTimer) return;
    this.wakeTimer = this.setTimer(() => {
      this.wakeTimer = null;
      void this.syncNow();
    }, delay);
  }

  /** Keep the periodic tick going. */
  private scheduleTick(): void {
    if (!this.started) return;
    this.tickTimer = this.setTimer(() => {
      this.tickTimer = null;
      void this.syncNow().finally(() => this.scheduleTick());
    }, C.TICK_INTERVAL_MS);
  }

  /** One pass: trim, check the session, drain live, then one backfill step. */
  private async pass(): Promise<void> {
    this.trimOutbox();
    if (isConversationSyncDisabled(this.deps.env ?? process.env)) return;
    const token = this.deps.cloud.getToken();
    const base = this.deps.cloud.getCloudUrl();
    if (!token || !base) return;
    if (this.now() < this.pausedUntil) return;

    this.checkAccount(token);

    const { instanceId, deviceName } = await this.deps.identity();
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
      this.pause('invalid_batch', `instance id "${instanceId}" is not accepted by Cloud`);
      return;
    }
    const version = (await this.deps.crewlyVersion?.().catch(() => undefined)) ?? undefined;
    const envelope = { instanceId, deviceName, version };

    // The plan window comes from an empty ingest (spec §B.4); the same empty
    // batch carries the roster when it is due.
    const roster = await this.rosterIfDue();
    if (!this.deps.outbox.getState(K.RETENTION_DAYS) || roster) {
      const probe = await this.send(base, token, envelope, 'live', [], roster ?? undefined);
      if (!this.settle(probe)) return;
      if (roster) {
        this.lastRosterAt = this.now();
        this.lastCapabilitiesKey = JSON.stringify(roster.capabilities ?? []);
      }
    }

    if (!(await this.drainLive(base, token, envelope))) return;
    await this.backfillStep(base, token, envelope);
  }

  /**
   * The roster and capabilities when they are due: every
   * {@link CLOUD_TALK_CONSTANTS.ROSTER_INTERVAL_MS}, or at once when the
   * capabilities changed (the Talk handler starting after the uploader).
   *
   * @returns The fields to send, or null when nothing is due
   */
  private async rosterIfDue(): Promise<{ roster?: AgentRosterEntry[]; capabilities?: string[] } | null> {
    if (!this.deps.roster && !this.deps.capabilities) return null;
    let capabilities: string[] | undefined;
    try {
      capabilities = this.deps.capabilities?.();
    } catch {
      capabilities = undefined;
    }
    const capsChanged = capabilities !== undefined && JSON.stringify(capabilities) !== this.lastCapabilitiesKey;
    if (!capsChanged && this.now() - this.lastRosterAt < CLOUD_TALK_CONSTANTS.ROSTER_INTERVAL_MS) return null;
    let roster: AgentRosterEntry[] | undefined;
    try {
      roster = await this.deps.roster?.();
    } catch (error) {
      this.logger.debug('Agent roster unavailable for Crewly Cloud', { error: error instanceof Error ? error.message : String(error) });
      roster = undefined;
    }
    if (!roster && capabilities === undefined) return null;
    return { ...(roster ? { roster } : {}), ...(capabilities !== undefined ? { capabilities } : {}) };
  }

  /**
   * Upload every waiting outbox row, oldest first.
   *
   * @returns False when a request failed (the pass stops)
   */
  private async drainLive(
    base: string,
    token: string,
    envelope: { instanceId: string; deviceName?: string; version?: string },
  ): Promise<boolean> {
    for (;;) {
      const entries = this.deps.outbox.peek(this.batchLimit);
      if (entries.length === 0) return true;
      const rows = this.deps.outbox.getMessages(entries.filter((e) => e.op === 'upsert').map((e) => e.messageId));
      const messages: IngestMessage[] = [];
      let bytes = 0;
      let lastSeq = entries[0]!.seq - 1;
      for (const entry of entries) {
        let message: IngestMessage | null;
        if (entry.op === 'delete') {
          message = { localId: entry.messageId, localSeq: entry.seq, op: 'delete' };
        } else {
          const row = rows.get(entry.messageId);
          // Deleted since, or not for Cloud: settled without sending.
          message = row ? toIngestUpsert(row, entry.seq) : null;
        }
        if (message) {
          const size = sizeOf(message);
          if (messages.length > 0 && bytes + size > C.BATCH_MAX_BYTES) break;
          messages.push(message);
          bytes += size;
        }
        lastSeq = entry.seq;
      }
      if (messages.length === 0) {
        this.deps.outbox.ackThrough(lastSeq);
        continue;
      }
      const outcome = await this.send(base, token, envelope, 'live', messages);
      if (!outcome.ok && outcome.status === 413) {
        if (messages.length > 1) {
          this.batchLimit = Math.max(1, Math.floor(messages.length / 2));
          continue;
        }
        // One message Cloud will never take: drop it rather than wedge the outbox.
        this.logger.warn('Cloud refused a message as too large; skipping it', { localId: messages[0]!.localId });
        this.deps.outbox.ackThrough(lastSeq);
        continue;
      }
      if (!this.settle(outcome)) return false;
      const acked = outcome.ok ? outcome.response.ackedThroughLocalSeq : null;
      this.deps.outbox.ackThrough(acked === null ? lastSeq : Math.min(acked, lastSeq));
      if (acked !== null && acked < lastSeq) return true; // Cloud settled less; resume next pass.
    }
  }

  /**
   * Send one page of history when a backfill is owed (first sign-in, account
   * switch, or a wider window after an upgrade). At most one request per
   * second; live rows always go first.
   */
  private async backfillStep(
    base: string,
    token: string,
    envelope: { instanceId: string; deviceName?: string; version?: string },
  ): Promise<void> {
    const retention = Number(this.deps.outbox.getState(K.RETENTION_DAYS)) || C.DEFAULT_RETENTION_DAYS;
    const doneFor = Number(this.deps.outbox.getState(K.BACKFILL_RETENTION_DAYS)) || 0;
    if (this.deps.outbox.getState(K.BACKFILL_DONE_AT) && doneFor >= retention) return;
    if (this.deps.outbox.getState(K.BACKFILL_DONE_AT) && doneFor < retention) {
      // Plan upgrade: a wider window — send it again from the start.
      this.deps.outbox.setState(K.BACKFILL_DONE_AT, null);
      this.deps.outbox.setState(K.BACKFILL_CURSOR, null);
    }
    const sinceLast = this.now() - this.lastBackfillAt;
    if (sinceLast < C.BACKFILL_MIN_INTERVAL_MS) {
      this.wake(C.BACKFILL_MIN_INTERVAL_MS - sinceLast);
      return;
    }
    if (!this.deps.outbox.getState(K.BACKFILL_CURSOR)) {
      try {
        this.deps.reclassifyOwnerRows?.();
      } catch {
        // best effort
      }
    }

    const cursorRaw = parseJson(this.deps.outbox.getState(K.BACKFILL_CURSOR)) as BackfillCursor | undefined;
    const cursor = cursorRaw && typeof cursorRaw.createdAt === 'number' && typeof cursorRaw.rowid === 'number' ? cursorRaw : null;
    const since = this.now() - retention * DAY_MS;
    const page = this.deps.outbox.backfillPage(since, cursor, Math.min(C.BACKFILL_PAGE_SIZE, INGEST_LIMITS.MAX_MESSAGES));
    if (page.length === 0) {
      this.deps.outbox.setState(K.BACKFILL_DONE_AT, String(this.now()));
      this.deps.outbox.setState(K.BACKFILL_RETENTION_DAYS, String(retention));
      this.deps.outbox.setState(K.BACKFILL_CURSOR, null);
      this.logger.info('Conversation history backfill to Crewly Cloud finished', { retentionDays: retention });
      return;
    }
    const messages: IngestMessage[] = [];
    let bytes = 0;
    let last: UploadMessageRow = page[0]!;
    for (const row of page) {
      const message = toIngestUpsert(row, 0);
      if (message) {
        const size = sizeOf(message);
        if (messages.length > 0 && bytes + size > C.BACKFILL_BATCH_MAX_BYTES) break;
        messages.push(message);
        bytes += size;
      }
      last = row;
    }
    this.lastBackfillAt = this.now();
    if (messages.length > 0) {
      const outcome = await this.send(base, token, envelope, 'backfill', messages);
      if (!this.settle(outcome)) return;
    }
    this.deps.outbox.setState(K.BACKFILL_CURSOR, JSON.stringify({ createdAt: last.createdAt, rowid: last.rowid }));
    this.wake(C.BACKFILL_MIN_INTERVAL_MS);
  }

  /**
   * POST one batch (gzip). Never throws.
   *
   * @returns The parsed outcome
   */
  private async send(
    base: string,
    token: string,
    envelope: { instanceId: string; deviceName?: string; version?: string },
    mode: IngestMode,
    messages: IngestMessage[],
    extras?: { roster?: AgentRosterEntry[]; capabilities?: string[] },
  ): Promise<SendOutcome> {
    const body: IngestRequest = {
      ...(extras?.roster ? { roster: extras.roster } : {}),
      ...(extras?.capabilities ? { capabilities: extras.capabilities } : {}),
      instanceId: envelope.instanceId,
      ...(this.deps.homeId ? { homeId: this.deps.homeId } : {}),
      ...(envelope.version ? { crewlyVersion: envelope.version } : {}),
      ...(envelope.deviceName ? { deviceName: envelope.deviceName } : {}),
      batchId: randomUUID(),
      mode,
      messages,
    };
    const url = `${base.replace(/\/$/, '')}${CONVERSATION_INGEST_PATH}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Encoding': 'gzip',
        },
        body: gzipSync(Buffer.from(JSON.stringify(body), 'utf8')),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, status: 0, code: null, message: error instanceof Error ? error.message : String(error) };
    }
    const parsed = (await response.json().catch(() => null)) as unknown;
    if (response.ok) return { ok: true, response: parseIngestResponse(parsed) };
    return {
      ok: false,
      status: response.status,
      code: parseIngestErrorCode(parsed),
      message: `HTTP ${response.status}`,
    };
  }

  /**
   * Book the result of a request: remember the retention window, reset or
   * advance the backoff, pause on the hour-long conditions.
   *
   * @returns True on success
   */
  private settle(outcome: SendOutcome): boolean {
    if (outcome.ok) {
      this.failures = 0;
      this.pausedUntil = 0;
      this.batchLimit = C.BATCH_MAX_MESSAGES;
      if (this.loggedPauses.size > 0) {
        this.logger.info('Crewly Cloud is taking conversation history again');
        this.loggedPauses.clear();
      }
      const days = outcome.response.retentionDays;
      if (days !== null && days > 0) this.deps.outbox.setState(K.RETENTION_DAYS, String(days));
      this.deps.outbox.setState(K.LAST_INGEST_AT, String(this.now()));
      void this.maybeNotifyOwner();
      return true;
    }
    const { status, code } = outcome;
    if (status === 404) {
      this.pause('not_deployed', 'Crewly Cloud has no conversation store yet; checking again in an hour');
    } else if (status === 403 && code === INGEST_ERROR_CODES.SYNC_DISABLED) {
      this.pause('sync_disabled', 'Conversation sync is switched off for this Crewly Cloud account; checking again in an hour');
    } else if (status === 503 && code === INGEST_ERROR_CODES.KEY_MISSING) {
      this.pause('key_missing', 'Crewly Cloud cannot store conversations right now (key missing); checking again in an hour');
    } else if (status === 400) {
      this.pause('invalid_batch', `Crewly Cloud refused a conversation batch (${code ?? 'invalid_batch'}); checking again in an hour`);
    } else {
      if (status === 401) void this.deps.cloud.tryRefreshToken?.().catch(() => false);
      this.failures += 1;
      const delay = Math.min(C.BACKOFF_INITIAL_MS * 2 ** (this.failures - 1), C.BACKOFF_MAX_MS);
      this.pausedUntil = this.now() + delay;
      if (this.failures === 1 || delay === C.BACKOFF_MAX_MS) {
        this.logger.warn('Conversation upload failed; will retry', { status, code, error: outcome.message, retryInMs: delay });
      }
      this.wake(delay);
    }
    return false;
  }

  /**
   * Pause for an hour, logging the reason once.
   *
   * @param reason - Why
   * @param message - Log line
   */
  private pause(reason: PauseReason, message: string): void {
    this.pausedUntil = this.now() + C.UNAVAILABLE_RETRY_MS;
    if (!this.loggedPauses.has(reason)) {
      this.loggedPauses.add(reason);
      this.logger.info(message);
    }
  }

  /**
   * On an account switch, start over: the new account gets this machine's
   * history through a fresh backfill, never the old account's queue.
   *
   * @param token - Current access token
   */
  private checkAccount(token: string): void {
    const account = accountIdOfToken(token);
    const stored = this.deps.outbox.getState(K.ACCOUNT_ID);
    if (stored === account) return;
    if (stored !== null) {
      this.logger.info('Crewly Cloud account changed; conversation history will be sent again for the new account');
      this.deps.outbox.clear();
      this.deps.outbox.clearState([K.NOTICE_SENT_AT]);
    }
    this.deps.outbox.setState(K.ACCOUNT_ID, account);
  }

  /** Keep the outbox bounded; log a history gap once. */
  private trimOutbox(): void {
    try {
      const dropped = this.deps.outbox.trim({ maxRows: C.OUTBOX_MAX_ROWS, olderThanMs: this.now() - C.OUTBOX_MAX_AGE_MS });
      if (dropped > 0) {
        this.deps.outbox.setState(K.GAP_AT, String(this.now()));
        if (!this.gapLogged) {
          this.gapLogged = true;
          this.logger.warn('Conversation outbox over its limit; oldest rows dropped (history gap on Crewly Cloud)', { dropped });
        }
      }
    } catch {
      // trimming is housekeeping
    }
  }

  /** O1: one DM to the owner the first time history reaches Cloud. */
  private async maybeNotifyOwner(): Promise<void> {
    if (!this.deps.notifyOwner) return;
    if (this.deps.outbox.getState(K.NOTICE_SENT_AT)) return;
    if (this.now() - this.lastNoticeAttemptAt < C.UNAVAILABLE_RETRY_MS && this.lastNoticeAttemptAt > 0) return;
    this.lastNoticeAttemptAt = this.now();
    // Claim it first so two quick successes cannot send two DMs.
    this.deps.outbox.setState(K.NOTICE_SENT_AT, String(this.now()));
    let posted = false;
    try {
      const { deviceName } = await this.deps.identity();
      posted = await this.deps.notifyOwner(C.NOTICE_TEXT.replace('{device}', deviceName || 'this machine'));
    } catch (error) {
      this.logger.debug('Conversation sync notice not sent', { error: error instanceof Error ? error.message : String(error) });
    }
    if (!posted) this.deps.outbox.setState(K.NOTICE_SENT_AT, null);
  }
}

let instance: ConversationCloudSyncService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The service, or null
 */
export function setConversationCloudSyncService(service: ConversationCloudSyncService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before wiring.
 *
 * @returns The service or null
 */
export function getConversationCloudSyncService(): ConversationCloudSyncService | null {
  return instance;
}
