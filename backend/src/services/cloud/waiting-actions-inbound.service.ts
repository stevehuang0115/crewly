/**
 * WaitingActionsInboundService — the machine side of "Waiting on you"
 * actions (specs/unified-conversations-cloud-store.md §F, Phase 5).
 *
 * The owner taps "Looks good" (验过了) or "Send back" (打回, with what still
 * needs fixing) in the Crewly Cloud portal. Cloud stores the action and
 * pushes a `waiting_action` relay message to this machine with only ids in
 * it (`{actionId, itemId, instanceId, ticketId}`) — the same secure pattern
 * as Cloud Talk. This service:
 *
 *  1. fetches the action with this machine's own Cloud token
 *     (`GET /api/cloud/conversations/waiting/actions/:actionId?instanceId=`).
 *     Cloud answers only for an action stored on the token's account and
 *     addressed to this machine, so a push anybody else dropped in the relay
 *     queue is never run; the fetched ids must match the push;
 *  2. runs it through the ticket review service — the same code as the
 *     board's `POST /api/tickets/:id/verify` / `…/reject` (a send-back from
 *     Cloud behaves like one from the board: the reason becomes an acceptance
 *     criterion and a rework WorkItem is queued for whoever answered);
 *  3. reports the result (`POST …/actions/:actionId/result`) so Cloud removes
 *     the item — or shows the owner why it could not be done — and asks the
 *     waiting uploader for a fresh snapshot.
 *
 * Idempotent: an action already carried out is not run again when Cloud
 * re-pushes it (it only re-reports), and the ticket service itself refuses
 * to accept a ticket twice.
 *
 * Older OSS versions ignore `waiting_action` (every relay listener filters on
 * its own `type`), and Cloud only sends it to machines advertising the
 * `waiting_actions` capability, which this service turns on when it starts.
 *
 * @module services/cloud/waiting-actions-inbound.service
 */

