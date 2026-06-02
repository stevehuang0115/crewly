/**
 * Intent Task Follow-Up Service — RETIRED to a no-op (2026-06-02).
 *
 * This service used to schedule periodic follow-up reminders for unresolved
 * intent tasks via `UnifiedSchedulerService`. That mechanism was dead-on-arrival:
 * the UnifiedScheduler poll loop was never started and nothing listened for its
 * `triggered` event, so a scheduled follow-up never actually fired. When
 * UnifiedSchedulerService was retired (in favour of the v3 TriggerEngine), this
 * service was reduced to a no-op shell that preserves its public API so the
 * (lazy) call sites in {@link IntentTaskService} keep compiling without change.
 *
 * Stuck/unresolved work is now handled by the WorkItem + reconciler autonomy
 * mesh (task pool → dispatch / auto-claim / reconciler self-heal), so there is
 * no behaviour to restore here. If task-level follow-up reminders are wanted
 * again, build them on the TriggerEngine (time/interval trigger → WorkItem),
 * not on a separate scheduler.
 *
 * @module services/intent-task/intent-task-follow-up.service
 */

import { EventEmitter } from 'events';
import type { IntentTaskStatus } from '../../types/intent-task.types.js';

/**
 * Payload that used to be emitted when a follow-up triggered. Retained for
 * backwards-compatible imports; no longer emitted.
 */
export interface FollowUpNeededPayload {
  taskId: string;
  intent: string;
  status: IntentTaskStatus;
  assignedSessions: string[];
}

/**
 * No-op shell of the former follow-up scheduler. Public methods are preserved
 * so existing callers compile unchanged; none of them schedule anything.
 */
export class IntentTaskFollowUpService extends EventEmitter {
  private static instance: IntentTaskFollowUpService | null = null;

  /** Get the singleton instance. */
  static getInstance(): IntentTaskFollowUpService {
    if (!IntentTaskFollowUpService.instance) {
      IntentTaskFollowUpService.instance = new IntentTaskFollowUpService();
    }
    return IntentTaskFollowUpService.instance;
  }

  /** Reset the singleton (for testing). */
  static resetInstance(): void {
    IntentTaskFollowUpService.instance = null;
  }

  /**
   * No-op. Previously created an interval schedule in UnifiedSchedulerService
   * (which never fired). Returns null — no schedule is created.
   *
   * @returns Always null
   */
  scheduleFollowUp(_taskId: string, _delayMinutes?: number): string | null {
    return null;
  }

  /**
   * No-op. Previously cancelled a task's follow-up schedule.
   *
   * @returns Always false (nothing to cancel)
   */
  cancelFollowUp(_taskId: string): boolean {
    return false;
  }
}
