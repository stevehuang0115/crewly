/**
 * Fallback Trigger Cleanup — cancels a delegation's "fallback check" timer
 * the moment the delegated WorkItem reaches a terminal status.
 *
 * `delegate-task` arms a one-shot time trigger named
 * `fallback-<target>-<wi8>` whose action creates a self-targeted "Fallback
 * check on <target> for task <wi8>" WorkItem for the orchestrator. Nothing
 * ever cancelled it, so on steamfun-ops it fired after every delegation
 * whether the work was long verified or not: 26 of 65 real WorkItems in
 * three days were these checks, each one a full orchestrator turn
 * (2026-09-18). The skill's default was raised to 2 h; this subscriber
 * removes the timer as soon as the work is done, verified or cancelled so it
 * never fires for finished work at all.
 *
 * @module services/v3/fallback-trigger-cleanup.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import { formatError } from '../../utils/format-error.js';
import { TriggerEngine } from './trigger-engine.service.js';

/** Events after which a delegation's fallback timer is pointless. */
export const FALLBACK_CLEANUP_EVENTS: readonly EventType[] = [
  'task:done',
  'task:verified',
  'task:cancelled',
] as const;

/** Length of the WorkItem-id prefix `delegate-task` puts in the trigger name. */
const WI_ID_PREFIX_LENGTH = 8;

/** The slice of the trigger engine this subscriber uses. */
export interface FallbackTriggerEngine {
  list(): Trigger[];
  cancel(id: string): Promise<boolean>;
}

/** Constructor dependencies. */
export interface FallbackTriggerCleanupDeps {
  eventBus: EventBusService;
  triggers: FallbackTriggerEngine;
}

/**
 * Name `delegate-task` gives the fallback timer for a WorkItem.
 *
 * @param workItemId - Full WorkItem id
 * @param target - Session the work was delegated to
 * @returns The trigger name
 */
export function fallbackTriggerName(workItemId: string, target: string): string {
  return `fallback-${target}-${workItemId.slice(0, WI_ID_PREFIX_LENGTH)}`;
}

/**
 * Whether a trigger is the fallback timer for the given WorkItem, regardless
 * of target (the event may not carry the target session).
 *
 * @param trigger - Candidate trigger
 * @param workItemId - Full WorkItem id
 * @returns True when the name matches `fallback-*-<wi8>`
 */
export function isFallbackTriggerFor(trigger: Pick<Trigger, 'name'>, workItemId: string): boolean {
  const name = trigger.name ?? '';
  return name.startsWith('fallback-') && name.endsWith(`-${workItemId.slice(0, WI_ID_PREFIX_LENGTH)}`);
}

/**
 * Subscribes to task terminal events and cancels matching fallback timers.
 */
export class FallbackTriggerCleanupSubscriber {
  private readonly logger: ComponentLogger;
  private readonly eventBus: EventBusService;
  private readonly triggers: FallbackTriggerEngine;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;

  constructor(deps: FallbackTriggerCleanupDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('FallbackTriggerCleanup');
    this.eventBus = deps.eventBus;
    this.triggers = deps.triggers;
  }

  /**
   * Production wiring.
   *
   * @param eventBus - The process event bus
   * @returns A subscriber bound to the trigger engine singleton
   */
  static boot(eventBus: EventBusService): FallbackTriggerCleanupSubscriber {
    return new FallbackTriggerCleanupSubscriber({ eventBus, triggers: TriggerEngine.getInstance() });
  }

  /** Subscribe. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const eventType of FALLBACK_CLEANUP_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => {
          void this.handle(e).catch((err) => {
            this.logger.warn('Fallback trigger cleanup failed', { eventType, error: formatError(err) });
          });
        }),
      );
    }
    this.logger.info('FallbackTriggerCleanup subscribed', { eventTypes: [...FALLBACK_CLEANUP_EVENTS] });
  }

  /** Unsubscribe. Safe to call twice. */
  stop(): void {
    for (const u of this.unsubscribers) {
      try {
        u();
      } catch {
        // ignore
      }
    }
    this.unsubscribers = [];
    this.started = false;
  }

  /**
   * Cancel every live fallback timer for the event's WorkItem.
   *
   * @param event - A task terminal event
   * @returns Number of triggers cancelled
   */
  async handle(event: AgentEvent): Promise<number> {
    const workItemId = event.workItemId;
    if (!workItemId) return 0;
    let cancelled = 0;
    for (const trigger of this.triggers.list()) {
      if (trigger.status !== 'active' && trigger.status !== 'paused') continue;
      if (!isFallbackTriggerFor(trigger, workItemId)) continue;
      if (await this.triggers.cancel(trigger.id)) {
        cancelled += 1;
        this.logger.info('Cancelled fallback timer for finished WorkItem', {
          workItemId,
          triggerId: trigger.id,
          name: trigger.name,
          event: event.type,
        });
      }
    }
    return cancelled;
  }
}