import { WAITING_SYNC_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { ReviewActionResult } from '../v3/ticket-review.service.js';
import type { IncomingMessage } from './cloud-sync.types.js';
import {
  parseWaitingActionFetchResponse,
  parseWaitingActionRelayData,
  type WaitingActionFetchResponse,
  type WaitingActionRelayData,
  type WaitingActionResultRequest,
} from './waiting-items.contract.js';

const C = WAITING_SYNC_CONSTANTS;

/** Emitter of relay messages (CloudSyncService). */
export interface WaitingActionsSource {
  on(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
  off(event: 'message', listener: (msg: IncomingMessage) => void): unknown;
}

/** The Cloud session (CloudClientService). */
export interface WaitingActionsCloud {
  getToken(): string | null;
  getCloudUrl(): string | null;
  tryRefreshToken?(): Promise<boolean>;
}

/** The ticket review operations (TicketReviewService). */
export interface WaitingActionsReview {
  verify(ref: string): Promise<ReviewActionResult>;
  reject(ref: string, reason: string, via: 'board'): Promise<ReviewActionResult>;
}

/** `fetch` signature (injectable for tests). */
export type WaitingActionsFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Constructor dependencies. */
export interface WaitingActionsInboundDeps {
  source: WaitingActionsSource;
  cloud: WaitingActionsCloud;
  /** The review service, or null before boot wired it. */
  review: () => WaitingActionsReview | null;
  /** This machine's id and name. */
  identity: () => Promise<{ instanceId: string; deviceName?: string }>;
  /** Ask the waiting uploader for a fresh snapshot. */
  requestResync?: () => void;
  fetchImpl?: WaitingActionsFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: ComponentLogger;
}

/** What {@link WaitingActionsInboundService.handle} did with one push (tests, logs). */
export type WaitingActionOutcome =
  | 'done'
  | 'refused'
  | 'duplicate'
  | 'ignored'
  | 'not_for_this_machine'
  | 'unverified'
  | 'expired'
  | 'fetch_failed';

type FetchOutcome =
  | { kind: 'ok'; action: WaitingActionFetchResponse }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'error'; error: string };

let active = false;

/**
 * Capabilities to advertise to Cloud (heartbeat and uploads).
 *
 * @returns `['waiting_actions']` while the handler runs, else `[]`
 */
export function waitingActionCapabilities(): string[] {
  return active ? [C.CAPABILITY] : [];
}

/**
 * Words for the owner when the machine could not do an action.
 *
 * @param reason - Ticket review refusal
 * @param device - Machine name
 * @returns Owner-readable text
 */
export function refusalText(reason: Exclude<ReviewActionResult, { ok: true }>['reason'], device: string): string {
  switch (reason) {
    case 'open_work':
      return `Work on this is still running on ${device}. Try again when it has finished.`;
    case 'invalid':
      return 'Say what still needs fixing.';
    case 'not_found':
      return `${device} no longer has this.`;
    case 'not_in_review':
      return 'This is no longer waiting for your review.';
    case 'already_done':
      return 'This was already accepted.';
    case 'cancelled':
      return 'This was cancelled.';
    default:
      return `${device} could not do this.`;
  }
}

/** Runs accept / send-back pushed from Crewly Cloud — see module docs. */
export class WaitingActionsInboundService {
  private readonly logger: ComponentLogger;
  private readonly fetchImpl: WaitingActionsFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();
  /** Actions already carried out → the result to report again on a re-push. */
  private readonly done = new Map<string, { at: number; result: WaitingActionResultRequest }>();
  private readonly listener = (msg: IncomingMessage): void => {
    void this.handle(msg);
  };
  private started = false;

  constructor(private readonly deps: WaitingActionsInboundDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('WaitingActionsInbound');
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Subscribe to relay messages and advertise the capability. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.source.on('message', this.listener);
    active = true;
    this.logger.info('"Waiting on you" action handler started');
  }

  /** Unsubscribe; the capability is no longer advertised. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.source.off('message', this.listener);
    active = false;
  }

  /**
   * Handle one relay message. Anything but a well-formed `waiting_action` is
   * ignored. Never throws.
   *
   * @param msg - Relay message from CloudSyncService
   * @returns What was done
   */
  async handle(msg: IncomingMessage): Promise<WaitingActionOutcome> {
    if (msg?.type !== C.RELAY_MESSAGE_TYPE) return 'ignored';
    const data = parseWaitingActionRelayData(msg.payload);
    if (!data) {
      this.logger.warn('Ignored a malformed waiting_action relay message');
      return 'ignored';
    }
    if (this.inFlight.has(data.actionId)) return 'duplicate';
    this.inFlight.add(data.actionId);
    try {
      return await this.process(data);
    } catch (error) {
      this.logger.warn('"Waiting on you" action failed', {
        actionId: data.actionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'fetch_failed';
    } finally {
      this.inFlight.delete(data.actionId);
    }
  }

  private async process(data: WaitingActionRelayData): Promise<WaitingActionOutcome> {
    const { instanceId, deviceName } = await this.deps.identity();
    if (data.instanceId !== instanceId) {
      this.logger.warn('Ignored a waiting_action addressed to another machine', { target: data.instanceId });
      return 'not_for_this_machine';
    }
    this.pruneDone();
    const earlier = this.done.get(data.actionId);
    if (earlier) {
      // Cloud re-pushed an action already carried out (our report was lost): report again.
      await this.report(data.actionId, earlier.result);
      return 'duplicate';
    }

    const fetched = await this.fetchAction(data, instanceId);
    if (fetched.kind === 'not_found') {
      this.logger.warn('Ignored a waiting_action Crewly Cloud does not know for this machine', { actionId: data.actionId });
      return 'unverified';
    }
    if (fetched.kind === 'expired') return 'expired';
    if (fetched.kind === 'error') {
      this.logger.warn('Could not fetch a "waiting on you" action; Cloud will push it again', { actionId: data.actionId, error: fetched.error });
      return 'fetch_failed';
    }
    const action = fetched.action;
    if (action.actionId !== data.actionId || action.ticketId !== data.ticketId || action.instanceId !== instanceId || action.itemId !== data.itemId) {
      this.logger.warn('Ignored a waiting_action that does not match what Cloud stored', { actionId: data.actionId });
      return 'unverified';
    }

    const device = deviceName || 'this machine';
    const review = this.deps.review();
    if (!review) {
      // Boot has not wired tickets yet — Cloud re-pushes in 5 minutes.
      this.logger.warn('Ticket review is not ready; a "waiting on you" action will be retried', { actionId: data.actionId });
      return 'fetch_failed';
    }
    const result =
      action.kind === 'accept' ? await review.verify(action.ticketId) : await review.reject(action.ticketId, action.reason ?? '', 'board');
    const report: WaitingActionResultRequest = result.ok
      ? { instanceId, ok: true }
      : { instanceId, ok: false, code: result.reason, error: refusalText(result.reason, device) };
    this.done.set(data.actionId, { at: this.now(), result: report });
    this.logger.info(result.ok ? 'Ticket answered from Crewly Cloud' : 'Ticket action from Crewly Cloud refused', {
      ticketId: action.ticketId,
      kind: action.kind,
      ...(result.ok ? {} : { reason: result.reason }),
    });
    await this.report(data.actionId, report);
    this.deps.requestResync?.();
    return result.ok ? 'done' : 'refused';
  }

  /** Forget carried-out actions after a day (bounded). */
  private pruneDone(): void {
    const cutoff = this.now() - C.DONE_ACTIONS_TTL_MS;
    for (const [id, entry] of this.done) if (entry.at < cutoff) this.done.delete(id);
    while (this.done.size > C.DONE_ACTIONS_MAX) {
      const oldest = this.done.keys().next().value as string;
      this.done.delete(oldest);
    }
  }

  private url(suffix: string): string | null {
    const base = this.deps.cloud.getCloudUrl();
    return base ? `${base.replace(/\/$/, '')}${C.ACTIONS_PATH}${suffix}` : null;
  }

  /**
   * Fetch the action from Cloud with this machine's token; one token refresh
   * on 401, a few retries on network / 5xx errors.
   */
  private async fetchAction(data: WaitingActionRelayData, instanceId: string): Promise<FetchOutcome> {
    const url = this.url(`/${encodeURIComponent(data.actionId)}?instanceId=${encodeURIComponent(instanceId)}`);
    if (!url) return { kind: 'error', error: 'not signed in to Crewly Cloud' };
    const delays = C.FETCH_RETRY_DELAYS_MS;
    let refreshed = false;
    let lastError = 'unknown';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await this.sleep(delays[attempt - 1] ?? 0);
      const token = this.deps.cloud.getToken();
      if (!token) return { kind: 'error', error: 'not signed in to Crewly Cloud' };
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (response.status === 401 && !refreshed && this.deps.cloud.tryRefreshToken) {
        refreshed = true;
        if (await this.deps.cloud.tryRefreshToken().catch(() => false)) {
          attempt--; // the retry with the new token is free
          continue;
        }
      }
      if (response.status === 404) return { kind: 'not_found' };
      if (response.status === 410) return { kind: 'expired' };
      if (response.ok) {
        const parsed = parseWaitingActionFetchResponse(await response.json().catch(() => null));
        return parsed ? { kind: 'ok', action: parsed } : { kind: 'error', error: 'unusable response from Crewly Cloud' };
      }
      lastError = `HTTP ${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
    }
    return { kind: 'error', error: lastError };
  }

  /** Report an action's result to Cloud (best effort; a re-push re-reports). */
  private async report(actionId: string, body: WaitingActionResultRequest): Promise<void> {
    const url = this.url(`/${encodeURIComponent(actionId)}/result`);
    const token = this.deps.cloud.getToken();
    if (!url || !token) return;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(C.REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) this.logger.debug('Crewly Cloud did not take an action result', { actionId, status: response.status });
    } catch (error) {
      // The uploader's next snapshot removes the item anyway.
      this.logger.debug('Could not report an action result to Crewly Cloud', { actionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
