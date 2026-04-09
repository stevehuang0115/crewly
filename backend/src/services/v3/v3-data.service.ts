/**
 * V3 Data Service — Automatic V3 entity creation via EventBus hooks
 *
 * Subscribes to existing backend events and automatically creates/updates
 * V3 entities (WorkItem, Request, Mission). This service is fire-and-forget:
 * errors are logged but never block the main flow.
 *
 * Design principle: Orchestrator has zero knowledge of V3 concepts.
 * V3 data is produced as a side effect of normal operations.
 *
 * Events consumed:
 * - task:delegated  -> creates WorkItem in TaskPool
 * - task:completed  -> updates WorkItem status to 'done'
 * - task:failed     -> updates WorkItem status to 'failed'
 * - goal:set        -> creates Mission with conservative policy
 * - message:user_work -> creates Request
 *
 * @module services/v3/v3-data.service
 */

import { EventEmitter } from 'events';
import { LoggerService } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { RequestService } from './request.service.js';
import { RequestTracker } from './request-tracker.service.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import { createMission, CONSERVATIVE_POLICY, type CreateMissionInput } from '../../types/v2/mission.types.js';
import { isValidRequestTransition, type IntentCategory, type IntentLevel } from '../../types/v2/request.types.js';
import { ensureDir, atomicWriteJson } from '../../utils/file-io.utils.js';
import { ProjectTaskWatcherService } from './project-task-watcher.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import * as path from 'path';
import * as fs from 'fs/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum content length for a user message to create a Request.
 * P2-1: Relaxed from 5 → 2 to stop dropping legitimate short commands
 * like "fix", "help", "go", "OK". Only truly empty or single-char
 * messages (e.g., ".", "k") are filtered out.
 */
export const MIN_REQUEST_CONTENT_LENGTH = 2;

/**
 * Grace period (in ms) before an open Request with no WorkItems is
 * auto-closed as dangling. P2-1: Added to prevent premature closure —
 * the orchestrator may need time to process the request and delegate.
 * Default: 5 minutes.
 */
export const DANGLING_REQUEST_GRACE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------

/**
 * Payload emitted when a task is delegated to an agent.
 */
export interface TaskDelegatedEvent {
  taskId: string;
  title: string;
  description?: string;
  assignedTo: string;
  priority?: string;
  projectPath: string;
  milestone?: string;
  requestId?: string;
  timestamp: string;
}

/**
 * Payload emitted when a task is completed.
 */
export interface TaskCompletedEvent {
  type: string;
  taskId?: string;
  sessionName: string;
  previousValue?: string;
  newValue: string;
  changedField?: string;
  timestamp: string;
}

/**
 * Payload emitted when a goal is set.
 */
export interface GoalSetEvent {
  goal: string;
  projectPath: string;
  setBy: string;
  timestamp: string;
}

/**
 * Payload emitted when a task is blocked.
 */
export interface TaskBlockedEvent {
  taskId?: string;
  sessionName: string;
  reason?: string;
  timestamp: string;
}

/**
 * Payload emitted when a user message is ready for processing.
 */
export interface UserWorkMessageEvent {
  messageId: string;
  conversationId: string;
  content: string;
  source: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * V3DataService automatically creates V3 data entities by subscribing to
 * backend EventBus events. It wraps every handler in try-catch to ensure
 * failures never impact the main workflow.
 *
 * @example
 * ```typescript
 * const v3Data = new V3DataService(eventBus, '/path/to/project');
 * // That's it — events are now being listened to.
 * ```
 */
export class V3DataService {
  private readonly logger = LoggerService.getInstance().createComponentLogger('V3DataService');
  private readonly projectPath: string;
  private readonly missionsDir: string;
  private taskWatcher: ProjectTaskWatcherService | null = null;

  /**
   * Creates and initializes the V3DataService.
   *
   * Subscribes to EventBus domain events and starts the ProjectTask file watcher
   * to ensure every ProjectTask has a corresponding WorkItem.
   *
   * @param eventBus - The EventEmitter that publishes domain events
   * @param projectPath - Absolute path to the project root
   */
  constructor(
    private readonly eventBus: EventEmitter,
    projectPath: string,
  ) {
    this.projectPath = projectPath;
    this.missionsDir = path.join(projectPath, '.crewly', 'missions');

    // Subscribe to events — all handlers are fire-and-forget
    this.eventBus.on('v3:task_delegated', this.onTaskDelegated.bind(this));
    this.eventBus.on('v3:task_completed', this.onTaskCompleted.bind(this));
    this.eventBus.on('v3:task_failed', this.onTaskFailed.bind(this));
    this.eventBus.on('v3:task_blocked', this.onTaskBlocked.bind(this));
    this.eventBus.on('v3:goal_set', this.onGoalSet.bind(this));
    this.eventBus.on('v3:user_work_message', this.onUserWorkMessage.bind(this));

    // Start ProjectTask file watcher (fire-and-forget)
    this.startTaskWatcher();

    this.logger.info('V3DataService initialized — listening for domain events');
  }

