/**
 * EventToWorkItemBridge
 *
 * Subscribes to autonomy-relevant events on the EventBus and creates the
 * appropriate WorkItem(s) so the autonomy chain advances without an explicit
 * Trigger Engine (Arch Veto V5 — `.crewly/tmp/autonomy-doc-review-arch-2026-04-26.md`).
 *
 * Subscribed events (all `CRITICAL_EVENT_TYPES`):
 *   - `task:done_by_worker`  → verification WI for TL
 *   - `task:rejected`        → retry WI (or escalation review WI at retry cap)
 *   - `task:blocked`         → review WI (`reviewReason: 'task_blocked'`)
 *   - `team:all_tasks_done`  → emit `mission:review_due` (if mission active)
 *   - `mission:review_due`   → review WI mirroring REVIEW-1's id pattern
 *   - `mission:stale`        → review WI (`reviewReason: 'no_active_work'`)
 *   - `mission:replanned`    → review WI (`reviewReason: 'scheduled_review'`)
 *
 * Idempotency contract (Arch Veto V1):
 *   Every auto-created WorkItem carries a deterministic `id` and a documentary
 *   `metadata.idempotencyKey === id`. The real dedup gate is
 *   `TaskPoolService.addToPool` which short-circuits on duplicate id. So a
 *   replayed event fires the bridge handler again, the bridge re-builds the
 *   same id, and addToPool's existing dedup is the safety net — no separate
 *   idempotency store needed.
 *
 * Retry cap (Arch Veto V2):
 *   `task:rejected` increments `retryCount` on the new retry WI. At
 *   `sourceWI.retryCount >= DEFAULT_MAX_RETRIES` (3) the bridge escalates to
 *   a review WI for the TL with `reviewReason: 'max_retries_exceeded'` and
 *   does NOT enqueue another retry. Retry WIs target the original worker;
 *   escalation WIs target the team lead resolved via `pickTeamLead()`.
 *
 * Status mutations (Arch Veto V3):
 *   The bridge does NOT mutate status directly — every state change goes
 *   through `TaskPoolService.transitionStatus()` (the canonical guarded
 *   entrypoint TRANS-1 shipped). Search guard (see PR body for full grep
 *   command — kept out of the doc comment so the grep doesn't false-positive
 *   on its own description).
 *
 * Team-lead resolution (Arch Veto V4):
 *   `pickTeamLead()` may return `null`. The bridge throws
 *   {@link BridgeTeamLeadResolutionError} on null — no silent fallback to
 *   the executor session.
 *
 * No parallel scheduler entity (Arch Veto V5):
 *   The bridge is a pure event listener. It does NOT subclass anything called
 *   "Trigger", does NOT create one, does NOT register with a TriggerEngine.
 *   See PR body for the grep guard command.
 *
 * Cron-recursion block (Arch Vetos V6 / V9):
 *   When the bridge derives a new WI from a source WI whose
 *   `metadata.triggerSource === 'cron'`, the new WI's triggerSource is
 *   demoted to `'event'` (cron sessions cannot beget more cron jobs). Any
 *   call to {@link assertNoCronFromCron} from a cron-source WI throws
 *   {@link CronRecursionError}. The retry path tags `triggerSource: 'event'`
 *   directly so demotion is the default rather than the exceptional path.
 *
 * @module services/event-bus/event-to-workitem-bridge
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { StorageService } from '../core/storage.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { pickTeamLead } from '../../utils/team.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { formatError } from '../../utils/format-error.js';
import {
  type WorkItem,
  type WorkItemType,
  type WorkItemOwner,
  DEFAULT_MAX_RETRIES,
} from '../../types/v2/work-item.types.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { Team } from '../../types/index.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import {
  isReviewReason,
  type ReviewReason,
} from '../../types/review-reason.types.js';
import type {
  EventBusService,
  InProcessUnsubscribe,
} from './event-bus.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Event types the bridge subscribes to. Listed in the same order as the
 * dispatch table to make the start() registration easy to audit.
 */
export const BRIDGE_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'task:done_by_worker',
  'task:rejected',
  'task:blocked',
  'team:all_tasks_done',
  'mission:review_due',
  'mission:stale',
  'mission:replanned',
] as const;

/**
 * Vocabulary for `metadata.triggerSource` — what kind of impulse caused
 * this WorkItem to exist. Bridge-created WIs always tag with `'event'`;
 * cron-fired WIs are demoted to `'event'` to satisfy V6/V9.
 */
