/**
 * Intent Task Follow-Up Service
 *
 * Automates follow-up scheduling for unresolved intent tasks.
 * Periodically checks on tasks that haven't been completed and notifies
 * the orchestrator to continue processing them.
 *
 * Features:
 * - Schedule follow-ups for unresolved tasks via UnifiedSchedulerService
 * - Auto-cancel follow-ups when tasks reach terminal status
 * - Session-less recovery: restore follow-ups on service restart
 * - Emit 'follow-up-needed' events for orchestrator consumption
 *
 * @module services/intent-task/intent-task-follow-up.service
 */

import { EventEmitter } from 'events';
import { IntentTaskService } from './intent-task.service.js';
import { UnifiedSchedulerService } from '../workflow/unified-scheduler.service.js';
import type { IntentTask, IntentTaskStatus } from '../../types/intent-task.types.js';

// =============================================================================
// Constants
// =============================================================================

/** Default follow-up delay in minutes */
const DEFAULT_FOLLOW_UP_DELAY_MINUTES = 15;

/** Target session for follow-up schedule messages (orchestrator) */
const FOLLOW_UP_TARGET = 'crewly-orc';

/** Terminal statuses that should cancel follow-ups */
const TERMINAL_STATUSES: ReadonlySet<IntentTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

// =============================================================================
// Types
// =============================================================================

/**
 * Payload emitted when a follow-up is triggered for an unresolved task.
 */
export interface FollowUpNeededPayload {
  /** The task ID that needs attention */
  taskId: string;
  /** The original intent description */
  intent: string;
  /** Current task status */
  status: IntentTaskStatus;
  /** Agent sessions assigned to this task */
  assignedSessions: string[];
}

// =============================================================================
// Service
// =============================================================================

/**
 * Service that schedules and manages automatic follow-ups for unresolved
 * intent tasks. Works with UnifiedSchedulerService for timing and
 * IntentTaskService for task state.
 *
 * Emits 'follow-up-needed' events when a follow-up triggers and the
 * associated task is still unresolved, allowing the orchestrator to
 * take action.
 *
 * @example
 * ```typescript
 * const service = IntentTaskFollowUpService.getInstance();
 * service.on('follow-up-needed', (payload) => {
 *   console.log(`Task ${payload.taskId} still unresolved`);
 * });
 * service.scheduleFollowUp('task-123');
 * ```
 */
export class IntentTaskFollowUpService extends EventEmitter {
  private static instance: IntentTaskFollowUpService | null = null;

  private readonly intentTaskService: IntentTaskService;
  private readonly schedulerService: UnifiedSchedulerService;

  /**
   * Create a new IntentTaskFollowUpService.
   *
   * @param intentTaskService - Override for IntentTaskService (used in tests)
   * @param schedulerService - Override for UnifiedSchedulerService (used in tests)
   */
  constructor(
    intentTaskService?: IntentTaskService,
    schedulerService?: UnifiedSchedulerService,
  ) {
    super();
    this.intentTaskService = intentTaskService ?? IntentTaskService.getInstance();
    this.schedulerService = schedulerService ?? UnifiedSchedulerService.getInstance();
  }

  /**
   * Get the singleton instance.
   *
   * @returns Shared IntentTaskFollowUpService instance
   */
  static getInstance(): IntentTaskFollowUpService {
    if (!IntentTaskFollowUpService.instance) {
      IntentTaskFollowUpService.instance = new IntentTaskFollowUpService();
    }
    return IntentTaskFollowUpService.instance;
  }

