import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { InProgressTask, InProgressTaskStatus, TaskTrackingData, TaskFileInfo, BlockedReport } from '../../types/task-tracking.types.js';
import type { OrgRole } from '../ai/prompt-modules/prompt-module.interface.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

export class TaskTrackingService extends EventEmitter {
  private readonly taskTrackingPath: string;
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('TaskTrackingService');
  private autoSyncInterval?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    this.taskTrackingPath = path.join(getCrewlyHomePath(), 'in_progress_tasks.json');
  }

  /**
   * Start periodic file system sync for all projects (#137).
   * Cleans up stale task tracking entries whose files have been moved or deleted.
   *
   * @param intervalMs - Sync interval in milliseconds (default: 30 minutes)
   */
  startAutoSync(intervalMs: number = 30 * 60 * 1000): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
    }

    this.autoSyncInterval = setInterval(() => {
      this.runAutoSync().catch((err) => {
        this.logger.warn('Auto-sync failed (non-critical)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    this.logger.info('Task auto-sync started', { intervalMs });
  }

  /**
   * Stop periodic file system sync.
   */
  stopAutoSync(): void {
    if (this.autoSyncInterval) {
      clearInterval(this.autoSyncInterval);
      this.autoSyncInterval = undefined;
      this.logger.info('Task auto-sync stopped');
    }
  }

  /**
   * Run auto-sync: iterate all tracked tasks and sync with file system.
   * Groups tasks by projectId and calls syncTasksWithFileSystem for each.
   */
  private async runAutoSync(): Promise<void> {
    const data = await this.loadTaskData();
    if (data.tasks.length === 0) return;

    // Group tasks by projectId and extract unique project paths
    const projectPaths = new Map<string, string>();
    for (const task of data.tasks) {
      if (!projectPaths.has(task.projectId) && task.taskFilePath) {
        // Derive project path from task file path:
        // taskFilePath looks like /path/to/project/.crewly/tasks/milestone/status/file.md
        const crewlyIdx = task.taskFilePath.indexOf('/.crewly/');
        if (crewlyIdx > 0) {
          projectPaths.set(task.projectId, task.taskFilePath.substring(0, crewlyIdx));
        }
      }
    }

    for (const [projectId, projectPath] of projectPaths) {
      try {
        await this.syncTasksWithFileSystem(projectPath, projectId);
      } catch (err) {
        this.logger.warn('Sync failed for project', {
          projectId,
          projectPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async loadTaskData(): Promise<TaskTrackingData> {
    try {
      if (!fsSync.existsSync(this.taskTrackingPath)) {
        const initialData: TaskTrackingData = {
          tasks: [],
          lastUpdated: new Date().toISOString(),
          version: '1.0.0'
        };
        await this.saveTaskData(initialData);
        return initialData;
      }

      const content = await fs.readFile(this.taskTrackingPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.error('Error loading task tracking data', { error: error instanceof Error ? error.message : String(error) });
      return {
        tasks: [],
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    }
  }

  async saveTaskData(data: TaskTrackingData): Promise<void> {
    try {
      data.lastUpdated = new Date().toISOString();
      await fs.writeFile(this.taskTrackingPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Error saving task tracking data', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async assignTask(
    projectId: string,
    teamId: string,
    taskFilePath: string,
    taskName: string,
    targetRole: string,
    teamMemberId: string,
    sessionName: string
  ): Promise<InProgressTask> {
    const data = await this.loadTaskData();

    const task: InProgressTask = {
      id: uuidv4(),
      projectId,
      teamId,
      taskFilePath,
      taskName,
      targetRole,
      assignedTeamMemberId: teamMemberId,
      assignedSessionName: sessionName,
      assignedAt: new Date().toISOString(),
      status: 'assigned'
    };

    data.tasks.push(task);
    await this.saveTaskData(data);

    // Emit task assigned event
    this.emit('task_assigned', task);

    return task;
  }

  async updateTaskStatus(taskId: string, status: InProgressTask['status'], blockReason?: string, requestorOrgRole?: OrgRole): Promise<void> {
    const data = await this.loadTaskData();
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    // Validate transition if requestor role is provided
    if (requestorOrgRole) {
      const validation = this.validateStatusTransition(task.status, status, requestorOrgRole);
      if (!validation.valid) {
        throw new Error(`Status transition rejected: ${validation.reason}`);
      }
    }

    const previousStatus = task.status;
    task.status = status;
    task.lastCheckedAt = new Date().toISOString();

    if (status === 'blocked' && blockReason) {
      task.blockReason = blockReason;
    }

    // Clear working notes on terminal statuses — not long-term memory
    if (status === 'completed' || status === 'verified') {
      task.workingNotes = undefined;
      task.workingNotesUpdatedAt = undefined;
    }

    await this.saveTaskData(data);

    // Emit task completed event if status is completed
    if (status === 'completed') {
      this.emit('task_completed', task);
    }

    // Architecture Upgrade Phase 6: emit task workflow events for action trigger chain.
    // These events drive the wake chain: done → TL verifies → verified → orc notified.
    this.emitTaskWorkflowEvent(task, previousStatus, status, data);
  }

  /**
   * Emit task workflow events that drive the action trigger chain.
   * Only emits for transitions that require a different actor to wake up.
   *
   * @param task - The updated task
   * @param fromStatus - Previous status
   * @param toStatus - New status
   * @param data - Current task tracking data (for team:all_tasks_done check)
   */
  private emitTaskWorkflowEvent(
    task: InProgressTask,
    fromStatus: InProgressTaskStatus,
    toStatus: InProgressTaskStatus,
    data: TaskTrackingData,
  ): void {
    // Map status transitions to event types
    const eventMap: Partial<Record<InProgressTaskStatus, string>> = {
      'assigned': 'task:assigned',
      'done': 'task:done',
      'verified': 'task:verified',
      'blocked': 'task:blocked',
      'failed': 'task:failed',
      'needs_clarification': 'task:needs_clarification',
    };

    const eventType = eventMap[toStatus];
    if (!eventType) return;

    // Don't re-emit if status didn't actually change
    if (fromStatus === toStatus) return;

    const payload = {
      taskId: task.id,
      taskName: task.taskName,
      taskStatus: toStatus,
      assignedSessionName: task.assignedSessionName,
      ownerMemberId: task.assignedTeamMemberId,
      teamId: task.teamId,
      parentTaskId: task.parentTaskId,
      delegatedBySession: task.delegatedBySession,
    };

    this.logger.info('Task workflow event emitted', { eventType, ...payload });
    this.emit('task_workflow_event', { type: eventType, ...payload });

    // Check for team:all_tasks_done (with active execution task filter)
    if (toStatus === 'verified' || toStatus === 'completed') {
      const activeStatuses: InProgressTaskStatus[] = [
        'assigned', 'accepted', 'active', 'working', 'blocked', 'done', 'verifying', 'submitted',
      ];
      const activeTeamTasks = data.tasks.filter(
        t => t.teamId === task.teamId && activeStatuses.includes(t.status)
      );
      if (activeTeamTasks.length === 0) {
        this.logger.info('All team tasks done — emitting team:all_tasks_done', { teamId: task.teamId });
        this.emit('task_workflow_event', {
          type: 'team:all_tasks_done',
          teamId: task.teamId,
          taskId: task.id,
        });
      }
    }
  }

  /**
   * Accept a task — transitions from 'assigned' to 'accepted'.
   * Records the agent's structured understanding of the task.
   *
   * @param taskId - Task ID to accept
   * @param sessionName - Session name of the accepting agent (must match assignee)
   * @param understanding - Agent's structured understanding of the task scope
   * @returns The updated task
   * @throws If task not found, not in 'assigned' status, or session doesn't match
   */
  async acceptTask(taskId: string, sessionName: string, understanding: string): Promise<InProgressTask> {
    const data = await this.loadTaskData();
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (task.status !== 'assigned') {
      throw new Error(`Task ${taskId} is in '${task.status}' status, expected 'assigned'`);
    }

    if (task.assignedSessionName !== sessionName) {
      throw new Error(`Session '${sessionName}' is not the assignee of task ${taskId}`);
    }

    task.status = 'accepted';
    task.acceptedAt = new Date().toISOString();
    task.acceptanceNote = understanding;
    task.lastCheckedAt = new Date().toISOString();

    await this.saveTaskData(data);
    this.emit('task_accepted', task);
    return task;
  }

  /**
   * Request clarification on a task — transitions to 'needs_clarification'.
   * Signals that the agent needs more info before starting work.
   *
   * @param taskId - Task ID to request clarification for
   * @param sessionName - Session name of the requesting agent (must match assignee)
   * @param question - What the agent needs clarified
   * @returns The updated task
   * @throws If task not found, not in valid status, or session doesn't match
   */
  async requestClarification(taskId: string, sessionName: string, question: string): Promise<InProgressTask> {
    const data = await this.loadTaskData();
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    if (task.status !== 'assigned' && task.status !== 'accepted') {
      throw new Error(`Task ${taskId} is in '${task.status}' status, expected 'assigned' or 'accepted'`);
    }

    if (task.assignedSessionName !== sessionName) {
      throw new Error(`Session '${sessionName}' is not the assignee of task ${taskId}`);
    }

    task.status = 'needs_clarification';
    task.clarificationRequest = question;
    task.lastCheckedAt = new Date().toISOString();

    await this.saveTaskData(data);
    this.emit('task_needs_clarification', task);
    return task;
  }

  /**
   * Save working notes for a task — persists agent's current working state
   * across session restarts. Not long-term memory; cleared on task completion.
   *
   * @param taskId - Task ID
   * @param sessionName - Session name (must match assignee)
   * @param notes - Working notes content
   * @throws If task not found or session doesn't match assignee
   */
  async updateWorkingNotes(taskId: string, sessionName: string, notes: string): Promise<void> {
    const data = await this.loadTaskData();
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task with ID ${taskId} not found`);
    if (task.assignedSessionName !== sessionName) {
      throw new Error(`Session '${sessionName}' is not the assignee of task ${taskId}`);
    }
    task.workingNotes = notes;
    task.workingNotesUpdatedAt = new Date().toISOString();
    await this.saveTaskData(data);
  }

  /**
   * Validate that a status transition is allowed based on the Task State Ownership Matrix.
   * Enforces who can write which status and which transitions are legal.
   *
   * @param currentStatus - Current task status
   * @param newStatus - Requested new status
   * @param requestorOrgRole - Organizational role of the requestor
   * @returns Validation result with optional reason for rejection
   */
  validateStatusTransition(
    currentStatus: InProgressTaskStatus,
    newStatus: InProgressTaskStatus,
    requestorOrgRole: OrgRole
  ): { valid: boolean; reason?: string } {
    // Status ownership matrix: who can write which status
    const executorStatuses: InProgressTaskStatus[] = ['accepted', 'needs_clarification', 'active', 'blocked', 'done', 'working', 'submitted'];
    const tlStatuses: InProgressTaskStatus[] = ['verifying', 'verified', 'failed', 'cancelled', 'assigned'];
    const orcStatuses: InProgressTaskStatus[] = ['cancelled', 'assigned', 'ready', 'backlog', 'pending_assignment'];

    // Check ownership
    if (requestorOrgRole === 'executor') {
      if (!executorStatuses.includes(newStatus)) {
        return { valid: false, reason: `Executor cannot set status to '${newStatus}'. Allowed: ${executorStatuses.join(', ')}` };
      }
    } else if (requestorOrgRole === 'team-lead') {
      if (!tlStatuses.includes(newStatus) && !executorStatuses.includes(newStatus)) {
        return { valid: false, reason: `Team Lead cannot set status to '${newStatus}'` };
      }
    } else if (requestorOrgRole === 'orchestrator') {
      if (!orcStatuses.includes(newStatus)) {
        return { valid: false, reason: `Orchestrator cannot set status to '${newStatus}'. Allowed: ${orcStatuses.join(', ')}` };
      }
    }

    // Illegal transitions
    if (currentStatus === 'assigned' && newStatus === 'verified') {
      return { valid: false, reason: 'Cannot skip execution: assigned → verified is illegal' };
    }
    if (currentStatus === 'done' && newStatus === 'assigned') {
      return { valid: false, reason: 'Cannot reassign directly from done. Must go through failed first.' };
    }

    return { valid: true };
  }

  async removeTask(taskId: string): Promise<void> {
    const data = await this.loadTaskData();
    data.tasks = data.tasks.filter(t => t.id !== taskId);
    await this.saveTaskData(data);
  }

  async addTaskToQueue(taskInfo: {
    projectId: string;
    teamId: string;
    taskFilePath: string;
    taskName: string;
    targetRole: string;
    priority: 'low' | 'medium' | 'high';
    createdAt: string;
  }): Promise<InProgressTask> {
    const data = await this.loadTaskData();

    const task: InProgressTask = {
      id: uuidv4(),
      projectId: taskInfo.projectId,
      teamId: taskInfo.teamId,
      taskFilePath: taskInfo.taskFilePath,
      taskName: taskInfo.taskName,
      targetRole: taskInfo.targetRole,
      assignedTeamMemberId: 'orchestrator', // Queued for orchestrator assignment
      assignedSessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
      assignedAt: taskInfo.createdAt,
      status: 'pending_assignment', // New status for tasks awaiting assignment
      priority: taskInfo.priority
    };

    data.tasks.push(task);
    await this.saveTaskData(data);

    return task;
  }

  async getTasksForProject(projectId: string): Promise<InProgressTask[]> {
    const data = await this.loadTaskData();
    return data.tasks.filter(t => t.projectId === projectId);
  }

  async getTasksForTeamMember(teamMemberId: string): Promise<InProgressTask[]> {
    const data = await this.loadTaskData();
    return data.tasks.filter(t => t.assignedTeamMemberId === teamMemberId);
  }

  async getAllInProgressTasks(): Promise<InProgressTask[]> {
    const data = await this.loadTaskData();
    return data.tasks;
  }

  // Utility method to scan project tasks and sync with file system
  async syncTasksWithFileSystem(projectPath: string, projectId: string): Promise<void> {
    const tasksPath = path.join(projectPath, '.crewly', 'tasks');

    if (!fsSync.existsSync(tasksPath)) {
      return;
    }

    const data = await this.loadTaskData();
    const projectTasks = data.tasks.filter(t => t.projectId === projectId);

    // Check if assigned tasks still exist in in_progress folder
    for (const task of projectTasks) {
      const expectedInProgressPath = task.taskFilePath.replace('/open/', '/in_progress/');
      const taskStillInProgress = fsSync.existsSync(expectedInProgressPath);

      if (!taskStillInProgress) {
        // Task was moved manually, check where it went
        const baseName = path.basename(task.taskFilePath);
        const milestoneDir = path.dirname(path.dirname(task.taskFilePath));

        const doneFile = path.join(milestoneDir, 'done', baseName);
        const blockedFile = path.join(milestoneDir, 'blocked', baseName);

        if (fsSync.existsSync(doneFile)) {
          // Task was completed, remove from tracking
          await this.removeTask(task.id);
        } else if (fsSync.existsSync(blockedFile)) {
          // Task was blocked, update status
          await this.updateTaskStatus(task.id, 'blocked', 'Moved to blocked folder manually');
        }
      }
    }
  }

  // Get available open tasks for a project
  async getOpenTasks(projectPath: string): Promise<TaskFileInfo[]> {
    const tasksPath = path.join(projectPath, '.crewly', 'tasks');
    const openTasks: TaskFileInfo[] = [];

    if (!fsSync.existsSync(tasksPath)) {
      return openTasks;
    }

    const milestones = await fs.readdir(tasksPath);

    for (const milestone of milestones) {
      if (!milestone.startsWith('m') || !milestone.includes('_')) continue;

      const milestonePath = path.join(tasksPath, milestone);
      const openFolderPath = path.join(milestonePath, 'open');

      if (fsSync.existsSync(openFolderPath)) {
        const openFiles = await fs.readdir(openFolderPath);

        for (const file of openFiles) {
          if (file.endsWith('.md')) {
            const fullPath = path.join(openFolderPath, file);

            // Parse role from filename (assumes format: NN_task_name_ROLE.md)
            const roleMatch = file.match(/_([a-z]+)\.md$/);
            const targetRole = roleMatch ? roleMatch[1] : 'unknown';

            openTasks.push({
              filePath: fullPath,
              fileName: file,
              taskName: this.extractTaskNameFromFile(file),
              targetRole,
              milestoneFolder: milestone,
              statusFolder: 'open'
            });
          }
        }
      }
    }

    return openTasks;
  }

  /**
   * Store monitoring IDs (schedules and subscriptions) for a task so they can be
   * automatically cleaned up when the task completes.
   *
   * @param taskId - The task ID to associate monitoring with
   * @param scheduleIds - Array of schedule check IDs to link
   * @param subscriptionIds - Array of event subscription IDs to link
   */
  async addMonitoringIds(
    taskId: string,
    scheduleIds: string[],
    subscriptionIds: string[]
  ): Promise<void> {
    const data = await this.loadTaskData();
    const task = data.tasks.find(t => t.id === taskId);

    if (!task) {
      throw new Error(`Task with ID ${taskId} not found`);
    }

    task.scheduleIds = [...(task.scheduleIds || []), ...scheduleIds];
    task.subscriptionIds = [...(task.subscriptionIds || []), ...subscriptionIds];
    await this.saveTaskData(data);

    this.logger.info('Added monitoring IDs to task', {
      taskId,
      scheduleIds,
      subscriptionIds,
    });
  }

  /**
   * Find all tasks assigned to a specific agent session.
   *
   * @param sessionName - The agent session name
   * @returns Array of tasks assigned to the session
   */
  async getTasksBySessionName(sessionName: string): Promise<InProgressTask[]> {
    const data = await this.loadTaskData();
    return data.tasks.filter(t => t.assignedSessionName === sessionName);
  }

  /**
   * Collect all monitoring IDs (schedules and subscriptions) for tasks assigned
   * to a specific agent session. Used for auto-cleanup when tasks complete.
   *
   * @param sessionName - The agent session name
   * @returns Object with arrays of scheduleIds and subscriptionIds
   */
  async getMonitoringIdsForSession(sessionName: string): Promise<{
    scheduleIds: string[];
    subscriptionIds: string[];
  }> {
    const tasks = await this.getTasksBySessionName(sessionName);
    const scheduleIds: string[] = [];
    const subscriptionIds: string[] = [];

    for (const task of tasks) {
      if (task.scheduleIds) {
        scheduleIds.push(...task.scheduleIds);
      }
      if (task.subscriptionIds) {
        subscriptionIds.push(...task.subscriptionIds);
      }
    }

    return { scheduleIds, subscriptionIds };
  }

  /**
   * Detect orphan tasks: tasks stuck in in_progress/assigned/active with no
   * corresponding active agent. Returns the list without modifying state.
   *
   * @param getTeamStatus - Function returning current team configurations
   * @param staleThresholdMs - Age threshold in ms to consider a task stale (default: 24 hours)
   * @returns Array of orphan tasks with staleness info
   */
  async detectOrphanTasks(
    getTeamStatus: () => Promise<any[]>,
    staleThresholdMs: number = 24 * 60 * 60 * 1000
  ): Promise<Array<InProgressTask & { staleSinceMs: number }>> {
    const data = await this.loadTaskData();
    const activeTasks = data.tasks.filter(
      t => t.status === 'assigned' || t.status === 'active' || t.status === 'working'
    );

    if (activeTasks.length === 0) return [];

    // Build set of all known agent session names + member IDs
    const teams = await getTeamStatus();
    const knownAgents = new Set<string>();
    for (const team of teams) {
      for (const member of (team.members || [])) {
        if (member.sessionName) knownAgents.add(member.sessionName);
        if (member.id) knownAgents.add(member.id);
      }
    }

    const now = Date.now();
    const orphans: Array<InProgressTask & { staleSinceMs: number }> = [];

    for (const task of activeTasks) {
      const agentKnown =
        knownAgents.has(task.assignedSessionName) ||
        knownAgents.has(task.assignedTeamMemberId);

      const assignedTime = new Date(task.assignedAt).getTime();
      const staleSinceMs = now - assignedTime;

      // Orphan if agent doesn't exist in any team OR task is stale
      if (!agentKnown || staleSinceMs > staleThresholdMs) {
        orphans.push({ ...task, staleSinceMs });
      }
    }

    return orphans;
  }

  /**
   * Bulk cleanup orphan tasks by marking them as cancelled and optionally
   * moving their files back to the open folder.
   *
   * @param taskIds - Array of task IDs to clean up
   * @param action - 'cancel' marks tasks as cancelled, 'reopen' moves them back to open
   * @returns Cleanup report with counts
   */
  async cleanupOrphanTasks(
    taskIds: string[],
    action: 'cancel' | 'reopen' = 'cancel'
  ): Promise<{ cleaned: number; errors: string[] }> {
    const report = { cleaned: 0, errors: [] as string[] };
    const data = await this.loadTaskData();

    for (const taskId of taskIds) {
      const task = data.tasks.find(t => t.id === taskId);
      if (!task) {
        report.errors.push(`Task ${taskId} not found`);
        continue;
      }

      try {
        if (action === 'reopen') {
          const moved = await this.moveTaskBackToOpen(task);
          if (moved) {
            await this.removeTask(taskId);
            report.cleaned++;
          } else {
            // File may already be gone — just remove from tracking
            await this.removeTask(taskId);
            report.cleaned++;
          }
        } else {
          // Cancel: update status and remove from active tracking
          task.status = 'cancelled';
          task.completedAt = new Date().toISOString();
          await this.saveTaskData(data);
          await this.removeTask(taskId);
          report.cleaned++;
        }
      } catch (err) {
        report.errors.push(
          `Failed to clean task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    this.logger.info('Orphan task cleanup complete', {
      action,
      cleaned: report.cleaned,
      errors: report.errors.length,
    });

    return report;
  }

  private extractTaskNameFromFile(filename: string): string {
    // Remove extension and number prefix
    return filename
      .replace('.md', '')
      .replace(/^\d+_/, '')
      .replace(/_[a-z]+$/, '') // Remove role suffix
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  /**
   * Recovers abandoned in-progress tasks by checking agent status and moving inactive tasks back to open
   * @param getTeamStatus Function to get current team status from API
   * @returns Recovery report with actions taken
   */
  async recoverAbandonedTasks(getTeamStatus: () => Promise<any[]>): Promise<{
    totalInProgress: number;
    recovered: number;
    skipped: number;
    errors: string[];
    recoveredTasks: string[];
  }> {
    const report = {
      totalInProgress: 0,
      recovered: 0,
      skipped: 0,
      errors: [] as string[],
      recoveredTasks: [] as string[]
    };

    try {
      this.logger.info('Starting task recovery check');

      const data = await this.loadTaskData();
      const inProgressTasks = data.tasks.filter(t => t.status === 'assigned' || t.status === 'active');
      report.totalInProgress = inProgressTasks.length;

      if (inProgressTasks.length === 0) {
        this.logger.info('No in-progress tasks found to recover');
        return report;
      }

      this.logger.info('Found in-progress tasks to check', { count: inProgressTasks.length });

      // Get current team status
      const teams = await getTeamStatus();
      const activeMembers = new Set();

      teams.forEach(team => {
        team.members?.forEach((member: any) => {
          if (member.agentStatus === 'active' && member.workingStatus === 'in_progress') {
            activeMembers.add(member.sessionName);
            activeMembers.add(member.id);
          }
        });
      });

      this.logger.info('Found active working members', { count: activeMembers.size });

      // Check each in-progress task
      for (const task of inProgressTasks) {
        try {
          const isAgentActive = activeMembers.has(task.assignedSessionName) ||
                              activeMembers.has(task.assignedTeamMemberId);

          if (isAgentActive) {
            this.logger.info('Agent is still active, keeping task', { sessionName: task.assignedSessionName, taskName: task.taskName });
            report.skipped++;
            continue;
          }

          this.logger.warn('Agent is inactive, recovering task', { sessionName: task.assignedSessionName, taskName: task.taskName });

          // Move task back to open folder and clean metadata
          const recovered = await this.moveTaskBackToOpen(task);
          if (recovered) {
            // Remove from JSON tracking
            await this.removeTask(task.id);
            report.recovered++;
            report.recoveredTasks.push(task.taskName);
            this.logger.info('Successfully recovered task', { taskName: task.taskName });
          } else {
            report.errors.push(`Failed to move task back to open: ${task.taskName}`);
            this.logger.error('Failed to recover task', { taskName: task.taskName });
          }

        } catch (error) {
          const errorMsg = `Error processing task ${task.taskName}: ${error instanceof Error ? error.message : String(error)}`;
          report.errors.push(errorMsg);
          this.logger.error('Error processing task during recovery', { taskName: task.taskName, error: error instanceof Error ? error.message : String(error) });
        }
      }

      this.logger.info('Recovery complete', { recovered: report.recovered, skipped: report.skipped, errors: report.errors.length });

    } catch (error) {
      const errorMsg = `Task recovery failed: ${error instanceof Error ? error.message : String(error)}`;
      report.errors.push(errorMsg);
      this.logger.error('Task recovery failed', { error: error instanceof Error ? error.message : String(error) });
    }

    return report;
  }

  /**
   * Moves a task back to the open folder and cleans assignment metadata
   */
  private async moveTaskBackToOpen(task: InProgressTask): Promise<boolean> {
    try {
      // Check if task file still exists in in_progress
      if (!fsSync.existsSync(task.taskFilePath)) {
        this.logger.warn('Task file not found in in_progress', { taskFilePath: task.taskFilePath });
        return false;
      }

      // Read current task content
      const content = await fs.readFile(task.taskFilePath, 'utf-8');

      // Clean assignment metadata
      const cleanedContent = this.cleanAssignmentMetadata(content);

      // Calculate target path in open folder
      const openPath = task.taskFilePath.replace('/in_progress/', '/open/');
      const openDir = path.dirname(openPath);

      // Ensure open directory exists
      if (!fsSync.existsSync(openDir)) {
        await fs.mkdir(openDir, { recursive: true });
      }

      // Write cleaned content to open folder
      await fs.writeFile(openPath, cleanedContent, 'utf-8');

      // Remove from in_progress folder
      await fs.unlink(task.taskFilePath);

      this.logger.info('Moved task back to open', { from: task.taskFilePath, to: openPath });
      return true;

    } catch (error) {
      this.logger.error('Failed to move task back to open', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Removes assignment metadata sections from task content
   */
  private cleanAssignmentMetadata(content: string): string {
    // Remove ## Assignment Information section and everything after it
    // This preserves the original task content but removes assignment metadata
    const lines = content.split('\n');
    const cleanedLines = [];
    let inAssignmentSection = false;

    for (const line of lines) {
      if (line.trim().startsWith('## Assignment Information')) {
        inAssignmentSection = true;
        continue;
      }

      // If we hit another ## section after assignment, stop skipping
      if (inAssignmentSection && line.trim().startsWith('## ') && !line.includes('Assignment Information')) {
        inAssignmentSection = false;
      }

      if (!inAssignmentSection) {
        cleanedLines.push(line);
      }
    }

    // Remove trailing empty lines
    while (cleanedLines.length > 0 && cleanedLines[cleanedLines.length - 1].trim() === '') {
      cleanedLines.pop();
    }

    return cleanedLines.join('\n');
  }
}