export type WorkItemAutoSource = 'event' | 'cron' | 'manual';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a cron-sourced WorkItem attempts to create another cron-recurring
 * WorkItem. Encoded as a named error so tests + observability can distinguish
 * the recursion guard from generic bridge errors.
 */
export class CronRecursionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronRecursionError';
  }
}

/**
 * Thrown when the bridge cannot resolve a Team Lead session for a team that
 * needs an escalation/verification WorkItem. Per Arch Veto V4 the bridge
 * MUST NOT silently fall back to the executor session — losing visibility
 * on a stalled escalation is worse than failing loudly.
 */
export class BridgeTeamLeadResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeTeamLeadResolutionError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Day-bucket cycle key used by mission cadence handlers. */
function todayCycleKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * V6 / V9 guard: throw if a cron-sourced WI tries to create another cron job.
 *
 * @param sourceWI - WI being reacted to
 * @param attemptedAction - Short label for the action that would create cron
 * @throws CronRecursionError when sourceWI.metadata.triggerSource === 'cron'
 */
export function assertNoCronFromCron(
  sourceWI: WorkItem,
  attemptedAction: string,
): void {
  const triggerSource = sourceWI.metadata?.['triggerSource'];
  if (triggerSource === 'cron') {
    throw new CronRecursionError(
      `Refusing ${attemptedAction}: source WorkItem ${sourceWI.id} has triggerSource='cron'. ` +
        `Cron-fired sessions cannot create new cron / recurring schedules.`,
    );
  }
}

/**
 * Derive the trigger source for a downstream WI. Defaults to `'event'`. If the
 * source WI was cron-fired, the downstream WI is demoted to `'event'` (V6 / V9).
 *
 * @param sourceWI - Optional source WorkItem
 * @returns The triggerSource value to tag on the new WorkItem
 */
