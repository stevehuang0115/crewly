/**
 * Intent Task Service — V2
 *
 * Manages the lifecycle of intent-based tasks with multi-intent decomposition:
 * - Decomposition: One chat message -> multiple intent tasks
 * - Intent Layer: classification, status management
 * - Execution Layer: Task -> Run -> Span tracking
 * - Association Layer: Schedule follow-up and project task linkage
 *
 * Integrates with TokenUsageService for per-task/run token tracking.
 *
 * @module services/intent-task/intent-task.service
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import {
  type IntentTask,
  type TaskRun,
  type TaskSpan,
  type IntentTaskStatus,
  type RunStatus,
  type IntentTaskSummary,
  type CreateIntentTaskInput,
  type UpdateIntentTaskInput,
  type StartRunInput,
  type RecordSpanInput,
  type DecomposeMessageInput,
  type DecomposeResult,
  type MessageGroup,
  type ProjectTaskStatus,
  classifyIntentLevel,
  classifyIntentCategory,
  decomposeIntents,
} from '../../types/intent-task.types.js';
import { TokenUsageService, calculateCost } from '../monitoring/token-usage.service.js';

// =============================================================================
// Constants
// =============================================================================

/** Maximum intent length shown in summaries before truncation */
const SUMMARY_INTENT_MAX_LENGTH = 120;

/** Terminal task statuses that set completedAt */
const TERMINAL_STATUSES: IntentTaskStatus[] = ['completed', 'failed', 'cancelled'];

/** Default persistence file path */
const DEFAULT_PERSISTENCE_PATH = join(homedir(), '.crewly', 'data', 'intent-tasks.json');

/** Debounce delay for file writes in milliseconds */
const SAVE_DEBOUNCE_MS = 300;

// =============================================================================
// Persistence Types
// =============================================================================

/**
 * Shape of the persisted JSON file for intent tasks and message texts.
 */
interface PersistedData {
  /** Version for future schema migrations */
  version: number;
  /** Serialized tasks array */
  tasks: IntentTask[];
  /** Serialized messageTexts entries */
  messageTexts: Array<[string, string]>;
}

// =============================================================================
// Service
// =============================================================================

/**
 * Service for creating, tracking, and managing intent-based tasks.
 *
 * V2 supports multi-intent decomposition: one chat message produces multiple
 * tasks grouped by messageId, displayed as a todo list.
 *
 * Uses in-memory storage with the Task -> Run -> Span execution model.
 * Token usage is bound to task_id + run_id via TokenUsageService integration.
 *
 * @example
 * ```typescript
 * const service = IntentTaskService.getInstance();
 * // Decompose a message into multiple tasks
 * const tasks = service.decomposeMessage({
 *   message: 'Search for abc then make it into a PDF'
 * });
 * // Each task can be worked on independently
 * const run = service.startRun(tasks[0].id, { sessionName: 'crewly-orc' });
 * service.completeRun(tasks[0].id, run.id);
 * service.completeTask(tasks[0].id, 'Found results');
 * ```
 */
export class IntentTaskService {
  private static instance: IntentTaskService | null = null;

  /** In-memory task storage keyed by task ID */
  private readonly tasks: Map<string, IntentTask> = new Map();

  /** Maps messageId to original message text for reconstruction */
  private readonly messageTexts: Map<string, string> = new Map();

  /** File path for JSON persistence */
  private readonly persistencePath: string;

  /** Timer handle for debounced save */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param persistencePath - Override file path (used in tests to avoid touching real data)
   */
  constructor(persistencePath?: string) {
    this.persistencePath = persistencePath ?? DEFAULT_PERSISTENCE_PATH;
    this.loadFromDisk();
  }

  /** Override persistence path for the next getInstance() call (testing only) */
  private static overridePath: string | undefined;

  /**
   * Get the singleton instance.
   *
   * @returns Shared IntentTaskService instance
   */
  static getInstance(): IntentTaskService {
    if (!IntentTaskService.instance) {
      IntentTaskService.instance = new IntentTaskService(IntentTaskService.overridePath);
    }
    return IntentTaskService.instance;
  }

