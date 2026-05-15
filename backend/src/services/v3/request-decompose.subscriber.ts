/**
 * Request Decompose Subscriber — Pipeline-#4 follow-up (Option C).
 *
 * **What this fixes**
 *
 * `RequestService.plan()` is a PURE FUNCTION that returns a {@link RequestPlan}
 * but does NOT persist anything or call `taskPool.addToPool` for the planned
 * tasks. Pipeline-#4 (PR #453) wired the linkage path (workitem:queued →
 * linkWorkItem → maybeCloseRequest sibling-count gate), but never bridged
 * `plan() → addToPool`. As a result, any new actionable L2 Request landed
 * with empty `workItemIds[]` unless the orc manually invoked the
 * `break-down-request` skill.
 *
 * Steve dogfooded the symptom on 2026-05-05: POSTed Requests showed up in
 * the Requests UI with no children, and the orc had to be prompted to
 * decompose them. "Rails built but not ridden."
 *
 * **What this does**
 *
 * Listens on the bus for `request:created`. When the Request is L2 and
 * carries an actionable `intentCategory`, calls `RequestService.plan()` and
 * adds each planned task to the pool with `requestId` set on the WorkItem.
 * The existing PR #453 L4 fix at
 * `request-sla.subscriber.ts:1153` then auto-links each WorkItem ID into
 * `Request.workItemIds[]` via the `workitem:queued` → `linkWorkItem`
 * pipeline — no manual link call needed here.
 *
 * **Why a separate subscriber, not a method on RequestSlaSubscriber**
 *
 * The SLA subscriber's responsibility is "track the user-reply SLA on
 * inbound Slack/chat-v2 surfaces". Auto-decomposition is a different
 * concern (intentLevel filter, plan() invocation, fan-out add-to-pool) and
 * belongs in its own subscriber so the SLA module's surface stays focused.
 * Separation also means a future change to the decomposition heuristic
 * (e.g. richer plan() strategies, intent-aware routing) can land without
 * disturbing the SLA contract.
 *
 * **Co-existence with RequestSlaSubscriber**
 *
 * For an L2 inbound-Slack Request, both subscribers fire on the same
 * `request:created` event. Order is undefined but irrelevant:
 *   - SLA seeds the `respond_to_user` WI immediately, syncing the threadTs
 *     index for the bridge's `markResolvedByThread` lookup.
 *   - This subscriber plans + queues the actual decomposition WIs.
 *   - The first non-respond_to_user `workitem:queued` triggers the SLA
 *     subscriber's `handleWorkItemQueued`, which (a) calls `linkWorkItem`
 *     (PR #453 L4) and (b) calls `markResolved(requestId,
 *     'workitem_decompose')` to retire the SLA tracker.
 *   - The Pipeline-#4 L5 grace window inside `maybeCloseRequest` keeps the
 *     parent Request open until siblings are linked, suppressing the
 *     premature `orc_reply` cascade close that the original bug would have
 *     triggered.
 *
 * Net effect: a POSTed L2 Request now lands with WorkItems within ~ms of
 * `request:created` publish, and the close-cascade behaves as designed.
 *
 * **Idempotence on redelivery**
 *
 * Two safeguards:
 *   1. In-memory `decomposedRequestIds` Set guards against the same event
 *      being delivered twice within process lifetime. O(1) check, no
 *      cross-process synchronisation needed.
 *   2. Belt-and-suspenders: even if the in-memory guard misses (e.g.
 *      restart between deliveries), `taskPool.addToPool` already
 *      short-circuits on duplicate id. We use deterministic ids — the
 *      uuidv4 from `createWorkItem` is non-deterministic, so the dup-check
 *      protects us only against the in-memory replay; cross-process replay
 *      protection is the `request.workItemIds.length > 0` skip below.
 *
 * **Skip rules** (in order; first match wins):
 *   - `intentLevel !== 'L2'` (L0/L1 are non-decomposing surfaces)
 *   - `intentCategory ∉ ACTIONABLE_CATEGORIES`
 *   - `request.workItemIds.length > 0` (caller already manually decomposed)
 *   - `decomposedRequestIds.has(request.id)` (already processed in this
 *     process lifetime)
 *   - `plan.tasks.length === 0` or `plan.strategy === 'none'`
 *
 * @module services/v3/request-decompose.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import { RequestService } from './request.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Request, IntentCategory } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import type { PlannedTask } from './v3-data.service.js';

// ---------------------------------------------------------------------------
// Filter rules
// ---------------------------------------------------------------------------

/**
 * Intent categories the auto-decompose subscriber will plan + fan-out for.
 *
 * Choice rationale:
 *   - `planning`     — explicit decomposition request; canonical use case.
 *   - `code_change`  — feature/refactor work; multi-step plan pays off.
 *   - `debugging`    — investigation + fix + verify benefits from split.
 *   - `deployment`   — multi-step coordination (build/ship/verify).
 *   - `research`     — survey + synthesise + report fans out cleanly.
 *
 * Excluded:
 *   - `query`        — single-shot lookup; decomposition adds noise.
 *   - `review`       — single artefact-bound; the orc handles inline.
 *   - `communication`— L1 surface; usually handled by SLA respond_to_user.
 *   - `other`        — explicitly opt-out for ambiguous shapes.
 *
 * The original brief listed `team_management` here — that is not a valid
 * IntentCategory in the type system (verified against
 * `backend/src/types/v2/request.types.ts:61-70`). Substituted `research`
 * which is genuinely actionable and decomposes well.
 */