  /**
   * Starts the ProjectTask file watcher that monitors `.crewly/tasks/` for
   * new task files and auto-creates WorkItems. Fire-and-forget — errors
   * are logged but never block initialization.
   */
  private startTaskWatcher(): void {
    try {
      this.taskWatcher = new ProjectTaskWatcherService(this.projectPath);
      this.taskWatcher.start().catch((err) => {
        this.logger.warn('ProjectTaskWatcher start failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.logger.warn('ProjectTaskWatcher initialization failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Event Handlers (all fire-and-forget)
  // ---------------------------------------------------------------------------

  /**
   * Handles task:delegated — creates a WorkItem in the TaskPool.
   *
   * @param event - Task delegation event payload
   */
  private async onTaskDelegated(event: TaskDelegatedEvent): Promise<void> {
    try {
      const taskPool = TaskPoolService.getInstance();

      // Dedup: check if a WorkItem with this projectTaskId already exists
      const existing = await taskPool.getAllItems();
      if (existing.some((wi) => wi.projectTaskId === event.taskId)) {
        this.logger.debug('WorkItem already exists for task, skipping', { taskId: event.taskId });
        return;
      }

      // Resolve requestId from the event payload ONLY. The requestId should be
      // set explicitly at the delegation site (task-management controller or
      // tool-registry) rather than inferred via time-window correlation.
      // This eliminates cross-conversation mislinks (Bug 2).
      const resolvedRequestId = event.requestId || undefined;

      const workItem = createWorkItem({
        type: 'delegate',
        owner: 'orchestrator',
        target: event.assignedTo,
        title: event.title,
        description: event.description,
        projectTaskId: event.taskId,
        requestId: resolvedRequestId,
        maxRetries: 2,
      });

      // Add to pool (createWorkItem already sets status to 'queued')
      await taskPool.addToPool(workItem);

      this.logger.info('WorkItem auto-created from task delegation', {
        workItemId: workItem.id,
        taskId: event.taskId,
        target: event.assignedTo,
        requestId: resolvedRequestId,
      });

      // Link WorkItem to Request for bidirectional tracking
      if (resolvedRequestId) {
        try {
          const requestService = RequestService.getInstance(this.projectPath);
          await requestService.linkWorkItem(resolvedRequestId, workItem.id);

          // Transition Request: open → running (first WorkItem assigned)
          const request = await requestService.getById(resolvedRequestId);
          if (request && request.status === 'open') {
            await requestService.update(resolvedRequestId, { status: 'running' });
          }
        } catch (linkErr) {
          this.logger.debug('Failed to link WorkItem to Request (non-fatal)', {
            requestId: resolvedRequestId,
            workItemId: workItem.id,
            error: linkErr instanceof Error ? linkErr.message : String(linkErr),
          });
        }
      }
    } catch (err) {
      this.logger.warn('V3DataService.onTaskDelegated failed (non-fatal)', {
        taskId: event.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles task:completed — updates the matching WorkItem to 'done'.
   *
   * Uses a two-tier matching strategy:
   * 1. Match by projectTaskId (most precise — correlates to the .crewly/tasks/ file ID)
   * 2. Fall back to sessionName + status (running or queued, since WorkItems
   *    created via delegation start as 'queued' and may never be claimed)
   *
   * @param event - Task completion event payload
   */
  private async onTaskCompleted(event: TaskCompletedEvent): Promise<void> {
    try {
      const taskPool = TaskPoolService.getInstance();
      const items = await taskPool.getAllItems();

      // Tier 1: precise match by projectTaskId
      let match = event.taskId
        ? items.find((wi) => wi.projectTaskId === event.taskId && wi.status !== 'done' && wi.status !== 'failed')
        : undefined;

      // Tier 2: match by sessionName + active status (running first, then queued)
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'running',
        );
      }
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'queued',
        );
      }

      if (!match) {
        this.logger.debug('No matching WorkItem found for completed task', {
          sessionName: event.sessionName,
          taskId: event.taskId,
        });
        return;
      }

      // Bug 1 fix: completeItem() requires status === 'running', but WorkItems
      // created via delegation start as 'queued' and may never be claimed.
      // Transition queued → running first so completeItem() succeeds.
      if (match.status === 'queued') {
        await taskPool.updateItemStatus(match.id, 'running');
      }

      await taskPool.completeItem(match.id);

      // Look up token usage for this work item
      try {
        const tokenUsageService = TokenUsageService.getInstance();
        const sessionUsage = tokenUsageService.getUsageBySessions();

        // Find usage for the agent session that completed this task
        const sessionSummary = sessionUsage.find(s => s.sessionName === event.sessionName);
        if (sessionSummary && match) {
          const totalInput = sessionSummary.totalInput || 0;
          const totalOutput = sessionSummary.totalOutput || 0;
          const totalCost = sessionSummary.cost || 0;

          if (totalInput > 0 || totalOutput > 0) {
            await taskPool.updateTokenUsage(match.id, totalInput, totalOutput, totalCost);
            this.logger.debug('Updated WorkItem token usage', {
              workItemId: match.id,
              inputTokens: totalInput,
              outputTokens: totalOutput,
              cost: totalCost,
            });
          }
        }
      } catch (tokenErr) {
        // Token usage update is non-fatal
        this.logger.debug('Failed to update WorkItem token usage (non-fatal)', {
          error: tokenErr instanceof Error ? tokenErr.message : String(tokenErr),
        });
      }

      this.logger.info('WorkItem auto-completed', {
        workItemId: match.id,
        sessionName: event.sessionName,
        taskId: event.taskId,
      });

      // Cascade: update parent Request status
      await this.cascadeRequestStatus(match.requestId);
    } catch (err) {
      this.logger.warn('V3DataService.onTaskCompleted failed (non-fatal)', {
        sessionName: event.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles task:failed — updates the matching WorkItem to 'failed'.
   *
   * Uses the same two-tier matching strategy as onTaskCompleted.
   *
   * @param event - Task failure event payload
   */
  private async onTaskFailed(event: TaskCompletedEvent): Promise<void> {
    try {
      const taskPool = TaskPoolService.getInstance();
      const items = await taskPool.getAllItems();

      // Tier 1: precise match by projectTaskId
      let match = event.taskId
        ? items.find((wi) => wi.projectTaskId === event.taskId && wi.status !== 'done' && wi.status !== 'failed')
        : undefined;

      // Tier 2: match by sessionName + active status
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'running',
        );
      }
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'queued',
        );
      }

      if (!match) {
        this.logger.debug('No matching WorkItem found for failed task', {
          sessionName: event.sessionName,
          taskId: event.taskId,
        });
        return;
      }

      // Bug 1 fix: failItem() requires status === 'running'.
      // Transition queued → running first so failItem() succeeds.
      if (match.status === 'queued') {
        await taskPool.updateItemStatus(match.id, 'running');
      }

      await taskPool.failItem(match.id, `Task failed for session ${event.sessionName}`);

      this.logger.info('WorkItem auto-failed', {
        workItemId: match.id,
        sessionName: event.sessionName,
        taskId: event.taskId,
      });

      // Cascade: update parent Request status
      await this.cascadeRequestStatus(match.requestId);
    } catch (err) {
      this.logger.warn('V3DataService.onTaskFailed failed (non-fatal)', {
        sessionName: event.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles goal:set — creates a Mission with conservative policy.
   *
   * @param event - Goal set event payload
   */
  private async onGoalSet(event: GoalSetEvent): Promise<void> {
    try {
      // Dedup: check if an active Mission with the same objective already exists
      const existingMissions = await this.listMissions();
      const duplicate = existingMissions.find(
        (m) =>
          m.objective === event.goal &&
          m.status !== 'completed' &&
          m.status !== 'cancelled',
      );

      if (duplicate) {
        this.logger.debug('Active Mission with same objective already exists, skipping', {
          missionId: duplicate.id,
          objective: event.goal,
        });
        return;
      }

      const mission = createMission({
        objective: event.goal,
        ownerTeamId: 'default',
        successCriteria: [],
        currentStrategy: '',
        cadence: '0 9 * * 1', // Default: weekly Monday review
      });

      // Decompose the mission objective into initial ProjectTasks
      const taskIds = await V3DataService.decomposeMissionToTasks(mission.id, event.goal, event.projectPath);
      mission.activeProjectTaskIds = taskIds;

      await ensureDir(this.missionsDir);
      await atomicWriteJson(
        path.join(this.missionsDir, `${mission.id}.json`),
        mission,
      );

      this.logger.info('Mission auto-created from goal with tasks', {
        missionId: mission.id,
        objective: event.goal,
        setBy: event.setBy,
        taskCount: taskIds.length,
      });
    } catch (err) {
      this.logger.warn('V3DataService.onGoalSet failed (non-fatal)', {
        goal: event.goal,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles message:user_work — creates a Request from a user message.
   *
   * @param event - User work message event payload
   */
  private async onUserWorkMessage(event: UserWorkMessageEvent): Promise<void> {
    try {
      // Signal new user turn — clear stale request correlation
      RequestTracker.getInstance().clearOnNewMessage();

      const requestService = RequestService.getInstance(this.projectPath);

      // Bug 3 fix: auto-close dangling Requests (open, no workItems).
      // When a new user message arrives, any previous Request that is still
      // 'open' with empty workItemIds was never delegated — the orchestrator
      // handled it directly. Close these as 'done' so they don't linger.
      //
      // P2-1 improvement: only auto-close Requests older than DANGLING_GRACE_MS
      // to avoid prematurely closing Requests before the orchestrator has time
      // to process them and create WorkItems.
      try {
        const allRequests = await requestService.listAll();
        const now = Date.now();
        const danglingRequests = allRequests.filter((r) => {
          if (r.status !== 'open' || r.workItemIds.length > 0) return false;
          // Grace period: only close if the Request has been open long enough
          const age = now - new Date(r.createdAt).getTime();
          return age > DANGLING_REQUEST_GRACE_MS;
        });
        for (const dangling of danglingRequests) {
          await requestService.update(dangling.id, { status: 'done' });
          this.logger.debug('Auto-closed dangling Request (no workItems, past grace period)', {
            requestId: dangling.id,
          });
        }
      } catch (cleanupErr) {
        this.logger.debug('Dangling Request cleanup failed (non-fatal)', {
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }

      // Dedup: check if a Request with this messageId already exists.
      // Previous: used conversationId (Slack thread), which blocked all
      // subsequent messages in the same thread. Now uses messageId so each
      // user message can independently create a Request.
      const existing = await requestService.findBySourceConversationItemId(event.messageId);
      if (existing) {
        this.logger.debug('Request already exists for this message, skipping', {
          messageId: event.messageId,
          existingRequestId: existing.id,
        });
        return;
      }

      // Simple filter: skip empty/whitespace-only messages.
      const content = event.content.trim();
      if (content.length < MIN_REQUEST_CONTENT_LENGTH) {
        this.logger.debug('Message too short to create Request', {
          messageId: event.messageId,
          contentLength: content.length,
          minRequired: MIN_REQUEST_CONTENT_LENGTH,
        });
        return;
      }

      // -----------------------------------------------------------------------
      // V3 Pipeline change: Semantic understanding moved to orchestrator skills.
      // The orchestrator (which has Claude LLM) will decide when to create
      // Requests via the 'create-request' skill and decompose them via the
      // 'break-down-request' skill. This removes mechanical keyword-based
      // intent classification from the data service.
      //
      // The helper functions (classifyIntent, isNonActionableMessage, etc.)
      // are preserved at the bottom of this file as potential fallback.
      // -----------------------------------------------------------------------
      this.logger.info('User work message received — awaiting orchestrator classification via skills', {
        messageId: event.messageId,
        source: event.source,
        contentLength: content.length,
      });
    } catch (err) {
      this.logger.warn('V3DataService.onUserWorkMessage failed (non-fatal)', {
        messageId: event.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handles task:blocked — updates the matching WorkItem to 'blocked'.
   *
   * Uses the same two-tier matching strategy as onTaskCompleted.
   *
   * @param event - Task blocked event payload
   */
  private async onTaskBlocked(event: TaskBlockedEvent): Promise<void> {
    try {
      const taskPool = TaskPoolService.getInstance();
      const items = await taskPool.getAllItems();

      // Tier 1: precise match by taskId → projectTaskId
      let match = event.taskId
        ? items.find((wi) => wi.projectTaskId === event.taskId && wi.status !== 'done' && wi.status !== 'failed')
        : undefined;

      // Tier 2: match by sessionName + active status
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'running',
        );
      }
      if (!match) {
        match = items.find(
          (wi) => wi.target === event.sessionName && wi.status === 'queued',
        );
      }

      if (!match) {
        this.logger.debug('No matching WorkItem found for blocked task', {
          sessionName: event.sessionName,
          taskId: event.taskId,
        });
        return;
      }

      await taskPool.updateItemStatus(match.id, 'blocked');

      this.logger.info('WorkItem auto-blocked', {
        workItemId: match.id,
        sessionName: event.sessionName,
        reason: event.reason,
      });

      // Cascade: update parent Request status
      await this.cascadeRequestStatus(match.requestId);
    } catch (err) {
      this.logger.warn('V3DataService.onTaskBlocked failed (non-fatal)', {
        sessionName: event.sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Recomputes Request.status from the aggregate state of its child WorkItems.
   *
   * Rules:
   * - All WorkItems done → Request = done
   * - Any WorkItem running → Request = running
   * - All WorkItems queued → no change (work delegated but not started)
   * - Any WorkItem blocked, none running → Request = blocked
   * - All WorkItems failed/cancelled → Request = cancelled
   * - Some done + some queued (no running) → Request = running
   *
   * @param requestId - The parent Request ID (may be undefined for unlinked WorkItems)
   */
  private async cascadeRequestStatus(requestId?: string): Promise<void> {
    if (!requestId) return;

    try {
      const requestService = RequestService.getInstance(this.projectPath);
      const request = await requestService.getById(requestId);
      if (!request || request.status === 'done' || request.status === 'cancelled') return;

      const taskPool = TaskPoolService.getInstance();
      const allItems = await taskPool.getAllItems();
      const childItems = allItems.filter((wi) => wi.requestId === requestId);

      if (childItems.length === 0) return;

      const statuses = childItems.map((wi) => wi.status);

      let newStatus: string;
      const allQueued = statuses.every((s) => s === 'queued' || s === 'scheduled');
      if (statuses.every((s) => s === 'done')) {
        newStatus = 'done';
      } else if (statuses.some((s) => s === 'running')) {
        newStatus = 'running';
      } else if (allQueued) {
        // All WorkItems still queued — work delegated but not started.
        // Keep Request in its current status (no change needed).
        return;
      } else if (statuses.some((s) => s === 'blocked') && !statuses.some((s) => s === 'running')) {
        newStatus = 'blocked';
      } else if (statuses.every((s) => s === 'failed' || s === 'cancelled')) {
        newStatus = 'cancelled';
      } else if (statuses.some((s) => s === 'done')) {
        // Some work completed, some still queued — progress is being made
        newStatus = 'running';
      } else {
        // Mixed state — keep current status
        return;
      }

      if (newStatus !== request.status && isValidRequestTransition(request.status, newStatus as any)) {
        await requestService.update(requestId, { status: newStatus as any });
        this.logger.info('Request status cascaded from WorkItems', {
          requestId,
          previousStatus: request.status,
          newStatus,
          childStatuses: statuses,
        });

        // Emit update event for notification services
        this.eventBus.emit('v3:request_updated', {
          requestId,
          status: newStatus,
          previousStatus: request.status,
        });
      }
    } catch (err) {
      this.logger.debug('cascadeRequestStatus failed (non-fatal)', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mission → Task Decomposition
  // ---------------------------------------------------------------------------

  /**
   * Decomposes a mission objective into initial ProjectTask files.
   *
   * Uses keyword-based planning to break the objective into 2-4 actionable
   * sub-tasks, writes them as markdown files under `.crewly/tasks/delegated/open/`,
   * and returns the task IDs (filenames without extension).
   *
   * @param missionId - The parent mission ID
   * @param objective - The mission objective text
   * @param projectPath - Absolute path to the project root
   * @returns Array of created task IDs (file basenames without .md)
   */
  public static async decomposeMissionToTasks(
    missionId: string,
    objective: string,
    projectPath: string,
  ): Promise<string[]> {
    const tasksDir = path.join(projectPath, '.crewly', 'tasks', 'delegated', 'open');
    await ensureDir(tasksDir);

    const planned = planTasksFromObjective(objective);
    const taskIds: string[] = [];
    const now = new Date().toISOString();
    const timestamp = Date.now();

    for (let i = 0; i < planned.length; i++) {
      const task = planned[i];
      const sanitizedTitle = task.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 80);
      const taskId = `${sanitizedTitle}_${timestamp + i}`;
      const fileName = `${taskId}.md`;

      const content = [
        `# ${task.title}`,
        '',
        task.description,
        '',
        '## Acceptance Criteria',
        ...task.acceptanceCriteria.map((c) => `- ${c}`),
        '',
        '## Context',
        `Parent mission: ${missionId}`,
        `Mission objective: ${objective}`,
        `Required role: developer`,
        '',
        '## Task Information',
        `- **Priority**: ${task.priority}`,
        '- **Milestone**: delegated',
        `- **Created at**: ${now}`,
        '- **Status**: Open',
        `- **Mission ID**: ${missionId}`,
      ].join('\n');

      await fs.writeFile(path.join(tasksDir, fileName), content, 'utf-8');
      taskIds.push(taskId);
    }

    LoggerService.getInstance().createComponentLogger('V3DataService').debug('Decomposed mission into tasks', {
      missionId,
      taskCount: taskIds.length,
      taskIds,
    });

    return taskIds;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Lists all missions from disk.
   *
   * @returns Array of Mission objects
   */
  private async listMissions(): Promise<Array<{ id: string; objective: string; status: string }>> {
    try {
      await ensureDir(this.missionsDir);
      const files = await import('fs/promises').then((fs) => fs.readdir(this.missionsDir));
      const missions: Array<{ id: string; objective: string; status: string }> = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(this.missionsDir, file);
          const { safeReadJson: readJson } = await import('../../utils/file-io.utils.js');
          const data = await readJson<{ id: string; objective: string; status: string } | null>(filePath, null);
          if (data && data.id && data.objective) {
            missions.push(data);
          }
        } catch {
          // Skip malformed files
        }
      }

      return missions;
    } catch {
      return [];
    }
  }

  /**
   * Stops listening to events. Used for cleanup/testing.
   */
  public dispose(): void {
    this.eventBus.removeAllListeners('v3:task_delegated');
    this.eventBus.removeAllListeners('v3:task_completed');
    this.eventBus.removeAllListeners('v3:task_failed');
    this.eventBus.removeAllListeners('v3:task_blocked');
    this.eventBus.removeAllListeners('v3:goal_set');
    this.eventBus.removeAllListeners('v3:user_work_message');

    if (this.taskWatcher) {
      this.taskWatcher.dispose();
      this.taskWatcher = null;
    }

    this.logger.info('V3DataService disposed');
  }
}

// ---------------------------------------------------------------------------
// Intent Classification (keyword-based, no AI)
// ---------------------------------------------------------------------------

/**
 * Patterns that identify non-actionable messages (confirmations, chit-chat,
 * acknowledgements). These messages should NOT create Requests.
 */
const NON_ACTIONABLE_PATTERNS = [
  // Acknowledgements / confirmations (Chinese + English)
  /^(好的|好|嗯|嗯嗯|行|行的|可以|没问题|收到|了解|知道了|明白|ok|okay|sure|yes|yep|yeah|yup|got it|sounds good|lgtm|ack|roger|copy|noted|thanks|thank you|thx|ty|np|no problem|alright|understood|fine|cool|nice|great|perfect|awesome|good|done|right|exactly|absolutely|definitely|indeed|correct|agreed|approved|confirmed|approve|accept|安排|好的安排|辛苦了|谢谢|不错|可以的|没事|随便|都行|好吧|对|对的|是的|嗯好|好嘞|好哒|okie|oki|kk|k)\s*[!.。！~～]*$/i,
  // Greetings
  /^(hi|hello|hey|yo|sup|morning|afternoon|evening|你好|早|早上好|下午好|晚上好|嗨|哈喽)\s*[!.。！~～]*$/i,
  // Emoji-only messages
  /^[\p{Emoji}\s]+$/u,
  // Filler / single-word non-work
  /^(hmm+|huh|ah|oh|lol|haha|hehe|wow|omg|idk|brb|ttyl|tbd|wip)\s*[!.。！~～]*$/i,
];

/**
 * Maximum word count for a message to be eligible for non-actionable check.
 * Longer messages are unlikely to be simple acknowledgements.
 */
const MAX_NON_ACTIONABLE_WORDS = 6;

/**
 * Checks if a message is non-actionable (confirmation, chit-chat, greeting).
 * These messages should not create Requests or WorkItems.
 *
 * @param content - The user message text (trimmed)
 * @returns True if the message is non-actionable
 */
export function isNonActionableMessage(content: string): boolean {
  // Long messages are likely actionable
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length > MAX_NON_ACTIONABLE_WORDS) return false;

  return NON_ACTIONABLE_PATTERNS.some((pattern) => pattern.test(content.trim()));
}

/**
 * Auto-classify request intent from message content.
 * Runs synchronously — no AI call, just keyword matching.
 *
 * @param content - The user message text
 * @returns Object with intentCategory and intentLevel
 */
export function classifyIntent(content: string): { intentCategory: IntentCategory; intentLevel: IntentLevel } {
  const lower = content.toLowerCase();

  // Non-actionable messages: acknowledgements, chit-chat, greetings
  if (isNonActionableMessage(content)) {
    return { intentCategory: 'other', intentLevel: 'L0' };
  }

  // Debugging — English + Chinese keywords
  if (/\b(fix|bug|error|crash|broken|issue)\b/.test(lower) || /修复|修|bug|报错|崩溃|出错|故障|异常/.test(content)) {
    return { intentCategory: 'debugging', intentLevel: 'L1' };
  }
  // Deployment
  if (/\b(deploy|release|publish|ship)\b/.test(lower) || /部署|发布|上线|发版/.test(content)) {
    return { intentCategory: 'deployment', intentLevel: 'L2' };
  }
  // Review
  if (/\b(review|pr|pull request|code review)\b/.test(lower) || /审查|评审|review|代码审查/.test(content)) {
    return { intentCategory: 'review', intentLevel: 'L1' };
  }
  // Planning
  if (/\b(plan|design|architect|spec)\b/.test(lower) || /规划|设计|架构|方案|计划/.test(content)) {
    return { intentCategory: 'planning', intentLevel: 'L2' };
  }
  // Research / analysis
  if (/\b(research|investigate|analyze|look into|evaluate|assess|audit)\b/.test(lower) || /研究|调查|分析|评估|排查|审计|检查/.test(content)) {
    return { intentCategory: 'research', intentLevel: 'L1' };
  }
  // Communication
  if (/\b(tell|ask|message|notify|send)\b/.test(lower) || /告诉|问|通知|发消息|转告/.test(content)) {
    return { intentCategory: 'communication', intentLevel: 'L0' };
  }
  // Code change
  if (/\b(add|implement|create|build|feature|write)\b/.test(lower) || /添加|实现|创建|开发|编写|搭建|新增/.test(content)) {
    return { intentCategory: 'code_change', intentLevel: 'L2' };
  }
  // Query / lookup (Chinese-specific, lightweight tasks)
  if (/查一下|查看|查询|看看|有多少|列出|统计/.test(content)) {
    return { intentCategory: 'research', intentLevel: 'L1' };
  }

  return { intentCategory: 'other', intentLevel: 'L1' };
}

// ---------------------------------------------------------------------------
// Mission → Task Planning (keyword-based, no AI)
// ---------------------------------------------------------------------------

/**
 * Planned task structure used during mission decomposition.
 */
export interface PlannedTask {
  /** Short task title */
  title: string;
  /** Detailed task description */
  description: string;
  /** Measurable acceptance criteria */
  acceptanceCriteria: string[];
  /** Task priority */
  priority: 'high' | 'medium' | 'low';
}

/**
 * Threshold for "complex" objectives that warrant multi-step decomposition.
 * Below this word count, a single task is sufficient.
 */
const COMPLEX_OBJECTIVE_WORD_THRESHOLD = 15;

/**
 * Determines whether an objective is complex enough for multi-step decomposition.
 * Complexity heuristics: word count, presence of conjunctions/lists, multiple
 * action verbs, or explicit multi-step indicators.
 *
 * @param objective - The objective text
 * @returns True if the objective warrants multiple tasks
 */
export function isComplexObjective(objective: string): boolean {
  const words = objective.split(/\s+/).filter(Boolean);
  if (words.length >= COMPLEX_OBJECTIVE_WORD_THRESHOLD) return true;

  // Chinese: character count heuristic (Chinese text has fewer spaces)
  const cjkChars = objective.match(/[\u4e00-\u9fff]/g);
  if (cjkChars && cjkChars.length >= 20) return true;

  const lower = objective.toLowerCase();
  // Multiple action verbs suggest multi-step work (English)
  const actionVerbs = lower.match(/\b(build|create|implement|add|fix|deploy|test|review|design|write|migrate|refactor|setup|configure|integrate)\b/g);
  if (actionVerbs && actionVerbs.length >= 2) return true;

  // Chinese action verbs
  const cnActionVerbs = objective.match(/创建|实现|添加|修复|部署|测试|审查|设计|编写|迁移|重构|配置|集成|评估|分析|检查|搭建|开发/g);
  if (cnActionVerbs && cnActionVerbs.length >= 2) return true;

  // Conjunctions or list indicators (English)
  if (/\b(and then|then|also|plus|as well as|followed by|after that)\b/.test(lower)) return true;
  if (/[;,]\s*(and\s+)?(then\s+)?/.test(objective) && words.length > 8) return true;

  // Chinese list/compound indicators: "包括...方面", enumeration with 、or ，
  if (/包括|以及|同时|另外|还有|并且|然后/.test(objective)) return true;
  // Chinese comma-separated list (3+ items with 、)
  const cnListItems = objective.split(/[、，]/).filter((s) => s.trim().length > 1);
  if (cnListItems.length >= 3) return true;

  return false;
}

/**
 * Decomposes a mission objective into actionable tasks using keyword matching.
 *
 * P0-1 fix: Uses intelligent decomposition instead of always producing 3 tasks.
 * - Simple/direct objectives → 1 task
 * - Complex/multi-step objectives → 2-3 tasks
 *
 * Recognises three broad categories:
 * - **Build** (create/implement/build/add/feature) → single task or design+implement+test
 * - **Fix** (fix/debug/resolve/repair/patch) → single task or investigate+fix+verify
 * - **Default** (anything else) → single task or plan+execute+review
 *
 * @param objective - The mission objective text
 * @returns Array of PlannedTask objects (1-3 items)
 */
export function planTasksFromObjective(objective: string): PlannedTask[] {
  const lower = objective.toLowerCase();
  const complex = isComplexObjective(objective);

  // Category: Build / Feature work (English + Chinese)
  if (/\b(build|create|implement|add|feature|develop|write|ship)\b/.test(lower) || /创建|实现|添加|开发|编写|搭建|新增/.test(objective)) {
    if (!complex) {
      return [{
        title: truncate(objective, 80),
        description: `Implement: ${objective}. Follow project conventions, write tests, ensure build passes.`,
        acceptanceCriteria: [
          'Functionality implemented and working',
          'Tests written and passing',
          'Build passes clean',
        ],
        priority: 'high',
      }];
    }
    return [
      {
        title: `Design approach for: ${truncate(objective, 60)}`,
        description: `Analyse requirements and design the technical approach for: ${objective}. Identify key components, interfaces, and dependencies.`,
        acceptanceCriteria: [
          'Technical approach documented',
          'Key components and interfaces identified',
          'Dependencies and risks listed',
        ],
        priority: 'high',
      },
      {
        title: `Implement: ${truncate(objective, 60)}`,
        description: `Implement the core functionality described in: ${objective}. Follow the design approach from the previous task.`,
        acceptanceCriteria: [
          'Core functionality implemented',
          'Code follows project conventions',
          'TypeScript compiles without errors',
        ],
        priority: 'high',
      },
      {
        title: `Test and verify: ${truncate(objective, 60)}`,
        description: `Write unit tests for the implementation of: ${objective}. Ensure minimum 80% coverage for new code.`,
        acceptanceCriteria: [
          'Unit tests written and passing',
          'Edge cases covered',
          'Build passes clean',
        ],
        priority: 'medium',
      },
    ];
  }

  // Category: Bug fix / Debugging (English + Chinese)
  if (/\b(fix|debug|resolve|repair|patch|broken|bug|error|crash)\b/.test(lower) || /修复|修|调试|解决|修补|bug|报错|崩溃/.test(objective)) {
    if (!complex) {
      return [{
        title: truncate(objective, 80),
        description: `Investigate and fix: ${objective}. Identify root cause, apply fix, verify with tests.`,
        acceptanceCriteria: [
          'Root cause identified and fixed',
          'Tests pass, no regressions',
          'Build passes clean',
        ],
        priority: 'high',
      }];
    }
    return [
      {
        title: `Investigate: ${truncate(objective, 60)}`,
        description: `Investigate the root cause of: ${objective}. Reproduce the issue and identify the failing code path.`,
        acceptanceCriteria: [
          'Root cause identified',
          'Issue reproduced reliably',
          'Affected code paths documented',
        ],
        priority: 'high',
      },
      {
        title: `Fix: ${truncate(objective, 60)}`,
        description: `Apply a fix for: ${objective}. Ensure the fix addresses the root cause, not just the symptoms.`,
        acceptanceCriteria: [
          'Fix applied and tested locally',
          'Root cause addressed',
          'No regressions introduced',
        ],
        priority: 'high',
      },
      {
        title: `Verify fix: ${truncate(objective, 60)}`,
        description: `Verify the fix for: ${objective}. Run full test suite and confirm the issue no longer reproduces.`,
        acceptanceCriteria: [
          'All existing tests pass',
          'Regression test added',
          'Issue confirmed resolved',
        ],
        priority: 'medium',
      },
    ];
  }

  // Default category
  if (!complex) {
    return [{
      title: truncate(objective, 80),
      description: `Execute: ${objective}. Complete the work and verify results.`,
      acceptanceCriteria: [
        'Objective completed',
        'Deliverables produced',
        'Build passes',
      ],
      priority: 'high',
    }];
  }

  return [
    {
      title: `Plan: ${truncate(objective, 60)}`,
      description: `Create an execution plan for: ${objective}. Break down the work into concrete steps.`,
      acceptanceCriteria: [
        'Execution plan created',
        'Steps are concrete and actionable',
        'Dependencies identified',
      ],
      priority: 'high',
    },
    {
      title: `Execute: ${truncate(objective, 60)}`,
      description: `Execute the plan for: ${objective}. Complete all steps identified in the planning phase.`,
      acceptanceCriteria: [
        'All planned steps completed',
        'Deliverables produced',
        'Build passes',
      ],
      priority: 'high',
    },
    {
      title: `Review: ${truncate(objective, 60)}`,
      description: `Review the completed work for: ${objective}. Verify quality, completeness, and alignment with the original objective.`,
      acceptanceCriteria: [
        'Work reviewed for quality',
        'Objective fully addressed',
        'Documentation updated if needed',
      ],
      priority: 'low',
    },
  ];
}

/**
 * Truncates a string to a maximum length, appending ellipsis if needed.
 *
 * @param str - The string to truncate
 * @param maxLen - Maximum length
 * @returns Truncated string
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Intent category labels for title prefixes.
 */
const INTENT_TITLE_PREFIXES: Partial<Record<IntentCategory, string>> = {
  debugging: 'Fix',
  deployment: 'Deploy',
  review: 'Review',
  planning: 'Plan',
  research: 'Research',
  code_change: 'Implement',
  communication: 'Message',
};

/**
 * Generates a summarized title for a Request instead of copying raw content.
 *
 * For short messages (under 60 chars), uses the content directly with an
 * intent prefix. For longer messages, extracts the first sentence or clause
 * and prepends the intent prefix.
 *
 * @param content - The trimmed user message
 * @param intentCategory - The classified intent category
 * @returns A concise, informative title (max 80 chars)
 */
export function generateRequestTitle(content: string, intentCategory: IntentCategory): string {
  const prefix = INTENT_TITLE_PREFIXES[intentCategory];

  // For short messages (under 60 chars), always add a prefix.
  // If no category-specific prefix, use a generic "Request" prefix
  // to ensure title ≠ description.
  if (content.length <= 60) {
    const label = prefix || 'Request';
    return truncate(`[${label}] ${content}`, 80);
  }

  // For longer messages, extract the first sentence or clause
  // and split on Chinese sentence-ending punctuation as well.
  const firstSentence = content.match(/^[^.!?\n。！？]+[.!?。！？]?/)?.[0] || content;
  const core = firstSentence.trim();

  const label = prefix || 'Request';
  return truncate(`[${label}] ${core}`, 80);
}
