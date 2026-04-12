/**
 * Task Projection Service (V3.1)
 *
 * Projects agent behavior into structured TaskRecord + TaskEvent entries.
 * The system automatically calls this — agents do not create TaskRecords directly.
 *
 * Responsibilities:
 * - CRUD for TaskRecords and TaskEvents
 * - Aggregation (per request, per agent, per skill)
 * - Token/cost accumulation
 * - Persistence to ~/.crewly/task-records/
 *
 * @module services/v3/task-projection.service
 */

import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ensureDir, atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import {
  type TaskRecord,
  type TaskEvent,
  type CreateTaskRecordInput,
  type UpdateTaskRecordInput,
  type RecordTaskEventInput,
  type TokenUsage,
  createTaskRecord,
  createTaskEvent,
} from '../../types/v3/task-record.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECORDS_DIR = 'task-records';
const RECORDS_FILE = 'records.json';
const EVENTS_FILE = 'events.json';

/** Keep at most this many events in memory/disk to avoid unbounded growth */
const MAX_EVENTS = 10_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TaskProjectionService {
  private static instance: TaskProjectionService | null = null;

  private readonly logger: ComponentLogger;
  private readonly recordsDir: string;
  private readonly recordsFile: string;
  private readonly eventsFile: string;

  private records: Map<string, TaskRecord> = new Map();
  private events: TaskEvent[] = [];

  private constructor(projectPath: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('TaskProjection');
    this.recordsDir = path.join(projectPath, '.crewly', RECORDS_DIR);
    this.recordsFile = path.join(this.recordsDir, RECORDS_FILE);
    this.eventsFile = path.join(this.recordsDir, EVENTS_FILE);
  }

  public static getInstance(projectPath?: string): TaskProjectionService {
    if (!TaskProjectionService.instance) {
      const p = projectPath || process.env.CREWLY_PROJECT_PATH || process.cwd();
      TaskProjectionService.instance = new TaskProjectionService(p);
    }
    return TaskProjectionService.instance;
  }

  public static resetInstance(): void {
    TaskProjectionService.instance = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  public async load(): Promise<void> {
    await ensureDir(this.recordsDir);
    const records = await safeReadJson<TaskRecord[]>(this.recordsFile, []);
    this.records.clear();
    for (const r of records) this.records.set(r.id, r);
    this.events = await safeReadJson<TaskEvent[]>(this.eventsFile, []);
    this.logger.info('TaskProjection loaded', { records: this.records.size, events: this.events.length });
  }

  // ---------------------------------------------------------------------------
  // TaskRecord CRUD
  // ---------------------------------------------------------------------------

  /**
   * Creates a new TaskRecord and emits a task_created event.
   *
   * @param input - Creation parameters
   * @returns The created TaskRecord
   */
  public async createRecord(input: CreateTaskRecordInput): Promise<TaskRecord> {
    const record = createTaskRecord(input);
    this.records.set(record.id, record);

    await this.appendEvent({
      taskId: record.id,
      eventType: 'task_created',
      agentId: input.ownerAgent,
      payload: { title: input.title, type: input.type, requestId: input.requestId },
    });

    await this.persistRecords();
    this.logger.info('TaskRecord created', { id: record.id, type: input.type, agent: input.ownerAgent });
    return record;
  }

  /**
   * Updates a TaskRecord's status and timestamps.
   *
   * @param id - TaskRecord ID
   * @param updates - Fields to update
   * @returns Updated TaskRecord or null if not found
   */
  public async updateRecord(id: string, updates: UpdateTaskRecordInput): Promise<TaskRecord | null> {
    const record = this.records.get(id);
    if (!record) return null;

    const now = new Date().toISOString();

    // Save existing token usage before Object.assign overwrites it
    const existingTokenUsage = record.tokenUsage;

    Object.assign(record, updates, { updatedAt: now });

    // Accumulate token usage (merge old + new instead of replacing)
    if (updates.tokenUsage && existingTokenUsage) {
      record.tokenUsage = mergeTokenUsage(existingTokenUsage, updates.tokenUsage);
    }

    await this.persistRecords();
    return record;
  }

  /**
   * Gets a TaskRecord by ID.
   */
  public getRecord(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  /**
   * Lists TaskRecords, optionally filtered by requestId, ownerAgent, status, or workItemId.
   */
  public listRecords(filter?: { requestId?: string; ownerAgent?: string; status?: string; workItemId?: string }): TaskRecord[] {
    const all = Array.from(this.records.values());
    if (!filter) return all;
    return all.filter((r) => {
      if (filter.requestId && r.requestId !== filter.requestId) return false;
      if (filter.ownerAgent && r.ownerAgent !== filter.ownerAgent) return false;
      if (filter.status && r.status !== filter.status) return false;
      if (filter.workItemId && r.workItemId !== filter.workItemId) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Convenience Status Transitions
  // ---------------------------------------------------------------------------

  /**
   * Marks a task as assigned to an agent.
   */
  public async markAssigned(taskId: string, agentId: string, assignedBy?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.updateRecord(taskId, { status: 'assigned', assignedAt: now });
    await this.appendEvent({ taskId, eventType: 'task_assigned', agentId, payload: { assignedBy } });
  }

  /**
   * Marks a task as started/running.
   */
  public async markStarted(taskId: string, agentId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.updateRecord(taskId, { status: 'running', startedAt: now });
    await this.appendEvent({ taskId, eventType: 'task_started', agentId, payload: {} });
  }

  /**
   * Marks a task as completed. Triggers async token roll-up to parent Request if applicable.
   */
  public async markDone(taskId: string, agentId: string, tokenUsage?: TokenUsage): Promise<void> {
    const now = new Date().toISOString();
    await this.updateRecord(taskId, { status: 'done', completedAt: now, tokenUsage });
    await this.appendEvent({ taskId, eventType: 'task_completed', agentId, payload: { tokenUsage } });

    // Async roll-up: accumulate tokens on the parent Request (non-blocking)
    if (tokenUsage) {
      const record = this.records.get(taskId);
      if (record?.requestId) {
        this.rollUpToRequest(record.requestId, tokenUsage);
      }
    }
  }

  /**
   * Asynchronously rolls up token usage from a completed task to its parent Request.
   * Errors are swallowed — this must never block agent-facing operations.
   *
   * @param requestId - Parent Request ID
   * @param tokenUsage - Token counts from the completed task
   */
  private rollUpToRequest(requestId: string, tokenUsage: TokenUsage): void {
    setImmediate(async () => {
      try {
        const { RequestService } = await import('./request.service.js');
        const svc = RequestService.getInstance();
        const request = await svc.getById(requestId);
        if (!request) return;
        await svc.update(requestId, {
          totalInputTokens: (request.totalInputTokens || 0) + (tokenUsage.promptTokens || 0),
          totalOutputTokens: (request.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0),
          totalCost: (request.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0),
        });
        this.logger.debug('Token roll-up to request complete', { requestId });

        // Cascade to Mission if applicable
        if (request.missionId && tokenUsage.estimatedCostUsd) {
          setImmediate(async () => {
            try {
              const { _loadMission, _saveMission } = await import('../../controllers/mission/mission-policy.controller.js');
              const mission = await _loadMission(request.missionId!);
              if (!mission) return;
              mission.totalInputTokens = (mission.totalInputTokens || 0) + (tokenUsage.promptTokens || 0);
              mission.totalOutputTokens = (mission.totalOutputTokens || 0) + (tokenUsage.completionTokens || 0);
              mission.totalCost = (mission.totalCost || 0) + (tokenUsage.estimatedCostUsd || 0);
              mission.updatedAt = new Date().toISOString();
              await _saveMission(mission);
              this.logger.debug('Token roll-up to mission complete', { missionId: request.missionId });
            } catch (err) {
              this.logger.debug('Mission token roll-up failed (non-fatal)', {
                missionId: request.missionId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          });
        }
      } catch (err) {
        this.logger.debug('Request token roll-up failed (non-fatal)', {
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /**
   * Marks a task as failed.
   */
  public async markFailed(taskId: string, agentId: string, reason?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.updateRecord(taskId, { status: 'failed', completedAt: now, blockedReason: reason });
    await this.appendEvent({ taskId, eventType: 'task_failed', agentId, payload: { reason } });
  }

  /**
   * Marks a task as blocked.
   */
  public async markBlocked(taskId: string, agentId: string, reason?: string): Promise<void> {
    await this.updateRecord(taskId, { status: 'blocked', blockedReason: reason });
    await this.appendEvent({ taskId, eventType: 'task_blocked', agentId, payload: { reason } });
  }

  // ---------------------------------------------------------------------------
  // Skill Execution Projection
  // ---------------------------------------------------------------------------

  /**
   * Records a skill invocation (called/succeeded/failed).
   */
  public async recordSkillCall(params: {
    taskId: string;
    agentId: string;
    skillName: string;
    success: boolean;
    tokenUsage?: TokenUsage;
    durationMs?: number;
    error?: string;
  }): Promise<void> {
    const { taskId, agentId, skillName, success, tokenUsage, durationMs, error } = params;

    await this.appendEvent({
      taskId,
      eventType: 'skill_called',
      agentId,
      payload: { skillName, success, durationMs },
    });

    await this.appendEvent({
      taskId,
      eventType: success ? 'skill_succeeded' : 'skill_failed',
      agentId,
      payload: { skillName, error, tokenUsage },
    });

    if (tokenUsage) {
      await this.updateRecord(taskId, { tokenUsage });
      await this.appendEvent({
        taskId,
        eventType: 'token_recorded',
        agentId,
        payload: { skillName, tokenUsage },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // TaskEvent
  // ---------------------------------------------------------------------------

  /**
   * Gets all events for a specific task.
   */
  public getEventsForTask(taskId: string): TaskEvent[] {
    return this.events.filter((e) => e.taskId === taskId);
  }

  /**
   * Lists recent events, optionally filtered by taskId.
   */
  public listEvents(filter?: { taskId?: string; eventType?: string }, limit = 200): TaskEvent[] {
    let result = this.events;
    if (filter?.taskId) result = result.filter((e) => e.taskId === filter.taskId);
    if (filter?.eventType) result = result.filter((e) => e.eventType === filter.eventType);
    return result.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // Aggregation
  // ---------------------------------------------------------------------------

  /**
   * Returns token usage aggregated per request.
   */
  public aggregateByRequest(): Record<string, TokenUsage> {
    const result: Record<string, TokenUsage> = {};
    for (const record of this.records.values()) {
      if (!record.requestId || !record.tokenUsage) continue;
      if (!result[record.requestId]) {
        result[record.requestId] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      }
      result[record.requestId] = mergeTokenUsage(result[record.requestId], record.tokenUsage);
    }
    return result;
  }

  /**
   * Returns token usage aggregated per agent.
   */
  public aggregateByAgent(): Record<string, TokenUsage> {
    const result: Record<string, TokenUsage> = {};
    for (const record of this.records.values()) {
      if (!record.tokenUsage) continue;
      if (!result[record.ownerAgent]) {
        result[record.ownerAgent] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      }
      result[record.ownerAgent] = mergeTokenUsage(result[record.ownerAgent], record.tokenUsage);
    }
    return result;
  }

  /**
   * Returns a summary of task counts by status.
   */
  public getSummary(): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byAgent: Record<string, number>;
  } {
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byAgent: Record<string, number> = {};

    for (const r of this.records.values()) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      byType[r.type] = (byType[r.type] || 0) + 1;
      byAgent[r.ownerAgent] = (byAgent[r.ownerAgent] || 0) + 1;
    }

    return { total: this.records.size, byStatus, byType, byAgent };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async persistRecords(): Promise<void> {
    await ensureDir(this.recordsDir);
    await atomicWriteJson(this.recordsFile, Array.from(this.records.values()));
  }

  private async persistEvents(): Promise<void> {
    await ensureDir(this.recordsDir);
    // Trim to keep max events
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
    await atomicWriteJson(this.eventsFile, this.events);
  }

  private async appendEvent(input: RecordTaskEventInput): Promise<void> {
    const event = createTaskEvent(input);
    this.events.push(event);
    await this.persistEvents();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    model: b.model || a.model,
    estimatedCostUsd: ((a.estimatedCostUsd || 0) + (b.estimatedCostUsd || 0)) || undefined,
  };
}
