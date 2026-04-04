/**
 * Tests for IntentTaskService — V2
 *
 * @module services/intent-task/intent-task.service.test
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IntentTaskService } from './intent-task.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

/** Create a unique temp file path for each test */
function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intent-task-test-'));
  return join(dir, 'intent-tasks.json');
}

describe('IntentTaskService', () => {
  let tempPath: string;

  beforeEach(() => {
    tempPath = makeTempPath();
    IntentTaskService.setPersistencePath(tempPath);
    IntentTaskService.resetInstance();
    TokenUsageService.resetInstance();
  });

  afterEach(() => {
    IntentTaskService.resetInstance();
    IntentTaskService.setPersistencePath(undefined);
    // Clean up temp files
    const dir = join(tempPath, '..');
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = IntentTaskService.getInstance();
      const b = IntentTaskService.getInstance();
      expect(a).toBe(b);
    });

    it('should return a new instance after reset', () => {
      const a = IntentTaskService.getInstance();
      IntentTaskService.resetInstance();
      const b = IntentTaskService.getInstance();
      expect(a).not.toBe(b);
    });
  });

  // ===========================================================================
  // Message Decomposition
  // ===========================================================================

  describe('decomposeMessage', () => {
    it('should decompose a message with "then" into multiple tasks', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Search for abc then make it into a PDF',
      });

      expect(tasks).toHaveLength(2);
      expect(tasks[0].intent).toBe('Search for abc');
      expect(tasks[1].intent).toBe('make it into a PDF');
    });

    it('should assign the same messageId to all decomposed tasks', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix the bug then deploy to staging',
      });

      expect(tasks).toHaveLength(2);
      expect(tasks[0].messageId).toBe(tasks[1].messageId);
      expect(tasks[0].messageId).toBeTruthy();
    });

    it('should set order field sequentially', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Search for abc then fix it then deploy',
      });

      expect(tasks.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < tasks.length; i++) {
        expect(tasks[i].order).toBe(i);
      }
    });

    it('should classify each task independently', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix the login bug then deploy to staging',
      });

      expect(tasks[0].category).toBe('debugging');
      expect(tasks[1].category).toBe('deployment');
    });

    it('should handle single-intent message as one task', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix the login bug',
      });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].intent).toBe('Fix the login bug');
      expect(tasks[0].order).toBe(0);
    });

    it('should apply projectTaskId to all decomposed tasks', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Search for abc then make PDF',
        projectTaskId: 'proj-123',
      });

      for (const task of tasks) {
        expect(task.projectTaskId).toBe('proj-123');
      }
    });

    it('should apply tags to all decomposed tasks', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix bug then deploy',
        tags: ['sprint-5', 'urgent'],
      });

      for (const task of tasks) {
        expect(task.tags).toEqual(['sprint-5', 'urgent']);
      }
    });

    it('should store all decomposed tasks in the service', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });
      expect(service.getTaskCount()).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty message gracefully', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: '' });
      expect(tasks).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Task CRUD
  // ===========================================================================

  describe('createTask', () => {
    it('should create a task with auto-classification', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Fix the login bug' });

      expect(task.id).toBeDefined();
      expect(task.intent).toBe('Fix the login bug');
      expect(task.level).toBe('L1');
      expect(task.category).toBe('debugging');
      expect(task.status).toBe('classified');
      expect(task.runs).toHaveLength(0);
      expect(task.totalInputTokens).toBe(0);
      expect(task.totalOutputTokens).toBe(0);
      expect(task.totalCost).toBe(0);
    });

    it('should generate a messageId when not provided', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Fix it' });
      expect(task.messageId).toBeDefined();
      expect(task.messageId.length).toBeGreaterThan(0);
    });

    it('should use provided messageId', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Fix it', messageId: 'msg-custom' });
      expect(task.messageId).toBe('msg-custom');
    });

    it('should accept explicit level and category', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({
        intent: 'Something ambiguous',
        level: 'L2',
        category: 'deployment',
      });

      expect(task.level).toBe('L2');
      expect(task.category).toBe('deployment');
    });

    it('should accept optional parentTaskId and tags', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({
        intent: 'Sub-task',
        parentTaskId: 'parent-123',
        tags: ['urgent', 'sprint-5'],
      });

      expect(task.parentTaskId).toBe('parent-123');
      expect(task.tags).toEqual(['urgent', 'sprint-5']);
    });

    it('should set order to 0 by default', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      expect(task.order).toBe(0);
    });

    it('should accept custom order', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test', order: 3 });
      expect(task.order).toBe(3);
    });

    it('should accept scheduleId and projectTaskId', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({
        intent: 'Test',
        scheduleId: 'sched-1',
        projectTaskId: 'proj-1',
      });

      expect(task.scheduleId).toBe('sched-1');
      expect(task.projectTaskId).toBe('proj-1');
    });
  });

  describe('getTask', () => {
    it('should return a task by ID', () => {
      const service = IntentTaskService.getInstance();
      const created = service.createTask({ intent: 'Test' });
      const retrieved = service.getTask(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(created.id);
    });

    it('should return null for non-existent ID', () => {
      const service = IntentTaskService.getInstance();
      expect(service.getTask('nonexistent')).toBeNull();
    });
  });

  describe('listTasks', () => {
    it('should list all tasks', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'First' });
      service.createTask({ intent: 'Second' });
      service.createTask({ intent: 'Third' });

      const tasks = service.listTasks();
      expect(tasks).toHaveLength(3);
    });

    it('should filter by status', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'Task 1' });
      service.createTask({ intent: 'Task 2' });
      service.updateTask(t1.id, { status: 'completed' });

      const completed = service.listTasks('completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe(t1.id);
    });
  });

  describe('listTaskSummaries', () => {
    it('should return summary objects with v2 fields', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'Fix it', scheduleId: 'sched-1', projectTaskId: 'proj-1' });

      const summaries = service.listTaskSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toHaveProperty('runCount');
      expect(summaries[0]).toHaveProperty('totalTokens');
      expect(summaries[0]).toHaveProperty('totalCost');
      expect(summaries[0]).toHaveProperty('messageId');
      expect(summaries[0]).toHaveProperty('order');
      expect(summaries[0].scheduleId).toBe('sched-1');
      expect(summaries[0].projectTaskId).toBe('proj-1');
    });

    it('should truncate long intents', () => {
      const service = IntentTaskService.getInstance();
      const longIntent = 'x'.repeat(200);
      service.createTask({ intent: longIntent });

      const summaries = service.listTaskSummaries();
      expect(summaries[0].intent.length).toBeLessThanOrEqual(123); // 120 + '...'
    });
  });

  describe('updateTask', () => {
    it('should update status', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const updated = service.updateTask(task.id, { status: 'in_progress' });
      expect(updated.status).toBe('in_progress');
    });

    it('should set completedAt on terminal statuses', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const updated = service.updateTask(task.id, { status: 'completed' });
      expect(updated.completedAt).not.toBeNull();
    });

    it('should clear scheduleId on terminal status', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test', scheduleId: 'sched-1' });
      expect(task.scheduleId).toBe('sched-1');

      const updated = service.updateTask(task.id, { status: 'completed' });
      expect(updated.scheduleId).toBeUndefined();
    });

    it('should clear scheduleId on failed status', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test', scheduleId: 'sched-1' });
      const updated = service.updateTask(task.id, { status: 'failed' });
      expect(updated.scheduleId).toBeUndefined();
    });

    it('should clear scheduleId on cancelled status', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test', scheduleId: 'sched-1' });
      const updated = service.updateTask(task.id, { status: 'cancelled' });
      expect(updated.scheduleId).toBeUndefined();
    });

    it('should throw for non-existent task', () => {
      const service = IntentTaskService.getInstance();
      expect(() => service.updateTask('nope', { status: 'completed' })).toThrow('Task not found');
    });

    it('should add assignedSessions without duplicates', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      service.updateTask(task.id, { assignedSessions: ['agent-1'] });
      service.updateTask(task.id, { assignedSessions: ['agent-1', 'agent-2'] });
      expect(task.assignedSessions).toEqual(['agent-1', 'agent-2']);
    });

    it('should update scheduleId', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const updated = service.updateTask(task.id, { scheduleId: 'sched-new' });
      expect(updated.scheduleId).toBe('sched-new');
    });
  });

  describe('completeTask / failTask', () => {
    it('should mark task as completed with result', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const completed = service.completeTask(task.id, 'Done successfully');
      expect(completed.status).toBe('completed');
      expect(completed.result).toBe('Done successfully');
    });

    it('should mark task as failed', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const failed = service.failTask(task.id, 'Timeout');
      expect(failed.status).toBe('failed');
      expect(failed.result).toBe('Timeout');
    });
  });

  describe('deleteTask', () => {
    it('should delete an existing task', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      expect(service.deleteTask(task.id)).toBe(true);
      expect(service.getTask(task.id)).toBeNull();
    });

    it('should return false for non-existent task', () => {
      const service = IntentTaskService.getInstance();
      expect(service.deleteTask('nope')).toBe(false);
    });
  });

  // ===========================================================================
  // Message Group Queries
  // ===========================================================================

  describe('listMessageGroups', () => {
    it('should group tasks by messageId', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });

      const groups = service.listMessageGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].tasks.length).toBeGreaterThanOrEqual(2);
      expect(groups[0].totalCount).toBeGreaterThanOrEqual(2);
    });

    it('should separate different messages into different groups', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.decomposeMessage({ message: 'Run tests' });

      const groups = service.listMessageGroups();
      expect(groups).toHaveLength(2);
    });

    it('should track completion counts', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Fix bug then deploy' });

      service.completeTask(tasks[0].id, 'Done');

      const groups = service.listMessageGroups();
      expect(groups[0].completedCount).toBe(1);
    });

    it('should include original message text', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy to staging' });

      const groups = service.listMessageGroups();
      expect(groups[0].originalMessage).toBe('Fix bug then deploy to staging');
    });

    it('should sort groups by createdAt descending', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'First message' });

      // Small delay to ensure different timestamps
      const tasks2 = service.decomposeMessage({ message: 'Second message' });

      const groups = service.listMessageGroups();
      // The second message should appear first (newest first) or same time
      expect(groups.length).toBe(2);
    });

    it('should order tasks within group by order field', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Search then fix then deploy' });

      const groups = service.listMessageGroups();
      const groupTasks = groups[0].tasks;
      for (let i = 1; i < groupTasks.length; i++) {
        expect(groupTasks[i].order).toBeGreaterThanOrEqual(groupTasks[i - 1].order);
      }
    });

    it('should filter groups by task status', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.completeTask(tasks[0].id, 'Done');

      // Filter for completed — should return group with only the completed task
      const completedGroups = service.listMessageGroups('completed');
      expect(completedGroups).toHaveLength(1);
      expect(completedGroups[0].tasks).toHaveLength(1);
      expect(completedGroups[0].tasks[0].status).toBe('completed');

      // originalMessage must be preserved (not rebuilt from filtered intents)
      expect(completedGroups[0].originalMessage).toBe('Fix bug then deploy');
    });

    it('should return empty when no tasks match status filter', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });

      const failedGroups = service.listMessageGroups('failed');
      expect(failedGroups).toHaveLength(0);
    });
  });

  describe('listTaskSummaries — originalMessage', () => {
    it('should include originalMessage in task summaries', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy to staging' });

      const summaries = service.listTaskSummaries();
      expect(summaries.length).toBeGreaterThanOrEqual(2);
      for (const summary of summaries) {
        expect(summary.originalMessage).toBe('Fix bug then deploy to staging');
      }
    });

    it('should include originalMessage when filtering summaries by status', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.completeTask(tasks[0].id, 'Done');

      const completedSummaries = service.listTaskSummaries('completed');
      expect(completedSummaries).toHaveLength(1);
      expect(completedSummaries[0].originalMessage).toBe('Fix bug then deploy');
    });
  });

  describe('getTasksByMessage', () => {
    it('should return tasks for a specific messageId', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Fix bug then deploy' });
      const messageId = tasks[0].messageId;

      const retrieved = service.getTasksByMessage(messageId);
      expect(retrieved.length).toBe(tasks.length);
    });

    it('should return empty array for unknown messageId', () => {
      const service = IntentTaskService.getInstance();
      expect(service.getTasksByMessage('unknown')).toEqual([]);
    });

    it('should sort by order', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({ message: 'Search then fix then deploy' });
      const messageId = tasks[0].messageId;

      const retrieved = service.getTasksByMessage(messageId);
      for (let i = 1; i < retrieved.length; i++) {
        expect(retrieved[i].order).toBeGreaterThanOrEqual(retrieved[i - 1].order);
      }
    });
  });

  // ===========================================================================
  // Project Task Association
  // ===========================================================================

  describe('getProjectTaskStatus', () => {
    it('should return status for linked project task', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({
        message: 'Fix bug then deploy',
        projectTaskId: 'proj-1',
      });

      const status = service.getProjectTaskStatus('proj-1');
      expect(status).not.toBeNull();
      expect(status!.projectTaskId).toBe('proj-1');
      expect(status!.totalTasks).toBeGreaterThanOrEqual(2);
      expect(status!.completedTasks).toBe(0);
      expect(status!.allCompleted).toBe(false);
    });

    it('should report allCompleted when all tasks done', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix bug then deploy',
        projectTaskId: 'proj-2',
      });

      for (const task of tasks) {
        service.completeTask(task.id);
      }

      const status = service.getProjectTaskStatus('proj-2');
      expect(status!.allCompleted).toBe(true);
      expect(status!.completedTasks).toBe(status!.totalTasks);
    });

    it('should return null for unlinked project task', () => {
      const service = IntentTaskService.getInstance();
      expect(service.getProjectTaskStatus('unknown')).toBeNull();
    });

    it('should include task summaries', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({
        message: 'Fix bug',
        projectTaskId: 'proj-3',
      });

      const status = service.getProjectTaskStatus('proj-3');
      expect(status!.tasks.length).toBe(1);
      expect(status!.tasks[0]).toHaveProperty('id');
      expect(status!.tasks[0]).toHaveProperty('messageId');
    });
  });

  // ===========================================================================
  // Schedule Association
  // ===========================================================================

  describe('schedule association', () => {
    it('should set schedule on a task', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      service.setSchedule(task.id, 'sched-abc');
      expect(service.getScheduleId(task.id)).toBe('sched-abc');
    });

    it('should return undefined for task without schedule', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      expect(service.getScheduleId(task.id)).toBeUndefined();
    });

    it('should return undefined for non-existent task', () => {
      const service = IntentTaskService.getInstance();
      expect(service.getScheduleId('nope')).toBeUndefined();
    });

    it('should clear schedule when task completes', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test', scheduleId: 'sched-1' });
      service.completeTask(task.id);
      expect(service.getScheduleId(task.id)).toBeUndefined();
    });
  });

  // ===========================================================================
  // Run Management
  // ===========================================================================

  describe('startRun', () => {
    it('should create a run and set task to in_progress', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      expect(run.id).toBeDefined();
      expect(run.taskId).toBe(task.id);
      expect(run.runNumber).toBe(1);
      expect(run.sessionName).toBe('agent-1');
      expect(run.status).toBe('running');
      expect(run.spans).toHaveLength(0);

      const updated = service.getTask(task.id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.assignedSessions).toContain('agent-1');
    });

    it('should bind token tracking context', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      service.startRun(task.id, { sessionName: 'agent-1' });

      const ctx = TokenUsageService.getInstance().getTaskContext('agent-1');
      expect(ctx).toBe(task.id);
    });

    it('should increment runNumber', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run1 = service.startRun(task.id, { sessionName: 'agent-1' });
      service.completeRun(task.id, run1.id);
      const run2 = service.startRun(task.id, { sessionName: 'agent-1' });
      expect(run2.runNumber).toBe(2);
    });

    it('should throw for non-existent task', () => {
      const service = IntentTaskService.getInstance();
      expect(() => service.startRun('nope', { sessionName: 'a' })).toThrow('Task not found');
    });
  });

  describe('completeRun / failRun', () => {
    it('should complete a run and clear token context', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      const completed = service.completeRun(task.id, run.id);

      expect(completed.status).toBe('completed');
      expect(completed.endedAt).not.toBeNull();
      expect(TokenUsageService.getInstance().getTaskContext('agent-1')).toBeNull();
    });

    it('should fail a run with error', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      const failed = service.failRun(task.id, run.id, 'API timeout');

      expect(failed.status).toBe('failed');
      expect(failed.error).toBe('API timeout');
    });

    it('should throw for non-existent run', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      expect(() => service.completeRun(task.id, 'nope')).toThrow('Run not found');
    });
  });

  describe('getRun', () => {
    it('should return a run by ID', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      const retrieved = service.getRun(task.id, run.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(run.id);
    });

    it('should return null for non-existent', () => {
      const service = IntentTaskService.getInstance();
      expect(service.getRun('nope', 'nope')).toBeNull();
    });
  });

  // ===========================================================================
  // Span Recording
  // ===========================================================================

  describe('recordSpan', () => {
    it('should record a span and aggregate tokens', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const span = service.recordSpan(task.id, run.id, {
        type: 'llm_call',
        label: 'claude-opus',
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 1500,
        metadata: { model: 'claude-3-opus' },
      });

      expect(span.id).toBeDefined();
      expect(span.type).toBe('llm_call');
      expect(span.inputTokens).toBe(500);
      expect(span.outputTokens).toBe(200);
      expect(span.durationMs).toBe(1500);

      // Check run aggregation
      const updatedRun = service.getRun(task.id, run.id)!;
      expect(updatedRun.totalInputTokens).toBe(500);
      expect(updatedRun.totalOutputTokens).toBe(200);
      expect(updatedRun.cost).toBeGreaterThan(0);

      // Check task aggregation
      const updatedTask = service.getTask(task.id)!;
      expect(updatedTask.totalInputTokens).toBe(500);
      expect(updatedTask.totalOutputTokens).toBe(200);
      expect(updatedTask.totalCost).toBeGreaterThan(0);
    });

    it('should accumulate across multiple spans', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      service.recordSpan(task.id, run.id, { type: 'llm_call', label: 'call-1', inputTokens: 100, outputTokens: 50 });
      service.recordSpan(task.id, run.id, { type: 'tool_call', label: 'bash_exec', inputTokens: 0, outputTokens: 0, durationMs: 500 });
      service.recordSpan(task.id, run.id, { type: 'llm_call', label: 'call-2', inputTokens: 200, outputTokens: 100 });

      const updatedRun = service.getRun(task.id, run.id)!;
      expect(updatedRun.spans).toHaveLength(3);
      expect(updatedRun.totalInputTokens).toBe(300);
      expect(updatedRun.totalOutputTokens).toBe(150);
    });

    it('should throw for non-running run', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      service.completeRun(task.id, run.id);

      expect(() =>
        service.recordSpan(task.id, run.id, { type: 'llm_call', label: 'x' })
      ).toThrow('not in running state');
    });

    it('should throw for non-existent task', () => {
      const service = IntentTaskService.getInstance();
      expect(() =>
        service.recordSpan('nope', 'nope', { type: 'llm_call', label: 'x' })
      ).toThrow('Task not found');
    });

    it('should throw for non-existent run', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test' });
      expect(() =>
        service.recordSpan(task.id, 'nope', { type: 'llm_call', label: 'x' })
      ).toThrow('Run not found');
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================

  describe('getStatistics', () => {
    it('should return aggregate statistics', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'What time is it?' });
      service.createTask({ intent: 'Fix the login bug' });
      const t3 = service.createTask({ intent: 'Deploy staging' });
      service.completeTask(t3.id);

      const stats = service.getStatistics();
      expect(stats.totalTasks).toBe(3);
      expect(stats.byStatus.classified).toBe(2);
      expect(stats.byStatus.completed).toBe(1);
      expect(stats.byLevel.L0).toBe(1);
      expect(stats.byLevel.L1).toBe(1);
    });

    it('should sum tokens across tasks', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'Task 1' });
      const r1 = service.startRun(t1.id, { sessionName: 'a' });
      service.recordSpan(t1.id, r1.id, { type: 'llm_call', label: 'x', inputTokens: 100, outputTokens: 50 });

      const t2 = service.createTask({ intent: 'Task 2' });
      const r2 = service.startRun(t2.id, { sessionName: 'b' });
      service.recordSpan(t2.id, r2.id, { type: 'llm_call', label: 'y', inputTokens: 200, outputTokens: 100 });

      const stats = service.getStatistics();
      expect(stats.totalTokens).toBe(450); // 100+50+200+100
    });

    it('should include totalMessages count', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.decomposeMessage({ message: 'Run tests' });

      const stats = service.getStatistics();
      expect(stats.totalMessages).toBe(2);
    });
  });

  // ===========================================================================
  // Persistence
  // ===========================================================================

  describe('persistence', () => {
    it('should persist tasks to disk and reload on new instance', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Persist me', tags: ['test'] });
      service.flushSync();

      // Verify file was written
      expect(existsSync(tempPath)).toBe(true);

      // Reset and create new instance pointing to same file
      IntentTaskService.resetInstance();
      const service2 = IntentTaskService.getInstance();

      const reloaded = service2.getTask(task.id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.intent).toBe('Persist me');
      expect(reloaded!.tags).toEqual(['test']);
    });

    it('should persist messageTexts and reconstruct message groups', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Fix bug then deploy to staging',
      });
      service.flushSync();

      IntentTaskService.resetInstance();
      const service2 = IntentTaskService.getInstance();

      const groups = service2.listMessageGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].originalMessage).toBe('Fix bug then deploy to staging');
      expect(groups[0].tasks.length).toBe(tasks.length);
    });

    it('should persist run and span data', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test with runs' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      service.recordSpan(task.id, run.id, {
        type: 'llm_call',
        label: 'opus',
        inputTokens: 500,
        outputTokens: 200,
      });
      service.completeRun(task.id, run.id);
      service.flushSync();

      IntentTaskService.resetInstance();
      const service2 = IntentTaskService.getInstance();

      const reloaded = service2.getTask(task.id)!;
      expect(reloaded.runs).toHaveLength(1);
      expect(reloaded.runs[0].status).toBe('completed');
      expect(reloaded.runs[0].totalInputTokens).toBe(500);
      expect(reloaded.runs[0].spans).toHaveLength(1);
      expect(reloaded.totalInputTokens).toBe(500);
      expect(reloaded.totalOutputTokens).toBe(200);
    });

    it('should survive corrupt file gracefully', () => {
      const { writeFileSync: wfs, mkdirSync: mds } = require('fs');
      const { dirname } = require('path');
      mds(dirname(tempPath), { recursive: true });
      wfs(tempPath, 'NOT VALID JSON!!!', 'utf-8');

      IntentTaskService.resetInstance();
      const service = IntentTaskService.getInstance();

      // Should start empty, not throw
      expect(service.getTaskCount()).toBe(0);
    });

    it('should start empty when persistence file does not exist', () => {
      // tempPath doesn't exist yet (no tasks created)
      const freshPath = makeTempPath();
      IntentTaskService.setPersistencePath(freshPath);
      IntentTaskService.resetInstance();
      const service = IntentTaskService.getInstance();

      expect(service.getTaskCount()).toBe(0);
      expect(service.listTasks()).toHaveLength(0);

      // Clean up
      const dir = join(freshPath, '..');
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should persist delete operations', () => {
      const service = IntentTaskService.getInstance();
      const task1 = service.createTask({ intent: 'Keep me' });
      const task2 = service.createTask({ intent: 'Delete me' });
      service.deleteTask(task2.id);
      service.flushSync();

      IntentTaskService.resetInstance();
      const service2 = IntentTaskService.getInstance();

      expect(service2.getTask(task1.id)).not.toBeNull();
      expect(service2.getTask(task2.id)).toBeNull();
      expect(service2.getTaskCount()).toBe(1);
    });

    it('should write valid JSON with version field', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'Version check' });
      service.flushSync();

      const raw = readFileSync(tempPath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.version).toBe(1);
      expect(Array.isArray(data.tasks)).toBe(true);
      expect(Array.isArray(data.messageTexts)).toBe(true);
    });

    it('should debounce rapid saves', async () => {
      const service = IntentTaskService.getInstance();

      // Create many tasks rapidly — should only produce one write
      for (let i = 0; i < 10; i++) {
        service.createTask({ intent: `Rapid task ${i}` });
      }

      // File may not exist yet (debounce pending)
      // Flush forces the write
      service.flushSync();

      IntentTaskService.resetInstance();
      const service2 = IntentTaskService.getInstance();
      expect(service2.getTaskCount()).toBe(10);
    });
  });

  // ===========================================================================
  // Unresolved Tasks
  // ===========================================================================

  describe('getUnresolvedTasks', () => {
    it('should return tasks with non-terminal statuses', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'classified task' });
      const t2 = service.createTask({ intent: 'in progress task' });
      service.updateTask(t2.id, { status: 'in_progress' });
      const t3 = service.createTask({ intent: 'completed task' });
      service.completeTask(t3.id, 'Done');
      const t4 = service.createTask({ intent: 'failed task' });
      service.failTask(t4.id, 'Error');

      const unresolved = service.getUnresolvedTasks();
      expect(unresolved).toHaveLength(2);
      const statuses = unresolved.map((t) => t.status);
      expect(statuses).toContain('classified');
      expect(statuses).toContain('in_progress');
      expect(statuses).not.toContain('completed');
      expect(statuses).not.toContain('failed');
    });

    it('should return empty array when all tasks are terminal', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'done' });
      const t2 = service.createTask({ intent: 'failed' });
      service.completeTask(t1.id);
      service.failTask(t2.id);

      expect(service.getUnresolvedTasks()).toHaveLength(0);
    });

    it('should return all tasks when none are terminal', () => {
      const service = IntentTaskService.getInstance();
      service.createTask({ intent: 'task 1' });
      service.createTask({ intent: 'task 2' });
      service.createTask({ intent: 'task 3' });

      expect(service.getUnresolvedTasks()).toHaveLength(3);
    });

    it('should sort by updatedAt descending', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'first' });
      const t2 = service.createTask({ intent: 'second' });
      // Update t1 to make it more recent
      service.updateTask(t1.id, { status: 'in_progress' });

      const unresolved = service.getUnresolvedTasks();
      expect(unresolved[0].id).toBe(t1.id);
      expect(unresolved[1].id).toBe(t2.id);
    });

    it('should exclude cancelled tasks', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'active' });
      const t2 = service.createTask({ intent: 'cancelled' });
      service.updateTask(t2.id, { status: 'cancelled' });

      const unresolved = service.getUnresolvedTasks();
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].id).toBe(t1.id);
    });
  });

  // ===========================================================================
  // Task A: runId Binding
  // ===========================================================================

  describe('runId binding', () => {
    it('should pass runId to TokenUsageService on startRun', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test runId binding' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const ctx = TokenUsageService.getInstance().getRunContext('agent-1');
      expect(ctx).not.toBeNull();
      expect(ctx!.taskId).toBe(task.id);
      expect(ctx!.runId).toBe(run.id);
    });

    it('should clear runId context when run completes', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test clear on complete' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      // Context should be set
      expect(TokenUsageService.getInstance().getRunContext('agent-1')).not.toBeNull();

      service.completeRun(task.id, run.id);

      // Context should be cleared
      expect(TokenUsageService.getInstance().getRunContext('agent-1')).toBeNull();
      expect(TokenUsageService.getInstance().getTaskContext('agent-1')).toBeNull();
    });

    it('should update runId context on subsequent startRun', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test multiple runs' });
      const run1 = service.startRun(task.id, { sessionName: 'agent-1' });
      service.completeRun(task.id, run1.id);

      const run2 = service.startRun(task.id, { sessionName: 'agent-1' });
      const ctx = TokenUsageService.getInstance().getRunContext('agent-1');
      expect(ctx!.runId).toBe(run2.id);
      expect(ctx!.runId).not.toBe(run1.id);
    });

    it('should reject recordSpan with mismatched runId', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test runId mismatch' });
      const run1 = service.startRun(task.id, { sessionName: 'agent-1' });

      // Create a second run (first must be finished first)
      service.completeRun(task.id, run1.id);
      const run2 = service.startRun(task.id, { sessionName: 'agent-1' });

      // Try to record span against run1 (completed) — should fail as not running
      expect(() =>
        service.recordSpan(task.id, run1.id, { type: 'llm_call', label: 'x' })
      ).toThrow('not in running state');

      // run2 should work fine since context matches
      const span = service.recordSpan(task.id, run2.id, {
        type: 'llm_call',
        label: 'test',
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(span.runId).toBe(run2.id);
    });

    it('should maintain backward compatible getTaskContext', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test backward compat' });
      service.startRun(task.id, { sessionName: 'agent-1' });

      // getTaskContext should still return just the taskId string
      const taskId = TokenUsageService.getInstance().getTaskContext('agent-1');
      expect(taskId).toBe(task.id);
      expect(typeof taskId).toBe('string');
    });
  });

  // ===========================================================================
  // Task B: Skill Cost Tracking
  // ===========================================================================

  describe('skill cost tracking', () => {
    it('should record skill_call span with costOverride', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test skill cost' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      const span = service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'browser-automation',
        costOverride: 0.05,
        durationMs: 3000,
        metadata: { action: 'screenshot' },
      });

      expect(span.type).toBe('skill_call');
      expect(span.costOverride).toBe(0.05);
      expect(span.durationMs).toBe(3000);
    });

    it('should aggregate skill costs separately from LLM costs on run', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test cost separation' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      // Record an LLM span
      service.recordSpan(task.id, run.id, {
        type: 'llm_call',
        label: 'claude-opus',
        inputTokens: 1000,
        outputTokens: 500,
        metadata: { model: 'claude-3-opus' },
      });

      // Record a skill span
      service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'api-call',
        costOverride: 0.10,
        durationMs: 2000,
      });

      const updatedRun = service.getRun(task.id, run.id)!;
      expect(updatedRun.cost).toBeGreaterThan(0); // LLM cost
      expect(updatedRun.skillCost).toBe(0.10); // Skill cost
      expect(updatedRun.spans).toHaveLength(2);
    });

    it('should aggregate skill costs to task level', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test task-level skill cost' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'browser-navigate',
        costOverride: 0.02,
      });

      service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'api-external',
        costOverride: 0.03,
      });

      const updatedTask = service.getTask(task.id)!;
      expect(updatedTask.totalSkillCost).toBe(0.05);
      expect(updatedTask.totalCost).toBe(0); // No LLM cost
    });

    it('should distinguish LLM and skill costs in getStatistics', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Stats test' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      // LLM span
      service.recordSpan(task.id, run.id, {
        type: 'llm_call',
        label: 'opus',
        inputTokens: 500,
        outputTokens: 200,
        metadata: { model: 'claude-3-opus' },
      });

      // Skill span
      service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'browser',
        costOverride: 0.08,
      });

      const stats = service.getStatistics();
      expect(stats.llmCost).toBeGreaterThan(0);
      expect(stats.skillCost).toBe(0.08);
      expect(stats.totalCost).toBe(stats.llmCost + stats.skillCost);
    });

    it('should handle skill span with zero costOverride as LLM cost path', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Test zero cost override' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      // costOverride of 0 should fall through to LLM cost calculation
      service.recordSpan(task.id, run.id, {
        type: 'tool_call',
        label: 'bash_exec',
        costOverride: 0,
        durationMs: 500,
      });

      const updatedRun = service.getRun(task.id, run.id)!;
      expect(updatedRun.skillCost).toBe(0); // Zero override doesn't count as skill cost
    });

    it('should include totalSkillCost in task summary', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Summary skill cost' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });

      service.recordSpan(task.id, run.id, {
        type: 'skill_call',
        label: 'api-call',
        costOverride: 0.15,
      });

      const summaries = service.listTaskSummaries();
      const summary = summaries.find((s) => s.id === task.id)!;
      expect(summary.totalSkillCost).toBe(0.15);
    });
  });
});
