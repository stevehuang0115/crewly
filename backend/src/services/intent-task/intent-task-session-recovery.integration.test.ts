/**
 * Integration tests for IntentTaskService session-less recovery.
 *
 * Tests that tasks, message groups, runs, and scheduleIds persist
 * correctly across singleton reset + reload cycles (simulating restarts).
 *
 * @module services/intent-task/intent-task-session-recovery.integration.test
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { IntentTaskService } from './intent-task.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

/** Create a unique temp file path for each test */
function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intent-recovery-test-'));
  return join(dir, 'intent-tasks.json');
}

/**
 * Helper: reset the singleton and reload from the same persistence path.
 * Simulates a server restart — in-memory state is lost, disk state survives.
 */
function simulateRestart(): void {
  IntentTaskService.resetInstance();
}

describe('IntentTaskService — Session-less Recovery', () => {
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
    const dir = join(tempPath, '..');
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // 1. Task persistence across restart
  // ===========================================================================

  describe('task persistence across restart', () => {
    it('should recover tasks after singleton reset and reload', () => {
      const service = IntentTaskService.getInstance();
      const task1 = service.createTask({ intent: 'Search for X' });
      const task2 = service.createTask({ intent: 'Deploy to staging' });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      expect(restored.getTask(task1.id)).not.toBeNull();
      expect(restored.getTask(task2.id)).not.toBeNull();
      expect(restored.getTaskCount()).toBe(2);
    });

    it('should preserve task status after restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Fix the bug' });
      service.completeTask(task.id, 'Bug fixed');
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.status).toBe('completed');
      expect(recovered!.result).toBe('Bug fixed');
      expect(recovered!.completedAt).not.toBeNull();
    });

    it('should preserve task metadata (level, category, tags) after restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({
        intent: 'Fix the login bug',
        tags: ['sprint-5', 'urgent'],
      });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.level).toBe(task.level);
      expect(recovered!.category).toBe(task.category);
      expect(recovered!.tags).toEqual(['sprint-5', 'urgent']);
    });
  });

  // ===========================================================================
  // 2. Follow-up schedule recovery
  // ===========================================================================

  describe('follow-up schedule recovery', () => {
    it('should preserve scheduleId after restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Monitor deployment' });
      service.setSchedule(task.id, 'sched-abc-123');
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.scheduleId).toBe('sched-abc-123');
    });

    it('should clear scheduleId for completed tasks after restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Run nightly batch' });
      service.setSchedule(task.id, 'sched-xyz');
      service.completeTask(task.id, 'Batch done');
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.scheduleId).toBeUndefined();
      expect(recovered!.status).toBe('completed');
    });
  });

  // ===========================================================================
  // 3. Multiple unresolved tasks
  // ===========================================================================

  describe('multiple unresolved tasks', () => {
    it('should recover only unresolved tasks as non-terminal after restart', () => {
      const service = IntentTaskService.getInstance();
      const tasks = [];
      for (let i = 0; i < 5; i++) {
        tasks.push(service.createTask({ intent: `Task ${i}` }));
      }
      // Complete 2 tasks
      service.completeTask(tasks[0].id, 'Done');
      service.completeTask(tasks[1].id, 'Done');
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      expect(restored.getTaskCount()).toBe(5);

      // 3 unresolved (classified), 2 completed
      const all = restored.listTasks();
      const unresolved = all.filter(
        (t) => !['completed', 'failed', 'cancelled'].includes(t.status)
      );
      const completed = all.filter((t) => t.status === 'completed');
      expect(unresolved).toHaveLength(3);
      expect(completed).toHaveLength(2);
    });

    it('should correctly recover mixed status tasks', () => {
      const service = IntentTaskService.getInstance();
      const t1 = service.createTask({ intent: 'Task A' });
      const t2 = service.createTask({ intent: 'Task B' });
      const t3 = service.createTask({ intent: 'Task C' });

      service.completeTask(t1.id);
      service.failTask(t2.id, 'Error occurred');
      // t3 stays classified
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      expect(restored.getTask(t1.id)!.status).toBe('completed');
      expect(restored.getTask(t2.id)!.status).toBe('failed');
      expect(restored.getTask(t2.id)!.result).toBe('Error occurred');
      expect(restored.getTask(t3.id)!.status).toBe('classified');
    });
  });

  // ===========================================================================
  // 4. Message group recovery
  // ===========================================================================

  describe('message group recovery', () => {
    it('should recover message groups after decomposeMessage + restart', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Search for abc then make it into a PDF',
      });
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const groups = restored.listMessageGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].originalMessage).toBe('Search for abc then make it into a PDF');
      expect(groups[0].totalCount).toBe(tasks.length);
    });

    it('should recover original message text for each group', () => {
      const service = IntentTaskService.getInstance();
      service.decomposeMessage({ message: 'Fix bug then deploy' });
      service.decomposeMessage({ message: 'Write docs then publish' });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const groups = restored.listMessageGroups();
      expect(groups).toHaveLength(2);
      const messages = groups.map((g) => g.originalMessage).sort();
      expect(messages).toContain('Fix bug then deploy');
      expect(messages).toContain('Write docs then publish');
    });
  });

  // ===========================================================================
  // 5. Run state recovery
  // ===========================================================================

  describe('run state recovery', () => {
    it('should recover run data after task + startRun + restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Process data' });
      const run = service.startRun(task.id, { sessionName: 'agent-1' });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.runs).toHaveLength(1);
      expect(recovered!.runs[0].id).toBe(run.id);
      expect(recovered!.runs[0].sessionName).toBe('agent-1');
      expect(recovered!.runs[0].status).toBe('running');
      expect(recovered!.status).toBe('in_progress');
    });

    it('should recover completed run with token aggregates', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Analyze results' });
      const run = service.startRun(task.id, { sessionName: 'agent-2' });
      service.recordSpan(task.id, run.id, {
        type: 'llm_call',
        label: 'analysis',
        inputTokens: 100,
        outputTokens: 50,
      });
      service.completeRun(task.id, run.id);
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered).not.toBeNull();
      expect(recovered!.runs[0].status).toBe('completed');
      expect(recovered!.runs[0].totalInputTokens).toBe(100);
      expect(recovered!.runs[0].totalOutputTokens).toBe(50);
      expect(recovered!.totalInputTokens).toBe(100);
      expect(recovered!.totalOutputTokens).toBe(50);
    });

    it('should recover assigned sessions after restart', () => {
      const service = IntentTaskService.getInstance();
      const task = service.createTask({ intent: 'Run tests' });
      service.startRun(task.id, { sessionName: 'dev-max' });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const recovered = restored.getTask(task.id);
      expect(recovered!.assignedSessions).toContain('dev-max');
    });
  });

  // ===========================================================================
  // 6. Concurrent message recovery
  // ===========================================================================

  describe('concurrent message recovery', () => {
    it('should recover all message groups from multiple decompose calls', () => {
      const service = IntentTaskService.getInstance();
      const batch1 = service.decomposeMessage({
        message: 'Fix login bug then update tests',
      });
      const batch2 = service.decomposeMessage({
        message: 'Refactor auth module then deploy',
      });
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const groups = restored.listMessageGroups();
      expect(groups).toHaveLength(2);

      const totalTasks = groups.reduce((sum, g) => sum + g.totalCount, 0);
      expect(totalTasks).toBe(batch1.length + batch2.length);
    });

    it('should maintain correct task-to-message mapping after restart', () => {
      const service = IntentTaskService.getInstance();
      const batch1 = service.decomposeMessage({
        message: 'Task A then Task B',
      });
      const batch2 = service.decomposeMessage({
        message: 'Task C then Task D',
      });
      const messageId1 = batch1[0].messageId;
      const messageId2 = batch2[0].messageId;
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const group1Tasks = restored.getTasksByMessage(messageId1);
      const group2Tasks = restored.getTasksByMessage(messageId2);
      expect(group1Tasks).toHaveLength(batch1.length);
      expect(group2Tasks).toHaveLength(batch2.length);
    });

    it('should recover completion counts per group after partial completion', () => {
      const service = IntentTaskService.getInstance();
      const tasks = service.decomposeMessage({
        message: 'Step 1 then Step 2 then Step 3',
      });
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      service.completeTask(tasks[0].id, 'Done step 1');
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      const groups = restored.listMessageGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].completedCount).toBe(1);
      expect(groups[0].totalCount).toBe(tasks.length);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle restart with no tasks (empty persistence)', () => {
      const service = IntentTaskService.getInstance();
      service.flushSync();

      simulateRestart();

      const restored = IntentTaskService.getInstance();
      expect(restored.getTaskCount()).toBe(0);
      expect(restored.listTasks()).toHaveLength(0);
      expect(restored.listMessageGroups()).toHaveLength(0);
    });

    it('should handle multiple restarts in sequence', () => {
      const service1 = IntentTaskService.getInstance();
      service1.createTask({ intent: 'First task' });
      service1.flushSync();

      simulateRestart();

      const service2 = IntentTaskService.getInstance();
      service2.createTask({ intent: 'Second task' });
      service2.flushSync();

      simulateRestart();

      const service3 = IntentTaskService.getInstance();
      expect(service3.getTaskCount()).toBe(2);
    });
  });
});
