/**
 * KR Completion Subscriber
 *
 * Closes two gaps in the OKR runtime loop that the data model already
 * supported but nothing ever drove:
 *
 * 1. **KR auto-measurement from task completion.**
 *    `KRTrackingService.onWorkItemCompleted` maps completed/total linked
 *    WorkItems onto a KR whose `measurementSource === 'task_completion'`,
 *    but had zero production callers. This subscriber listens to the
 *    pool's terminal-success events (`task:done`, `task:verified`),
 *    resolves the KR either from `workItem.metadata.krId` or from any KR
 *    of the mission whose `linkedWorkItemIds` contains the WI, and calls
 *    `onWorkItemCompleted`.
 *
 * 2. **`team:all_tasks_done` publication.**
 *    The event was declared, CRITICAL, subscribed to by the orchestrator
 *    and handled by the EventToWorkItemBridge (→ `mission:review_due` →
 *    review WI) — but nothing published it. On every task terminal event
 *    (`task:done`, `task:verified`, `task:cancelled`) this subscriber
 *    checks whether the WI's mission has zero non-terminal WorkItems left
 *    and, if so, publishes once per mission per UTC day (idempotent id
 *    `<missionId>:all_tasks_done:<YYYY-MM-DD>`).
 *
 * Follows the same shape as the other in-process subscribers (bridge,
 * auto-learning, milestone): `onInProcess` subscriptions, per-dispatch
 * try/catch, `flushPending()` for tests, idempotent `start()`/`stop()`.
 *
 * @module services/v3/kr-completion.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { SLA_TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';
import type { Mission } from '../../types/v2/mission.types.js';
import { formatError } from '../../utils/format-error.js';
import { safeReadJson } from '../../utils/file-io.utils.js';
import { getMissionPath } from './mission-paths.js';
import { KRTrackingService } from './kr-tracking.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Terminal-success events that may move a `task_completion` KR. */
export const KR_MEASURE_EVENTS: readonly EventType[] = ['task:done', 'task:verified'] as const;

/**
 * Task terminal events after which a mission may have no active work left.
 * `task:cancelled` is included so a mission whose last item was cancelled
 * still gets its "all done — review" nudge.
 */
export const ALL_TASKS_DONE_TRIGGER_EVENTS: readonly EventType[] = [
  'task:done',
  'task:verified',
  'task:cancelled',
] as const;

/** Bounded size of the per-day `team:all_tasks_done` dedup set. */
const ALL_TASKS_DONE_DEDUP_CAPACITY = 1000;

/** KR measurement source that this subscriber is allowed to drive. */
const TASK_COMPLETION_SOURCE = 'task_completion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal pool surface the subscriber needs. */
export interface KRCompletionTaskPool {
  findWorkItem(id: string): Promise<WorkItem | null | undefined>;
  getAllItems(): Promise<WorkItem[]>;
}

/** Minimal KR-tracking surface the subscriber needs. */
export interface KRCompletionTracker {
  listByMission(missionId: string): Promise<KeyResult[]>;
  get(missionId: string, krId: string): Promise<KeyResult | null>;
  onWorkItemCompleted(workItem: WorkItem): Promise<void>;
}

