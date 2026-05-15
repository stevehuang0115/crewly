/**
 * RequestStatusUpdateSubscriber — pushes progress updates back to the user's
 * Slack thread while a Request is in flight.
 *
 * **Why this exists.** 2026-05-09 dogfood feedback: when a Slack message
 * triggers a Request that decomposes into Plan/Execute/Review WIs and
 * runs for an hour, the user has no visibility into progress. orc replied
 * once at the start ("[Plan] received, will arrange"), then went silent
 * until — sometimes — a final completion broadcast much later. Owner-Facing
 * Communication Standard (P0-6, PR #493) covers tone + jargon for the
 * messages we DO send, but says nothing about cadence. Sustained silence
 * during long-running work is its own UX failure: it forces the owner
 * to ping "?" or guess whether anything is happening.
 *
 * **What this does.** Subscribes to the canonical lifecycle events on
 * the bus and posts a brief, plain-language status update to the
 * originating Slack thread when:
 *   - a child WorkItem reaches done_by_worker / verified
 *   - a child WI is rejected / blocked / failed
 *   - the parent Request transitions to a terminal status
 *
 * Plus a heartbeat: if a Request has been in flight for longer than
 * the heartbeat interval since the last status post, the subscriber
 * emits a brief "still working" update. This catches the case where
 * a single WI runs for hours without a milestone event firing.
 *
 * **What this is NOT.** This is not a replacement for orc's first reply
 * (the SLA `respond_to_user` path handles that). It's a layer on top
 * that fires only after the Request is past its initial ack and while
 * downstream work is still moving.
 *
 * **Anti-spam.** The subscriber tracks `lastStatusPostedAt` per Request
 * in memory. Non-milestone events within MIN_INTER_POST_MS of the last
 * post are coalesced. Milestones (terminal Request status changes)
 * always go through.
 *
 * @module services/v3/request-status-update.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Request, RequestStatus } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';
import { TERMINAL_REQUEST_STATUSES, isValidRequestTransition } from '../../types/v2/index.js';

/**
 * WorkItem statuses that count as "terminal" for the heartbeat's
 * is-this-Request-actually-still-in-flight check.
 *
 * Imported from `work-item.types.ts` so the closer agrees with the
 * canonical contract (`{done, verified, cancelled}`) used by
 * `RequestService.update`'s child-validation gate. The previous shape
 * of this constant was wider — it also included `done_by_worker`,
 * `failed`, and `rejected` — which produced a real bug:
 *
 * 2026-05-09 dogfood: a Request with one `done_by_worker` child (verify
 * WI cancelled out-of-band) and two `cancelled` children was deemed
 * "all terminal" by the closer, but `RequestService.update` then refused
 * the close because `done_by_worker` is not in the canonical terminal
 * set. The closer logged a confusing "stale Request close failed"
 * warning every 30 minutes and the Request stayed wedged in `running`.
 *
 * Aligning the closer's set with the validation gate keeps both views
 * consistent. Trade-off: Requests with stuck-but-recoverable children
 * (`done_by_worker` awaiting verification, `failed` awaiting BRIDGE-1
 * retry, `rejected` awaiting re-queue) are NOT auto-closed by the
 * sweep — they stay in flight until the recovery path completes or a
 * human cancels them. That's the right call: the closer's job is to
 * mop up genuinely-finished Requests, not to short-circuit pipelines
 * that are merely paused.
 */
const TERMINAL_WORKITEM_STATUSES = TERMINAL_WORK_ITEM_STATUSES;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default heartbeat interval. The subscriber only emits a heartbeat when
 * the request has been quiet (no other status post) for at least this long
 * AND the request is still in flight.
 */
const DEFAULT_HEARTBEAT_MINUTES = 30;

/**
 * Minimum time between any two posts on the same thread. Non-milestone
 * events landing inside this window are coalesced. Milestones (terminal
 * Request status) bypass this check — the user always sees the final
 * verdict.
 */
const MIN_INTER_POST_MS = 5 * 60 * 1000;

/**
 * Events the subscriber listens to.
 */
const SUBSCRIBED_EVENTS: readonly EventType[] = [
  'task:done_by_worker',
  'task:verified',
  'task:rejected',
  'task:blocked',
  'task:failed',
] as const;

// ---------------------------------------------------------------------------
// Dependency surface
// ---------------------------------------------------------------------------