export const ACTIONABLE_INTENT_CATEGORIES: ReadonlySet<IntentCategory> = new Set<IntentCategory>([
  'planning',
  'code_change',
  'debugging',
  'deployment',
  'research',
]);

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

/**
 * Event types this subscriber listens to. Exported so wiring code can
 * cross-reference what's subscribed without re-parsing the class.
 */
export const REQUEST_DECOMPOSE_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'request:created',
] as const;

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Constructor dependencies. Production wiring uses {@link RequestDecomposeSubscriber.boot};
 * tests construct directly with fakes.
 */
export interface RequestDecomposeSubscriberDependencies {
  /** Live event bus. */
  eventBus: EventBusService;
  /** Live RequestService for plan() + getById. */
  requestService: RequestService;
  /** Live TaskPoolService for addToPool. */
  taskPool: TaskPoolService;
  /** Override actionable categories (testing). */
  actionableCategories?: ReadonlySet<IntentCategory>;
  /** Optional logger override. */
  logger?: ComponentLogger;
}

// ---------------------------------------------------------------------------
// Module-level setter / getter (mirrors the SLA subscriber pattern)
// ---------------------------------------------------------------------------

let activeSubscriber: RequestDecomposeSubscriber | null = null;

/**
 * Production hook — set the active subscriber instance during boot so
 * shutdown code can find it. Tests bypass this by constructing directly.
 *
 * @param subscriber - The active subscriber, or `null` to clear.
 */
export function setRequestDecomposeSubscriber(
  subscriber: RequestDecomposeSubscriber | null,
): void {
  activeSubscriber = subscriber;
}

/**
 * Read-only access to the active subscriber. Used by shutdown code in
 * `index.ts` and by debugging tooling.
 *
 * @returns The active subscriber, or `null` if not booted.
 */
