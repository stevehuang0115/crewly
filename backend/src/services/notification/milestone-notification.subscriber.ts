/**
 * MilestoneNotificationSubscriber (DF-1, issue #438)
 *
 * Mirrors `auto-learning.subscriber.ts` exactly — same shape (subscribe
 * to lifecycle events, dispatch idempotently, log on failure) but with a
 * different action: enqueue a `[MILESTONE]` message into the orchestrator's
 * chat queue so orc's Smart Notification Protocol can decide whether to
 * forward to the owner. The QW-3 prompt change (#436, PR #581) adds a
 * dedicated `[MILESTONE]` row to that priority table — always 🟡 Important,
 * never downgraded to ⚪ Info.
 *
 * **Why a backend subscriber when the agent-side prompt path already exists?**
 * The QW-1 prompt change (#434, PR #581) tells agents to call `report-status
 * --status milestone` when they ship. But that only fires when the agent
 * decides to call it. Some lifecycle events (TL `verifyItem(verified)`,
 * `mission:replanned`) happen at the system level WITHOUT going through
 * report-status. The subscriber here is the safety net: any time a
 * verified/replanned event surfaces, the owner gets notified even if the
 * worker forgot to self-surface.
 *
 * Subscribed events (closed-set, mirrors the same Arch Veto V7 + N1
 * rationale as auto-learning):
 *   - `task:verified`        — TL verified a worker's output (shipped artifact)
 *   - `mission:replanned`    — strategy changed (rare, escalate)
 *
 * Idempotency (Arch Veto V1):
 *   `${eventType}:${workItemId}` (or `${eventType}:${missionId}:${eventId}`
 *   for mission events) against an in-memory bounded LRU.
 *
 * No new event types (Arch Veto V7):
 *   Listens only to event types already in `EVENT_TYPES`.
 *
 * Fire-and-forget:
 *   `enqueueNotification()` is async; each dispatch is wrapped so a thrown
 *   error logs but doesn't break the publisher or other subscribers.
 *
 * @module services/notification/milestone-notification.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import { formatError } from '../../utils/format-error.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/** Minimal MessageQueueService surface this subscriber depends on. */
export interface IMessageQueueServiceLike {
  enqueue(input: {
    content: string;
    conversationId: string;
    source: string;
    targetSession?: string;
    sourceMetadata?: Record<string, unknown>;
  }): unknown;
}

/**
 * Events this subscriber listens to. Closed-set per the same Arch N1 rule
 * `auto-learning.subscriber` follows — additions require explicit review.
 */
export const MILESTONE_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'task:verified',
  'mission:replanned',
] as const;

/** Bounded LRU cap to keep the dedup set from growing indefinitely. */
const DEDUP_LRU_CAPACITY = 1024;

/** Minimal LRU-ish bounded set — same shape `auto-learning.subscriber` uses. */
class BoundedSet {
  private readonly capacity: number;
  private readonly items: Set<string> = new Set();
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  add(key: string): void {
    if (this.items.has(key)) return;
    if (this.items.size >= this.capacity) {
      const first = this.items.values().next().value;
      if (first !== undefined) this.items.delete(first);
    }
    this.items.add(key);
  }
  get size(): number {
    return this.items.size;
  }
}

export interface MilestoneNotificationDependencies {
  eventBus: EventBusService;
  /** Notification sink — typically the orchestrator's MessageQueueService. */
  messageQueueService: IMessageQueueServiceLike;
  /** Optional logger override (defaults to a fresh component logger). */
  logger?: ComponentLogger;
  /** Optional dedup LRU capacity (defaults to {@link DEDUP_LRU_CAPACITY}). */
  dedupCapacity?: number;
  /** Optional override for the orchestrator session name. */
  orchestratorSession?: string;
}

/**
 * MilestoneNotificationSubscriber — surfaces lifecycle milestones to the
 * orchestrator's chat queue with a `[MILESTONE]` envelope.
 */
