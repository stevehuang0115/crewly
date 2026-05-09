/**
 * RequestCascadeSubscriber — keeps Request.status in sync with the
 * aggregate state of its child WorkItems by reacting to live task
 * lifecycle events on the central EventBus.
 *
 * **Why this exists.** 2026-05-09 dogfood: `cascadeRequestStatus` lives
 * inside V3DataService, but the only callers are V3DataService's
 * onTaskCompleted/onTaskFailed/onTaskBlocked handlers — and those
 * handlers are wired to the **retired** `v3:task_*` events that nothing
 * emits anymore (`mission-executor.service.ts:152` v1-cleanup comment).
 * So the cascade hadn't fired for any task event in months.
 *
 * Symptom: a Slack-originated Request whose 4 child WIs all landed in
 * `cancelled` stayed in `ready` for hours, generating misleading
 * "0/4, 进行中 0..." heartbeats every sweep.
 *
 * **What this subscribes to.** Every live task lifecycle event that the
 * central EventBus publishes:
 *   - `task:done_by_worker`   — child finished, awaiting verification
 *   - `task:verified`         — verifier accepted
 *   - `task:rejected`         — verifier sent back for retry
 *   - `task:cancelled`        — child cancelled (added in this PR)
 *   - `task:failed`           — child failed terminally
 *   - `task:blocked`          — child wedged
 *
 * Each handler resolves `requestId` from the event payload (or by
 * looking up the WI if the event didn't carry it) and calls
 * {@link cascadeRequestStatus}, which re-reads pool state and patches
 * the parent Request to the right status.
 *
 * **What this is NOT.** This is not a notification service —
 * `RequestStatusUpdateSubscriber` handles user-facing Slack updates.
 * They share the event stream but have separate concerns. (The
 * heartbeat-driven closer in `RequestStatusUpdateSubscriber` remains
 * as a 30-min safety net for any cancellation that bypasses the
 * publish path — e.g. direct storage mutation by an ops script.)
 *
 * @module services/v3/request-cascade.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
  cascadeRequestStatus,
  type CascadeRequestService,
  type CascadeTaskPool,
  type CascadeNotifier,
} from './cascade-request-status.js';

/**
 * Events that may signal a Request needs re-cascading.
 */
const SUBSCRIBED_EVENTS: readonly EventType[] = [
  'task:done_by_worker',
  'task:verified',
  'task:rejected',
  'task:cancelled',
  'task:failed',
  'task:blocked',
] as const;

/**
 * Minimal pool surface — needs both `findWorkItem` (resolve missing
 * requestId from event payload) and `getAllItems` (the cascade itself
 * re-reads pool state).
 */
export interface CascadeSubscriberTaskPool extends CascadeTaskPool {
  findWorkItem(id: string): Promise<WorkItem | undefined | null>;
}

export interface RequestCascadeSubscriberDependencies {
  eventBus: EventBusService;
  requestService: CascadeRequestService;
  taskPool: CascadeSubscriberTaskPool;
  /** Optional notifier — production wiring passes the same EventBus so
   * `v3:request_updated` reaches existing UI subscribers. */
  notifier?: CascadeNotifier;
  logger?: ComponentLogger;
}

export class RequestCascadeSubscriber {
  private readonly eventBus: EventBusService;
  private readonly requestService: CascadeRequestService;
  private readonly taskPool: CascadeSubscriberTaskPool;
  private readonly notifier?: CascadeNotifier;
  private readonly logger: ComponentLogger;

  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  /** In-flight async dispatch promises — exposed via `flushPending` for tests. */
  private readonly pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: RequestCascadeSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.requestService = deps.requestService;
    this.taskPool = deps.taskPool;
    this.notifier = deps.notifier;
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('RequestCascadeSubscriber');
  }

  /**
   * Subscribe to bus events. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const eventType of SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }

    this.logger.info('RequestCascadeSubscriber subscribed', {
      eventTypes: SUBSCRIBED_EVENTS,
    });
  }

  /**
   * Detach subscriptions. Safe to call repeatedly.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const unsub of this.unsubscribers) {
      try {
        unsub();
      } catch (err) {
        this.logger.warn('Unsubscribe failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.unsubscribers = [];
  }

  /**
   * Test affordance — wait for any in-flight dispatch promises to settle.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.pendingDispatches));
    }
  }

  // -------------------------------------------------------------------------

  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const dispatch = (async () => {
      try {
        await this.handleTaskEvent(eventType, event);
      } catch (err) {
        // Best-effort — never let a cascade failure poison the bus.
        this.logger.warn('Cascade dispatch failed (non-fatal)', {
          eventType,
          workItemId: event.workItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.pendingDispatches.add(dispatch);
    void dispatch.finally(() => this.pendingDispatches.delete(dispatch));
    return dispatch;
  }

  private async handleTaskEvent(_eventType: EventType, event: AgentEvent): Promise<void> {
    let requestId = event.requestId;

    // Some emitters don't carry requestId on the event payload (older
    // call sites, hand-fired test events). Resolve via the WI if we
    // have a workItemId. If neither is present, there's nothing to
    // cascade — quietly bail.
    if (!requestId && event.workItemId) {
      const wi = await this.taskPool.findWorkItem(event.workItemId);
      if (wi) requestId = wi.requestId;
    }

    if (!requestId) return;

    await cascadeRequestStatus(requestId, {
      requestService: this.requestService,
      taskPool: this.taskPool,
      logger: this.logger,
      notifier: this.notifier,
    });
  }
}
