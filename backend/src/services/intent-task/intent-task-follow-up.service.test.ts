/**
 * Tests for IntentTaskFollowUpService
 *
 * @module services/intent-task/intent-task-follow-up.service.test
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IntentTaskFollowUpService } from './intent-task-follow-up.service.js';
import type { FollowUpNeededPayload } from './intent-task-follow-up.service.js';
import { IntentTaskService } from './intent-task.service.js';
import { UnifiedSchedulerService } from '../workflow/unified-scheduler.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

/** Create a unique temp dir for isolation */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'follow-up-test-'));
}

describe('IntentTaskFollowUpService', () => {
  let tempDir: string;
  let intentService: IntentTaskService;
  let schedulerService: UnifiedSchedulerService;
  let followUpService: IntentTaskFollowUpService;

  beforeEach(() => {
    tempDir = makeTempDir();
    const taskPath = join(tempDir, 'intent-tasks.json');
    const schedulerHome = tempDir;

    // Reset all singletons
    IntentTaskService.setPersistencePath(taskPath);
    IntentTaskService.resetInstance();
    UnifiedSchedulerService.resetInstance();
    IntentTaskFollowUpService.resetInstance();
    TokenUsageService.resetInstance();

    intentService = IntentTaskService.getInstance();
    schedulerService = UnifiedSchedulerService.getInstance(schedulerHome);
    followUpService = new IntentTaskFollowUpService(intentService, schedulerService);
  });

  afterEach(() => {
    IntentTaskFollowUpService.resetInstance();
    IntentTaskService.resetInstance();
    IntentTaskService.setPersistencePath(undefined);
    UnifiedSchedulerService.resetInstance();

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = IntentTaskFollowUpService.getInstance();
      const b = IntentTaskFollowUpService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a new instance after reset', () => {
      const a = IntentTaskFollowUpService.getInstance();
      IntentTaskFollowUpService.resetInstance();
      const b = IntentTaskFollowUpService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ===========================================================================
  // scheduleFollowUp
  // ===========================================================================

  describe('scheduleFollowUp', () => {
    it('should create a schedule for an unresolved task', () => {
      const task = intentService.createTask({ intent: 'fix the bug' });

      const scheduleId = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId).toBeTruthy();
      const updatedTask = intentService.getTask(task.id);
      expect(updatedTask?.scheduleId).toBe(scheduleId);

      // Verify schedule was created in scheduler
      const schedule = schedulerService.get(scheduleId!);
      expect(schedule).not.toBeNull();
      expect(schedule?.type).toBe('interval');
      expect(schedule?.intervalMinutes).toBe(15);
      expect(schedule?.enabled).toBe(true);
    });

    it('should use custom delay when provided', () => {
      const task = intentService.createTask({ intent: 'deploy to staging' });

      const scheduleId = followUpService.scheduleFollowUp(task.id, 30);

      const schedule = schedulerService.get(scheduleId!);
      expect(schedule?.intervalMinutes).toBe(30);
    });

    it('should return null for a completed task', () => {
      const task = intentService.createTask({ intent: 'already done' });
      intentService.completeTask(task.id, 'Done');

      const scheduleId = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId).toBeNull();
    });

    it('should return null for a failed task', () => {
      const task = intentService.createTask({ intent: 'broken' });
      intentService.failTask(task.id, 'Error');

      const scheduleId = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId).toBeNull();
    });

    it('should return null for a cancelled task', () => {
      const task = intentService.createTask({ intent: 'nope' });
      intentService.updateTask(task.id, { status: 'cancelled' });

      const scheduleId = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId).toBeNull();
    });

    it('should throw if task does not exist', () => {
      expect(() => followUpService.scheduleFollowUp('nonexistent')).toThrow('Task not found');
    });

    it('should not create duplicate schedule if one is already active', () => {
      const task = intentService.createTask({ intent: 'do something' });

      const scheduleId1 = followUpService.scheduleFollowUp(task.id);
      const scheduleId2 = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId1).toBe(scheduleId2);
    });

    it('should recreate schedule if existing one was paused', () => {
      const task = intentService.createTask({ intent: 'do something' });

      const scheduleId1 = followUpService.scheduleFollowUp(task.id);
      // Pause the schedule
      schedulerService.pause(scheduleId1!);

      const scheduleId2 = followUpService.scheduleFollowUp(task.id);

      expect(scheduleId2).not.toBe(scheduleId1);
      expect(scheduleId2).toBeTruthy();
    });
  });

  // ===========================================================================
  // onFollowUpTriggered
  // ===========================================================================

  describe('onFollowUpTriggered', () => {
    it('should cancel schedule when task is completed', () => {
      const task = intentService.createTask({ intent: 'fix bug' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      // Complete the task
      intentService.completeTask(task.id, 'Fixed');

      followUpService.onFollowUpTriggered(scheduleId);

      // Schedule should be deleted
      expect(schedulerService.get(scheduleId)).toBeNull();
      // Task scheduleId should be cleared
      const updatedTask = intentService.getTask(task.id);
      expect(updatedTask?.scheduleId).toBeUndefined();
    });

    it('should cancel schedule when task is failed', () => {
      const task = intentService.createTask({ intent: 'try something' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      intentService.failTask(task.id, 'Broken');

      followUpService.onFollowUpTriggered(scheduleId);

      expect(schedulerService.get(scheduleId)).toBeNull();
    });

    it('should cancel schedule when task is cancelled', () => {
      const task = intentService.createTask({ intent: 'never mind' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      intentService.updateTask(task.id, { status: 'cancelled' });

      followUpService.onFollowUpTriggered(scheduleId);

      expect(schedulerService.get(scheduleId)).toBeNull();
    });

    it('should emit follow-up-needed when task is still in_progress', () => {
      const task = intentService.createTask({ intent: 'long running task' });
      intentService.updateTask(task.id, { status: 'in_progress' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      const events: FollowUpNeededPayload[] = [];
      followUpService.on('follow-up-needed', (payload: FollowUpNeededPayload) => {
        events.push(payload);
      });

      followUpService.onFollowUpTriggered(scheduleId);

      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe(task.id);
      expect(events[0].intent).toBe('long running task');
      expect(events[0].status).toBe('in_progress');
    });

    it('should emit follow-up-needed when task is still classified', () => {
      const task = intentService.createTask({ intent: 'classified task' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      const events: FollowUpNeededPayload[] = [];
      followUpService.on('follow-up-needed', (payload: FollowUpNeededPayload) => {
        events.push(payload);
      });

      followUpService.onFollowUpTriggered(scheduleId);

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('classified');
    });

    it('should emit follow-up-needed when task is pending', () => {
      const task = intentService.createTask({ intent: 'pending task' });
      intentService.updateTask(task.id, { status: 'pending' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      const events: FollowUpNeededPayload[] = [];
      followUpService.on('follow-up-needed', (payload: FollowUpNeededPayload) => {
        events.push(payload);
      });

      followUpService.onFollowUpTriggered(scheduleId);

      expect(events).toHaveLength(1);
      expect(events[0].status).toBe('pending');
    });

    it('should include assignedSessions in the payload', () => {
      const task = intentService.createTask({ intent: 'assigned task' });
      intentService.updateTask(task.id, { assignedSessions: ['agent-1', 'agent-2'] });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      const events: FollowUpNeededPayload[] = [];
      followUpService.on('follow-up-needed', (payload: FollowUpNeededPayload) => {
        events.push(payload);
      });

      followUpService.onFollowUpTriggered(scheduleId);

      expect(events[0].assignedSessions).toEqual(['agent-1', 'agent-2']);
    });

    it('should delete orphaned schedule when no task is found', () => {
      // Create a schedule directly (not through followUp)
      const schedule = schedulerService.create({
        target: 'crewly-orc',
        type: 'interval',
        intervalMinutes: 15,
        message: 'orphaned',
      });

      followUpService.onFollowUpTriggered(schedule.id);

      // Schedule should be cleaned up
      expect(schedulerService.get(schedule.id)).toBeNull();
    });
  });

  // ===========================================================================
  // restoreFollowUps
  // ===========================================================================

  describe('restoreFollowUps', () => {
    it('should create follow-ups for unresolved tasks without scheduleId', () => {
      intentService.createTask({ intent: 'task without schedule 1' });
      intentService.createTask({ intent: 'task without schedule 2' });

      const restored = followUpService.restoreFollowUps();

      expect(restored).toBe(2);
      // Both tasks should now have scheduleIds
      const tasks = intentService.listTasks();
      for (const task of tasks) {
        expect(task.scheduleId).toBeTruthy();
      }
    });

    it('should recreate follow-ups for tasks with missing schedules', () => {
      const task = intentService.createTask({ intent: 'lost schedule' });
      // Manually set a scheduleId that doesn't exist in scheduler
      intentService.updateTask(task.id, { scheduleId: 'nonexistent-schedule' });

      const restored = followUpService.restoreFollowUps();

      expect(restored).toBe(1);
      const updatedTask = intentService.getTask(task.id);
      expect(updatedTask?.scheduleId).not.toBe('nonexistent-schedule');
      expect(updatedTask?.scheduleId).toBeTruthy();
    });

    it('should skip tasks with active schedules', () => {
      const task = intentService.createTask({ intent: 'already scheduled' });
      followUpService.scheduleFollowUp(task.id);

      const restored = followUpService.restoreFollowUps();

      expect(restored).toBe(0);
    });

    it('should skip terminal tasks', () => {
      const task1 = intentService.createTask({ intent: 'completed' });
      const task2 = intentService.createTask({ intent: 'failed' });
      const task3 = intentService.createTask({ intent: 'cancelled' });
      intentService.completeTask(task1.id, 'Done');
      intentService.failTask(task2.id, 'Error');
      intentService.updateTask(task3.id, { status: 'cancelled' });

      const restored = followUpService.restoreFollowUps();

      expect(restored).toBe(0);
    });

    it('should use custom delay when provided', () => {
      intentService.createTask({ intent: 'custom delay task' });

      followUpService.restoreFollowUps(30);

      const tasks = intentService.listTasks();
      const schedule = schedulerService.get(tasks[0].scheduleId!);
      expect(schedule?.intervalMinutes).toBe(30);
    });

    it('should handle mixed resolved and unresolved tasks', () => {
      const task1 = intentService.createTask({ intent: 'resolved task' });
      intentService.createTask({ intent: 'unresolved task 1' });
      intentService.createTask({ intent: 'unresolved task 2' });
      intentService.completeTask(task1.id, 'Done');

      const restored = followUpService.restoreFollowUps();

      expect(restored).toBe(2);
    });
  });

  // ===========================================================================
  // cancelFollowUp
  // ===========================================================================

  describe('cancelFollowUp', () => {
    it('should cancel an existing follow-up', () => {
      const task = intentService.createTask({ intent: 'cancel me' });
      const scheduleId = followUpService.scheduleFollowUp(task.id)!;

      const result = followUpService.cancelFollowUp(task.id);

      expect(result).toBe(true);
      expect(schedulerService.get(scheduleId)).toBeNull();
      const updatedTask = intentService.getTask(task.id);
      expect(updatedTask?.scheduleId).toBeUndefined();
    });

    it('should return false if task has no follow-up', () => {
      const task = intentService.createTask({ intent: 'no follow-up' });

      const result = followUpService.cancelFollowUp(task.id);

      expect(result).toBe(false);
    });

    it('should return false for nonexistent task', () => {
      const result = followUpService.cancelFollowUp('nonexistent');

      expect(result).toBe(false);
    });
  });
});
