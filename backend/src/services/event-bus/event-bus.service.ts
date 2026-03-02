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
import type { MessageQueueService } from '../messaging/message-queue.service.js';
import type { SlackThreadStoreService } from '../slack/slack-thread-store.service.js';
import type {
  AgentEvent,
  EventType,
  EventFilter,
  EventSubscription,
  CreateSubscriptionInput,
} from '../../types/event-bus.types.js';
import { isValidCreateSubscriptionInput } from '../../types/event-bus.types.js';

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

  /**
   * Dedup guard for publish(): ignores duplicate events for the same
   * (type, sessionName) within EVENT_DEBOUNCE_WINDOW_MS (5s).
   * Key: `${eventType}:${sessionName}`, value: timestamp (ms).
   */
  private recentPublishMap: Map<string, number> = new Map();

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
    if (this.recentPublishMap.size > 100) {
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
    if (this.pendingNotifications.size > 0) {
      this.flushNotifications();
    }

    this.subscriptions.clear();
    this.recentPublishMap.clear();
    this.logger.info('EventBusService cleaned up');
  }

  /**
   * Buffer a notification for debounced delivery with per-agent deduplication.
   * If the same agent already has a pending notification for this subscriber,
   * it is overwritten with the latest event (only final state matters).
   *
   * @param sub - The subscription whose subscriber should receive the message
   * @param message - The formatted notification message
   * @param event - The original agent event
   */
  private bufferNotification(sub: EventSubscription, message: string, event: AgentEvent): void {
    // Dedup key: same subscriber + same agent = keep only the latest event.
    // If agent-joe transitions idle→active→idle in 5 seconds, the orchestrator
    // only receives the final "idle" notification, not all three.
    const dedupKey = `${sub.subscriberSession}:${event.sessionName}`;

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
  }

  /**
   * Flush all buffered notifications as a single combined message.
   * Groups by subscriber session and delivers one enqueue per subscriber.
   */
  private flushNotifications(): void {
    this.batchTimer = null;

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

    // Group messages by subscriber session
    const bySubscriber = new Map<string, string[]>();
    for (const [, entry] of this.pendingNotifications) {
      // Extract subscriber from the dedup key isn't possible cleanly,
      // so we just collect all messages (all go to orchestrator in practice)
      const subscriber = 'system'; // All event notifications use conversationId 'system'
      const existing = bySubscriber.get(subscriber) ?? [];
      existing.push(entry.message);
      bySubscriber.set(subscriber, existing);
    }

    const totalCount = this.pendingNotifications.size;

    // Deliver one combined message per subscriber
    for (const [, messages] of bySubscriber) {
      const combinedContent = messages.join('\n');

      try {
        this.messageQueueService.enqueue({
          content: combinedContent,
          conversationId: 'system',
          source: 'system_event',
        });
      } catch (error) {
        this.logger.error('Failed to enqueue batched event notifications', {
          error: error instanceof Error ? error.message : String(error),
          messageCount: messages.length,
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
   * Deliver a notification message to the subscriber via the message queue.
   *
   * @param sub - The subscription whose subscriber should receive the message
   * @param message - The formatted notification message
   */
  private deliverNotification(sub: EventSubscription, message: string): void {
    if (!this.messageQueueService) {
      this.logger.warn('MessageQueueService not set, cannot deliver event notification', {
        subscriptionId: sub.id,
      });
      return;
    }

    try {
      this.messageQueueService.enqueue({
        content: message,
        conversationId: 'system',
        source: 'system_event',
      });

      this.logger.debug('Event notification enqueued', {
        subscriptionId: sub.id,
        subscriber: sub.subscriberSession,
      });
    } catch (error) {
      this.logger.error('Failed to enqueue event notification', {
        subscriptionId: sub.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
        this.subscriptions.delete(id);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger.debug('Cleaned up expired subscriptions', { removed });
    }
  }
}