  /**
   * Reset the singleton (for testing).
   */
  static resetInstance(): void {
    IntentTaskFollowUpService.instance = null;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Schedule a follow-up for an unresolved task.
   *
   * Creates an interval schedule in UnifiedSchedulerService that will
   * trigger periodically. The schedule ID is stored on the task for
   * later cancellation.
   *
   * @param taskId - The intent task ID to follow up on
   * @param delayMinutes - Minutes between follow-up checks (default: 15)
   * @returns The schedule ID, or null if the task is not found or already terminal
   * @throws Error if the task does not exist
   */
  scheduleFollowUp(taskId: string, delayMinutes?: number): string | null {
    const task = this.intentTaskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Don't schedule for already-terminal tasks
    if (TERMINAL_STATUSES.has(task.status)) {
      return null;
    }

    // If task already has a follow-up schedule, don't create a duplicate
    if (task.scheduleId) {
      const existingSchedule = this.schedulerService.get(task.scheduleId);
      if (existingSchedule && existingSchedule.status === 'active') {
        return task.scheduleId;
      }
    }

    const interval = delayMinutes ?? DEFAULT_FOLLOW_UP_DELAY_MINUTES;

    const schedule = this.schedulerService.create({
      target: FOLLOW_UP_TARGET,
      type: 'interval',
      intervalMinutes: interval,
      message: `[follow-up] Task ${taskId} is still unresolved. Intent: "${task.intent}". Status: ${task.status}. Please check on it.`,
      enabled: true,
      autoStart: false,
      maxConsecutiveTriggers: 10,
    });

    // Associate the schedule with the task
    this.intentTaskService.setSchedule(taskId, schedule.id);

    return schedule.id;
  }

  /**
   * Handle a follow-up trigger from the scheduler.
   *
   * Checks the associated task's status:
   * - If terminal (completed/failed/cancelled): cancels the schedule
   * - If still unresolved: emits 'follow-up-needed' event
   *
   * @param scheduleId - The schedule ID that was triggered
   */
  onFollowUpTriggered(scheduleId: string): void {
    // Find the task associated with this schedule
    const task = this.findTaskByScheduleId(scheduleId);

    if (!task) {
      // No task found for this schedule — clean it up
      this.schedulerService.delete(scheduleId);
      return;
    }

    if (TERMINAL_STATUSES.has(task.status)) {
      // Task is done — cancel the follow-up schedule
      this.cancelFollowUpByScheduleId(task.id, scheduleId);
      return;
    }

    // Task is still unresolved — emit event for orchestrator
    const payload: FollowUpNeededPayload = {
      taskId: task.id,
      intent: task.intent,
      status: task.status,
      assignedSessions: [...task.assignedSessions],
    };

    this.emit('follow-up-needed', payload);
  }

  /**
   * Restore follow-ups after a service restart.
   *
   * Scans all unresolved tasks and ensures each has an active follow-up
   * schedule. For tasks with a scheduleId, verifies the schedule is still
   * active in UnifiedSchedulerService. For unresolved tasks without a
   * scheduleId, creates a new follow-up.
   *
   * @param delayMinutes - Minutes between follow-up checks (default: 15)
   * @returns Number of follow-ups restored or created
   */
  restoreFollowUps(delayMinutes?: number): number {
    const unresolvedTasks = this.getUnresolvedTasks();
    let restoredCount = 0;

    for (const task of unresolvedTasks) {
      if (task.scheduleId) {
        // Task has a schedule — check if it's still active
        const schedule = this.schedulerService.get(task.scheduleId);
        if (schedule && schedule.status === 'active') {
          // Schedule is still active, nothing to do
          continue;
        }
        // Schedule is missing or not active — recreate
      }

      // Create (or recreate) a follow-up schedule
      const scheduleId = this.scheduleFollowUp(task.id, delayMinutes);
      if (scheduleId) {
        restoredCount++;
      }
    }

    return restoredCount;
  }

  /**
   * Cancel the follow-up schedule for a task.
   *
   * Removes the schedule from UnifiedSchedulerService and clears the
   * scheduleId on the task.
   *
   * @param taskId - The intent task ID
   * @returns True if a follow-up was cancelled, false if none existed
   */
  cancelFollowUp(taskId: string): boolean {
    const task = this.intentTaskService.getTask(taskId);
    if (!task || !task.scheduleId) {
      return false;
    }

    const scheduleId = task.scheduleId;
    this.schedulerService.delete(scheduleId);
    this.intentTaskService.updateTask(taskId, { scheduleId: undefined });

    return true;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Find a task by its associated schedule ID.
   *
   * @param scheduleId - The schedule ID to search for
   * @returns The matching task, or null if not found
   */
  private findTaskByScheduleId(scheduleId: string): IntentTask | null {
    const allTasks = this.intentTaskService.listTasks();
    return allTasks.find((t) => t.scheduleId === scheduleId) ?? null;
  }

  /**
   * Cancel a follow-up by schedule ID and clear the task association.
   *
   * @param taskId - The intent task ID
   * @param scheduleId - The schedule ID to delete
   */
  private cancelFollowUpByScheduleId(taskId: string, scheduleId: string): void {
    this.schedulerService.delete(scheduleId);
    this.intentTaskService.updateTask(taskId, { scheduleId: undefined });
  }

  /**
   * Get all unresolved tasks (status is not terminal).
   *
   * @returns Array of unresolved tasks
   */
  private getUnresolvedTasks(): IntentTask[] {
    return this.intentTaskService.listTasks().filter(
      (t) => !TERMINAL_STATUSES.has(t.status),
    );
  }
}
