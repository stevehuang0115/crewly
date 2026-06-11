/**
 * Standalone cascade-request-status helper.
 *
 * Extracted from `V3DataService.cascadeRequestStatus` so that any
 * subscriber on the central EventBus can call it without dragging in
 * the V3DataService singleton or being forced through V3DataService's
 * internal `v3:task_*` event subscriptions (which were retired in the
 * v1-cleanup campaign — `mission-executor.service.ts:152`).
 *
 * The 2026-05-09 dogfood bug shape:
 *   - All 4 child WIs of a Slack-originated Request landed in
 *     `cancelled`.
 *   - V3DataService's onTaskCompleted/onTaskFailed handlers
 *     (which were the ONLY callers of cascade) never fired because
 *     their `v3:task_*` events were dead.
 *   - Request stayed in `ready` for hours.
 *   - Heartbeat sweep faithfully posted "0/4, 进行中 0..." every cycle.
 *
 * The fix path: emit `task:cancelled` from the task-pool when a WI
 * lands in cancelled, subscribe to it (and the other live task
 * lifecycle events) in `RequestCascadeSubscriber`, and call this
 * helper. The Request now closes within seconds of the last child WI
 * transitioning, instead of waiting for the heartbeat catch.
 *
 * @module services/v3/cascade-request-status
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  isValidRequestTransition,
  type RequestStatus,
  type Request,
} from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

/**
 * Minimal {@link RequestService} surface the cascade needs. Defining it
 * explicitly keeps tests and alternate callers from being forced to
 * mock the entire service.
 */
export interface CascadeRequestService {
  getById(id: string): Promise<Request | null>;
  update(id: string, patch: Partial<Request>): Promise<unknown>;
}

/**
 * Minimal {@link TaskPoolService} surface — only `getAllItems` is used
 * (the cascade re-reads pool state to make its decision rather than
 * trusting the event payload, which may be stale after a rapid burst).
 */
export interface CascadeTaskPool {
  getAllItems(): Promise<WorkItem[]>;
}

/**
 * Optional sink for "Request status changed" notifications. The original
 * V3DataService implementation emitted `v3:request_updated`; preserved
 * here so existing internal subscribers (UI refresh, etc.) keep working
 * even though the cascade no longer lives in V3DataService.
 */
export interface CascadeNotifier {
  emit(event: 'v3:request_updated', payload: {
    requestId: string;
    status: RequestStatus;
    previousStatus: RequestStatus;
  }): void;
}

export interface CascadeDeps {
  requestService: CascadeRequestService;
  taskPool: CascadeTaskPool;
  logger?: ComponentLogger;
  notifier?: CascadeNotifier;
}

/**
 * Verified-reply SLA resolution reasons — these tags appear in
 * `WorkItem.metadata.slaResolvedReason` when
 * `RequestSlaSubscriber.markResolved` deliberately cancels the
 * respond_to_user tracker because the orchestrator answered the user.
 * Such cancellations are NOT abandonments and should not propagate
 * a `cancelled` status to the parent Request; the SLA subscriber's
 * own `maybeCloseRequest` owns that transition.
 *
 * Keep in sync with `request-sla.subscriber.ts:VERIFIED_REPLY_REASONS`.
 */
const VERIFIED_SLA_REPLY_REASONS = new Set([
  'orc_reply',
  'orc_reply_recheck',
  'chatv2_reply',
  'workitem_decompose',
]);

/**
 * Returns true when a WorkItem's metadata indicates the cancellation
 * came from a verified-reply SLA auto-resolve (orc replied to the
 * user, or chat-v2 saw an agent reply, or the WI was retired because
 * the Request was decomposed into new WIs).
 *
 * @param metadata - WorkItem.metadata bag (may be undefined)
 * @returns true if the cancellation should be ignored for parent
 *   Request cascade purposes
 */
function isSlaResolvedByVerifiedReply(metadata: Record<string, unknown> | undefined): boolean {
  const reason = metadata?.slaResolvedReason;
  return typeof reason === 'string' && VERIFIED_SLA_REPLY_REASONS.has(reason);
}

/**
 * Recompute Request.status from the aggregate state of its child WIs
 * and persist any change.
 *
 * Cascade rules — match the original V3DataService implementation so
 * behaviour is unchanged for paths that already cascade correctly:
 *
 *   - All children done/verified                 → done
 *     (P2: `done_by_worker` does NOT count — see the acceptance-gate note
 *      at the rule below; unverified children keep the Request `running`)
 *   - Any child running                          → running
 *   - All children queued/scheduled              → no change
 *     (work delegated, not started — Request keeps current status)
 *   - Any child blocked, none running            → blocked
 *   - All children failed/cancelled              → cancelled
 *   - Some done, no running                      → running
 *     (progress is happening; further events will cascade to done)
 *   - Mixed                                       → no change
 *
 * Honours `REQUEST_TRANSITIONS`. Skips silently when the target is
 * unreachable from the current status — the next event tick will try
 * again with fresh state.
 *
 * Best-effort. Logs but does not throw — a failing cascade must not
 * break the subscriber that called it.
 *
 * @param requestId - Parent Request ID. `undefined` is a no-op (the WI
 *   wasn't part of a Request).
 * @param deps - Service surface needed to read pool + write request.
 */