export function getRequestDecomposeSubscriber(): RequestDecomposeSubscriber | null {
  return activeSubscriber;
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

/**
 * Auto-decomposes new actionable L2 Requests into pool WorkItems.
 *
 * @example
 * ```typescript
 * const sub = RequestDecomposeSubscriber.boot(eventBus, requestService, taskPool);
 * sub.start();
 * // … on shutdown:
 * sub.stop();
 * ```
 */
export class RequestDecomposeSubscriber {
  private readonly eventBus: EventBusService;
  private readonly requestService: RequestService;
  private readonly taskPool: TaskPoolService;
  private readonly actionableCategories: ReadonlySet<IntentCategory>;
  private readonly logger: ComponentLogger;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  /**
   * In-memory dedupe of Request IDs that have already been auto-decomposed
   * by this process. Protects against bus redelivery within process
   * lifetime. Cross-process replay (restart) is handled by the
   * `request.workItemIds.length > 0` skip rule in {@link handleRequestCreated}.
   */
  private readonly decomposedRequestIds: Set<string> = new Set();
  /** In-flight async dispatch promises (test affordance). */
  private readonly pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: RequestDecomposeSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.requestService = deps.requestService;
    this.taskPool = deps.taskPool;
    this.actionableCategories = deps.actionableCategories ?? ACTIONABLE_INTENT_CATEGORIES;
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('RequestDecomposeSubscriber');
  }

  /**
   * Production wiring helper. Tests should use the constructor directly.
   *
   * @param eventBus - Live event bus
   * @param requestService - Live RequestService
   * @param taskPool - Live TaskPoolService
   * @returns A subscriber ready to `start()`
   */
  static boot(
    eventBus: EventBusService,
    requestService: RequestService,
    taskPool: TaskPoolService,
  ): RequestDecomposeSubscriber {
    return new RequestDecomposeSubscriber({
      eventBus,
      requestService,
      taskPool,
    });
  }

  /**
   * Subscribe + register the in-process handlers. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const eventType of REQUEST_DECOMPOSE_SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }

    this.logger.info('RequestDecomposeSubscriber subscribed', {
      eventTypes: REQUEST_DECOMPOSE_SUBSCRIBED_EVENTS,
      actionableCategories: Array.from(this.actionableCategories),
    });
  }

  /**
   * Wait for in-flight async dispatches to settle. Test affordance.
   *
   * @returns Promise that resolves when all pending dispatches finish.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Detach subscriptions. Safe to call repeatedly.
   */
  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.warn('Decompose unsubscribe threw', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.unsubscribers = [];
    this.started = false;
    this.logger.info('RequestDecomposeSubscriber stopped');
  }

  /**
   * Test-only accessor for the dedupe set. Useful for verifying the
   * in-memory guard from integration tests.
   *
   * @returns The set of Request IDs already processed by this instance.
   */
  public getDecomposedRequestIdsSnapshot(): ReadonlySet<string> {
    return new Set(this.decomposedRequestIds);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * `request:created` handler. Filters by intentLevel + actionable
   * intentCategory, calls plan(), and adds each planned task to the pool
   * as a WorkItem with `requestId` set. The existing PR #453 L4 fix
   * (`request-sla.subscriber.ts:handleWorkItemQueued`) auto-links each WI
   * into `Request.workItemIds[]`, so no manual `linkWorkItem` call is
   * needed here.
   *
   * @param event - The `request:created` event from the bus.
   */
  private handleRequestCreated = async (event: AgentEvent): Promise<void> => {
    if (!event.requestId) {
      this.logger.debug('request:created event missing requestId', { eventId: event.id });
      return;
    }

    const requestId = event.requestId;

    // In-memory dedupe guard against bus redelivery within process lifetime.
    if (this.decomposedRequestIds.has(requestId)) {
      this.logger.debug('request:created already auto-decomposed — skip', { requestId });
      return;
    }

    const request = await this.requestService.getById(requestId);
    if (!request) {
      this.logger.warn('request:created references unknown Request', { requestId });
      return;
    }

    if (!this.shouldDecompose(request)) {
      // shouldDecompose logs the specific reason; no double-log here.
      return;
    }

    const plan = await this.requestService.plan(request.description);
    if (plan.tasks.length === 0 || plan.strategy === 'none') {
      this.logger.warn('plan() returned no tasks — skip auto-decompose', {
        requestId,
        strategy: plan.strategy,
        reasoning: plan.reasoning,
      });
      // Mark as processed even on no-op plan so a redelivery doesn't
      // re-attempt the same dead-end work.
      this.decomposedRequestIds.add(requestId);
      return;
    }

    // Mark BEFORE addToPool so a concurrent redelivery sees us in-flight
    // and skips. The skip rule is best-effort — a true redelivery race
    // (event delivered twice within microseconds) would still hit
    // `addToPool`'s id-based dedup as a secondary safety net (though our
    // ids are uuidv4 so the secondary net only catches truly identical WI
    // objects, not "same Request decomposed twice"). The primary cross-
    // process safety net is the `workItemIds.length > 0` skip on
    // restart-replay.
    this.decomposedRequestIds.add(requestId);

    // Two-pass fan-out so `dependsOnTitles` can be resolved to WorkItem IDs:
    //   Pass 1 — build all WorkItems (without resolved deps) so we have a
    //            complete title→id map.
    //   Pass 2 — for each task with `dependsOnTitles`, look up the matching
    //            WorkItem ids and write them into `wi.dependsOn` (canonical
    //            field). Items that depend on something also flip to status
    //            'blocked' so they don't get claimed before their dependency
    //            completes (mirrors mission-executor's PR #491 fix).
    //   Pass 3 — addToPool in plan order. Mission-executor takes the same
    //            shape; symmetrising here means the pool always sees a
    //            self-consistent dependency graph at insertion time.
    const queuedIds: string[] = [];
    const titleToId = new Map<string, string>();
    const builtItems: WorkItem[] = [];

    // Pass 1: build (no deps)
    for (const task of plan.tasks) {
      const wi = this.buildWorkItemFromTask(task, request);
      builtItems.push(wi);
      titleToId.set(task.title, wi.id);
    }

    // Pass 2: resolve dependsOnTitles → dependsOn (id list) + status='blocked'
    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const wi = builtItems[i];
      if (!task.dependsOnTitles || task.dependsOnTitles.length === 0) continue;
      const blockedByIds = task.dependsOnTitles
        .map((title) => titleToId.get(title))
        .filter((id): id is string => id !== undefined);
      if (blockedByIds.length > 0) {
        wi.dependsOn = blockedByIds;
        wi.status = 'blocked';
        // Steve 2026-05-15 dogfood: surface a human-readable reason so
        // the UI's "Blocked" badge isn't opaque. List the dependency
        // titles (truncated) so a user clicking through sees "Waiting
        // on: Plan: ..." rather than just "Blocked" with no timeline
        // event.
        const depTitles = task.dependsOnTitles
          .map((t) => (t.length > 50 ? `${t.slice(0, 50)}…` : t))
          .join('; ');
        wi.blockedReason = `Waiting on dependency: ${depTitles}`;
      }
    }

    // Pass 3: addToPool. Insert in plan order so the dependency-resolver
    // sees parents before children at the moment of insertion.
    for (const wi of builtItems) {
      try {
        await this.taskPool.addToPool(wi);
        queuedIds.push(wi.id);
      } catch (err) {
        this.logger.warn('addToPool failed during auto-decompose (non-fatal)', {
          requestId,
          taskTitle: wi.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('Request auto-decomposed', {
      requestId,
      strategy: plan.strategy,
      taskCount: plan.tasks.length,
      queuedCount: queuedIds.length,
      queuedIds,
    });
  };

  /**
   * Filter predicate. Returns true iff the Request should be auto-decomposed.
   * Logs the specific skip reason at debug level so ops can correlate
   * "I POSTed a Request but no WIs appeared" with the rule that excluded it.
   *
   * @param request - The Request to evaluate.
   * @returns True if this subscriber should plan + addToPool for this Request.
   */
  private shouldDecompose(request: Request): boolean {
    if (request.intentLevel !== 'L2') {
      this.logger.debug('skip auto-decompose — intentLevel is not L2', {
        requestId: request.id,
        intentLevel: request.intentLevel,
      });
      return false;
    }

    if (!this.actionableCategories.has(request.intentCategory)) {
      this.logger.debug('skip auto-decompose — non-actionable intentCategory', {
        requestId: request.id,
        intentCategory: request.intentCategory,
      });
      return false;
    }

    // Caller (or a prior pass before a restart) already decomposed this
    // Request manually. Don't double-add. The check is on the persisted
    // workItemIds (cross-process safe) — distinct from the in-memory
    // decomposedRequestIds dedupe (within-process redelivery).
    if (request.workItemIds.length > 0) {
      this.logger.debug('skip auto-decompose — Request already has linked WorkItems', {
        requestId: request.id,
        existingCount: request.workItemIds.length,
      });
      return false;
    }

    return true;
  }

  /**
   * Builds a pool-ready WorkItem from a planned task. Mirrors the
   * `break-down-request` skill's WI shape (owner=orchestrator, no preset
   * target → orc routes during fan-out) so consumers downstream can't
   * tell whether the decomposition came from the skill or this subscriber.
   *
   * @param task - The planned task from RequestService.plan()
   * @param request - The parent Request (provides id + missionId for back-refs)
   * @returns A queued WorkItem ready for `taskPool.addToPool`.
   */
  private buildWorkItemFromTask(task: PlannedTask, request: Request): WorkItem {
    return createWorkItem({
      type: 'delegate',
      owner: 'orchestrator',
      // No `target` — orc decides assignment during fan-out. Mirrors the
      // `break-down-request` skill's `target=unassigned` default.
      title: task.title,
      description: this.formatDescription(task),
      requestId: request.id,
      missionId: request.missionId,
      metadata: {
        autoDecomposed: true,
        planStrategy: 'derived-from-RequestService.plan',
        priority: task.priority,
        acceptanceCriteria: task.acceptanceCriteria,
      },
    });
  }

  /**
   * Combine PlannedTask description + acceptance criteria into a single
   * description block visible to the agent picking up the WorkItem.
   * Acceptance criteria render as a bullet list under a header so the
   * agent's prompt-builder can surface them inline.
   *
   * @param task - The planned task.
   * @returns Combined description + criteria block.
   */
  private formatDescription(task: PlannedTask): string {
    const criteria = task.acceptanceCriteria
      .map((c) => `  - ${c}`)
      .join('\n');
    return `${task.description}\n\nAcceptance criteria:\n${criteria}`;
  }

  /**
   * Wrap a dispatch so a thrown handler is logged and isolated. Mirrors
   * `RequestSlaSubscriber.safeDispatch`.
   *
   * @param eventType - The event type that triggered this dispatch
   * @param event - The event payload
   * @returns Promise that resolves when the handler finishes (or throws).
   */
  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const dispatch = (async () => {
      try {
        if (eventType === 'request:created') {
          await this.handleRequestCreated(event);
        }
      } catch (err) {
        this.logger.error('Decompose subscriber handler threw', {
          eventType,
          eventId: event.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    this.pendingDispatches.add(dispatch);
    dispatch
      .finally(() => {
        this.pendingDispatches.delete(dispatch);
      })
      .catch(() => {
        // suppress unhandled-rejection — flushPending owners use allSettled.
      });
    return dispatch;
  }
}