  /**
   * Reset the singleton (for testing).
   * Flushes any pending writes before discarding.
   */
  static resetInstance(): void {
    if (IntentTaskService.instance) {
      IntentTaskService.instance.flushSync();
    }
    IntentTaskService.instance = null;
  }

  /**
   * Set a custom persistence path for the next getInstance() call.
   * Pass undefined to reset to default path.
   * Used in tests to isolate from real user data.
   *
   * @param path - Custom file path, or undefined for default
   */
  static setPersistencePath(path: string | undefined): void {
    IntentTaskService.overridePath = path;
  }

  // ===========================================================================
  // Persistence — Load / Save
  // ===========================================================================

  /**
   * Load tasks and messageTexts from the JSON persistence file.
   * Called once in the constructor. Silently starts empty if file is missing or corrupt.
   */
  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistencePath)) {
        return;
      }
      const raw = readFileSync(this.persistencePath, 'utf-8');
      const data: PersistedData = JSON.parse(raw);

      if (!data || typeof data.version !== 'number') {
        return;
      }

      if (Array.isArray(data.tasks)) {
        for (const task of data.tasks) {
          this.tasks.set(task.id, task);
        }
      }

      if (Array.isArray(data.messageTexts)) {
        for (const [key, value] of data.messageTexts) {
          this.messageTexts.set(key, value);
        }
      }
    } catch {
      // File missing, corrupt, or unreadable — start fresh
    }
  }

  /**
   * Schedule a debounced write to disk.
   * Coalesces rapid mutations into a single file write after SAVE_DEBOUNCE_MS.
   */
  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveToDisk();
      this.saveTimer = null;
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Immediately write current state to disk.
   * Creates parent directories if they don't exist.
   */
  private saveToDisk(): void {
    try {
      const dir = dirname(this.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: PersistedData = {
        version: 1,
        tasks: Array.from(this.tasks.values()),
        messageTexts: Array.from(this.messageTexts.entries()),
      };

      writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Swallow write errors — data still in memory, will retry on next mutation
    }
  }

  /**
   * Flush any pending debounced writes immediately.
   * Called before instance teardown and useful in tests.
   */
  flushSync(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  // ===========================================================================
  // Message Decomposition
  // ===========================================================================

  /**
   * Decompose a user message into multiple intent tasks.
   *
   * Splits the message using heuristic patterns, classifies each intent,
   * and creates individual tasks grouped by a shared messageId.
   *
   * @param input - The message to decompose and optional metadata
   * @returns Array of created IntentTasks
   */
  decomposeMessage(input: DecomposeMessageInput): IntentTask[] {
    const result = decomposeIntents(input.message);
    const messageId = randomUUID();

    // Store original message for later retrieval
    this.messageTexts.set(messageId, input.message);

    const tasks: IntentTask[] = result.intents.map((decomposed, index) =>
      this.createTask({
        intent: decomposed.intent,
        messageId,
        level: decomposed.level,
        category: decomposed.category,
        projectTaskId: input.projectTaskId,
        tags: input.tags,
        order: index,
      })
    );

    // Auto-schedule follow-ups if requested
    if (input.autoSchedule) {
      import('./intent-task-follow-up.service.js').then(({ IntentTaskFollowUpService }) => {
        const followUpService = IntentTaskFollowUpService.getInstance();
        for (const task of tasks) {
          try {
            followUpService.scheduleFollowUp(task.id);
          } catch {
            // Best-effort — don't fail decomposition if follow-up scheduling fails
          }
        }
      }).catch(() => {
        // Follow-up service not available
      });
    }

    return tasks;
  }

  // ===========================================================================
  // Task CRUD
  // ===========================================================================

  /**
   * Create a new intent task.
   *
   * Auto-classifies level and category if not provided.
   * Generates a messageId if not supplied (for single-task creation).
   *
   * @param input - Task creation input
   * @returns The created IntentTask
   */
  createTask(input: CreateIntentTaskInput): IntentTask {
    const now = new Date().toISOString();
    const level = input.level ?? classifyIntentLevel(input.intent);
    const category = input.category ?? classifyIntentCategory(input.intent);
    const messageId = input.messageId ?? randomUUID();

    const task: IntentTask = {
      id: randomUUID(),
      messageId,
      intent: input.intent,
      level,
      category,
      status: 'classified',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      assignedSessions: [],
      runs: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalSkillCost: 0,
      parentTaskId: input.parentTaskId,
      tags: input.tags,
      scheduleId: input.scheduleId,
      projectTaskId: input.projectTaskId,
      order: input.order ?? 0,
    };

    this.tasks.set(task.id, task);

    // Store message text for single-task creation if not already stored
    if (!this.messageTexts.has(messageId)) {
      this.messageTexts.set(messageId, input.intent);
    }

    this.scheduleSave();
    return task;
  }

  /**
   * Get a task by ID.
   *
   * @param taskId - Task identifier
   * @returns The task, or null if not found
   */
  getTask(taskId: string): IntentTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /**
   * List all tasks, optionally filtered by status.
   *
   * @param status - Optional status filter
   * @returns Array of tasks sorted by updatedAt descending
   */
  listTasks(status?: IntentTaskStatus): IntentTask[] {
    let tasks = Array.from(this.tasks.values());
    if (status) {
      tasks = tasks.filter((t) => t.status === status);
    }
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * List task summaries for UI display.
   *
   * @param status - Optional status filter
   * @returns Array of task summaries
   */
  listTaskSummaries(status?: IntentTaskStatus): IntentTaskSummary[] {
    return this.listTasks(status).map((task) => this.toSummary(task));
  }

  /**
   * Update a task's status and/or metadata.
   *
   * When a task completes, this method also handles schedule cancellation
   * (clears scheduleId on terminal statuses).
   *
   * @param taskId - Task identifier
   * @param input - Fields to update
   * @returns The updated task
   * @throws Error if task not found
   */
  updateTask(taskId: string, input: UpdateIntentTaskInput): IntentTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (input.status) {
      task.status = input.status;
      if (TERMINAL_STATUSES.includes(input.status)) {
        task.completedAt = new Date().toISOString();
        // Clear schedule association on terminal status
        task.scheduleId = undefined;
      }
    }

    if (input.result !== undefined) {
      task.result = input.result;
    }

    if (input.assignedSessions) {
      for (const session of input.assignedSessions) {
        if (!task.assignedSessions.includes(session)) {
          task.assignedSessions.push(session);
        }
      }
    }

    if ('scheduleId' in input) {
      task.scheduleId = input.scheduleId;
    }

    task.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return task;
  }

  /**
   * Convenience: mark a task as completed with an optional result summary.
   * Clears scheduleId automatically and cancels any follow-up schedule.
   *
   * @param taskId - Task identifier
   * @param result - Optional result summary
   * @returns The updated task
   */
  completeTask(taskId: string, result?: string): IntentTask {
    this.cancelFollowUpIfExists(taskId);
    return this.updateTask(taskId, { status: 'completed', result });
  }

  /**
   * Convenience: mark a task as failed.
   * Clears scheduleId automatically and cancels any follow-up schedule.
   *
   * @param taskId - Task identifier
   * @param result - Optional error description
   * @returns The updated task
   */
  failTask(taskId: string, result?: string): IntentTask {
    this.cancelFollowUpIfExists(taskId);
    return this.updateTask(taskId, { status: 'failed', result });
  }

  /**
   * Delete a task by ID.
   *
   * @param taskId - Task identifier
   * @returns True if deleted, false if not found
   */
  deleteTask(taskId: string): boolean {
    const deleted = this.tasks.delete(taskId);
    if (deleted) {
      this.scheduleSave();
    }
    return deleted;
  }

  // ===========================================================================
  // Message Group Queries
  // ===========================================================================

  /**
   * List tasks grouped by messageId, forming todo-list style groups.
   *
   * Each group represents one original chat message with its decomposed tasks.
   * Groups are sorted by creation time (newest first).
   *
   * When a status filter is provided, only groups containing at least one task
   * with that status are returned. The originalMessage is always preserved from
   * the stored messageTexts map (never rebuilt from filtered intents).
   *
   * @param status - Optional status filter; only groups with matching tasks are returned
   * @returns Array of MessageGroup objects
   */
  listMessageGroups(status?: IntentTaskStatus): MessageGroup[] {
    const groupMap = new Map<string, IntentTask[]>();

    for (const task of this.tasks.values()) {
      // When filtering, skip tasks that don't match the status
      if (status && task.status !== status) {
        continue;
      }
      const existing = groupMap.get(task.messageId) ?? [];
      existing.push(task);
      groupMap.set(task.messageId, existing);
    }

    const groups: MessageGroup[] = [];
    for (const [messageId, tasks] of groupMap) {
      // Sort tasks within group by order
      tasks.sort((a, b) => a.order - b.order);

      const completedCount = tasks.filter((t) =>
        TERMINAL_STATUSES.includes(t.status)
      ).length;

      const earliestCreatedAt = tasks
        .map((t) => t.createdAt)
        .sort()[0] ?? new Date().toISOString();

      groups.push({
        messageId,
        originalMessage: this.messageTexts.get(messageId) ?? tasks.map((t) => t.intent).join(', '),
        createdAt: earliestCreatedAt,
        tasks: tasks.map((t) => this.toSummary(t)),
        completedCount,
        totalCount: tasks.length,
      });
    }

    // Sort groups by createdAt descending (newest first)
    return groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Get tasks for a specific message ID.
   *
   * @param messageId - Message identifier
   * @returns Array of tasks belonging to this message, sorted by order
   */
  getTasksByMessage(messageId: string): IntentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.messageId === messageId)
      .sort((a, b) => a.order - b.order);
  }

  // ===========================================================================
  // Project Task Association
  // ===========================================================================

  /**
   * Get the completion status of a project task based on its linked intent tasks.
   *
   * @param projectTaskId - The project task ID from .crewly/tasks/
   * @returns ProjectTaskStatus with completion counts, or null if no tasks linked
   */
  getProjectTaskStatus(projectTaskId: string): ProjectTaskStatus | null {
    const linkedTasks = Array.from(this.tasks.values())
      .filter((t) => t.projectTaskId === projectTaskId);

    if (linkedTasks.length === 0) {
      return null;
    }

    const completedTasks = linkedTasks.filter((t) => t.status === 'completed').length;

    return {
      projectTaskId,
      totalTasks: linkedTasks.length,
      completedTasks,
      allCompleted: completedTasks === linkedTasks.length,
      tasks: linkedTasks.map((t) => this.toSummary(t)),
    };
  }

  // ===========================================================================
  // Schedule Association
  // ===========================================================================

  /**
   * Associate a schedule with a task for automatic follow-up.
   *
   * @param taskId - Task identifier
   * @param scheduleId - Schedule identifier to associate
   * @returns The updated task
   * @throws Error if task not found
   */
  setSchedule(taskId: string, scheduleId: string): IntentTask {
    return this.updateTask(taskId, { scheduleId });
  }

  /**
   * Get the schedule ID associated with a task.
   *
   * @param taskId - Task identifier
   * @returns The schedule ID, or undefined if none
   */
  getScheduleId(taskId: string): string | undefined {
    return this.tasks.get(taskId)?.scheduleId;
  }

  // ===========================================================================
  // Run Management
  // ===========================================================================

  /**
   * Start a new run for a task.
   *
   * Sets the task to in_progress and binds token tracking via TokenUsageService.
   *
   * @param taskId - Task identifier
   * @param input - Run creation input (sessionName)
   * @returns The created TaskRun
   * @throws Error if task not found
   */
  startRun(taskId: string, input: StartRunInput): TaskRun {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const now = new Date().toISOString();
    const run: TaskRun = {
      id: randomUUID(),
      taskId,
      runNumber: task.runs.length + 1,
      sessionName: input.sessionName,
      status: 'running',
      startedAt: now,
      endedAt: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cost: 0,
      skillCost: 0,
      spans: [],
    };

    task.runs.push(run);
    task.status = 'in_progress';
    task.updatedAt = now;

    // Add session to assignedSessions
    if (!task.assignedSessions.includes(input.sessionName)) {
      task.assignedSessions.push(input.sessionName);
    }

    // Bind token tracking context with runId for precise run-level attribution
    TokenUsageService.getInstance().setTaskContext(input.sessionName, taskId, run.id);

    this.scheduleSave();
    return run;
  }

  /**
   * Complete a run, aggregating token totals.
   *
   * @param taskId - Task identifier
   * @param runId - Run identifier
   * @returns The completed run
   * @throws Error if task or run not found
   */
  completeRun(taskId: string, runId: string): TaskRun {
    return this.finishRun(taskId, runId, 'completed');
  }

  /**
   * Fail a run with an optional error message.
   *
   * @param taskId - Task identifier
   * @param runId - Run identifier
   * @param error - Optional error message
   * @returns The failed run
   * @throws Error if task or run not found
   */
  failRun(taskId: string, runId: string, error?: string): TaskRun {
    return this.finishRun(taskId, runId, 'failed', error);
  }

  /**
   * Get a specific run.
   *
   * @param taskId - Task identifier
   * @param runId - Run identifier
   * @returns The run, or null if not found
   */
  getRun(taskId: string, runId: string): TaskRun | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return task.runs.find((r) => r.id === runId) ?? null;
  }

  // ===========================================================================
  // Span Recording
  // ===========================================================================

  /**
   * Record a completed span within a run.
   *
   * Automatically updates run and task token aggregates.
   * For skill_call spans, use costOverride to record non-token costs.
   * Validates that the runId matches the current token tracking context.
   *
   * @param taskId - Task identifier
   * @param runId - Run identifier
   * @param input - Span data (supports costOverride for skill costs)
   * @returns The recorded span
   * @throws Error if task or run not found, run is not running, or runId mismatch
   */
  recordSpan(taskId: string, runId: string, input: RecordSpanInput): TaskSpan {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const run = task.runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (run.status !== 'running') {
      throw new Error(`Run ${runId} is not in running state (current: ${run.status})`);
    }

    // Validate runId matches token tracking context (if context is set)
    const runContext = TokenUsageService.getInstance().getRunContext(run.sessionName);
    if (runContext && runContext.runId && runContext.runId !== runId) {
      throw new Error(`Run ID mismatch: expected ${runContext.runId}, got ${runId}`);
    }

    const now = new Date().toISOString();
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const durationMs = input.durationMs ?? null;

    const span: TaskSpan = {
      id: randomUUID(),
      runId,
      type: input.type,
      label: input.label,
      startedAt: durationMs !== null
        ? new Date(Date.now() - durationMs).toISOString()
        : now,
      endedAt: now,
      durationMs,
      inputTokens,
      outputTokens,
      costOverride: input.costOverride,
      metadata: input.metadata,
    };

    run.spans.push(span);

    // Aggregate tokens to run level
    run.totalInputTokens += inputTokens;
    run.totalOutputTokens += outputTokens;

    // Compute cost: use costOverride for skill spans, token-based for LLM spans
    if (input.costOverride !== undefined && input.costOverride > 0) {
      // Skill cost — direct cost override (API calls, browser automation, etc.)
      run.skillCost += input.costOverride;
      task.totalSkillCost += input.costOverride;
    } else {
      // LLM cost — computed from token counts
      const model = (input.metadata?.model as string) ?? 'default';
      const spanCost = calculateCost(inputTokens, outputTokens, model);
      run.cost += spanCost;
      task.totalCost += spanCost;
    }

    // Aggregate tokens to task level (regardless of cost type)
    task.totalInputTokens += inputTokens;
    task.totalOutputTokens += outputTokens;
    task.updatedAt = now;

    this.scheduleSave();
    return span;
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get aggregate statistics across all tasks.
   *
   * @returns Object with counts and token totals
   */
  getStatistics(): {
    totalTasks: number;
    byStatus: Record<string, number>;
    byLevel: Record<string, number>;
    totalTokens: number;
    totalCost: number;
    llmCost: number;
    skillCost: number;
    totalMessages: number;
  } {
    const byStatus: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    const messageIds = new Set<string>();
    let totalTokens = 0;
    let llmCost = 0;
    let skillCost = 0;

    for (const task of this.tasks.values()) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      byLevel[task.level] = (byLevel[task.level] ?? 0) + 1;
      totalTokens += task.totalInputTokens + task.totalOutputTokens;
      llmCost += task.totalCost;
      skillCost += task.totalSkillCost;
      messageIds.add(task.messageId);
    }

    return {
      totalTasks: this.tasks.size,
      byStatus,
      byLevel,
      totalTokens,
      totalCost: llmCost + skillCost,
      llmCost,
      skillCost,
      totalMessages: messageIds.size,
    };
  }

  /**
   * Get the total number of tasks (for testing).
   *
   * @returns Number of tasks
   */
  getTaskCount(): number {
    return this.tasks.size;
  }

  // ===========================================================================
  // Unresolved Tasks
  // ===========================================================================

  /**
   * Get all unresolved tasks (status is not terminal: completed, failed, cancelled).
   *
   * Useful for follow-up scheduling and dashboard displays of tasks
   * that still need attention.
   *
   * @returns Array of tasks with non-terminal statuses, sorted by updatedAt descending
   */
  getUnresolvedTasks(): IntentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => !TERMINAL_STATUSES.includes(t.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Cancel follow-up schedule if the task has one.
   * Lazily imports IntentTaskFollowUpService to avoid circular dependency.
   *
   * @param taskId - Task identifier
   */
  private cancelFollowUpIfExists(taskId: string): void {
    try {
      const task = this.tasks.get(taskId);
      if (task?.scheduleId) {
        // Lazy import to avoid circular dependency
        import('./intent-task-follow-up.service.js').then(({ IntentTaskFollowUpService }) => {
          IntentTaskFollowUpService.getInstance().cancelFollowUp(taskId);
        }).catch(() => {
          // Follow-up service not available — that's okay, scheduleId is still cleared in updateTask
        });
      }
    } catch {
      // Swallow errors — follow-up cancellation is best-effort
    }
  }

  /**
   * Convert an IntentTask to an IntentTaskSummary for UI display.
   *
   * Includes originalMessage from the messageTexts map so that filtered
   * flat-list views preserve the user's original input context.
   */
  private toSummary(task: IntentTask): IntentTaskSummary {
    return {
      id: task.id,
      messageId: task.messageId,
      intent: task.intent.length > SUMMARY_INTENT_MAX_LENGTH
        ? task.intent.substring(0, SUMMARY_INTENT_MAX_LENGTH) + '...'
        : task.intent,
      level: task.level,
      category: task.category,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      runCount: task.runs.length,
      totalTokens: task.totalInputTokens + task.totalOutputTokens,
      totalCost: task.totalCost,
      totalSkillCost: task.totalSkillCost,
      assignedSessions: task.assignedSessions,
      order: task.order,
      scheduleId: task.scheduleId,
      projectTaskId: task.projectTaskId,
      originalMessage: this.messageTexts.get(task.messageId),
    };
  }

  /**
   * Finish a run with a given status, aggregating totals.
   */
  private finishRun(taskId: string, runId: string, status: RunStatus, error?: string): TaskRun {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const run = task.runs.find((r) => r.id === runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    run.status = status;
    run.endedAt = new Date().toISOString();
    if (error) {
      run.error = error;
    }

    task.updatedAt = run.endedAt;

    // Clear token tracking context for this session
    TokenUsageService.getInstance().setTaskContext(run.sessionName, null);

    this.scheduleSave();
    return run;
  }
}