export class MilestoneNotificationSubscriber {
  private readonly eventBus: EventBusService;
  private readonly messageQueueService: IMessageQueueServiceLike;
  private readonly logger: ComponentLogger;
  private readonly dedup: BoundedSet;
  private readonly orchestratorSession: string;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  private pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: MilestoneNotificationDependencies) {
    this.eventBus = deps.eventBus;
    this.messageQueueService = deps.messageQueueService;
    this.logger =
      deps.logger ??
      LoggerService.getInstance().createComponentLogger('MilestoneNotificationSubscriber');
    this.dedup = new BoundedSet(deps.dedupCapacity ?? DEDUP_LRU_CAPACITY);
    this.orchestratorSession = deps.orchestratorSession ?? ORCHESTRATOR_SESSION_NAME;
  }

  /** Subscribe to all configured events. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const eventType of MILESTONE_SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }
    this.logger.info('MilestoneNotificationSubscriber subscribed', {
      eventTypes: MILESTONE_SUBSCRIBED_EVENTS,
      orchestratorSession: this.orchestratorSession,
    });
  }

  /** Wait for every in-flight dispatch. Test affordance. */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /** Detach all subscriptions. */
  stop(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch (err) {
        this.logger.warn('MilestoneNotification unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];
    this.started = false;
    this.logger.info('MilestoneNotificationSubscriber stopped');
  }

  /** Snapshot of the dedup state. Test affordance. */
  get dedupSize(): number {
    return this.dedup.size;
  }

  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const promise = (async () => {
      try {
        await this.dispatchOne(eventType, event);
      } catch (err) {
        this.logger.warn('MilestoneNotification dispatch threw — swallowed', {
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

  private async dispatchOne(eventType: EventType, event: AgentEvent): Promise<void> {
    // Idempotency key — `${type}:${workItemId}` for task events,
    // `${type}:${missionId}:${eventId}` for mission events.
    const wiKey = event.workItemId
      ? `${eventType}:${event.workItemId}`
      : `${eventType}:${event.missionId ?? ''}:${event.id}`;
    if (this.dedup.has(wiKey)) {
      this.logger.debug('MilestoneNotification deduped', { wiKey });
      return;
    }
    this.dedup.add(wiKey);

    // Trivial-event filter: a verified WI with no artifact / summary
    // signal isn't milestone-worthy. The agent-side report-status path
    // already filters via the ≥30-char summary gate (issue #435); this
    // backend filter catches the case where lifecycle events fire
    // without a corresponding agent surface.
    const summary = this.extractSummary(event);
    if (!summary || summary.length < 30) {
      this.logger.debug('MilestoneNotification skipped — summary too short or absent', {
        eventType,
        workItemId: event.workItemId,
      });
      return;
    }

    const envelope = this.buildEnvelope(eventType, event, summary);
    try {
      this.messageQueueService.enqueue({
        content: envelope,
        conversationId: 'system_milestone',
        source: 'system_event',
        targetSession: this.orchestratorSession,
        sourceMetadata: {
          eventType,
          workItemId: event.workItemId,
          missionId: event.missionId,
        },
      });
      this.logger.info('MilestoneNotification enqueued', {
        eventType,
        workItemId: event.workItemId,
        summaryPreview: summary.slice(0, 80),
      });
    } catch (err) {
      this.logger.warn('MilestoneNotification enqueue failed (non-fatal)', {
        eventType,
        workItemId: event.workItemId,
        error: formatError(err),
      });
    }
  }

  /**
   * Best-effort summary extraction from an event payload. Different event
   * types stash human-readable text in different fields; this normalizes.
   */
  private extractSummary(event: AgentEvent): string | null {
    const raw = (event as unknown as { summary?: string; result?: { summary?: string }; reason?: string })
      .summary
      ?? (event as unknown as { result?: { summary?: string } }).result?.summary
      ?? (event as unknown as { reason?: string }).reason
      ?? '';
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  }

  private buildEnvelope(eventType: EventType, event: AgentEvent, summary: string): string {
    // `[MILESTONE] Source: ${who} | Event: ${eventType} | ${summary}`
    // Matches the priority-table row in orchestrator/prompt.md (#436)
    // verbatim, so the bypass-by-prompt rule fires correctly when this
    // envelope arrives.
    const who = event.sessionName || event.workItemId || 'system';
    return `[MILESTONE] Source: ${who} | Event: ${eventType} | ${summary}`;
  }
}