export async function cascadeRequestStatus(
  requestId: string | undefined,
  deps: CascadeDeps,
): Promise<void> {
  if (!requestId) return;

  const logger =
    deps.logger ?? LoggerService.getInstance().createComponentLogger('CascadeRequestStatus');

  try {
    const request = await deps.requestService.getById(requestId);
    if (!request) return;
    if (request.status === 'done' || request.status === 'cancelled') return;

    const allItems = await deps.taskPool.getAllItems();
    const allChildItems = allItems.filter((wi) => wi.requestId === requestId);
    if (allChildItems.length === 0) return;

    // 2026-05-15 dogfood (Steve): Slack Requests with a single
    // respond_to_user SLA tracker were ending up in `cancelled` →
    // overwritten to `done` by RequestSlaSubscriber.maybeCloseRequest
    // in a ~10ms race window. Root cause: `markResolved(orc_reply)`
    // transitions the SLA tracker `queued → cancelled`, the
    // `task:cancelled` event fires here, and the cascade sees
    // `statuses=['cancelled']` → newStatus='cancelled'. Then SLA's
    // own auto-close (next tick) flips it to `done` and the Request
    // ends with inconsistent status events in its log.
    //
    // Filter out children that were cancelled by a verified-reply
    // SLA resolution — those aren't real abandonments, the SLA
    // closer owns the parent Request transition. If after filtering
    // nothing remains, let the SLA path drive the close.
    const childItems = allChildItems.filter(
      (wi) => wi.status !== 'cancelled' || !isSlaResolvedByVerifiedReply(wi.metadata),
    );
    if (childItems.length === 0) {
      logger.debug('Cascade skipped — only SLA-resolved cancellations remain', {
        requestId,
        slaResolvedCount: allChildItems.length,
      });
      return;
    }

    const statuses = childItems.map((wi) => wi.status);

    let newStatus: RequestStatus;
    const allQueued = statuses.every((s) => s === 'queued' || s === 'scheduled');
    // P2 acceptance gate: a Request is only `done` when its children are
    // actually VERIFIED (or `done`), NOT merely `done_by_worker`. A
    // `done_by_worker` child is awaiting a TL/orc verdict — counting it as
    // complete would mark the deliverable done before it was ever accepted
    // (the Request-level silent-pass). Such children keep the Request
    // `running` (pending verification); P1's verify-enforcement escalates them
    // to the orc for a verdict (→ verified, or rejected → rework), after which
    // this cascade completes the Request honestly.
    if (statuses.every((s) => s === 'done' || s === 'verified')) {
      newStatus = 'done';
    } else if (statuses.some((s) => s === 'running')) {
      newStatus = 'running';
    } else if (allQueued) {
      return;
    } else if (statuses.some((s) => s === 'blocked') && !statuses.some((s) => s === 'running')) {
      newStatus = 'blocked';
    } else if (statuses.every((s) => s === 'failed' || s === 'cancelled')) {
      newStatus = 'cancelled';
    } else if (statuses.some((s) => s === 'done' || s === 'verified' || s === 'done_by_worker')) {
      newStatus = 'running';
    } else {
      return;
    }

    if (newStatus === request.status) return;

    // Direct transition.
    if (isValidRequestTransition(request.status, newStatus)) {
      await deps.requestService.update(requestId, { status: newStatus });
      logger.info('Request status cascaded from WorkItems', {
        requestId,
        previousStatus: request.status,
        newStatus,
        childStatuses: statuses,
      });
      deps.notifier?.emit('v3:request_updated', {
        requestId,
        status: newStatus,
        previousStatus: request.status,
      });
      return;
    }

    // `ready → done` is illegal; hop via running. Same shape used by
    // the heartbeat-driven closer in RequestStatusUpdateSubscriber so
    // both paths converge on identical semantics.
    if (
      newStatus === 'done' &&
      isValidRequestTransition(request.status, 'running') &&
      isValidRequestTransition('running', 'done')
    ) {
      await deps.requestService.update(requestId, { status: 'running' });
      await deps.requestService.update(requestId, { status: 'done' });
      logger.info('Request status cascaded via running hop', {
        requestId,
        previousStatus: request.status,
        newStatus,
        childStatuses: statuses,
      });
      deps.notifier?.emit('v3:request_updated', {
        requestId,
        status: newStatus,
        previousStatus: request.status,
      });
      return;
    }

    logger.debug('Cascade target not reachable from current status', {
      requestId,
      currentStatus: request.status,
      targetStatus: newStatus,
    });
  } catch (err) {
    logger.debug('cascadeRequestStatus failed (non-fatal)', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