/** Constructor dependencies (all injectable for tests). */
export interface KRCompletionSubscriberDependencies {
  eventBus: EventBusService;
  taskPool: KRCompletionTaskPool;
  krTracking: KRCompletionTracker;
  /** Loads a mission by id (for `ownerTeamId` on the published event). */
  loadMission?: (missionId: string) => Promise<Mission | null>;
  logger?: ComponentLogger;
  /** Clock override for the per-day dedup key. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC calendar-day key (`YYYY-MM-DD`). */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Default production mission loader — reads the shared missions dir. */
async function defaultLoadMission(missionId: string): Promise<Mission | null> {
  try {
    return await safeReadJson<Mission | null>(getMissionPath(missionId), null);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

/**
 * Drives KR auto-measurement and `team:all_tasks_done` from task terminal
 * events. See module docs.
 */
export class KRCompletionSubscriber {
  private readonly eventBus: EventBusService;
  private readonly taskPool: KRCompletionTaskPool;
  private readonly krTracking: KRCompletionTracker;
  private readonly loadMission: (missionId: string) => Promise<Mission | null>;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  private readonly pendingDispatches: Set<Promise<void>> = new Set();
  /** `<missionId>:<YYYY-MM-DD>` keys already published today (FIFO-bounded). */
  private readonly publishedAllDone: string[] = [];

  constructor(deps: KRCompletionSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.taskPool = deps.taskPool;
    this.krTracking = deps.krTracking;
    this.loadMission = deps.loadMission ?? defaultLoadMission;
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('KRCompletionSubscriber');
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Production wiring helper — constructs from singletons.
   *
   * @param eventBus - The live event bus
   * @returns A subscriber ready to `start()`
   */
  static boot(eventBus: EventBusService): KRCompletionSubscriber {
    return new KRCompletionSubscriber({
      eventBus,
      taskPool: TaskPoolService.getInstance(),
      krTracking: KRTrackingService.getInstance(),
    });
  }

  /** Subscribe to the task terminal events. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const eventType of ALL_TASKS_DONE_TRIGGER_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }
    this.logger.info('KRCompletionSubscriber subscribed', {
      eventTypes: ALL_TASKS_DONE_TRIGGER_EVENTS,
    });
  }

  /** Detach all subscriptions. Idempotent. */
  stop(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch (err) {
        this.logger.warn('KRCompletion unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];
    this.started = false;
  }

  /** Await every in-flight dispatch. Test affordance. */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      await Promise.allSettled(Array.from(this.pendingDispatches));
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const promise = (async () => {
      try {
        await this.handle(eventType, event);
      } catch (err) {
        this.logger.warn('KRCompletion dispatch threw — swallowed', {
          eventType,
          eventId: event.id,
          error: formatError(err),
        });
      }
    })();
    this.pendingDispatches.add(promise);
    promise.finally(() => this.pendingDispatches.delete(promise));
    return promise;
  }

  /**
   * Resolve the source WI, then run the KR measurement (success events
   * only) and the all-tasks-done check (every trigger event). The two
   * halves are independent — a failure in one is logged and does not stop
   * the other.
   */
  private async handle(eventType: EventType, event: AgentEvent): Promise<void> {
    if (!event.workItemId) return;
    const workItem = await this.taskPool.findWorkItem(event.workItemId);
    if (!workItem || !workItem.missionId) return;

    if (KR_MEASURE_EVENTS.includes(eventType)) {
      try {
        await this.measureKR(workItem);
      } catch (err) {
        this.logger.warn('KR auto-measure failed', {
          workItemId: workItem.id,
          missionId: workItem.missionId,
          error: formatError(err),
        });
      }
    }

    await this.maybePublishAllTasksDone(workItem.missionId);
  }

  /**
   * Find the KR the WI contributes to and feed it to
   * {@link KRTrackingService.onWorkItemCompleted} when that KR is measured
   * by task completion.
   */
  private async measureKR(workItem: WorkItem): Promise<void> {
    const missionId = workItem.missionId as string;
    const explicitKrId =
      typeof workItem.metadata?.krId === 'string' ? (workItem.metadata.krId as string) : undefined;

    let kr: KeyResult | null = null;
    if (explicitKrId) {
      kr = await this.krTracking.get(missionId, explicitKrId);
    } else {
      const krs = await this.krTracking.listByMission(missionId);
      kr = krs.find((k) => k.linkedWorkItemIds.includes(workItem.id)) ?? null;
    }

    if (!kr) return;
    if (kr.measurementSource !== TASK_COMPLETION_SOURCE) {
      this.logger.debug('KR not measured by task completion — skipping auto-measure', {
        krId: kr.id,
        measurementSource: kr.measurementSource,
      });
      return;
    }

    // `onWorkItemCompleted` keys on `metadata.krId`; inject it when the link
    // was discovered via `linkedWorkItemIds` so the existing service method
    // can stay untouched.
    const withKr: WorkItem = explicitKrId
      ? workItem
      : { ...workItem, metadata: { ...(workItem.metadata ?? {}), krId: kr.id } };
    await this.krTracking.onWorkItemCompleted(withKr);
    this.logger.info('KR auto-measured from task completion', {
      krId: kr.id,
      missionId,
      workItemId: workItem.id,
    });
  }

  /**
   * Publish `team:all_tasks_done` once per mission per UTC day when the
   * mission has no non-terminal WorkItems left in the pool.
   */
  private async maybePublishAllTasksDone(missionId: string): Promise<void> {
    const key = `${missionId}:${dayKey(this.now())}`;
    if (this.publishedAllDone.includes(key)) return;

    const allItems = await this.taskPool.getAllItems();
    const missionItems = allItems.filter((wi) => wi.missionId === missionId);
    if (missionItems.length === 0) return;
    const active = missionItems.filter((wi) => !SLA_TERMINAL_WORK_ITEM_STATUSES.has(wi.status));
    if (active.length > 0) return;

    // Re-check after the awaits: two WIs finishing in the same tick both
    // pass the early check above; only the first to reach this synchronous
    // section may publish.
    if (this.publishedAllDone.includes(key)) return;
    this.rememberPublished(key);
    const mission = await this.loadMission(missionId);
    this.eventBus.publish({
      id: `${missionId}:all_tasks_done:${dayKey(this.now())}`,
      type: 'team:all_tasks_done',
      timestamp: this.now().toISOString(),
      teamId: mission?.ownerTeamId ?? '',
      teamName: '',
      memberId: '',
      memberName: '',
      sessionName: '',
      previousValue: String(missionItems.length),
      newValue: 'all_tasks_done',
      changedField: 'taskStatus',
      missionId,
    });
    this.logger.info('team:all_tasks_done published', {
      missionId,
      totalItems: missionItems.length,
    });
  }

  private rememberPublished(key: string): void {
    this.publishedAllDone.push(key);
    if (this.publishedAllDone.length > ALL_TASKS_DONE_DEDUP_CAPACITY) {
      this.publishedAllDone.shift();
    }
  }
}
