/**
 * AutoLearningSubscriber (LEARN-1)
 *
 * Subscribes to terminal WorkItem and mission lifecycle events on the
 * EventBus and auto-records a learning entry via the existing
 * {@link MemoryService.recordLearning} entrypoint. Closes the
 * "agents-forget-to-record" gap noted in `.crewly/tmp/autonomy-doc-review-2026-04-26.md`
 * §4 item 6 without introducing the rejected new "L-Event" type (Arch Veto V7,
 * promoted from canonical V2 per the V-numbering map of 2026-04-27) and
 * without expanding the 3-scope memory model into the rejected 5-scope shape
 * (Arch Veto V9, promoted from canonical V3).
 *
 * Subscribed events:
 *   - `task:verified`    → `pattern`     (a passed verification — what worked)
 *   - `task:done`        → `pattern`     (a completion — what worked)
 *   - `task:rejected`    → `gotcha`      (TL rejected — what didn't work)
 *   - `task:failed`      → `gotcha`      (worker failed — what broke)
 *   - `mission:replanned`→ `sop_update`  (strategy changed — operating practice)
 *
 * Idempotency contract (Arch Veto V1):
 *   Each handler dedupe-checks `${eventType}:${workItemId}` (or
 *   `${eventType}:${missionId}:${eventId}` for mission events) against an
 *   in-memory bounded LRU. The underlying `recordLearning()` is append-only
 *   (no native dedup), so the subscriber owns idempotency. The LRU is capped
 *   at {@link DEDUP_LRU_CAPACITY} entries to bound growth across long-lived
 *   processes.
 *
 * No new event types (Arch Veto V7):
 *   The subscriber listens to event types that already exist in `EVENT_TYPES`
 *   (added by BRIDGE-1.1). It does NOT introduce a new event class or any
 *   `learning:*` vocabulary. The implementation-detector grep at PR time —
 *   class/interface/type/new declarations — yields empty.
 *
 * No memory-scope expansion (Arch Veto V9):
 *   `recordLearning()` is called with the existing scope model. No new
 *   `team` / `user` scope members are added, and no `Skill`-prefixed candidate
 *   type is introduced. The implementation-detector grep at PR time yields
 *   empty.
 *
 * Fire-and-forget:
 *   Subscribers are called synchronously by the EventBus (in-process) but
 *   `recordLearning` itself is async; we wrap each dispatch so a thrown
 *   error is logged without affecting other subscribers or the publisher
 *   call site (mirrors {@link EventToWorkItemBridge.safeDispatch}).
 *
 * @module services/memory/auto-learning.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { IMemoryService } from './memory.service.js';
import { MemoryService } from './memory.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import { formatError } from '../../utils/format-error.js';

// ---------------------------------------------------------------------------
// Category vocabulary (LOCAL — does not extend RememberCategory)
// ---------------------------------------------------------------------------

/**
 * Tag prefix appended to the auto-recorded learning string. This is **not**
 * the {@link RememberCategory} enum used by the unified remember operation —
 * `recordLearning` writes free-form text to the project learnings log
 * (no `category` field), so this string prefix exists purely for human/grep
 * downstream filtering. Keeping it local avoids a forced extension of
 * `RememberCategory` (Arch Veto V9 forbids enum sprawl).
 */
export type AutoLearningTag = 'pattern' | 'gotcha' | 'sop_update';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Event types this subscriber listens to. Order mirrors the dispatch table
 * inside {@link AutoLearningSubscriber.start} for easy audit.
 *
 * NOTE: All five exist in `EVENT_TYPES` already (added by BRIDGE-1.1). LEARN-1
 * adds zero new event types — Arch Veto V7 holds.
 */
export const LEARN_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'task:verified',
  'task:done',
  'task:rejected',
  'task:failed',
  'mission:replanned',
] as const;

/**
 * Stable identity used as the `agentId` on every auto-recorded learning.
 * Distinct from any human/agent session so the project learnings log makes
 * the system origin visible (`### [system/system:auto-learning] hh:mm:ss`).
 */
export const AUTO_LEARNING_AGENT_ID = 'system:auto-learning';
export const AUTO_LEARNING_AGENT_ROLE = 'system';

/**
 * Maximum entries retained in the dedup LRU. Sized for ~hours of typical
 * event volume; the dominant cost is map memory which is negligible at 1k.
 */
export const DEDUP_LRU_CAPACITY = 1000;

