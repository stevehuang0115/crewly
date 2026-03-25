import { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import { ApiResponse } from '../../types/index.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('SchedulerController');

type RecurrenceType = 'interval' | 'daily' | 'weekdays' | 'weekly';

function getMinutesUntilNextOccurrence(
  recurrenceType: RecurrenceType,
  timeOfDay?: string,
  dayOfWeek?: number,
): number {
  if (recurrenceType === 'interval') {
    return 0;
  }

  const [hourStr, minuteStr] = (timeOfDay || '08:00').split(':');
  const hour = Number.parseInt(hourStr, 10);
  const minute = Number.parseInt(minuteStr, 10);
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  if (recurrenceType === 'daily') {
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
  } else if (recurrenceType === 'weekdays') {
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1);
    }
  } else if (recurrenceType === 'weekly') {
    const target = typeof dayOfWeek === 'number' ? dayOfWeek : 1;
    const delta = (target - now.getDay() + 7) % 7;
    next.setDate(now.getDate() + delta);
    if (next <= now) {
      next.setDate(next.getDate() + 7);
    }
  }

  const diffMs = Math.max(next.getTime() - now.getTime(), 60_000);
  return Math.ceil(diffMs / 60000);
}

export async function scheduleCheck(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const {
      targetSession,
      minutes,
      message,
      isRecurring,
      intervalMinutes,
      maxOccurrences,
      recurrenceType = 'interval',
      timeOfDay,
      dayOfWeek,
      timezone,
      label,
      persistent,
      taskId,
    } = req.body as any;
    const isCalendarMode = recurrenceType && recurrenceType !== 'interval';
    if (!targetSession || !message || (!isCalendarMode && !minutes)) {
      res.status(400).json({ success: false, error: 'targetSession, minutes, and message are required' } as ApiResponse);
      return;
    }

    const normalizedRecurrence = recurrenceType as RecurrenceType;
    let normalizedMinutes = Number(minutes || 0);
    let normalizedInterval = Number(intervalMinutes || 0);

    if (normalizedRecurrence !== 'interval') {
      normalizedMinutes = getMinutesUntilNextOccurrence(normalizedRecurrence, timeOfDay, dayOfWeek);
      normalizedInterval = normalizedRecurrence === 'weekly' ? 7 * 24 * 60 : 24 * 60;
    }

    if (!normalizedMinutes) {
      res.status(400).json({ success: false, error: 'minutes (or recurrenceType/timeOfDay) is required' } as ApiResponse);
      return;
    }
    // Keep backwards compatibility with previous scheduler behavior:
    // negative minutes are accepted by legacy callers/tests.

    let checkId: string;
    const hasExtendedSchedule = normalizedRecurrence !== 'interval'
      || timeOfDay
      || typeof dayOfWeek === 'number'
      || timezone
      || label
      || typeof persistent === 'boolean'
      || taskId;

    if (isRecurring && normalizedInterval) {
      if (hasExtendedSchedule) {
        checkId = this.schedulerService.scheduleRecurringCheck(
          targetSession,
          normalizedInterval,
          message,
          'progress-check',
          maxOccurrences,
          { recurrenceType: normalizedRecurrence, timeOfDay, dayOfWeek, timezone, label, persistent, taskId }
        );
      } else {
        checkId = this.schedulerService.scheduleRecurringCheck(
          targetSession,
          normalizedInterval,
          message,
          'progress-check',
          maxOccurrences
        );
      }
    } else {
      if (hasExtendedSchedule) {
        checkId = this.schedulerService.scheduleCheck(
          targetSession,
          normalizedMinutes,
          message,
          'check-in',
          { recurrenceType: normalizedRecurrence, timeOfDay, dayOfWeek, timezone, label, persistent }
        );
      } else {
        checkId = this.schedulerService.scheduleCheck(targetSession, normalizedMinutes, message);
      }
    }
    res.status(201).json({ success: true, data: { checkId }, message: 'Check-in scheduled successfully' } as ApiResponse<{ checkId: string }>);
  } catch (error) {
    logger.error('Error scheduling check', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to schedule check-in' } as ApiResponse);
  }
}

export async function getScheduledChecks(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { session } = req.query as any;
    const checks = session ? this.schedulerService.getChecksForSession(session) : this.schedulerService.listScheduledChecks();
    res.json({ success: true, data: checks } as ApiResponse);
  } catch (error) {
    logger.error('Error getting scheduled checks', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to retrieve scheduled checks' } as ApiResponse);
  }
}

export async function cancelScheduledCheck(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as any;
    const found = this.schedulerService.cancelCheck(id);
    if (found) {
      res.json({ success: true, message: 'Check-in cancelled successfully' } as ApiResponse);
    } else {
      // #290: Still return success because the fallback storage deletion was
      // triggered. The entry will be removed from the persisted file even if
      // it was not found in the in-memory maps (e.g. after a server restart).
      res.json({ success: true, message: 'Check-in not found in memory; persisted entry cleanup triggered' } as ApiResponse);
    }
  } catch (error) {
    logger.error('Error cancelling check', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to cancel check-in' } as ApiResponse);
  }
}

/**
 * Cancel all scheduled checks with optional filters.
 *
 * Query params:
 * - session: only cancel checks for this session
 * - olderThanMinutes: only cancel checks older than N minutes
 *
 * @param req - Request with optional query filters
 * @param res - Response with cancelled count
 */
export async function cancelAllScheduledChecks(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { session, olderThanMinutes } = req.query as { session?: string; olderThanMinutes?: string };
    const filter: { session?: string; olderThanMinutes?: number } = {};
    if (session) {
      filter.session = session;
    }
    if (olderThanMinutes) {
      const parsed = Number(olderThanMinutes);
      if (!isNaN(parsed) && parsed > 0) {
        filter.olderThanMinutes = parsed;
      }
    }
    const cancelled = this.schedulerService.cancelAllChecks(Object.keys(filter).length > 0 ? filter : undefined);
    res.json({
      success: true,
      data: { cancelled },
      message: `Cancelled ${cancelled} scheduled check(s)`,
    } as ApiResponse<{ cancelled: number }>);
  } catch (error) {
    logger.error('Error cancelling all checks', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to cancel scheduled checks' } as ApiResponse);
  }
}

/**
 * Record that the orchestrator manually checked an agent's status or logs.
 * Prevents redundant recurring checks from firing within the same interval.
 *
 * @param req - Request with { agentSession: string }
 * @param res - Response confirming the recording
 */
export async function recordManualCheck(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { agentSession } = req.body as { agentSession?: string };
  if (!agentSession || typeof agentSession !== 'string') {
    res.status(400).json({ success: false, error: 'agentSession is required' } as ApiResponse);
    return;
  }
  this.schedulerService.recordManualCheck(agentSession);
  res.json({ success: true } as ApiResponse);
}

/**
 * Restores persisted scheduled checks (both recurring and one-time) after a restart.
 *
 * @param req - Request (no body required)
 * @param res - Response with restore counts
 */
export async function restoreScheduledChecks(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const recurringCount = await this.schedulerService.restoreRecurringChecks();
    const oneTimeCount = await this.schedulerService.restoreOneTimeChecks();
    res.json({
      success: true,
      data: { recurringRestored: recurringCount, oneTimeRestored: oneTimeCount },
      message: `Restored ${recurringCount} recurring and ${oneTimeCount} one-time checks`,
    } as ApiResponse<{ recurringRestored: number; oneTimeRestored: number }>);
  } catch (error) {
    logger.error('Error restoring scheduled checks', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to restore scheduled checks' } as ApiResponse);
  }
}
