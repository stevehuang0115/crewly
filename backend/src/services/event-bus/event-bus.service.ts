/**
 * Event Bus Service
 *
 * Central pub/sub service for agent lifecycle events. Agents publish events
 * (idle, busy, active, inactive) and subscribers receive notifications when
 * matching events occur. Notifications are delivered via the MessageQueueService
 * to the orchestrator terminal.
 *
 * @module services/event-bus/event-bus
 */

import { EventEmitter } from 'events';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { EVENT_BUS_CONSTANTS } from '../../constants.js';
import { formatError } from '../../utils/format-error.js';
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import type { SlackThreadStoreService } from '../slack/slack-thread-store.service.js';
import type {
  AgentEvent,
  EventSubscription,
  CreateSubscriptionInput,
  EventType,
} from '../../types/event-bus.types.js';
import { isValidCreateSubscriptionInput, isCriticalEventType } from '../../types/event-bus.types.js';

/**
 * In-process event handler signature used by {@link EventBusService.onInProcess}.
 *
 * Handlers may be sync or async. Async handlers run concurrently with the
 * publisher's synchronous control flow — `publish()` does NOT await pending
 * promises, but rejected promises are caught and logged, never propagated.
 */
export type InProcessEventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * Detach function returned by {@link EventBusService.onInProcess}. Invoke to
 * unregister the handler from the bus. Idempotent — calling more than once is
 * a no-op.
 */
export type InProcessUnsubscribe = () => void;

/**
 * Buffered notification entry pending delivery after debounce window.
 */
interface BufferedNotification {
  /** The formatted notification message */
  message: string;
  /** The original event that triggered this notification */
  event: AgentEvent;
  /** Timestamp when this entry was last updated (for dedup overwrites) */
  updatedAt: number;
}

/**
 * EventBusService manages event subscriptions and publishes agent lifecycle
 * events. When an event matches a subscription, a notification message is
 * enqueued into the MessageQueueService for delivery to the subscriber.
 *
 * @example
 * ```typescript
 * const eventBus = new EventBusService();
 * eventBus.setMessageQueueService(queueService);
 *
 * eventBus.subscribe({
 *   eventType: 'agent:idle',
 *   filter: { sessionName: 'agent-joe' },
 *   subscriberSession: 'crewly-orc',
 *   oneShot: true,
 * });
 *
 * eventBus.publish(agentIdleEvent);
 * ```
 */
export class EventBusService extends EventEmitter {
  private logger: ComponentLogger;
  private subscriptions: Map<string, EventSubscription> = new Map();
  private messageQueueService: MessageQueueService | null = null;
  private slackThreadStore: SlackThreadStoreService | null = null;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private deliveryCount = 0;

  /**
   * Buffered notifications pending delivery after debounce window.
   * Key: `${subscriberSession}:${event.sessionName}` for per-agent dedup.
   * When the same agent fires multiple events within the debounce window,
   * only the latest event is kept (deduplication by overwrite).
   */
  private pendingNotifications: Map<string, BufferedNotification> = new Map();

  /** Debounce timer for batching event notifications */
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Hard-deadline timer that forces a flush even if debounce keeps resetting */
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Dedup guard for publish(): ignores duplicate events for the same
   * (type, sessionName) within EVENT_DEBOUNCE_WINDOW_MS (5s).
   * Key: `${eventType}:${sessionName}`, value: timestamp (ms).
   */
  private recentPublishMap: Map<string, number> = new Map();

  /**
   * In-process subscribers keyed by event type. Used by internal services
   * (EventToWorkItemBridge, LEARN-1's auto-record-learning subscriber) that
   * need to react to events synchronously without going through the
   * agent-session subscription queue.
   *
   * The agent-session subscriptions ({@link subscriptions}) and these
   * in-process handlers are intentionally separate — the former routes
   * through MessageQueueService and is rate-limited / debounced, the
   * latter fires immediately and is meant for trusted internal callers.
   */
  private inProcessHandlers: Map<EventType, Set<InProcessEventHandler>> = new Map();

  constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('EventBus');
    this.startCleanup();
  }

  /**
   * Set the MessageQueueService instance for delivering notifications.
   *
   * @param service - The MessageQueueService instance
   */
  setMessageQueueService(service: MessageQueueService): void {
    this.messageQueueService = service;
  }

  /**
   * Set the SlackThreadStoreService for enriching notifications with thread paths.
   *
   * @param store - The SlackThreadStoreService instance
   */
  setSlackThreadStore(store: SlackThreadStoreService): void {
    this.slackThreadStore = store;
  }

  /**
   * Create a new event subscription.
   *
   * @param input - Subscription configuration
   * @returns The created EventSubscription
   * @throws Error if input is invalid or limits are exceeded
   */
  subscribe(input: CreateSubscriptionInput): EventSubscription {
    if (!isValidCreateSubscriptionInput(input)) {
      throw new Error('Invalid subscription input');
    }

    // Check per-session limit
    const sessionCount = this.getSubscriptionCountForSession(input.subscriberSession);
    if (sessionCount >= EVENT_BUS_CONSTANTS.MAX_SUBSCRIPTIONS_PER_SESSION) {
      throw new Error(
        `Subscription limit reached for session ${input.subscriberSession} (max ${EVENT_BUS_CONSTANTS.MAX_SUBSCRIPTIONS_PER_SESSION})`
      );
    }

    // Check total limit
    if (this.subscriptions.size >= EVENT_BUS_CONSTANTS.MAX_TOTAL_SUBSCRIPTIONS) {
      throw new Error(
        `Total subscription limit reached (max ${EVENT_BUS_CONSTANTS.MAX_TOTAL_SUBSCRIPTIONS})`
      );
    }

    const ttlMinutes = Math.min(
      input.ttlMinutes ?? EVENT_BUS_CONSTANTS.DEFAULT_SUBSCRIPTION_TTL_MINUTES,
      EVENT_BUS_CONSTANTS.MAX_SUBSCRIPTION_TTL_MINUTES
    );

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

    const subscription: EventSubscription = {
      id: crypto.randomUUID(),
      eventType: input.eventType,
      filter: input.filter,
      oneShot: input.oneShot ?? true,
      subscriberSession: input.subscriberSession,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      messageTemplate: input.messageTemplate,
    };

    this.subscriptions.set(subscription.id, subscription);

    this.logger.info('Subscription created', {
      subscriptionId: subscription.id,
      eventType: subscription.eventType,
      subscriber: subscription.subscriberSession,
      oneShot: subscription.oneShot,
      ttlMinutes,
    });

    return subscription;
  }

  /**
   * Remove a subscription by ID.
   *
   * @param subscriptionId - ID of the subscription to remove
   * @returns True if the subscription was found and removed
   */
  unsubscribe(subscriptionId: string): boolean {
    const removed = this.subscriptions.delete(subscriptionId);
    if (removed) {
      this.logger.info('Subscription removed', { subscriptionId });
    }
    return removed;
  }

  /**
   * Publish an event to all matching subscriptions.
   * For each match, formats a notification message and enqueues it
   * into the MessageQueueService for delivery to the subscriber.
   *
   * @param event - The agent lifecycle event to publish
   */
  publish(event: AgentEvent): void {
    // Dedup: ignore duplicate events for the same (type, sessionName) within
    // the debounce window. This prevents redundant notifications when both
    // the file watcher and ActivityMonitor detect the same status transition.
    const dedupKey = `${event.type}:${event.sessionName}`;
    const nowMs = Date.now();
    const lastPublished = this.recentPublishMap.get(dedupKey);
    if (lastPublished && nowMs - lastPublished < EVENT_BUS_CONSTANTS.EVENT_DEBOUNCE_WINDOW_MS) {
      this.logger.debug('Duplicate event suppressed within debounce window', {
        type: event.type,
        sessionName: event.sessionName,
        msSinceLast: nowMs - lastPublished,
      });
      return;
    }
    this.recentPublishMap.set(dedupKey, nowMs);

    // Clean up old entries periodically (keep map small)
    if (this.recentPublishMap.size > EVENT_BUS_CONSTANTS.DEDUP_MAP_CLEANUP_THRESHOLD) {
      for (const [key, ts] of this.recentPublishMap) {
        if (nowMs - ts > EVENT_BUS_CONSTANTS.EVENT_DEBOUNCE_WINDOW_MS) {
          this.recentPublishMap.delete(key);
        }
      }
    }

    this.logger.info('Event published', {
      eventId: event.id,
      type: event.type,
      sessionName: event.sessionName,
      changedField: event.changedField,
      previousValue: event.previousValue,
      newValue: event.newValue,
    });

    // Emit event_published for any listener that needs to react to ALL events
    // regardless of subscriptions (e.g., auditor monitoring agent:inactive)
    this.emit('event_published', {
      eventId: event.id,
      eventType: event.type,
      sessionName: event.sessionName,
    });

    // Dispatch to in-process handlers (BRIDGE-1, LEARN-1, …). Errors are
    // isolated — a throwing handler MUST NOT affect other handlers or the
    // publisher's control flow.
    this.dispatchInProcess(event);

    const toRemove: string[] = [];

    const now = new Date();
    for (const [id, sub] of this.subscriptions) {
      // Check expiration
      if (sub.expiresAt && new Date(sub.expiresAt) < now) {
        toRemove.push(id);
        continue;
      }

      if (!this.matchesSubscription(event, sub)) {
        continue;
      }

      // Format notification and buffer for debounced delivery.
      // Dedup: same agent + same subscriber = keep only latest event.
      const message = this.formatNotification(event, sub);
      this.bufferNotification(sub, message, event);
      this.deliveryCount++;

      this.emit('event_delivered', {
        subscriptionId: sub.id,
        eventId: event.id,
        eventType: event.type,
      });

      if (sub.oneShot) {
        toRemove.push(id);
      }
    }

    // Clean up one-shot and expired subscriptions
    for (const id of toRemove) {
      this.subscriptions.delete(id);
    }
  }

  /**
   * Register an in-process handler for one or more event types.
   *
   * Used by trusted internal services (EventToWorkItemBridge, LEARN-1's
   * auto-record-learning subscriber) that need synchronous reactivity to
   * the event stream without going through the agent-session subscription
   * queue. These handlers fire from `publish()` immediately after the
   * `event_published` EventEmitter signal, before the debounced
   * notification flush, so callers can rely on the same publish ordering
   * semantics as `EventEmitter.on('event_published', …)` listeners.
   *
   * Handler errors are isolated:
   *   - synchronous throws are caught and logged
   *   - rejected promises returned by async handlers are caught and logged
   *   - neither propagates to other in-process handlers nor to the
   *     publisher's `publish()` call site
   *
   * Returned `unsubscribe` is idempotent.
   *
   * @param eventTypes - One event type or an array of event types to listen for
   * @param handler - Sync or async handler invoked once per matching event
   * @returns A function that detaches the handler when called
   *
   * @example
   * ```typescript
   * const unsubscribe = eventBus.onInProcess(
   *   ['task:done_by_worker', 'task:rejected'],
   *   async (event) => {
   *     await bridge.handleTaskEvent(event);
   *   },
   * );
   * // Later: unsubscribe();
   * ```
   */
  onInProcess(
    eventTypes: EventType | EventType[],
    handler: InProcessEventHandler,
  ): InProcessUnsubscribe {
    if (typeof handler !== 'function') {
      throw new Error('onInProcess handler must be a function');
    }
    const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
    if (types.length === 0) {
      throw new Error('onInProcess requires at least one event type');
    }

    for (const type of types) {
      let handlerSet = this.inProcessHandlers.get(type);
      if (!handlerSet) {
        handlerSet = new Set();
        this.inProcessHandlers.set(type, handlerSet);
      }
      handlerSet.add(handler);
    }

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      for (const type of types) {
        const handlerSet = this.inProcessHandlers.get(type);
        if (!handlerSet) continue;
        handlerSet.delete(handler);
        if (handlerSet.size === 0) {
          this.inProcessHandlers.delete(type);
        }
      }
    };
  }

  /**
   * Invoke every in-process handler registered for an event's type.
   * Sync throws and async rejections are caught + logged; never propagated.
   *
   * @param event - The event being published
   */
  private dispatchInProcess(event: AgentEvent): void {
    const handlerSet = this.inProcessHandlers.get(event.type);
    if (!handlerSet || handlerSet.size === 0) return;

    // Snapshot so a handler that calls unsubscribe() during dispatch does
    // not mutate the iterator.
    const handlers = Array.from(handlerSet);
    for (const handler of handlers) {
      try {
        const maybePromise = handler(event);
        if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
          (maybePromise as Promise<void>).catch((error) => {
            this.logger.error('In-process event handler rejected', {
              error: formatError(error),
              eventId: event.id,
              eventType: event.type,
            });
          });
        }
      } catch (error) {
        this.logger.error('In-process event handler threw synchronously', {
          error: formatError(error),
          eventId: event.id,
          eventType: event.type,
        });
      }
    }
  }

  /**
   * List subscriptions, optionally filtered by subscriber session.
   *
   * @param subscriberSession - Optional session name to filter by
   * @returns Array of matching subscriptions
   */
  listSubscriptions(subscriberSession?: string): EventSubscription[] {
    const all = Array.from(this.subscriptions.values());
    if (subscriberSession) {
      return all.filter((sub) => sub.subscriberSession === subscriberSession);
    }
    return all;
  }

  /**
   * Get a specific subscription by ID.
   *
   * @param subscriptionId - ID of the subscription
   * @returns The subscription or undefined
   */
  getSubscription(subscriptionId: string): EventSubscription | undefined {
    return this.subscriptions.get(subscriptionId);
  }

  /**
   * Get event bus statistics.
   *
   * @returns Stats object with subscription and delivery counts
   */
  getStats(): { subscriptionCount: number; deliveryCount: number } {
    return {
      subscriptionCount: this.subscriptions.size,
      deliveryCount: this.deliveryCount,
    };
  }

  /**
   * Stop the cleanup timer and clear all subscriptions.
   */
  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Flush any pending notifications before shutdown
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
    if (this.pendingNotifications.size > 0) {
      this.flushNotifications();
    }

    this.subscriptions.clear();
    this.recentPublishMap.clear();
    this.inProcessHandlers.clear();
    this.logger.info('EventBusService cleaned up');
  }

  /**
   * Buffer a notification for debounced delivery with per-agent deduplication.
   * Critical events (task:completed, task:failed, agent:inactive, etc.) bypass
   * the debounce buffer and are delivered immediately to avoid notification delay.
   *
   * @param sub - The subscription whose subscriber should receive the message
   * @param message - The formatted notification message
   * @param event - The original agent event
   */
  private bufferNotification(sub: EventSubscription, message: string, event: AgentEvent): void {
    // Critical events bypass debounce — deliver immediately
    if (isCriticalEventType(event.type)) {
      this.deliverImmediately(sub.subscriberSession, message);
      return;
    }

    // Dedup key: same subscriber + same agent = keep only the latest event.
    // If agent-joe transitions idle→active→idle in 5 seconds, the orchestrator
    // only receives the final "idle" notification, not all three.
    // Use '||' separator (not ':') to avoid collision with session name chars.
    const dedupKey = `${sub.subscriberSession}||${event.sessionName}`;

    this.pendingNotifications.set(dedupKey, {
      message,
      event,
      updatedAt: Date.now(),
    });

    // Reset debounce timer — wait for EVENT_DEBOUNCE_WINDOW_MS of quiet time
    // before flushing all buffered notifications as one batch.
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.flushNotifications();
    }, EVENT_BUS_CONSTANTS.EVENT_DEBOUNCE_WINDOW_MS);

    // Hard deadline: ensure notifications are flushed within MAX_BATCH_WAIT_MS
    // even if new events keep resetting the debounce timer. Only start the
    // hard-deadline timer once (when first event enters the buffer).
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.logger.info('MAX_BATCH_WAIT reached, forcing flush');
        this.flushNotifications();
      }, EVENT_BUS_CONSTANTS.MAX_BATCH_WAIT_MS);
    }
  }

  /**
   * Deliver a notification immediately without debouncing.
   * Used for critical events that must reach the subscriber ASAP.
   *
   * @param subscriberSession - The session to deliver to
   * @param message - The formatted notification message
   */
  private deliverImmediately(subscriberSession: string, message: string): void {
    if (!this.messageQueueService) {
      this.logger.warn('MessageQueueService not set, discarding critical notification', {
        subscriberSession,
      });
      return;
    }

    try {
      this.messageQueueService.enqueue({
        content: message,
        conversationId: 'system',
        source: 'system_event',
        targetSession: subscriberSession,
      });
      this.logger.info('Critical event delivered immediately', { subscriberSession });
    } catch (error) {
      this.logger.error('Failed to deliver critical event notification', {
        error: formatError(error),
        subscriberSession,
      });
    }
  }

  /**
   * Flush all buffered notifications as a single combined message.
   * Groups by subscriber session and delivers one enqueue per subscriber.
   */
  private flushNotifications(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }

    if (this.pendingNotifications.size === 0) {
      return;
    }

    if (!this.messageQueueService) {
      this.logger.warn('MessageQueueService not set, discarding buffered notifications', {
        count: this.pendingNotifications.size,
      });
      this.pendingNotifications.clear();
      return;
    }

    // Group messages by subscriber session (extracted from dedup key format: subscriberSession||agentSession)
    const bySubscriber = new Map<string, string[]>();
    for (const [dedupKey, entry] of this.pendingNotifications) {
      const subscriberSession = dedupKey.split('||')[0];
      const existing = bySubscriber.get(subscriberSession) ?? [];
      existing.push(entry.message);
      bySubscriber.set(subscriberSession, existing);
    }

    const totalCount = this.pendingNotifications.size;

    // Deliver one combined message per subscriber, with targetSession set
    for (const [subscriberSession, messages] of bySubscriber) {
      const combinedContent = messages.join('\n');

      try {
        this.messageQueueService.enqueue({
          content: combinedContent,
          conversationId: 'system',
          source: 'system_event',
          targetSession: subscriberSession,
        });
      } catch (error) {
        this.logger.error('Failed to enqueue batched event notifications', {
          error: formatError(error),
          messageCount: messages.length,
          subscriberSession,
        });
      }
    }

    this.logger.info('Flushed batched event notifications', {
      dedupedCount: totalCount,
      originalEvents: '(deduplicated)',
    });

    this.pendingNotifications.clear();
  }

  /**
   * Check if an event matches a subscription's type and filter criteria.
   *
   * @param event - The event to check
   * @param sub - The subscription to match against
   * @returns True if the event matches the subscription
   */
  private matchesSubscription(event: AgentEvent, sub: EventSubscription): boolean {
    // Skip self-events: don't deliver events to the session that generated them.
    // e.g. the orchestrator should not receive its own agent:busy/agent:idle events.
    if (sub.subscriberSession && event.sessionName === sub.subscriberSession) {
      return false;
    }

    // Match event type
    const types = Array.isArray(sub.eventType) ? sub.eventType : [sub.eventType];
    if (!types.includes(event.type)) {
      return false;
    }

    // Match filter criteria
    const { filter } = sub;
    if (filter.sessionName && filter.sessionName !== event.sessionName) {
      return false;
    }
    if (filter.memberId && filter.memberId !== event.memberId) {
      return false;
    }
    if (filter.teamId && filter.teamId !== event.teamId) {
      return false;
    }

    // Hierarchy filter criteria
    if (filter.taskId && filter.taskId !== event.taskId) {
      return false;
    }
    if (filter.hierarchyLevel !== undefined && filter.hierarchyLevel !== event.hierarchyLevel) {
      return false;
    }
    if (filter.parentMemberId && filter.parentMemberId !== event.parentMemberId) {
      return false;
    }

    return true;
  }

  /**
   * Format a notification message for an event and subscription.
   *
   * @param event - The event that triggered the notification
   * @param sub - The subscription that matched
   * @returns Formatted notification message string
   */
  private formatNotification(event: AgentEvent, sub: EventSubscription): string {
    if (sub.messageTemplate) {
      return sub.messageTemplate
        .replace(/\{memberName\}/g, event.memberName)
        .replace(/\{sessionName\}/g, event.sessionName)
        .replace(/\{eventType\}/g, event.type)
        .replace(/\{previousValue\}/g, event.previousValue)
        .replace(/\{newValue\}/g, event.newValue)
        .replace(/\{teamName\}/g, event.teamName)
        .replace(/\{teamId\}/g, event.teamId)
        .replace(/\{memberId\}/g, event.memberId);
    }

    const prefix = `[${EVENT_BUS_CONSTANTS.EVENT_MESSAGE_PREFIX}:${sub.id}:${event.type}]`;
    let baseMessage = `${prefix} Agent "${event.memberName}" (session: ${event.sessionName}) is now ${event.newValue} (was: ${event.previousValue}). Team: ${event.teamName}.`;

    // Enrich with Slack thread file paths so orchestrator can route notifications
    if (this.slackThreadStore) {
      const threads = this.slackThreadStore.findThreadsForAgent(event.sessionName);
      if (threads.length > 0) {
        baseMessage += ` [Slack thread files: ${threads.map((t) => t.filePath).join(', ')}]`;
      }
    }

    return baseMessage;
  }

  /**
   * Get the number of subscriptions for a given subscriber session.
   *
   * @param subscriberSession - Session name to count
   * @returns Number of subscriptions
   */
  private getSubscriptionCountForSession(subscriberSession: string): number {
    let count = 0;
    for (const sub of this.subscriptions.values()) {
      if (sub.subscriberSession === subscriberSession) {
        count++;
      }
    }
    return count;
  }

  /**
   * Start the periodic cleanup timer to remove expired subscriptions.
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, EVENT_BUS_CONSTANTS.CLEANUP_INTERVAL);
    // Don't prevent graceful shutdown
    this.cleanupInterval.unref();
  }

  /**
   * Remove all expired subscriptions.
   */
  private cleanupExpired(): void {
    const now = new Date();
    let removed = 0;

    for (const [id, sub] of this.subscriptions) {
      if (sub.expiresAt && new Date(sub.expiresAt) < now) {
        this.logger.info('Subscription expired without matching events', {
          subscriptionId: id,
          eventType: sub.eventType,
          subscriber: sub.subscriberSession,
          filter: sub.filter,
          createdAt: sub.createdAt,
          expiresAt: sub.expiresAt,
        });
        this.subscriptions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug('Cleaned up expired subscriptions', { removed });
    }
  }
}