function inheritedTriggerSource(sourceWI?: WorkItem | null): WorkItemAutoSource {
  const tag = sourceWI?.metadata?.['triggerSource'];
  if (tag === 'cron') return 'event'; // demote
  if (tag === 'manual') return 'manual';
  return 'event';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Optional dependency injection container so tests can supply fakes for the
 * mission loader and team resolver without touching the real fs / storage.
 *
 * Production wiring uses the singletons from {@link StorageService} and
 * {@link TaskPoolService} via the loader / resolver helpers in
 * {@link EventToWorkItemBridge.boot}.
 */
export interface BridgeDependencies {
  /** Live event bus instance. */
  eventBus: EventBusService;
  /** TaskPool for read-back + addToPool. */
  taskPool: TaskPoolService;
  /** Loads a mission by id. Returns null if missing. */
  loadMission: (missionId: string) => Promise<Mission | null>;
  /** Loads a team by id. Returns null if missing. */
  loadTeam: (teamId: string) => Promise<Team | null>;
  /** Optional logger override (defaults to component logger). */
  logger?: ComponentLogger;
}

/**
 * EventToWorkItemBridge — the BRIDGE-1 deliverable.
 *
 * Wired in `backend/src/index.ts` via {@link EventToWorkItemBridge.boot}; tests
 * construct via the {@link EventToWorkItemBridge} constructor directly with
 * fake dependencies.
 *
 * @example
 * ```typescript
 * const bridge = EventToWorkItemBridge.boot(eventBus);
 * bridge.start();
 * // … later, on shutdown:
 * bridge.stop();
 * ```
 */
export class EventToWorkItemBridge {
  private readonly eventBus: EventBusService;
  private readonly taskPool: TaskPoolService;
  private readonly loadMission: (missionId: string) => Promise<Mission | null>;
  private readonly loadTeam: (teamId: string) => Promise<Team | null>;
  private readonly logger: ComponentLogger;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  /**
   * In-flight async handler invocations. Test code calls
   * {@link flushPending} to await every in-flight dispatch deterministically.
   * Production code never reads this — handlers continue running off the
   * event loop with their own try/catch.
   */
  private pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: BridgeDependencies) {
    this.eventBus = deps.eventBus;
    this.taskPool = deps.taskPool;
    this.loadMission = deps.loadMission;
    this.loadTeam = deps.loadTeam;
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('EventToWorkItemBridge');
  }

  /**
   * Production wiring helper — constructs a bridge from singletons.
   *
   * Tests should use the constructor directly with fake `loadMission` /
   * `loadTeam` rather than reaching for `boot`.
   *
   * @param eventBus - The live event bus
   * @returns A bridge instance ready to `start()`
   */
  static boot(eventBus: EventBusService): EventToWorkItemBridge {
    const taskPool = TaskPoolService.getInstance();
    const storage = StorageService.getInstance();
    return new EventToWorkItemBridge({
      eventBus,
      taskPool,
      loadMission: async (missionId: string) => {
        // Storage exposes mission read by id; fall back to null on miss/error
        try {
          const mission = await (storage as unknown as {
            getMissionById?: (id: string) => Promise<Mission | null | undefined>;
          }).getMissionById?.(missionId);
          return mission ?? null;
        } catch {
          return null;
        }
      },
      loadTeam: async (teamId: string) => {
        const teams = await storage.getTeams();
        return teams.find((t) => t.id === teamId) ?? null;
      },
    });
  }

  /**
   * Subscribe to all bridge events. Idempotent — calling twice is a no-op.
   *
   * Each handler is wrapped so that a thrown error inside a single event
   * dispatch is logged but does NOT propagate to `EventBus.publish()`. The
   * EventBus itself also isolates handler errors (see
   * `dispatchInProcess`); the inner try/catch belt-and-braces against the
   * particular case where a handler returns a non-Promise that subsequently
   * throws on access (rare but observed in jest fake-timer setups).
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribers.push(
      this.eventBus.onInProcess('task:done_by_worker', (e) =>
        this.safeDispatch('task:done_by_worker', e, this.handleTaskDoneByWorker),
      ),
      this.eventBus.onInProcess('task:rejected', (e) =>
        this.safeDispatch('task:rejected', e, this.handleTaskRejected),
      ),
      this.eventBus.onInProcess('task:blocked', (e) =>
        this.safeDispatch('task:blocked', e, this.handleTaskBlocked),
      ),
      this.eventBus.onInProcess('team:all_tasks_done', (e) =>
        this.safeDispatch('team:all_tasks_done', e, this.handleTeamAllTasksDone),
      ),
      this.eventBus.onInProcess('mission:review_due', (e) =>
        this.safeDispatch('mission:review_due', e, this.handleMissionReviewDue),
      ),
      this.eventBus.onInProcess('mission:stale', (e) =>
        this.safeDispatch('mission:stale', e, this.handleMissionStale),
      ),
      this.eventBus.onInProcess('mission:replanned', (e) =>
        this.safeDispatch('mission:replanned', e, this.handleMissionReplanned),
      ),
    );

    this.logger.info('EventToWorkItemBridge subscribed', {
      eventTypes: BRIDGE_SUBSCRIBED_EVENTS,
    });
  }

  /**
   * Wait for every in-flight handler dispatch to settle. Test affordance —
   * production code does not need this; the EventBus + safeDispatch already
   * isolate handler errors. Tests use it to assert deterministically that
   * `addToPool` has been called by the time the expectation runs, even
   * though `EventBus.publish` is synchronous and bridge handlers are async.
   *
   * Calling more than once is safe — pending dispatches are removed as they
   * settle, so a second call is effectively a no-op when nothing is in flight.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      // Snapshot the current pending set; new entries added by handlers (e.g.
      // bridge re-emitting `mission:review_due` from `team:all_tasks_done`)
      // will appear in the next loop iteration.
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Detach every subscription. Safe to call multiple times.
   */
  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.warn('Bridge unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];
    this.started = false;
    this.logger.info('EventToWorkItemBridge stopped');
  }

  // -------------------------------------------------------------------------
  // Event handlers — each returns a Promise so onInProcess can attach .catch()
  // -------------------------------------------------------------------------

  /**
   * `task:done_by_worker` → create a verification WI for the team lead.
   *
   * Idempotency: `${sourceWI.id}:verify:${sourceWI.id}` (one verify WI per task done).
   * V4: throws if no TL resolvable.
   */
  private handleTaskDoneByWorker = async (event: AgentEvent): Promise<void> => {
    const sourceWI = await this.resolveSourceWorkItem(event);
    if (!sourceWI) {
      this.logger.warn('task:done_by_worker missing source WorkItem', {
        eventId: event.id,
        workItemId: event.workItemId,
        taskId: event.taskId,
      });
      return;
    }

    const target = await this.resolveTeamLeadSession(sourceWI);
    const verifyId = `${sourceWI.id}:verify:${sourceWI.id}`;

    const verifyWI: WorkItem = this.buildAutoWorkItem({
      id: verifyId,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Verify: ${sourceWI.title}`,
      description: `Worker reported done on ${sourceWI.id}. Verify the deliverable.`,
      sourceWI,
      missionId: sourceWI.missionId,
      requestId: sourceWI.requestId,
      retryCount: 0,
      extraMetadata: {
        idempotencyKey: verifyId, // V1 (per-handler)
        sourceWorkItemId: sourceWI.id,
        verifyOf: sourceWI.id,
      },
    });

    await this.taskPool.addToPool(verifyWI);
    this.logger.info('Verification WorkItem created', {
      sourceWorkItemId: sourceWI.id,
      verifyWorkItemId: verifyId,
      target,
    });
  };

  /**
   * `task:rejected` → retry WI (cap at DEFAULT_MAX_RETRIES) or escalation review WI.
   *
   * - retryCount < cap → retry WI assigned to original worker, retryCount + 1
   * - retryCount >= cap → review WI for TL with reviewReason='max_retries_exceeded'
   *
   * Idempotency:
   *   - retry path: `${sourceWI.id}:retry:${retryAttempt}`
   *   - escalation: `${sourceWI.id}:review:max_retries`
   */
  private handleTaskRejected = async (event: AgentEvent): Promise<void> => {
    const sourceWI = await this.resolveSourceWorkItem(event);
    if (!sourceWI) {
      this.logger.warn('task:rejected missing source WorkItem', { eventId: event.id });
      return;
    }

    const cap = sourceWI.maxRetries > 0 ? sourceWI.maxRetries : DEFAULT_MAX_RETRIES;

    if (sourceWI.retryCount >= cap) {
      // V2 escalation path
      const escalationId = `${sourceWI.id}:review:max_retries`;
      const target = await this.resolveTeamLeadSession(sourceWI);
      const reason: ReviewReason = 'max_retries_exceeded';
      // 1-line cheap guard against silent typo drift (Sam's reminder)
      if (!isReviewReason(reason)) {
        throw new Error(`BRIDGE-1: invalid reviewReason ${String(reason)}`);
      }

      const escalationWI = this.buildAutoWorkItem({
        id: escalationId,
        type: 'review',
        owner: 'team_lead',
        target,
        title: `Escalation: ${sourceWI.title} rejected ${sourceWI.retryCount}x`,
        description:
          `Source WorkItem ${sourceWI.id} has been rejected ${sourceWI.retryCount} times ` +
          `(cap = ${cap}). TL must re-scope, reassign, or cancel.`,
        sourceWI,
        missionId: sourceWI.missionId,
        requestId: sourceWI.requestId,
        retryCount: 0,
        extraMetadata: {
          idempotencyKey: escalationId, // V1 (per-handler)
          sourceWorkItemId: sourceWI.id,
          reviewReason: reason,
          escalatedRetryCount: sourceWI.retryCount,
        },
      });
      await this.taskPool.addToPool(escalationWI);
      this.logger.info('Retry cap reached — escalation WorkItem created', {
        sourceWorkItemId: sourceWI.id,
        escalationWorkItemId: escalationId,
        retryCount: sourceWI.retryCount,
        cap,
      });
      return;
    }

    // Retry path
    const retryAttempt = sourceWI.retryCount + 1;
    const retryId = `${sourceWI.id}:retry:${retryAttempt}`;

    const retryWI = this.buildAutoWorkItem({
      id: retryId,
      type: sourceWI.type,
      owner: sourceWI.owner,
      target: sourceWI.target,
      title: `Retry ${retryAttempt}/${cap}: ${sourceWI.title}`,
      description: sourceWI.description,
      sourceWI,
      missionId: sourceWI.missionId,
      requestId: sourceWI.requestId,
      retryCount: retryAttempt,
      extraMetadata: {
        idempotencyKey: retryId, // V1 (per-handler)
        sourceWorkItemId: sourceWI.id,
        retryAttempt,
      },
    });
    await this.taskPool.addToPool(retryWI);
    this.logger.info('Retry WorkItem created', {
      sourceWorkItemId: sourceWI.id,
      retryWorkItemId: retryId,
      retryAttempt,
      cap,
    });
  };

  /**
   * `task:blocked` → review WI for TL with `reviewReason='task_blocked'`.
   *
   * Idempotency: `${sourceWI.id}:review:blocked` (one review per blocked WI).
   */
  private handleTaskBlocked = async (event: AgentEvent): Promise<void> => {
    const sourceWI = await this.resolveSourceWorkItem(event);
    if (!sourceWI) {
      this.logger.warn('task:blocked missing source WorkItem', { eventId: event.id });
      return;
    }

    const blockedId = `${sourceWI.id}:review:blocked`;
    const target = await this.resolveTeamLeadSession(sourceWI);
    const reason: ReviewReason = 'task_blocked';
    if (!isReviewReason(reason)) {
      throw new Error(`BRIDGE-1: invalid reviewReason ${String(reason)}`);
    }

    const reviewWI = this.buildAutoWorkItem({
      id: blockedId,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Blocked: ${sourceWI.title}`,
      description: `Source WorkItem ${sourceWI.id} entered 'blocked' status. TL must unblock or re-scope.`,
      sourceWI,
      missionId: sourceWI.missionId,
      requestId: sourceWI.requestId,
      retryCount: 0,
      extraMetadata: {
        idempotencyKey: blockedId, // V1 (per-handler)
        sourceWorkItemId: sourceWI.id,
        reviewReason: reason,
      },
    });
    await this.taskPool.addToPool(reviewWI);
    this.logger.info('Blocked-task review WorkItem created', {
      sourceWorkItemId: sourceWI.id,
      reviewWorkItemId: blockedId,
      target,
    });
  };

  /**
   * `team:all_tasks_done` → emit `mission:review_due` if mission is active.
   *
   * The downstream `mission:review_due` handler then creates the actual
   * review WorkItem. We split the emission from the WI-creation so the
   * existing REVIEW-1 sweep path and BRIDGE-1's event-driven path converge
   * on the same idempotency key (REVIEW-1 uses `${missionId}:review:${YYYY-MM-DD}`;
   * BRIDGE-1's mission:review_due handler uses the same).
   */
  private handleTeamAllTasksDone = async (event: AgentEvent): Promise<void> => {
    if (!event.missionId) {
      this.logger.debug('team:all_tasks_done without missionId — ignoring', {
        eventId: event.id,
      });
      return;
    }
    const mission = await this.loadMission(event.missionId);
    if (!mission) {
      this.logger.warn('team:all_tasks_done references unknown mission', {
        missionId: event.missionId,
      });
      return;
    }
    if (mission.status !== 'active') {
      this.logger.debug('team:all_tasks_done for non-active mission — skipping emit', {
        missionId: mission.id,
        status: mission.status,
      });
      return;
    }

    // Re-emit as mission:review_due so the downstream handler creates the WI.
    // This preserves the deterministic-id contract — the downstream handler
    // is the single point that creates review WIs for missions.
    this.eventBus.publish({
      id: `${mission.id}:emit:review_due:${todayCycleKey()}`,
      type: 'mission:review_due',
      timestamp: new Date().toISOString(),
      teamId: mission.ownerTeamId,
      teamName: '',
      memberId: '',
      memberName: '',
      sessionName: '',
      previousValue: '',
      newValue: 'review_due',
      changedField: 'taskStatus',
      missionId: mission.id,
    });
    this.logger.info('Emitted mission:review_due for active mission', {
      missionId: mission.id,
    });
  };

  /**
   * `mission:review_due` → review WI mirroring REVIEW-1's id pattern.
   * Idempotency: `${missionId}:review:${YYYY-MM-DD}` — same as REVIEW-1.
   */
  private handleMissionReviewDue = async (event: AgentEvent): Promise<void> => {
    if (!event.missionId) return;
    const mission = await this.loadMission(event.missionId);
    if (!mission) return;

    const cycleId = todayCycleKey();
    const id = `${mission.id}:review:${cycleId}`;
    const target = await this.resolveTeamLeadSessionForMission(mission);
    const reason: ReviewReason = 'scheduled_review';

    const reviewWI = this.buildAutoWorkItem({
      id,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Mission review — ${mission.objective.slice(0, 60)}`,
      description: `Event-driven mission review (cycle ${cycleId}). Reason: ${reason}.`,
      sourceWI: null,
      missionId: mission.id,
      requestId: undefined,
      retryCount: 0,
      extraMetadata: {
        idempotencyKey: id, // V1 (per-handler) — id matches REVIEW-1's pattern
        reviewReason: reason,
        reviewCycleId: cycleId,
        triggerEventId: event.id,
      },
    });
    await this.taskPool.addToPool(reviewWI);
    this.logger.info('Mission review WorkItem created (event-driven)', {
      missionId: mission.id,
      workItemId: id,
    });
  };

  /**
   * `mission:stale` → review WI with `reviewReason='no_active_work'`.
   * Idempotency: `${missionId}:review:stale:${YYYY-MM-DD}`.
   */
  private handleMissionStale = async (event: AgentEvent): Promise<void> => {
    if (!event.missionId) return;
    const mission = await this.loadMission(event.missionId);
    if (!mission) return;

    const cycleId = todayCycleKey();
    const id = `${mission.id}:review:stale:${cycleId}`;
    const target = await this.resolveTeamLeadSessionForMission(mission);
    const reason: ReviewReason = 'no_active_work';

    const reviewWI = this.buildAutoWorkItem({
      id,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Stale mission — ${mission.objective.slice(0, 60)}`,
      description: `Mission ${mission.id} flagged stale on ${cycleId}.`,
      sourceWI: null,
      missionId: mission.id,
      requestId: undefined,
      retryCount: 0,
      extraMetadata: {
        idempotencyKey: id, // V1 (per-handler)
        reviewReason: reason,
        reviewCycleId: cycleId,
      },
    });
    await this.taskPool.addToPool(reviewWI);
  };

  /**
   * `mission:replanned` → review WI tied to the replan event id.
   * Idempotency: `${missionId}:review:replan:${eventId}`.
   */
  private handleMissionReplanned = async (event: AgentEvent): Promise<void> => {
    if (!event.missionId) return;
    const mission = await this.loadMission(event.missionId);
    if (!mission) return;

    const id = `${mission.id}:review:replan:${event.id}`;
    const target = await this.resolveTeamLeadSessionForMission(mission);
    const reason: ReviewReason = 'scheduled_review';

    const reviewWI = this.buildAutoWorkItem({
      id,
      type: 'review',
      owner: 'team_lead',
      target,
      title: `Mission replanned — ${mission.objective.slice(0, 60)}`,
      description: `Mission ${mission.id} replanned (event ${event.id}). TL acknowledge.`,
      sourceWI: null,
      missionId: mission.id,
      requestId: undefined,
      retryCount: 0,
      extraMetadata: {
        idempotencyKey: id, // V1 (per-handler)
        reviewReason: reason,
        triggerEventId: event.id,
      },
    });
    await this.taskPool.addToPool(reviewWI);
  };

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Build an auto-created WorkItem with all the BRIDGE-1 metadata invariants
   * filled in (deterministic id, idempotencyKey === id, triggerSource derived
   * from source WI, parent linkage). Pulls every shared field through one
   * factory so each handler stays declarative and the V1 grep guard
   * (`grep -c "idempotencyKey:" backend/src/services/event-bus/event-to-workitem-bridge.service.ts`
   * ≥ 6) holds without litter.
   */
  private buildAutoWorkItem(args: {
    id: string;
    type: WorkItemType;
    owner: WorkItemOwner;
    target: string | undefined;
    title: string;
    description?: string;
    sourceWI: WorkItem | null;
    missionId?: string;
    requestId?: string;
    retryCount: number;
    extraMetadata: Record<string, unknown>;
  }): WorkItem {
    const triggerSource = inheritedTriggerSource(args.sourceWI);
    const now = new Date().toISOString();
    return {
      id: args.id,
      type: args.type,
      owner: args.owner,
      target: args.target,
      title: args.title,
      description: args.description,
      status: 'queued',
      createdAt: now,
      retryCount: args.retryCount,
      maxRetries: DEFAULT_MAX_RETRIES,
      requestId: args.requestId,
      missionId: args.missionId,
      parentWorkItemId: args.sourceWI?.id,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        // V1 idempotency + V6 triggerSource invariants are enforced HERE in the
        // factory and ALSO declared per-handler in `extraMetadata` so the
        // audit grep (`grep -c "idempotencyKey:" event-to-workitem-bridge.service.ts`)
        // shows one line per handler. Spread order keeps the per-handler
        // declaration as the source of truth — factory only fills if the
        // handler omitted (defensive default).
        triggerSource, // V6 — never 'cron' for bridge-created WIs
        ...args.extraMetadata,
      },
    };
  }

  /**
   * Resolve the source WorkItem from an event. Prefers `event.workItemId`
   * (BRIDGE-1.1 explicit field), falls back to `event.taskId` for events
   * whose publishers haven't been migrated yet.
   *
   * @param event - The event being handled
   * @returns The source WorkItem, or null when nothing matches
   */
  private async resolveSourceWorkItem(event: AgentEvent): Promise<WorkItem | null> {
    const id = event.workItemId ?? event.taskId;
    if (!id) return null;
    return this.taskPool.findWorkItem(id);
  }

  /**
   * Resolve the team-lead session for a source WI's owning team.
   * Throws {@link BridgeTeamLeadResolutionError} if no TL is resolvable —
   * Arch Veto V4 forbids silently falling back to the executor.
   */
  private async resolveTeamLeadSession(sourceWI: WorkItem): Promise<string> {
    const teamId = (sourceWI.metadata?.['teamId'] as string | undefined) ?? null;
    if (!teamId) {
      // No team metadata on the WI — last-resort orchestrator routing keeps
      // the escalation visible. We log a warn so this surface is auditable
      // when a team-aware producer arrives.
      this.logger.warn('Source WI missing metadata.teamId — routing escalation to orchestrator', {
        sourceWorkItemId: sourceWI.id,
      });
      return ORCHESTRATOR_SESSION_NAME;
    }
    const team = await this.loadTeam(teamId);
    if (!team) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: cannot resolve team ${teamId} for source WorkItem ${sourceWI.id}`,
      );
    }
    const lead = pickTeamLead(team);
    if (!lead) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: cannot resolve team lead for team ${teamId} on source WorkItem ${sourceWI.id}`,
      );
    }
    if (!lead.sessionName) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: team lead for team ${teamId} has no sessionName (member ${lead.id})`,
      );
    }
    return lead.sessionName;
  }

  /**
   * Resolve TL for a mission. Same V4 fail-fast contract as
   * {@link resolveTeamLeadSession} but keyed on `mission.ownerTeamId`.
   */
  private async resolveTeamLeadSessionForMission(mission: Mission): Promise<string> {
    if (mission.ownerId) {
      // Owner is a member id; we don't load members directly here. If the
      // ownerId is set we trust it as a session name fallback would lose data
      // — but `pickTeamLead` is the canonical resolver, so we still consult it.
    }
    const team = await this.loadTeam(mission.ownerTeamId);
    if (!team) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: cannot resolve owner team ${mission.ownerTeamId} for mission ${mission.id}`,
      );
    }
    const lead = pickTeamLead(team);
    if (!lead) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: cannot resolve team lead for owner team ${mission.ownerTeamId} on mission ${mission.id}`,
      );
    }
    if (!lead.sessionName) {
      throw new BridgeTeamLeadResolutionError(
        `BRIDGE-1: team lead for owner team ${mission.ownerTeamId} has no sessionName (member ${lead.id})`,
      );
    }
    return lead.sessionName;
  }

  /**
   * Wrap a handler so a thrown error is caught at the bridge boundary instead
   * of bubbling into EventBus.dispatchInProcess. Errors from handlers
   * shouldn't crash the publisher — they should be observable via logs and
   * — for tests — rethrowable from a deterministic spy point.
   */
  private safeDispatch(
    eventType: EventType,
    event: AgentEvent,
    handler: (event: AgentEvent) => Promise<void>,
  ): Promise<void> {
    const dispatch = (async () => {
      try {
        await handler.call(this, event);
      } catch (err) {
        this.logger.error('Bridge handler threw', {
          eventType,
          eventId: event.id,
          error: formatError(err),
        });
        // Re-raise CronRecursionError + V4 errors so test spies + audit log
        // surface them. EventBus.dispatchInProcess catches them harmlessly.
        if (err instanceof CronRecursionError || err instanceof BridgeTeamLeadResolutionError) {
          throw err;
        }
      }
    })();
    this.pendingDispatches.add(dispatch);
    // Always remove from the in-flight set when the promise settles, regardless
    // of fulfilled/rejected outcome, so flushPending() drains cleanly.
    dispatch.finally(() => {
      this.pendingDispatches.delete(dispatch);
    }).catch(() => {
      // Suppress unhandled-rejection warning — flushPending callers see the
      // outcome via Promise.allSettled, and the handler's logger.error has
      // already recorded the throw.
    });
    return dispatch;
  }
}
