/**
 * Tests for V3 TaskRecord type definitions and factory functions.
 *
 * @module types/v3/task-record.types.test
 */

import { createTaskRecord, createTaskEvent } from './task-record.types.js';
import type { CreateTaskRecordInput, RecordTaskEventInput } from './task-record.types.js';

describe('createTaskRecord', () => {
  it('should create a TaskRecord with default status "created"', () => {
    const input: CreateTaskRecordInput = {
      title: 'Test task',
      type: 'self_execution',
      ownerAgent: 'agent-1',
    };

    const record = createTaskRecord(input);

    expect(record.id).toBeDefined();
    expect(record.title).toBe('Test task');
    expect(record.type).toBe('self_execution');
    expect(record.ownerAgent).toBe('agent-1');
    expect(record.status).toBe('created');
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
  });

  it('should include optional fields when provided', () => {
    const input: CreateTaskRecordInput = {
      title: 'Delegated task',
      type: 'delegation',
      ownerAgent: 'agent-2',
      requestId: 'req-1',
      workItemId: 'wi-1',
      parentTaskId: 'parent-1',
      assignedBy: 'orchestrator',
      triggerId: 'trigger-1',
    };

    const record = createTaskRecord(input);

    expect(record.requestId).toBe('req-1');
    expect(record.workItemId).toBe('wi-1');
    expect(record.parentTaskId).toBe('parent-1');
    expect(record.assignedBy).toBe('orchestrator');
    expect(record.triggerId).toBe('trigger-1');
  });

  it('should generate unique IDs', () => {
    const a = createTaskRecord({ title: 'A', type: 'self_execution', ownerAgent: 'agent-1' });
    const b = createTaskRecord({ title: 'B', type: 'self_execution', ownerAgent: 'agent-1' });

    expect(a.id).not.toBe(b.id);
  });
});

describe('createTaskEvent', () => {
  it('should create a TaskEvent with timestamp', () => {
    const input: RecordTaskEventInput = {
      taskId: 'task-1',
      eventType: 'task_created',
      agentId: 'agent-1',
    };

    const event = createTaskEvent(input);

    expect(event.id).toBeDefined();
    expect(event.taskId).toBe('task-1');
    expect(event.eventType).toBe('task_created');
    expect(event.agentId).toBe('agent-1');
    expect(event.timestamp).toBeDefined();
    expect(event.payload).toEqual({});
  });

  it('should include payload when provided', () => {
    const input: RecordTaskEventInput = {
      taskId: 'task-1',
      eventType: 'skill_called',
      agentId: 'agent-1',
      payload: { skillName: 'deploy', success: true },
    };

    const event = createTaskEvent(input);

    expect(event.payload).toEqual({ skillName: 'deploy', success: true });
  });
});