/**
 * Minimal view of {@link RequestService} this subscriber needs.
 * Defining the surface explicitly lets tests pass a fake without dragging
 * in the full service singleton.
 */
export interface RequestServiceLike {
  getById(id: string): Promise<Request | null>;
  listAll(): Promise<Request[]>;
  /**
   * Patch a Request's persisted state. The heartbeat-driven cascade only
   * uses `{ status }` to close stale-but-non-terminal Requests, but the
   * production type signature is wider — keep the signature loose so
   * fakes can pass `Partial<Request>` without compiler grief.
   */
  update(id: string, patch: Partial<Request>): Promise<unknown>;
}

/**
 * Minimal view of {@link TaskPoolService} this subscriber needs.
 *
 * `findWorkItem` returns `WorkItem | undefined | null` because production
 * `TaskPoolService.findWorkItem` returns `null` when the id is unknown,
 * while in-process fakes typically return `undefined`. The subscriber
 * treats both as "no WI" and short-circuits.
 */
export interface TaskPoolServiceLike {
  findWorkItem(id: string): Promise<WorkItem | undefined | null>;
  getAllItems(): Promise<WorkItem[]>;
}

/**
 * Slack post adapter. The production wiring posts via the in-process
 * SlackService; tests pass a stub that records the calls.
 */
export type SlackPoster = (params: { channelId: string; text: string; threadTs: string }) => Promise<void>;

export interface RequestStatusUpdateSubscriberDependencies {
  eventBus: EventBusService;
  requestService: RequestServiceLike;
  taskPool: TaskPoolServiceLike;
  slackPoster: SlackPoster;
  /** Heartbeat interval override. If 0, heartbeat is disabled. */
  heartbeatMinutes?: number;
  /** Optional logger override. */
  logger?: ComponentLogger;
  /** Test override for the heartbeat scheduler. Defaults to setInterval. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

interface ParsedSlackContext {
  channelId: string;
  threadTs: string;
}

/**
 * Parse the `sourceConversationItemId` of a Slack-originated Request into
 * the `(channelId, threadTs)` pair needed to post back to the same thread.
 *
 * Format: `slack-{channelId}-{ts1}.{ts2}` OR `slack-{channelId}-{ts1}-{ts2}`
 * (the bridge stamps both shapes — the second is the underscore-friendly
 * variant). The threadTs we want is `{ts1}.{ts2}` (dot-joined).
 *
 * @param scid - The Request's `sourceConversationItemId`
 * @returns Parsed context, or null if the id is not a Slack id we recognise
 */
/**
 * Compute a stable, content-only fingerprint of a Request's child-WI
 * state. Two snapshots produce the same fingerprint iff every status
 * count is equal — so a heartbeat that would say "still 3 blocked, 0
 * done" matches the previous "still 3 blocked, 0 done" and gets
 * suppressed by {@link RequestStatusUpdateSubscriber.runHeartbeat}.
 *
 * Uses status counts only — not WI ids or titles — so cosmetic
 * re-decompositions of the same Request (different uuids, same shape)
 * still match. WI churn that doesn't move the count needle isn't a
 * progress signal.
 *
 * @param childWIs - All WIs whose `requestId` matches the parent
 * @returns A short string fingerprint, e.g. `done=1,running=0,queued=0,blocked=3,failed=0,total=4`
 */
export function computeStateFingerprint(childWIs: WorkItem[]): string {
  const counts = { done: 0, running: 0, queued: 0, blocked: 0, failed: 0 };
  for (const wi of childWIs) {
    const s = wi.status;
    if (s === 'done' || s === 'verified' || s === 'done_by_worker') counts.done++;
    else if (s === 'running') counts.running++;
    else if (s === 'queued') counts.queued++;
    else if (s === 'blocked') counts.blocked++;
    else if (s === 'failed' || s === 'cancelled') counts.failed++;
  }
  return (
    `done=${counts.done},running=${counts.running},queued=${counts.queued},` +
    `blocked=${counts.blocked},failed=${counts.failed},total=${childWIs.length}`
  );
}

export function parseSlackThreadContext(scid: string | undefined): ParsedSlackContext | null {
  if (!scid || !scid.startsWith('slack-')) return null;
  // 2026-05-13 dogfood fix: Slack thread-reply Requests use the
  // `slack-{channelId}-{threadRoot}-msg-{messageTs}` encoding so that
  // the SLA threadIndex keys on the actual thread root (which is what
  // orc replies to via reply-slack). Strip the trailing `-msg-{ts}`
  // before extracting threadTs so both shapes parse to the thread root.
  // Top-level messages (`slack-{channelId}-{ts}`) are unaffected — the
  // strip is a no-op on those.
  const stripped = scid.replace(/-msg-\d+\.\d+$/, '');
  const m = stripped.match(/^slack-(.+)-(\d+)[.-](\d+)$/);
  if (!m) return null;
  const [, channelId, ts1, ts2] = m;
  return { channelId, threadTs: `${ts1}.${ts2}` };
}

export class RequestStatusUpdateSubscriber {
  private readonly eventBus: EventBusService;
  private readonly requestService: RequestServiceLike;
  private readonly taskPool: TaskPoolServiceLike;
  private readonly slackPoster: SlackPoster;
  private readonly heartbeatMinutes: number;
  private readonly logger: ComponentLogger;
  private readonly scheduler: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };

  private unsubscribers: InProcessUnsubscribe[] = [];
  private heartbeatHandle: unknown = null;
  private started = false;

  /** In-memory map: requestId → epoch ms of last status post. */
  private readonly lastPostedAt: Map<string, number> = new Map();
  /**
   * In-memory map: requestId → state-fingerprint of the last heartbeat
   * post. The heartbeat sweep skips a Request if its current fingerprint
   * matches the last one — there's no point telling the user "still 3
   * blocked" once an hour when nothing has changed since the previous
   * "still 3 blocked" message.
   *
   * Bug shape (2026-05-09 dogfood): a Slack thread received 7+ identical
   * "⏳ 还在做。已完成 0/4, 进行中 0, 排队 0, 卡住 3" messages over the
   * day because the WI state genuinely hadn't moved (Plan WI was wedged
   * blocked) but the heartbeat cadence faithfully kept firing. Plain-
   * language UX rule: a "no change" heartbeat IS noise, not signal.
   *
   * Fingerprint is derived from the {done, running, queued, blocked,
   * failed, total} counts (see {@link buildHeartbeatText}). Only counts —
   * not WI ids or titles — so cosmetic re-decompositions don't trigger
   * a fresh ping.
   */
  private readonly lastHeartbeatFingerprint: Map<string, string> = new Map();
  /** In-flight async dispatch promises (test affordance). */
  private readonly pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: RequestStatusUpdateSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.requestService = deps.requestService;
    this.taskPool = deps.taskPool;
    this.slackPoster = deps.slackPoster;
    this.heartbeatMinutes = deps.heartbeatMinutes ?? DEFAULT_HEARTBEAT_MINUTES;
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('RequestStatusUpdateSubscriber');
    this.scheduler = deps.scheduler ?? {
      setInterval: (fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        // Don't keep the event loop alive just for the heartbeat sweep.
        if (typeof (t as { unref?: () => void }).unref === 'function') {
          (t as { unref: () => void }).unref();
        }
        return t;
      },
      clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
    };
  }

  /**
   * Subscribe to bus events + start the heartbeat sweep. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const eventType of SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }

    if (this.heartbeatMinutes > 0) {
      const intervalMs = this.heartbeatMinutes * 60 * 1000;
      this.heartbeatHandle = this.scheduler.setInterval(() => {
        // Don't await — this runs at scheduler cadence; an overlapping
        // sweep is best left to skip itself via the inter-post window.
        this.runHeartbeat().catch((err) => {
          this.logger.warn('Heartbeat sweep threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, intervalMs);
    }

    this.logger.info('RequestStatusUpdateSubscriber subscribed', {
      eventTypes: SUBSCRIBED_EVENTS,
      heartbeatMinutes: this.heartbeatMinutes,
    });
  }

  /**
   * Detach subscriptions + stop heartbeat. Safe to call repeatedly.
   */
  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.warn('Status-update unsubscribe threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.unsubscribers = [];
    if (this.heartbeatHandle !== null) {
      this.scheduler.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    this.started = false;
  }

  /**
   * Wait for in-flight async dispatches to settle. Test affordance.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Manual trigger for the heartbeat sweep. Test affordance + ops button.
   */
  async runHeartbeat(): Promise<number> {
    let posted = 0;
    let allRequests: Request[];
    try {
      allRequests = await this.requestService.listAll();
    } catch (err) {
      this.logger.warn('Heartbeat: listAll failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    const now = Date.now();
    const stalenessMs = this.heartbeatMinutes * 60 * 1000;

    for (const r of allRequests) {
      // Only follow up on Slack-originated, non-terminal Requests.
      if (TERMINAL_REQUEST_STATUSES.has(r.status)) continue;
      const slackCtx = parseSlackThreadContext(r.sourceConversationItemId);
      if (!slackCtx) continue;

      const last = this.lastPostedAt.get(r.id);
      if (last !== undefined && now - last < stalenessMs) continue;

      // No status update has been emitted for this Request since the
      // heartbeat window started. Post a heartbeat unless either:
      //   (a) there's genuinely nothing to report (zero in-flight WIs), or
      //   (b) the WI state-fingerprint matches the last heartbeat — i.e.
      //       nothing has changed since we last said "still 3 blocked",
      //       so saying it again is noise.
      const items = await this.taskPool.getAllItems();
      const childWIs = items.filter((wi) => wi.requestId === r.id);
      if (childWIs.length === 0) continue;

      // All-terminal guard — when every child WI is terminal but the
      // Request itself is still non-terminal, the cascade upstream got
      // skipped (cascadeRequestStatus is wired to the retired
      // `v3:task_*` events on V3DataService — see 2026-05-09 dogfood
      // bug, Request 6d60a1cd had 4 cancelled WIs and the Request
      // stayed in `ready` for hours, generating misleading
      // "0/4, 进行中 0, 排队 0, 卡住 0" heartbeats every sweep).
      // Close the Request instead of pinging the user with a
      // confusing zero-everywhere line.
      const allTerminal = childWIs.every((wi) =>
        TERMINAL_WORKITEM_STATUSES.has(wi.status),
      );
      if (allTerminal) {
        await this.closeStaleRequest(r, childWIs);
        continue;
      }

      // Steve 2026-05-15 dogfood: heartbeat fired for the 智库 Request
      // showing "5/7 完成, 进行中 1" right after Grace's user-visible
      // Review landed. The "进行中 1" was orc's *internal Verify WI*
      // for Grace's Review — internal bookkeeping the user can't act
      // on. From the user's chat view this read as "system still
      // pending on something" when in fact the deliverable was done.
      //
      // Filter to user-deliverable WIs (`type === 'delegate'`). Review
      // / verify / cron_run / notify / reconcile / check / confirm
      // are internal types — surfacing their pending status to the
      // owner is noise. If every deliverable has reached a
      // user-perceived terminal state (done / verified / done_by_worker
      // / cancelled / failed / rejected), suppress the heartbeat — the
      // owner already saw the deliverable land; the internal verify
      // path will close the Request soon enough.
      const deliverableWIs = childWIs.filter((wi) => wi.type === 'delegate');
      const userTerminalStatuses = new Set<WorkItem['status']>([
        'done',
        'verified',
        'done_by_worker',
        'cancelled',
        'failed',
        'rejected',
      ]);
      if (
        deliverableWIs.length > 0 &&
        deliverableWIs.every((wi) => userTerminalStatuses.has(wi.status))
      ) {
        this.logger.debug(
          'Heartbeat suppressed — all user-deliverable WIs reached terminal; only internal verify/review remains',
          {
            requestId: r.id,
            deliverableCount: deliverableWIs.length,
            internalInFlight: childWIs.length - deliverableWIs.length,
          },
        );
        continue;
      }

      const fingerprint = computeStateFingerprint(childWIs);
      const lastFp = this.lastHeartbeatFingerprint.get(r.id);
      if (lastFp === fingerprint) {
        this.logger.debug('Heartbeat skipped — state unchanged since last post', {
          requestId: r.id,
          fingerprint,
        });
        continue;
      }

      // Build heartbeat from deliverables only when we have any, so the
      // count the owner sees matches what they care about (their actual
      // work, not the system's verify bookkeeping). Falls back to the
      // full childWIs only if the Request somehow has zero delegates —
      // a malformed shape we should still report on rather than hide.
      const heartbeatBasis =
        deliverableWIs.length > 0 ? deliverableWIs : childWIs;
      const text = this.buildHeartbeatText(r, heartbeatBasis);
      try {
        await this.slackPoster({ channelId: slackCtx.channelId, text, threadTs: slackCtx.threadTs });
        this.lastPostedAt.set(r.id, now);
        this.lastHeartbeatFingerprint.set(r.id, fingerprint);
        posted++;
      } catch (err) {
        this.logger.warn('Heartbeat post failed', {
          requestId: r.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (posted > 0) {
      this.logger.info('Heartbeat sweep posted updates', { count: posted });
    }
    return posted;
  }

  // -------------------------------------------------------------------------
  // Event handler
  // -------------------------------------------------------------------------

  private async handleTaskEvent(eventType: EventType, event: AgentEvent): Promise<void> {
    const workItemId = event.workItemId ?? this.extractWorkItemId(event);
    if (!workItemId) return;
    const wi = await this.taskPool.findWorkItem(workItemId);
    if (!wi || !wi.requestId) return;
    const request = await this.requestService.getById(wi.requestId);
    if (!request) return;
    const slackCtx = parseSlackThreadContext(request.sourceConversationItemId);
    if (!slackCtx) return;

    // Spam guard: coalesce non-milestone events within the inter-post window.
    // We treat all task lifecycle events as non-milestone here. The Request
    // terminal cascade fires `request:status` events on the SlackBridge SLA
    // path, where the existing `markResolvedByThread` handles user-facing
    // closure separately.
    const last = this.lastPostedAt.get(request.id);
    if (last !== undefined && Date.now() - last < MIN_INTER_POST_MS) {
      this.logger.debug('Coalesced status update (within MIN_INTER_POST_MS)', {
        requestId: request.id,
        eventType,
        sinceLastMs: Date.now() - last,
      });
      return;
    }

    const text = this.buildEventText(eventType, wi, request);
    try {
      await this.slackPoster({ channelId: slackCtx.channelId, text, threadTs: slackCtx.threadTs });
      this.lastPostedAt.set(request.id, Date.now());
    } catch (err) {
      this.logger.warn('Status update post failed', {
        requestId: request.id,
        eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Best-effort `workItemId` extraction from an event payload. Newer
   * publishers set the canonical field; older ones encode it on
   * `eventId` (`task:done_by_worker:{workItemId}` shape).
   */
  private extractWorkItemId(event: AgentEvent): string | undefined {
    if (event.workItemId) return event.workItemId;
    const eid = event.id ?? '';
    const match = eid.match(/^task:[^:]+:(.+)$/);
    if (match) return match[1];
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Message templates (plain language, per Owner-Facing Comm Standard P0-6)
  // -------------------------------------------------------------------------

  private buildEventText(eventType: EventType, wi: WorkItem, _request: Request): string {
    const titleShort = (wi.title ?? '').split('\n')[0].slice(0, 60);
    const targetShort = humanizeAgentName(wi.target);
    switch (eventType) {
      case 'task:done_by_worker':
        return `✅ ${targetShort} 完成了「${titleShort}」, 等下一步。`;
      case 'task:verified':
        return `🟢 「${titleShort}」已通过检查。`;
      case 'task:rejected':
        return `🔁 「${titleShort}」检查未通过, 让 ${targetShort} 重做。`;
      case 'task:blocked':
        return `⛔ 「${titleShort}」卡住了 (target=${targetShort})。我会跟进。`;
      case 'task:failed':
        return `❌ 「${titleShort}」失败 (target=${targetShort})。我会跟进或转交。`;
      default:
        return `更新: 「${titleShort}」状态变化 (${eventType})。`;
    }
  }

  private buildHeartbeatText(_request: Request, childWIs: WorkItem[]): string {
    const counts = {
      done: 0,
      running: 0,
      queued: 0,
      blocked: 0,
      failed: 0,
      other: 0,
    };
    for (const wi of childWIs) {
      const s = wi.status;
      if (s === 'done' || s === 'verified' || s === 'done_by_worker') counts.done++;
      else if (s === 'running') counts.running++;
      else if (s === 'queued') counts.queued++;
      else if (s === 'blocked') counts.blocked++;
      else if (s === 'failed' || s === 'cancelled') counts.failed++;
      else counts.other++;
    }
    // Only surface the failed/cancelled bucket when it's non-zero.
    // Hiding it unconditionally (the original shape) was the bug —
    // 4 cancelled WIs rendered as "0/4, 进行中 0, 排队 0, 卡住 0",
    // which reads as "everything vanished" rather than "everything
    // got cancelled". The all-terminal guard in runHeartbeat now
    // intercepts the pure-cancelled case, but a mixed Request with
    // some cancelled and some still in-flight would still hit this
    // path, so include the count for honesty.
    const tail = counts.failed > 0 ? `, 取消/失败 ${counts.failed}` : '';
    return (
      `⏳ 还在做。已完成 ${counts.done}/${childWIs.length}, ` +
      `进行中 ${counts.running}, 排队 ${counts.queued}, 卡住 ${counts.blocked}${tail}。` +
      ` 我会在有变化时再更新。`
    );
  }

  /**
   * Close a Request whose every child WI has reached a terminal status
   * but whose own status hasn't been cascaded. Picks `done` if any
   * child landed on a success-shaped terminal; otherwise `cancelled`.
   *
   * Honours `REQUEST_TRANSITIONS` — `ready → done` is illegal in the
   * state machine, so for `ready` Requests we step through `running`
   * first (a single `running` hop is harmless because the Request is
   * about to land in a terminal state immediately after).
   *
   * Best-effort. Logs but does not throw on failure: the heartbeat
   * sweep must keep moving across other Requests.
   */
  private async closeStaleRequest(request: Request, childWIs: WorkItem[]): Promise<void> {
    // `done_by_worker` is filtered out by the all-terminal guard
    // upstream (it's not in TERMINAL_WORKITEM_STATUSES anymore — see
    // the constant definition for the rationale). So success only
    // comes from `done` or `verified` here.
    const hasSuccess = childWIs.some(
      (wi) => wi.status === 'done' || wi.status === 'verified',
    );
    const target: RequestStatus = hasSuccess ? 'done' : 'cancelled';

    const log = (extra: Record<string, unknown> = {}) => ({
      requestId: request.id,
      previousStatus: request.status,
      newStatus: target,
      childCount: childWIs.length,
      childStatuses: childWIs.map((wi) => wi.status),
      ...extra,
    });

    try {
      // Direct transition when allowed.
      if (isValidRequestTransition(request.status, target)) {
        await this.requestService.update(request.id, { status: target });
        this.logger.info('Heartbeat closed stale Request (all children terminal)', log());
        return;
      }

      // `ready → done` is invalid; step through `running` first.
      // ready → running → done is the canonical path for Requests
      // that bypassed the running stage entirely.
      if (
        target === 'done' &&
        isValidRequestTransition(request.status, 'running') &&
        isValidRequestTransition('running', 'done')
      ) {
        await this.requestService.update(request.id, { status: 'running' });
        await this.requestService.update(request.id, { status: 'done' });
        this.logger.info('Heartbeat closed stale Request via running hop', log());
        return;
      }

      this.logger.warn('Heartbeat: stale Request close blocked by state machine', log());
    } catch (err) {
      this.logger.warn('Heartbeat: stale Request close failed', {
        ...log(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const dispatch = (async () => {
      try {
        await this.handleTaskEvent(eventType, event);
      } catch (err) {
        this.logger.error('Status-update handler threw', {
          eventType,
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.pendingDispatches.add(dispatch);
    dispatch.finally(() => {
      this.pendingDispatches.delete(dispatch);
    });
    return dispatch;
  }
}

/**
 * Translate an internal session name into something the owner recognises.
 * Mirrors the spirit of P0-6 Owner-Facing Communication Standard rule 4
 * ("Translate every internal term before sending"). The rule is a loose
 * one — the goal is "less jargony", not "perfect human name lookup".
 *
 * @param sessionName - e.g. 'crewly-product-leo-21a5477e' or 'crewly-orc'
 * @returns A short label suitable for Slack ('Leo', 'Orc', 'Sam', ...)
 */
function humanizeAgentName(sessionName: string | undefined): string {
  if (!sessionName) return '团队';
  if (sessionName === 'crewly-orc') return 'Orc';
  // crewly-product-leo-21a5477e → 'Leo'
  // crewly-marketing-luna-... → 'Luna'
  // flopost-pia-... → 'Pia'
  const parts = sessionName.split('-');
  // Heuristic: pick the first segment that is a short alpha word and
  // is neither the team prefix ('crewly', 'flopost', 'product', 'marketing',
  // ...) nor an id segment.
  const skip = new Set([
    'crewly', 'product', 'marketing', 'flopost', 'support',
    'auditor', 'team', 'pro', 'orc', 'agent',
  ]);
  for (const p of parts) {
    if (!p) continue;
    if (skip.has(p)) continue;
    if (/^[a-z]{2,12}$/.test(p)) {
      return p.charAt(0).toUpperCase() + p.slice(1);
    }
  }
  return sessionName;
}
