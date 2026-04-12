/**
 * Tests for TaskProjectionService — CRUD, aggregation, and token accumulation
 * for V3 TaskRecords and TaskEvents.
 *
 * @module services/v3/task-projection.service.test
 */

import { TaskProjectionService } from './task-projection.service.js';
import type { TokenUsage, TaskRecord } from '../../types/v3/task-record.types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFiles = new Map<string, string>();

jest.mock('fs/promises', () => ({
  readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockImplementation(async (filePath: string, data: unknown) => {
    mockFiles.set(filePath, JSON.stringify(data));
  }),
  safeReadJson: jest.fn().mockImplementation(async (filePath: string, fallback: unknown) => {
    const content = mockFiles.get(filePath);
    if (!content) return fallback;
    return JSON.parse(content);
  }),
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('TaskProjectionService', () => {
  let service: TaskProjectionService;

  beforeEach(async () => {
    TaskProjectionService.resetInstance();
    mockFiles.clear();
    service = TaskProjectionService.getInstance('/tmp/test-project');
    await service.load();
  });

  afterEach(() => {
    TaskProjectionService.resetInstance();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // createRecord
  // -------------------------------------------------------------------------
  describe('createRecord', () => {
    it('should create a TaskRecord with correct defaults', async () => {
      const record = await service.createRecord({
        title: 'Implement auth',
        type: 'self_execution',
        ownerAgent: 'agent-1',
        requestId: 'req-1',
      });

      expect(record.id).toBeDefined();
      expect(record.title).toBe('Implement auth');
      expect(record.type).toBe('self_execution');
      expect(record.ownerAgent).toBe('agent-1');
      expect(record.status).toBe('created');
      expect(record.requestId).toBe('req-1');
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();
    });

    it('should emit a task_created event', async () => {
      const record = await service.createRecord({
        title: 'Test task',
        type: 'delegation',
        ownerAgent: 'agent-2',
      });

      const events = service.getEventsForTask(record.id);
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe('task_created');
      expect(events[0].agentId).toBe('agent-2');
    });

    it('should persist the record', async () => {
      await service.createRecord({
        title: 'Persistent task',
        type: 'skill_call',
        ownerAgent: 'agent-3',
      });

      // Reload and verify
      TaskProjectionService.resetInstance();
      const reloaded = TaskProjectionService.getInstance('/tmp/test-project');
      await reloaded.load();
      const records = reloaded.listRecords();
      expect(records).toHaveLength(1);
      expect(records[0].title).toBe('Persistent task');
    });

    it('should support optional fields', async () => {
      const record = await service.createRecord({
        title: 'Delegated task',
        type: 'delegation',
        ownerAgent: 'agent-1',
        workItemId: 'wi-1',
        parentTaskId: 'parent-1',
        assignedBy: 'orchestrator',
        triggerId: 'trigger-1',
      });

      expect(record.workItemId).toBe('wi-1');
      expect(record.parentTaskId).toBe('parent-1');
      expect(record.assignedBy).toBe('orchestrator');
      expect(record.triggerId).toBe('trigger-1');
    });
  });

  // -------------------------------------------------------------------------
  // updateRecord
  // -------------------------------------------------------------------------
  describe('updateRecord', () => {
    it('should update status and timestamps', async () => {
      const record = await service.createRecord({
        title: 'Update test',
        type: 'self_execution',
        ownerAgent: 'agent-1',
      });

      const originalUpdatedAt = record.updatedAt;

      // Small delay to ensure different timestamp
      await new Promise(r => setTimeout(r, 5));

      const updated = await service.updateRecord(record.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeDefined();
      expect(updated!.updatedAt).not.toBe(originalUpdatedAt);
    });

    it('should return null for non-existent record', async () => {
      const result = await service.updateRecord('nonexistent', { status: 'running' });
      expect(result).toBeNull();
    });

    it('should accumulate token usage when both exist', async () => {
      const record = await service.createRecord({
        title: 'Token test',
        type: 'skill_call',
        ownerAgent: 'agent-1',
      });

      // First token update
      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'claude' },
      });

      // Second token update — should merge
      const updated = await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, model: 'claude-2' },
      });

      expect(updated!.tokenUsage!.promptTokens).toBe(300);
      expect(updated!.tokenUsage!.completionTokens).toBe(150);
      expect(updated!.tokenUsage!.totalTokens).toBe(450);
      // Model should be from the latest update
      expect(updated!.tokenUsage!.model).toBe('claude-2');
    });

    it('should set token usage when record has none', async () => {
      const record = await service.createRecord({
        title: 'First tokens',
        type: 'skill_call',
        ownerAgent: 'agent-1',
      });

      const updated = await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      });

      expect(updated!.tokenUsage!.promptTokens).toBe(50);
      expect(updated!.tokenUsage!.completionTokens).toBe(25);
    });
  });

  // -------------------------------------------------------------------------
  // getRecord / listRecords
  // -------------------------------------------------------------------------
  describe('getRecord', () => {
    it('should return undefined for missing record', () => {
      expect(service.getRecord('missing')).toBeUndefined();
    });

    it('should return existing record', async () => {
      const created = await service.createRecord({
        title: 'Find me',
        type: 'self_execution',
        ownerAgent: 'agent-1',
      });

      const found = service.getRecord(created.id);
      expect(found).toBeDefined();
      expect(found!.title).toBe('Find me');
    });
  });

  describe('listRecords', () => {
    it('should return all records when no filter', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'r1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2', requestId: 'r2' });

      const all = service.listRecords();
      expect(all).toHaveLength(2);
    });

    it('should filter by requestId', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'r1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2', requestId: 'r2' });

      const filtered = service.listRecords({ requestId: 'r1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('A');
    });

    it('should filter by ownerAgent', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2' });

      const filtered = service.listRecords({ ownerAgent: 'agent-2' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('B');
    });

    it('should filter by status', async () => {
      const r1 = await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2' });
      await service.updateRecord(r1.id, { status: 'running' });

      const filtered = service.listRecords({ status: 'running' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('A');
    });

    it('should filter by workItemId', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1', workItemId: 'wi-1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2', workItemId: 'wi-2' });

      const filtered = service.listRecords({ workItemId: 'wi-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('A');
    });

    it('should combine multiple filters', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'r1' });
      await service.createRecord({ title: 'B', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'r2' });
      await service.createRecord({ title: 'C', type: 'delegation', ownerAgent: 'agent-2', requestId: 'r1' });

      const filtered = service.listRecords({ ownerAgent: 'agent-1', requestId: 'r1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('A');
    });
  });

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------
  describe('status transitions', () => {
    it('markAssigned should set status and emit event', async () => {
      const record = await service.createRecord({ title: 'Assign me', type: 'delegation', ownerAgent: 'agent-1' });
      await service.markAssigned(record.id, 'agent-1', 'orchestrator');

      const updated = service.getRecord(record.id);
      expect(updated!.status).toBe('assigned');
      expect(updated!.assignedAt).toBeDefined();

      const events = service.getEventsForTask(record.id);
      const assignEvent = events.find(e => e.eventType === 'task_assigned');
      expect(assignEvent).toBeDefined();
      expect(assignEvent!.payload).toEqual({ assignedBy: 'orchestrator' });
    });

    it('markStarted should set status and emit event', async () => {
      const record = await service.createRecord({ title: 'Start me', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.markStarted(record.id, 'agent-1');

      const updated = service.getRecord(record.id);
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeDefined();

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'task_started')).toBe(true);
    });

    it('markDone should set status, completedAt, and emit event', async () => {
      const record = await service.createRecord({ title: 'Finish me', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.markDone(record.id, 'agent-1');

      const updated = service.getRecord(record.id);
      expect(updated!.status).toBe('done');
      expect(updated!.completedAt).toBeDefined();

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'task_completed')).toBe(true);
    });

    it('markDone with tokenUsage should accumulate tokens', async () => {
      const record = await service.createRecord({ title: 'Token task', type: 'skill_call', ownerAgent: 'agent-1' });
      const tokens: TokenUsage = { promptTokens: 500, completionTokens: 200, totalTokens: 700, estimatedCostUsd: 0.01 };
      await service.markDone(record.id, 'agent-1', tokens);

      const updated = service.getRecord(record.id);
      expect(updated!.tokenUsage!.promptTokens).toBe(500);
      expect(updated!.tokenUsage!.estimatedCostUsd).toBe(0.01);
    });

    it('markFailed should set status, completedAt, reason, and emit event', async () => {
      const record = await service.createRecord({ title: 'Fail me', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.markFailed(record.id, 'agent-1', 'Timeout exceeded');

      const updated = service.getRecord(record.id);
      expect(updated!.status).toBe('failed');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.blockedReason).toBe('Timeout exceeded');

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'task_failed')).toBe(true);
    });

    it('markBlocked should set status, reason, and emit event', async () => {
      const record = await service.createRecord({ title: 'Block me', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.markBlocked(record.id, 'agent-1', 'Missing dependency');

      const updated = service.getRecord(record.id);
      expect(updated!.status).toBe('blocked');
      expect(updated!.blockedReason).toBe('Missing dependency');

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'task_blocked')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // recordSkillCall
  // -------------------------------------------------------------------------
  describe('recordSkillCall', () => {
    it('should record successful skill call with two events', async () => {
      const record = await service.createRecord({ title: 'Skill task', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.recordSkillCall({
        taskId: record.id,
        agentId: 'agent-1',
        skillName: 'code-review',
        success: true,
        durationMs: 1500,
      });

      const events = service.getEventsForTask(record.id);
      const skillCalled = events.find(e => e.eventType === 'skill_called');
      const skillSucceeded = events.find(e => e.eventType === 'skill_succeeded');
      expect(skillCalled).toBeDefined();
      expect(skillSucceeded).toBeDefined();
      expect(skillCalled!.payload).toMatchObject({ skillName: 'code-review', success: true });
    });

    it('should record failed skill call', async () => {
      const record = await service.createRecord({ title: 'Failing skill', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.recordSkillCall({
        taskId: record.id,
        agentId: 'agent-1',
        skillName: 'deploy',
        success: false,
        error: 'Connection refused',
      });

      const events = service.getEventsForTask(record.id);
      const skillFailed = events.find(e => e.eventType === 'skill_failed');
      expect(skillFailed).toBeDefined();
      expect(skillFailed!.payload).toMatchObject({ skillName: 'deploy', error: 'Connection refused' });
    });

    it('should accumulate token usage and emit token_recorded event', async () => {
      const record = await service.createRecord({ title: 'Token skill', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.recordSkillCall({
        taskId: record.id,
        agentId: 'agent-1',
        skillName: 'research',
        success: true,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const updated = service.getRecord(record.id);
      expect(updated!.tokenUsage!.promptTokens).toBe(100);

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'token_recorded')).toBe(true);
    });

    it('should not emit token_recorded if no tokenUsage', async () => {
      const record = await service.createRecord({ title: 'No tokens', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.recordSkillCall({
        taskId: record.id,
        agentId: 'agent-1',
        skillName: 'status-check',
        success: true,
      });

      const events = service.getEventsForTask(record.id);
      expect(events.some(e => e.eventType === 'token_recorded')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Event queries
  // -------------------------------------------------------------------------
  describe('getEventsForTask', () => {
    it('should return only events for the specified task', async () => {
      const r1 = await service.createRecord({ title: 'Task 1', type: 'self_execution', ownerAgent: 'agent-1' });
      const r2 = await service.createRecord({ title: 'Task 2', type: 'delegation', ownerAgent: 'agent-2' });

      const r1Events = service.getEventsForTask(r1.id);
      expect(r1Events).toHaveLength(1); // task_created
      expect(r1Events[0].taskId).toBe(r1.id);
    });
  });

  describe('listEvents', () => {
    it('should return all events when no filter', async () => {
      await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2' });

      const events = service.listEvents();
      expect(events.length).toBe(2);
    });

    it('should filter by eventType', async () => {
      const record = await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      await service.markStarted(record.id, 'agent-1');
      await service.markDone(record.id, 'agent-1');

      const completedEvents = service.listEvents({ eventType: 'task_completed' });
      expect(completedEvents).toHaveLength(1);
    });

    it('should respect limit', async () => {
      // Create many events
      for (let i = 0; i < 5; i++) {
        await service.createRecord({ title: `Task ${i}`, type: 'self_execution', ownerAgent: 'agent-1' });
      }

      const limited = service.listEvents(undefined, 3);
      expect(limited).toHaveLength(3);
    });

    it('should return last N events (most recent)', async () => {
      const records: TaskRecord[] = [];
      for (let i = 0; i < 5; i++) {
        records.push(await service.createRecord({ title: `Task ${i}`, type: 'self_execution', ownerAgent: 'agent-1' }));
      }

      const limited = service.listEvents(undefined, 2);
      // Should get the last 2 events (Task 3 and Task 4)
      expect(limited[0].taskId).toBe(records[3].id);
      expect(limited[1].taskId).toBe(records[4].id);
    });
  });

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------
  describe('aggregateByRequest', () => {
    it('should aggregate token usage per request', async () => {
      const r1 = await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'req-1' });
      const r2 = await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2', requestId: 'req-1' });
      const r3 = await service.createRecord({ title: 'C', type: 'skill_call', ownerAgent: 'agent-1', requestId: 'req-2' });

      await service.updateRecord(r1.id, { tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
      await service.updateRecord(r2.id, { tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } });
      await service.updateRecord(r3.id, { tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 } });

      const agg = service.aggregateByRequest();
      expect(agg['req-1'].promptTokens).toBe(300);
      expect(agg['req-1'].completionTokens).toBe(150);
      expect(agg['req-2'].promptTokens).toBe(50);
    });

    it('should skip records without requestId or tokenUsage', async () => {
      await service.createRecord({ title: 'No request', type: 'self_execution', ownerAgent: 'agent-1' });
      const r2 = await service.createRecord({ title: 'No tokens', type: 'self_execution', ownerAgent: 'agent-1', requestId: 'req-1' });

      const agg = service.aggregateByRequest();
      expect(Object.keys(agg)).toHaveLength(0);
    });
  });

  describe('aggregateByAgent', () => {
    it('should aggregate token usage per agent', async () => {
      const r1 = await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      const r2 = await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-1' });
      const r3 = await service.createRecord({ title: 'C', type: 'skill_call', ownerAgent: 'agent-2' });

      await service.updateRecord(r1.id, { tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
      await service.updateRecord(r2.id, { tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 } });
      await service.updateRecord(r3.id, { tokenUsage: { promptTokens: 75, completionTokens: 30, totalTokens: 105 } });

      const agg = service.aggregateByAgent();
      expect(agg['agent-1'].promptTokens).toBe(300);
      expect(agg['agent-2'].promptTokens).toBe(75);
    });

    it('should skip records without tokenUsage', async () => {
      await service.createRecord({ title: 'No tokens', type: 'self_execution', ownerAgent: 'agent-1' });

      const agg = service.aggregateByAgent();
      expect(Object.keys(agg)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // getSummary
  // -------------------------------------------------------------------------
  describe('getSummary', () => {
    it('should return correct counts by status, type, and agent', async () => {
      const r1 = await service.createRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
      const r2 = await service.createRecord({ title: 'B', type: 'delegation', ownerAgent: 'agent-2' });
      const r3 = await service.createRecord({ title: 'C', type: 'self_execution', ownerAgent: 'agent-1' });

      await service.updateRecord(r1.id, { status: 'running' });
      await service.updateRecord(r2.id, { status: 'done' });

      const summary = service.getSummary();
      expect(summary.total).toBe(3);
      expect(summary.byStatus['running']).toBe(1);
      expect(summary.byStatus['done']).toBe(1);
      expect(summary.byStatus['created']).toBe(1);
      expect(summary.byType['self_execution']).toBe(2);
      expect(summary.byType['delegation']).toBe(1);
      expect(summary.byAgent['agent-1']).toBe(2);
      expect(summary.byAgent['agent-2']).toBe(1);
    });

    it('should return zeroes for empty service', () => {
      const summary = service.getSummary();
      expect(summary.total).toBe(0);
      expect(summary.byStatus).toEqual({});
      expect(summary.byType).toEqual({});
      expect(summary.byAgent).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // mergeTokenUsage (tested through updateRecord)
  // -------------------------------------------------------------------------
  describe('token merging edge cases', () => {
    it('should handle undefined estimatedCostUsd gracefully', async () => {
      const record = await service.createRecord({ title: 'Cost test', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      });

      const updated = service.getRecord(record.id);
      // undefined + undefined should remain undefined
      expect(updated!.tokenUsage!.estimatedCostUsd).toBeUndefined();
    });

    it('should accumulate estimatedCostUsd when both present', async () => {
      const record = await service.createRecord({ title: 'Cost test 2', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, estimatedCostUsd: 0.005 },
      });
      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300, estimatedCostUsd: 0.01 },
      });

      const updated = service.getRecord(record.id);
      expect(updated!.tokenUsage!.estimatedCostUsd).toBeCloseTo(0.015);
    });

    it('should prefer latest model name', async () => {
      const record = await service.createRecord({ title: 'Model test', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'claude-3' },
      });
      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75, model: 'claude-4' },
      });

      const updated = service.getRecord(record.id);
      expect(updated!.tokenUsage!.model).toBe('claude-4');
    });

    it('should keep first model when second is undefined', async () => {
      const record = await service.createRecord({ title: 'Model fallback', type: 'skill_call', ownerAgent: 'agent-1' });

      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, model: 'claude-3' },
      });
      await service.updateRecord(record.id, {
        tokenUsage: { promptTokens: 50, completionTokens: 25, totalTokens: 75 },
      });

      const updated = service.getRecord(record.id);
      expect(updated!.tokenUsage!.model).toBe('claude-3');
    });
  });

  // -------------------------------------------------------------------------
  // Event trimming
  // -------------------------------------------------------------------------
  describe('event trimming', () => {
    it('should persist events after appending', async () => {
      await service.createRecord({ title: 'Event test', type: 'self_execution', ownerAgent: 'agent-1' });

      // Reload and verify events persisted
      TaskProjectionService.resetInstance();
      const reloaded = TaskProjectionService.getInstance('/tmp/test-project');
      await reloaded.load();
      const events = reloaded.listEvents();
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------
  describe('singleton', () => {
    it('should return same instance on multiple calls', () => {
      const a = TaskProjectionService.getInstance('/tmp/test');
      const b = TaskProjectionService.getInstance();
      expect(a).toBe(b);
    });

    it('should reset instance', () => {
      const a = TaskProjectionService.getInstance('/tmp/test');
      TaskProjectionService.resetInstance();
      const b = TaskProjectionService.getInstance('/tmp/test2');
      expect(a).not.toBe(b);
    });
  });
});