/**
 * Mapping from event type to the {@link AutoLearningTag} the auto-recorder
 * stamps onto the learning string. Kept as a runtime object so a missing
 * entry yields `undefined` and the dispatcher can default rather than crash.
 */
const EVENT_CATEGORY_MAP: Partial<Record<EventType, AutoLearningTag>> = {
  'task:verified': 'pattern',
  'task:done': 'pattern',
  'task:rejected': 'gotcha',
  'task:failed': 'gotcha',
  'mission:replanned': 'sop_update',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bounded set with FIFO eviction. Used as a cheap LRU-ish dedup cache for the
 * subscriber's idempotency key set. We don't strictly need recency ordering
 * (events arrive in roughly chronological order), so FIFO is fine and avoids
 * the per-access mutation cost of a true LRU.
 */
class BoundedSet {
  private readonly capacity: number;
  private readonly data = new Set<string>();

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('BoundedSet capacity must be positive');
    }
    this.capacity = capacity;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  /**
   * Add a key; evict the oldest insertion when the set is at capacity.
   * Returns `true` if the key was newly added, `false` if it was already
   * present (caller-side idempotency check piggy-backs on this).
   */
  add(key: string): boolean {
    if (this.data.has(key)) return false;
    if (this.data.size >= this.capacity) {
      // Set iteration is insertion-ordered → first iter step yields the oldest.
      const oldest = this.data.values().next().value;
      if (oldest !== undefined) this.data.delete(oldest);
    }
    this.data.add(key);
    return true;
  }

  get size(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }
}

/**
 * Build the deterministic idempotency key for an event. Task events key on
 * `workItemId` (or `taskId` fallback) so a single WI-lifecycle transition
 * dedupes across replays. Mission events key on `missionId:eventId` so each
 * replan produces one learning even if the mission has many.
 *
 * @param event - The event being handled
 * @returns A stable key, or null if the event doesn't carry enough identity
 */
function buildIdempotencyKey(event: AgentEvent): string | null {
  if (event.type === 'mission:replanned') {
    if (!event.missionId) return null;
    return `${event.type}:${event.missionId}:${event.id}`;
  }
  const wiKey = event.workItemId ?? event.taskId;
  if (!wiKey) return null;
  return `${event.type}:${wiKey}`;
}

/**
 * Format a templated learning summary. Includes the WorkItem id, transition
 * (previous→new), resolver session, mission/team context, and timestamp —
 * everything an operator skimming the learnings log needs to find the
 * underlying WorkItem without re-running a query.
 *
 * Uses the `[[Entity]]` Karpathy-lite convention so the auto-recorded
 * learnings live in the same shape as agent-recorded ones.
 *
 * @param event - The event being summarized
 * @returns A single-line markdown-safe summary
 */
