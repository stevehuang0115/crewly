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
 * Recompute Request.status from the aggregate state of its child WIs
 * and persist any change.
 *
 * Cascade rules — match the original V3DataService implementation so
 * behaviour is unchanged for paths that already cascade correctly:
 *
 *   - All children done/verified/done_by_worker → done
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
    const childItems = allItems.filter((wi) => wi.requestId === requestId);
    if (childItems.length === 0) return;

    const statuses = childItems.map((wi) => wi.status);

    let newStatus: RequestStatus;
    const allQueued = statuses.every((s) => s === 'queued' || s === 'scheduled');
    if (statuses.every((s) => s === 'done' || s === 'verified' || s === 'done_by_worker')) {
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
