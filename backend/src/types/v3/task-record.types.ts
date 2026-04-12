/**
 * V3.1 Task Record Types
 *
 * TaskRecord = projection of agent behavior into a structured execution step.
 * Created automatically by the system, not by agents directly.
 *
 * Three-layer model:
 *   Request → TaskRecord → TaskEvent
 *
 * @module types/v3/task-record.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type TaskRecordType =
  | 'self_execution'  // Agent decided to do it themselves
  | 'delegation'      // Agent delegated to another agent
  | 'skill_call'      // Discrete skill invocation step
  | 'reconcile'       // System-initiated reconciliation task
  | 'trigger_action'; // Fired by TriggerEngine

export type TaskRecordStatus =
  | 'created'
  | 'assigned'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed';

export type TaskEventType =
  | 'task_created'
  | 'task_assigned'
  | 'task_started'
  | 'task_blocked'
  | 'task_completed'
  | 'task_failed'
  | 'skill_called'
  | 'skill_succeeded'
  | 'skill_failed'
  | 'agent_resumed'
  | 'agent_failed'
  | 'token_recorded';

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
  estimatedCostUsd?: number;
}

// ---------------------------------------------------------------------------
// TaskRecord
// ---------------------------------------------------------------------------

export interface TaskRecord {
  id: string;
  /** Parent Request this task belongs to */
  requestId?: string;
  /** Parent WorkItem ID if this was spawned from task-pool */
  workItemId?: string;
  /** Hierarchical parent TaskRecord (delegation chain) */
  parentTaskId?: string;

  title: string;
  type: TaskRecordType;
  ownerAgent: string;
  status: TaskRecordStatus;

  assignedBy?: string;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;

  /** Aggregated token usage for this task */
  tokenUsage?: TokenUsage;

  /** ID of the trigger that spawned this task (if any) */
  triggerId?: string;

  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// TaskEvent
// ---------------------------------------------------------------------------

export interface TaskEvent {
  id: string;
  taskId: string;
  eventType: TaskEventType;
  agentId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

export interface CreateTaskRecordInput {
  title: string;
  type: TaskRecordType;
  ownerAgent: string;
  requestId?: string;
  workItemId?: string;
  parentTaskId?: string;
  assignedBy?: string;
  triggerId?: string;
}

export interface UpdateTaskRecordInput {
  status?: TaskRecordStatus;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  tokenUsage?: TokenUsage;
}

export interface RecordTaskEventInput {
  taskId: string;
  eventType: TaskEventType;
  agentId: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskRecord(input: CreateTaskRecordInput): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    title: input.title,
    type: input.type,
    ownerAgent: input.ownerAgent,
    status: 'created',
    requestId: input.requestId,
    workItemId: input.workItemId,
    parentTaskId: input.parentTaskId,
    assignedBy: input.assignedBy,
    triggerId: input.triggerId,
    createdAt: now,
    updatedAt: now,
  };
}

export function createTaskEvent(input: RecordTaskEventInput): TaskEvent {
  return {
    id: uuidv4(),
    taskId: input.taskId,
    eventType: input.eventType,
    agentId: input.agentId,
    timestamp: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}