function buildLearningSummary(event: AgentEvent): string {
  const entity = event.workItemId ?? event.taskId ?? event.missionId ?? 'unknown';
  const entityKind = event.type.startsWith('mission:') ? 'Mission' : 'WorkItem';
  const transition =
    event.previousValue && event.newValue
      ? `${event.previousValue}→${event.newValue}`
      : event.newValue || event.type;
  const teamCtx = event.teamId ? ` team=${event.teamId}` : '';
  const missionCtx = event.missionId ? ` mission=${event.missionId}` : '';
  const resolverCtx = event.sessionName ? ` resolver=${event.sessionName}` : '';
  return (
    `[[${entityKind}-${entity}]] ${event.type} ${transition}.` +
    `${teamCtx}${missionCtx}${resolverCtx} timestamp=${event.timestamp}. Source: ${event.id}.`
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Optional dependency container so tests can supply fakes for the event bus
 * and memory service without touching singletons.
 */
export interface AutoLearningSubscriberDependencies {
  /** Live event bus. */
  eventBus: EventBusService;
  /** Memory service that owns `recordLearning`. */
  memoryService: IMemoryService;
  /** Project path used for the project-learnings log. Defaults to {@link process.cwd}. */
  projectPath?: string;
  /** Optional logger (defaults to component logger). */
  logger?: ComponentLogger;
  /** Optional dedup LRU capacity override (defaults to {@link DEDUP_LRU_CAPACITY}). */
  dedupCapacity?: number;
}

/**
 * AutoLearningSubscriber — the LEARN-1 deliverable.
 *
 * Wired in `backend/src/index.ts` via {@link AutoLearningSubscriber.boot}; tests
 * construct via the constructor directly with fake dependencies.
 *
 * @example
 * ```typescript
 * const subscriber = AutoLearningSubscriber.boot(eventBus);
 * subscriber.start();
 * // … later, on shutdown:
 * subscriber.stop();
 * ```
 */
export class AutoLearningSubscriber {
  private readonly eventBus: EventBusService;
  private readonly memoryService: IMemoryService;
  private readonly projectPath: string;
  private readonly logger: ComponentLogger;
  private readonly dedup: BoundedSet;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  /**
   * In-flight async dispatch promises. Test code calls
   * {@link flushPending} to await every in-flight call deterministically.
   */
  private pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: AutoLearningSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.memoryService = deps.memoryService;
    this.projectPath = deps.projectPath ?? process.cwd();
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('AutoLearningSubscriber');
    this.dedup = new BoundedSet(deps.dedupCapacity ?? DEDUP_LRU_CAPACITY);
  }

  /**
   * Production wiring helper. Tests should use the constructor directly.
   *
   * @param eventBus - The live event bus
   * @param projectPath - Optional override for the project-learnings target path
   * @returns A subscriber instance ready to `start()`
   */
  static boot(eventBus: EventBusService, projectPath?: string): AutoLearningSubscriber {
    return new AutoLearningSubscriber({
      eventBus,
      memoryService: MemoryService.getInstance(),
      projectPath,
    });
  }

  /**
   * Subscribe to all configured events. Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const eventType of LEARN_SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }

    this.logger.info('AutoLearningSubscriber subscribed', {
      eventTypes: LEARN_SUBSCRIBED_EVENTS,
      projectPath: this.projectPath,
    });
  }

  /**
   * Wait for every in-flight dispatch to settle. Test affordance.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Detach all subscriptions. Safe to call more than once.
   */
  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.warn('AutoLearning unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];
    this.started = false;
    this.logger.info('AutoLearningSubscriber stopped');
  }

  /**
   * Snapshot of the dedup state (test affordance — production code never
   * reads this).
   */
  get dedupSize(): number {
    return this.dedup.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Core handler. Resolves the idempotency key, dedupes, picks the category,
   * builds the templated summary, and calls `memoryService.recordLearning()`.
   */
  private handle = async (eventType: EventType, event: AgentEvent): Promise<void> => {
    const key = buildIdempotencyKey(event);
    if (!key) {
      this.logger.debug('AutoLearning skipping event without identifying key', {
        eventType,
        eventId: event.id,
      });
      return;
    }
    if (!this.dedup.add(key)) {
      this.logger.debug('AutoLearning dedup hit — skipping replay', { key, eventId: event.id });
      return;
    }

    const category = EVENT_CATEGORY_MAP[eventType];
    if (!category) {
      // Defensive: an unknown event slipped past the subscription filter.
      // Skip rather than recording a category-less learning.
      this.logger.warn('AutoLearning got unmapped event — skipping', { eventType });
      return;
    }

    const summary = buildLearningSummary(event);
    const relatedTask = event.workItemId ?? event.taskId;

    await this.memoryService.recordLearning({
      agentId: AUTO_LEARNING_AGENT_ID,
      agentRole: AUTO_LEARNING_AGENT_ROLE,
      projectPath: this.projectPath,
      // Prefix the learning with category so downstream readers (and grep
      // audits) can filter without parsing the structured metadata.
      learning: `[${category}] ${summary}`,
      relatedTask,
    });

    this.logger.info('AutoLearning recorded', {
      eventType,
      category,
      key,
      relatedTask,
    });
  };

  /**
   * Wrap a dispatch so a thrown error is logged without poisoning other
   * subscribers or the publisher. Mirrors
   * {@link EventToWorkItemBridge.safeDispatch}.
   */
  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const dispatch = (async () => {
      try {
        await this.handle(eventType, event);
      } catch (err) {
        this.logger.error('AutoLearning handler threw', {
          eventType,
          eventId: event.id,
          error: formatError(err),
        });
      }
    })();
    this.pendingDispatches.add(dispatch);
    dispatch
      .finally(() => {
        this.pendingDispatches.delete(dispatch);
      })
      .catch(() => {
        // Suppress unhandled-rejection warning — flushPending callers see
        // the outcome via Promise.allSettled, and the logger.error has
        // already recorded the throw.
      });
    return dispatch;
  }
}
