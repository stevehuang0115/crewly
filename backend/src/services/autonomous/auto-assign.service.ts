/**
 * Auto-Assignment Service
 *
 * Automatically assigns tasks to idle agents based on role matching,
 * priority, and dependency rules.
 *
 * @module services/autonomous/auto-assign.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { parse as parseYAML } from 'yaml';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { TaskService, Task } from '../project/task.service.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import {
  AssignmentStrategy,
  AssignmentEvent,
  AssignmentEventType,
  QueuedTask,
  TaskAssignment,
  TaskAssignmentResult,
  TaskQueue,
  AutoAssignConfig,
  RoleMatchRule,
  FindNextTaskParams,
  FindNextTaskResult,
  AUTO_ASSIGN_CONSTANTS,
  DEFAULT_AUTO_ASSIGN_CONFIG,
  DEFAULT_ASSIGNMENT_STRATEGY,
} from '../../types/auto-assign.types.js';

/**
 * Agent workload information
 */
export interface AgentWorkload {
  /** Session name of the agent */
  sessionName: string;
  /** Agent ID */
  agentId: string;
  /** Agent's role */
  role: string;
  /** Currently assigned task IDs */
  currentTasks: string[];
  /** Tasks completed today */
  completedToday: number;
  /** Average iterations per task */
  averageIterations: number;
}

/**
 * Interface for the Auto-Assignment Service
 */
export interface IAutoAssignService {
  /**
   * Initialize the service for a project
   *
   * @param projectPath - Path to the project
   */
  initialize(projectPath: string): Promise<void>;

  /**
   * Get the assignment strategy configuration for a project
   *
   * @param projectPath - Path to the project
   * @returns Assignment strategy configuration
   */
  getConfig(projectPath: string): Promise<AssignmentStrategy>;

  /**
   * Update the assignment strategy configuration
   *
   * @param projectPath - Path to the project
   * @param config - Partial configuration to merge
   */
  setConfig(projectPath: string, config: Partial<AssignmentStrategy>): Promise<void>;

  /**
   * Assign the next available task to an agent
   *
   * @param sessionName - Agent session name
   * @returns Assignment result or null if no task available
   */
  assignNextTask(sessionName: string): Promise<TaskAssignmentResult | null>;

  /**
   * Find the next task suitable for a role
   *
   * @param params - Search parameters
   * @returns Search result with task or reason for no match
   */
  findNextTask(params: FindNextTaskParams): Promise<FindNextTaskResult>;

  /**
   * Assign a specific task to an agent
   *
   * @param taskPath - Path to the task file
   * @param sessionName - Agent session name
   * @returns Assignment result
   */
  assignTask(taskPath: string, sessionName: string): Promise<TaskAssignmentResult>;

  /**
   * Get the task queue for a project
   *
   * @param projectPath - Path to the project
   * @returns Task queue
   */
  getTaskQueue(projectPath: string): Promise<TaskQueue>;

  /**
   * Refresh the task queue from the filesystem
   *
   * @param projectPath - Path to the project
   */
  refreshQueue(projectPath: string): Promise<void>;

  /**
   * Get an agent's current workload
   *
   * @param sessionName - Agent session name
   * @returns Agent workload information
   */
  getAgentWorkload(sessionName: string): Promise<AgentWorkload>;

  /**
   * Register a handler for task assignment events
   *
   * @param handler - Event handler function
   */
  onTaskAssigned(handler: (event: AssignmentEvent) => void): void;

  /**
   * Register a handler for agent idle events
   *
   * @param handler - Event handler function
   */
  onAgentIdle(handler: (event: AssignmentEvent) => void): void;

  /**
   * Pause auto-assignment for a project
   *
   * @param projectPath - Path to the project
   */
  pauseAutoAssign(projectPath: string): Promise<void>;

  /**
   * Resume auto-assignment for a project
   *
   * @param projectPath - Path to the project
   */
  resumeAutoAssign(projectPath: string): Promise<void>;

  /**
   * Check if auto-assignment is enabled for a project
   *
   * @param projectPath - Path to the project
   * @returns True if enabled and not paused
   */
  isAutoAssignEnabled(projectPath: string): Promise<boolean>;
}

/**
 * Service for automatic task assignment to agents
 *
 * @example
 * ```typescript
 * const service = AutoAssignService.getInstance();
 * await service.initialize('/path/to/project');
 *
 * // Assign next task to an idle agent
 * const result = await service.assignNextTask('agent-session');
 * if (result) {
 *   console.log(`Assigned task ${result.taskId} to agent`);
 * }
 * ```
 */
export class AutoAssignService extends EventEmitter implements IAutoAssignService {
  private static instance: AutoAssignService | null = null;

  private readonly logger: ComponentLogger;
  private taskService: TaskService | null = null;
  private eventBus: EventBusService | null = null;
  private eventUnsubscribe: InProcessUnsubscribe | null = null;

  /** Configuration cache per project */
  private configs: Map<string, AutoAssignConfig> = new Map();
  /** Task queue cache per project */
  private queues: Map<string, TaskQueue> = new Map();
  /** Paused projects */
  private paused: Set<string> = new Set();
  /** Agent to project mapping */
  private agentProjects: Map<string, string> = new Map();
  /** Assignment history per project */
  private assignmentHistory: Map<string, TaskAssignment[]> = new Map();
  /** Daily assignment counts per agent */
  private dailyAssignments: Map<string, { date: string; count: number }> = new Map();
  /** Last assignment time per agent */
  private lastAssignmentTime: Map<string, number> = new Map();

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('AutoAssignService');
  }

  /**
   * Gets the singleton instance
   *
   * @returns The AutoAssignService instance
   */
  public static getInstance(): AutoAssignService {
    if (!AutoAssignService.instance) {
      AutoAssignService.instance = new AutoAssignService();
    }
    return AutoAssignService.instance;
  }

  /**
   * Clears the singleton instance (for testing)
   */
  public static clearInstance(): void {
    AutoAssignService.instance = null;
  }

  /**
   * Set the task service (for dependency injection/testing)
   *
   * @param service - Task service instance
   */
  public setTaskService(service: TaskService): void {
    this.taskService = service;
  }

  /**
   * Backwards-compatible no-op. Kept so existing wiring in `index.ts`
   * compiles during the TaskTrackingService deletion window. In-progress
   * task data and completion events now come from TaskPoolService and
   * EventBusService — see {@link setEventBus}.
   *
   * @deprecated Will be removed in a follow-up. Do not call from new code.
   */
  public setTaskTrackingService(_service: unknown): void {
    // intentionally empty
  }

  /**
   * Wire the EventBus so this service can react to V3 WorkItem
   * completion events. Replaces the legacy TaskTrackingService
   * `task_completed` emitter event used by {@link subscribeToEvents}.
   *
   * @param bus - The shared EventBusService
   */
  public setEventBus(bus: EventBusService): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe();
      this.eventUnsubscribe = null;
    }
    this.eventBus = bus;
  }

  /**
   * Get the task service, creating one if needed
   *
   * @param projectPath - Project path
   * @returns Task service
   */
  private getTaskService(projectPath?: string): TaskService {
    if (!this.taskService) {
      this.taskService = new TaskService(projectPath);
    }
    return this.taskService;
  }

  /**
   * Initialize the service for a project
   *
   * @param projectPath - Path to the project
   */
  public async initialize(projectPath: string): Promise<void> {
    // Load or create config
    const config = await this.loadConfig(projectPath);
    this.configs.set(projectPath, config);

    // Build initial queue
    await this.refreshQueue(projectPath);

    // Subscribe to task events
    this.subscribeToEvents(projectPath);

    this.logger.info('AutoAssignService initialized', { projectPath });
  }

  /**
   * Load configuration from file or return defaults
   *
   * @param projectPath - Project path
   * @returns Auto-assign configuration
   */
  private async loadConfig(projectPath: string): Promise<AutoAssignConfig> {
    const configPath = path.join(
      projectPath,
      AUTO_ASSIGN_CONSTANTS.PATHS.CONFIG_DIR,
      AUTO_ASSIGN_CONSTANTS.PATHS.CONFIG_FILE
    );

    try {
      if (existsSync(configPath)) {
        const content = await fs.readFile(configPath, 'utf-8');
        const parsed = parseYAML(content) as Partial<AutoAssignConfig>;

        // Merge with defaults
        return {
          enabled: parsed.enabled ?? DEFAULT_AUTO_ASSIGN_CONFIG.enabled,
          strategy: {
            ...DEFAULT_ASSIGNMENT_STRATEGY,
            ...parsed.strategy,
            roleMatching:
              parsed.strategy?.roleMatching ?? DEFAULT_ASSIGNMENT_STRATEGY.roleMatching,
            loadBalancing: {
              ...DEFAULT_ASSIGNMENT_STRATEGY.loadBalancing,
              ...parsed.strategy?.loadBalancing,
            },
            dependencies: {
              ...DEFAULT_ASSIGNMENT_STRATEGY.dependencies,
              ...parsed.strategy?.dependencies,
            },
          },
          notifications: {
            ...DEFAULT_AUTO_ASSIGN_CONFIG.notifications,
            ...parsed.notifications,
          },
          limits: {
            ...DEFAULT_AUTO_ASSIGN_CONFIG.limits,
            ...parsed.limits,
          },
        };
      }
    } catch (error) {
      this.logger.warn('Failed to load config, using defaults', { projectPath, error });
    }

    return { ...DEFAULT_AUTO_ASSIGN_CONFIG };
  }

  /**
   * Get the assignment strategy configuration for a project
   *
   * @param projectPath - Path to the project
   * @returns Assignment strategy configuration
   */
  public async getConfig(projectPath: string): Promise<AssignmentStrategy> {
    if (!this.configs.has(projectPath)) {
      const config = await this.loadConfig(projectPath);
      this.configs.set(projectPath, config);
    }
    return this.configs.get(projectPath)!.strategy;
  }

  /**
   * Update the assignment strategy configuration
   *
   * @param projectPath - Path to the project
   * @param config - Partial configuration to merge
   */
  public async setConfig(projectPath: string, config: Partial<AssignmentStrategy>): Promise<void> {
    const existing = this.configs.get(projectPath) || { ...DEFAULT_AUTO_ASSIGN_CONFIG };

    existing.strategy = {
      ...existing.strategy,
      ...config,
    };

    this.configs.set(projectPath, existing);
    this.logger.info('Config updated', { projectPath });
  }

  /**
   * Assign the next available task to an agent
   *
   * @param sessionName - Agent session name
   * @returns Assignment result or null if no task available
   */
  public async assignNextTask(sessionName: string): Promise<TaskAssignmentResult | null> {
    const projectPath = this.agentProjects.get(sessionName);

    if (!projectPath) {
      this.logger.warn('No project associated with agent', { sessionName });
      return null;
    }

    // Check if auto-assign is enabled and not paused
    if (!(await this.isAutoAssignEnabled(projectPath))) {
      this.logger.debug('Auto-assign disabled or paused', { projectPath });
      return null;
    }

    // Check agent workload
    const workload = await this.getAgentWorkload(sessionName);
    const config = await this.getConfig(projectPath);

    if (workload.currentTasks.length >= config.loadBalancing.maxConcurrentTasks) {
      this.logger.debug('Agent at max capacity', { sessionName, currentTasks: workload.currentTasks.length });
      return null;
    }

    // Check cooldown
    const lastTime = this.lastAssignmentTime.get(sessionName) || 0;
    const fullConfig = this.configs.get(projectPath) || DEFAULT_AUTO_ASSIGN_CONFIG;
    const cooldownMs = fullConfig.limits.cooldownBetweenTasks * 1000;

    if (Date.now() - lastTime < cooldownMs) {
      this.logger.debug('Agent in cooldown period', { sessionName });
      return null;
    }

    // Check daily limit
    const dailyRecord = this.dailyAssignments.get(sessionName);
    const today = new Date().toISOString().split('T')[0];

    if (dailyRecord && dailyRecord.date === today) {
      if (dailyRecord.count >= fullConfig.limits.maxAssignmentsPerDay) {
        this.logger.debug('Agent at daily limit', { sessionName, count: dailyRecord.count });
        return null;
      }
    }

    // Find next task
    const result = await this.findNextTask({
      sessionName,
      role: workload.role,
      projectPath,
    });

    if (!result.found || !result.task) {
      this.emitEvent({
        type: 'no_tasks',
        agentId: workload.agentId,
        sessionName,
        timestamp: new Date().toISOString(),
        metadata: { reason: result.reason },
      });
      return null;
    }

    // Assign the task
    return this.assignTask(result.task.taskPath, sessionName);
  }

  /**
   * Find the next task suitable for a role
   *
   * @param params - Search parameters
   * @returns Search result with task or reason for no match
   */
  public async findNextTask(params: FindNextTaskParams): Promise<FindNextTaskResult> {
    const { role, projectPath, preferredTaskTypes } = params;

    const queue = await this.getTaskQueue(projectPath);
    const config = await this.getConfig(projectPath);

    // Filter tasks by eligibility
    const eligibleTasks = queue.tasks.filter((task) => {
      // Check role match
      if (task.requiredRole && task.requiredRole !== role) {
        if (!this.canRoleHandleTask(role, task, config)) {
          return false;
        }
      }

      // Check if task type matches role capabilities
      if (task.taskType && !this.canRoleHandleTaskType(role, task.taskType, config)) {
        // Check if it's an exclusive task type for another role
        if (this.isExclusiveForOtherRole(role, task.taskType, config)) {
          return false;
        }
      }

      // Check dependencies
      if (config.dependencies.respectBlocking && task.blockedBy.length > 0) {
        return false;
      }

      return true;
    });

    if (eligibleTasks.length === 0) {
      // Determine reason
      if (queue.tasks.length === 0) {
        return { found: false, reason: 'no_tasks' };
      }

      const blockedCount = queue.tasks.filter((t) => t.blockedBy.length > 0).length;
      if (blockedCount === queue.tasks.length) {
        return { found: false, reason: 'all_blocked' };
      }

      return { found: false, reason: 'role_mismatch' };
    }

    // Sort by priority and preference
    const sorted = this.sortTasks(eligibleTasks, config, preferredTaskTypes);

    return {
      found: true,
      task: sorted[0],
    };
  }

  /**
   * Sort tasks by priority and preferences
   *
   * @param tasks - Tasks to sort
   * @param config - Assignment strategy
   * @param preferredTypes - Preferred task types
   * @returns Sorted tasks
   */
  private sortTasks(
    tasks: QueuedTask[],
    config: AssignmentStrategy,
    preferredTypes?: string[]
  ): QueuedTask[] {
    return [...tasks].sort((a, b) => {
      // Preferred types first
      if (preferredTypes && preferredTypes.length > 0) {
        const aPreferred = a.taskType && preferredTypes.includes(a.taskType);
        const bPreferred = b.taskType && preferredTypes.includes(b.taskType);
        if (aPreferred && !bPreferred) return -1;
        if (!aPreferred && bPreferred) return 1;
      }

      // Then by prioritization strategy
      if (config.prioritization === 'priority') {
        // Lower priority number = more important (CRITICAL=1 is highest priority)
        return a.priority - b.priority;
      } else if (config.prioritization === 'fifo') {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      } else if (config.prioritization === 'deadline') {
        // Tasks with estimated hours should be done sooner
        const aHours = a.estimatedHours ?? Infinity;
        const bHours = b.estimatedHours ?? Infinity;
        return aHours - bHours;
      }

      return 0;
    });
  }

  /**
   * Check if a role can handle a specific task
   *
   * @param role - Agent role
   * @param task - Task to check
   * @param config - Assignment strategy
   * @returns True if role can handle the task
   */
  private canRoleHandleTask(role: string, task: QueuedTask, config: AssignmentStrategy): boolean {
    // If task requires a specific role and it doesn't match, check if the role can substitute
    if (task.requiredRole && task.requiredRole !== role) {
      // Check if the current role can substitute for the required role
      // For example, 'developer' can do generic dev work, but not 'qa' tasks
      const roleHierarchy: Record<string, string[]> = {
        'frontend-developer': ['developer'],
        'backend-developer': ['developer'],
        developer: [],
        pm: [],
        tpm: [],
        pgm: [],
        qa: ['tester'],
        tester: [],
        orchestrator: [],
        designer: [],
        devops: [],
      };

      // Check if the agent's role is in the hierarchy chain for required role
      const canSubstitute = roleHierarchy[role]?.includes(task.requiredRole) || false;
      if (!canSubstitute) {
        return false;
      }
    }

    // Check task type compatibility if present
    const rule = config.roleMatching.find((r) => r.role === role);
    if (!rule) return false;

    if (task.taskType && !rule.taskTypes.includes(task.taskType)) {
      return false;
    }

    return true;
  }

  /**
   * Check if a role can handle a task type
   *
   * @param role - Agent role
   * @param taskType - Task type
   * @param config - Assignment strategy
   * @returns True if role can handle the task type
   */
  private canRoleHandleTaskType(
    role: string,
    taskType: string,
    config: AssignmentStrategy
  ): boolean {
    const rule = config.roleMatching.find((r) => r.role === role);
    if (!rule) return false;
    return rule.taskTypes.includes(taskType);
  }

  /**
   * Check if a task type is exclusive to another role
   *
   * @param role - Current role
   * @param taskType - Task type
   * @param config - Assignment strategy
   * @returns True if exclusive to another role
   */
  private isExclusiveForOtherRole(
    role: string,
    taskType: string,
    config: AssignmentStrategy
  ): boolean {
    for (const rule of config.roleMatching) {
      if (rule.role !== role && rule.exclusive && rule.taskTypes.includes(taskType)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Assign a specific task to an agent
   *
   * @param taskPath - Path to the task file
   * @param sessionName - Agent session name
   * @returns Assignment result
   */
  public async assignTask(taskPath: string, sessionName: string): Promise<TaskAssignmentResult> {
    const workload = await this.getAgentWorkload(sessionName);
    const projectPath = this.agentProjects.get(sessionName);

    if (!projectPath) {
      throw new Error(`No project associated with session: ${sessionName}`);
    }

    // Get task info
    const taskService = this.getTaskService(projectPath);
    const tasks = await taskService.getAllTasks();
    const task = tasks.find((t) => t.filePath === taskPath);

    if (!task) {
      throw new Error(`Task not found: ${taskPath}`);
    }

    const now = new Date().toISOString();

    // Create assignment record
    const assignment: TaskAssignment = {
      taskId: task.id,
      agentId: workload.agentId,
      sessionName,
      assignedAt: now,
      status: 'active',
    };

    // Add to assignment history
    const history = this.assignmentHistory.get(projectPath) || [];
    history.push(assignment);
    this.assignmentHistory.set(projectPath, history);

    // Update daily count
    const today = now.split('T')[0];
    const dailyRecord = this.dailyAssignments.get(sessionName);
    if (dailyRecord && dailyRecord.date === today) {
      dailyRecord.count++;
    } else {
      this.dailyAssignments.set(sessionName, { date: today, count: 1 });
    }

    // Update last assignment time
    this.lastAssignmentTime.set(sessionName, Date.now());

    const result: TaskAssignmentResult = {
      taskId: task.id,
      taskPath,
      agentId: workload.agentId,
      sessionName,
      assignedAt: now,
    };

    // Emit event
    this.emitEvent({
      type: 'task_assigned',
      agentId: workload.agentId,
      sessionName,
      taskId: task.id,
      timestamp: now,
      metadata: {
        taskPath,
        taskTitle: task.title,
        priority: task.priority,
      },
    });

    // Refresh queue to reflect assignment
    await this.refreshQueue(projectPath);

    this.logger.info('Task assigned', {
      taskId: task.id,
      sessionName,
      taskTitle: task.title,
    });

    return result;
  }

  /**
   * Get the task queue for a project
   *
   * @param projectPath - Path to the project
   * @returns Task queue
   */
  public async getTaskQueue(projectPath: string): Promise<TaskQueue> {
    if (!this.queues.has(projectPath)) {
      await this.refreshQueue(projectPath);
    }
    return this.queues.get(projectPath)!;
  }

  /**
   * Refresh the task queue from the filesystem
   *
   * @param projectPath - Path to the project
   */
  public async refreshQueue(projectPath: string): Promise<void> {
    const taskService = this.getTaskService(projectPath);
    const allTasks = await taskService.getAllTasks();

    // Get open tasks
    const openTasks = allTasks.filter((t) => t.status === 'open');

    // Get in-progress task IDs to check dependencies
    const inProgressTasks = allTasks.filter((t) => t.status === 'in_progress');
    const inProgressIds = new Set(inProgressTasks.map((t) => t.id));
    const openIds = new Set(openTasks.map((t) => t.id));

    // Build queue
    const queuedTasks: QueuedTask[] = openTasks.map((task) => {
      // Parse dependencies from task content if available
      const dependencies = this.extractDependencies(task);

      // Calculate blocked by - tasks that are dependencies and not yet done
      const blockedBy = dependencies.filter((d) => inProgressIds.has(d) || openIds.has(d));

      return {
        taskId: task.id,
        taskPath: task.filePath,
        title: task.title,
        priority: this.getPriorityValue(task.priority),
        taskType: this.extractTaskType(task),
        requiredRole: task.assignee,
        dependencies,
        blockedBy,
        createdAt: task.createdAt,
        estimatedHours: this.extractEstimatedHours(task),
        labels: this.extractLabels(task),
      };
    });

    // Get assignment history
    const assignments = this.assignmentHistory.get(projectPath) || [];
    const config = await this.getConfig(projectPath);

    this.queues.set(projectPath, {
      projectPath,
      tasks: queuedTasks,
      assignments,
      config,
      lastUpdated: new Date().toISOString(),
    });

    this.logger.debug('Queue refreshed', {
      projectPath,
      taskCount: queuedTasks.length,
    });
  }

  /**
   * Convert priority string to numeric value
   *
   * @param priority - Priority string
   * @returns Numeric priority value
   */
  private getPriorityValue(priority: string): number {
    const values: Record<string, number> = {
      critical: AUTO_ASSIGN_CONSTANTS.PRIORITY.CRITICAL,
      high: AUTO_ASSIGN_CONSTANTS.PRIORITY.HIGH,
      medium: AUTO_ASSIGN_CONSTANTS.PRIORITY.MEDIUM,
      low: AUTO_ASSIGN_CONSTANTS.PRIORITY.LOW,
      backlog: AUTO_ASSIGN_CONSTANTS.PRIORITY.BACKLOG,
    };
    return values[priority.toLowerCase()] ?? AUTO_ASSIGN_CONSTANTS.PRIORITY.MEDIUM;
  }

  /**
   * Extract task type from task
   *
   * @param task - Task object
   * @returns Task type or undefined
   */
  private extractTaskType(task: Task): string | undefined {
    // Try to infer from title or labels
    const title = task.title.toLowerCase();
    const taskTypes = Object.values(AUTO_ASSIGN_CONSTANTS.TASK_TYPES).flat();

    for (const type of taskTypes) {
      if (title.includes(type)) {
        return type;
      }
    }

    return undefined;
  }

  /**
   * Extract dependencies from task
   *
   * @param task - Task object
   * @returns Array of dependency task IDs
   */
  private extractDependencies(task: Task): string[] {
    // Look for dependency patterns in description
    const depPattern = /depends on:?\s*([^\n]+)/i;
    const match = task.description.match(depPattern);

    if (match) {
      return match[1]
        .split(/[,\s]+/)
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
    }

    return [];
  }

  /**
   * Extract estimated hours from task
   *
   * @param task - Task object
   * @returns Estimated hours or undefined
   */
  private extractEstimatedHours(task: Task): number | undefined {
    const estPattern = /estimated:?\s*(\d+)\s*(hours?|h)/i;
    const match = task.description.match(estPattern);

    if (match) {
      return parseInt(match[1], 10);
    }

    return undefined;
  }

  /**
   * Extract labels from task
   *
   * @param task - Task object
   * @returns Array of labels
   */
  private extractLabels(task: Task): string[] {
    // Look for label patterns
    const labelPattern = /labels?:?\s*([^\n]+)/i;
    const match = task.description.match(labelPattern);

    if (match) {
      return match[1]
        .split(/[,\s]+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    }

    return [];
  }

  /**
   * Get an agent's current workload
   *
   * @param sessionName - Agent session name
   * @returns Agent workload information
   */
  public async getAgentWorkload(sessionName: string): Promise<AgentWorkload> {
    // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
    // Replaces TaskTrackingService.getAllInProgressTasks with V3 pool query
    // filtered by `target` (session name).
    const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
    const items = await TaskPoolService.getInstance().getAllItems();
    const agentTasks = items.filter(
      (wi) =>
        wi.target === sessionName &&
        (wi.status === 'queued' || wi.status === 'accepted' || wi.status === 'running'),
    );

    // Calculate completed today
    const today = new Date().toISOString().split('T')[0];
    const dailyRecord = this.dailyAssignments.get(sessionName);
    const completedToday = dailyRecord?.date === today ? dailyRecord.count : 0;

    return {
      sessionName,
      agentId: sessionName,
      role: this.getAgentRole(sessionName),
      currentTasks: agentTasks.map((t) => t.id),
      completedToday,
      averageIterations: 0, // Would need iteration tracking to calculate
    };
  }

  /**
   * Get the role for an agent session
   *
   * @param sessionName - Session name
   * @returns Role string
   */
  private getAgentRole(sessionName: string): string {
    // Parse role from session name convention (e.g., "project-developer-1")
    const parts = sessionName.split('-');
    if (parts.length >= 2) {
      // Common role patterns
      const roleKeywords = [
        'developer',
        'frontend-developer',
        'backend-developer',
        'qa',
        'tester',
        'pm',
        'tpm',
        'pgm',
        'designer',
        'orchestrator',
      ];

      for (const keyword of roleKeywords) {
        if (sessionName.includes(keyword)) {
          return keyword;
        }
      }
    }

    return 'developer'; // Default role
  }

  /**
   * Register an agent with a project
   *
   * @param sessionName - Agent session name
   * @param projectPath - Project path
   */
  public registerAgent(sessionName: string, projectPath: string): void {
    this.agentProjects.set(sessionName, projectPath);
    this.logger.debug('Agent registered', { sessionName, projectPath });
  }

  /**
   * Unregister an agent
   *
   * @param sessionName - Agent session name
   */
  public unregisterAgent(sessionName: string): void {
    this.agentProjects.delete(sessionName);
    this.logger.debug('Agent unregistered', { sessionName });
  }

  /**
   * Emit an assignment event
   *
   * @param event - Event to emit
   */
  private emitEvent(event: AssignmentEvent): void {
    this.emit(event.type, event);
    this.emit('assignment_event', event);
    this.logger.debug('Event emitted', { type: event.type, taskId: event.taskId });
  }

  /**
   * Register a handler for task assignment events
   *
   * @param handler - Event handler function
   */
  public onTaskAssigned(handler: (event: AssignmentEvent) => void): void {
    this.on('task_assigned', handler);
  }

  /**
   * Register a handler for agent idle events
   *
   * @param handler - Event handler function
   */
  public onAgentIdle(handler: (event: AssignmentEvent) => void): void {
    this.on('agent_idle', handler);
  }

  /**
   * Subscribe to task completion events for a project.
   *
   * V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
   * Replaces the legacy TaskTrackingService `task_completed` emitter
   * subscription with an EventBus `task:done_by_worker` subscription.
   *
   * @param projectPath - Project path
   */
  private subscribeToEvents(projectPath: string): void {
    if (!this.eventBus) {
      this.logger.warn('EventBus not wired; auto-assign cannot react to completion events', {
        projectPath,
      });
      return;
    }

    // Listen for V3 task completion events. AgentEvent carries the
    // optional `workItemId` (BRIDGE-1 autonomy correlation field) and
    // falls back to `taskId`; we read the WI from the pool to recover
    // the target session name.
    this.eventUnsubscribe = this.eventBus.onInProcess('task:done_by_worker', async (event) => {
      const eventAny = event as { workItemId?: string; taskId?: string };
      const workItemId = eventAny.workItemId ?? eventAny.taskId ?? '';
      if (!workItemId) return;
      const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
      const wi = await TaskPoolService.getInstance().findWorkItem(workItemId);
      if (!wi) return;

      // Adapter: synthesize the legacy task shape the rest of this method expects.
      const task = {
        id: wi.id,
        assignedSessionName: wi.target ?? '',
      };
      const sessionName = task.assignedSessionName;
      const agentProjectPath = this.agentProjects.get(sessionName);

      if (agentProjectPath === projectPath) {
        // Update assignment history
        const history = this.assignmentHistory.get(projectPath) || [];
        const assignment = history.find(
          (a) => a.taskId === task.id && a.status === 'active'
        );
        if (assignment) {
          assignment.status = 'completed';
          assignment.completedAt = new Date().toISOString();
        }

        // Emit completion event. V3 doesn't carry team-member-id on the
        // WorkItem so we use the session name as the agentId; downstream
        // consumers that previously needed the member-id can resolve it
        // from the team registry if necessary.
        this.emitEvent({
          type: 'task_completed',
          agentId: sessionName,
          sessionName,
          taskId: task.id,
          timestamp: new Date().toISOString(),
        });

        // Try to assign next task
        await this.assignNextTask(sessionName);
      }
    });
  }

  /**
   * Pause auto-assignment for a project
   *
   * @param projectPath - Path to the project
   */
  public async pauseAutoAssign(projectPath: string): Promise<void> {
    this.paused.add(projectPath);
    this.logger.info('Auto-assign paused', { projectPath });
  }

  /**
   * Resume auto-assignment for a project
   *
   * @param projectPath - Path to the project
   */
  public async resumeAutoAssign(projectPath: string): Promise<void> {
    this.paused.delete(projectPath);
    this.logger.info('Auto-assign resumed', { projectPath });
  }

  /**
   * Check if auto-assignment is enabled for a project
   *
   * @param projectPath - Path to the project
   * @returns True if enabled and not paused
   */
  public async isAutoAssignEnabled(projectPath: string): Promise<boolean> {
    if (this.paused.has(projectPath)) {
      return false;
    }

    const config = this.configs.get(projectPath);
    return config?.enabled ?? false;
  }

  /**
   * Mark a task as failed
   *
   * @param taskId - Task ID
   * @param sessionName - Agent session name
   * @param reason - Failure reason
   */
  public async markTaskFailed(
    taskId: string,
    sessionName: string,
    reason?: string
  ): Promise<void> {
    const projectPath = this.agentProjects.get(sessionName);

    if (projectPath) {
      const history = this.assignmentHistory.get(projectPath) || [];
      const assignment = history.find((a) => a.taskId === taskId && a.status === 'active');

      if (assignment) {
        assignment.status = 'failed';
      }

      this.emitEvent({
        type: 'task_failed',
        agentId: assignment?.agentId || sessionName,
        sessionName,
        taskId,
        timestamp: new Date().toISOString(),
        metadata: { reason },
      });
    }
  }

  /**
   * Get assignment statistics for a project
   *
   * @param projectPath - Project path
   * @returns Assignment statistics
   */
  public getStatistics(projectPath: string): {
    totalAssigned: number;
    completed: number;
    failed: number;
    active: number;
  } {
    const history = this.assignmentHistory.get(projectPath) || [];

    return {
      totalAssigned: history.length,
      completed: history.filter((a) => a.status === 'completed').length,
      failed: history.filter((a) => a.status === 'failed').length,
      active: history.filter((a) => a.status === 'active').length,
    };
  }

  /**
   * Clear all cached data (for testing)
   */
  public clearCache(): void {
    this.configs.clear();
    this.queues.clear();
    this.paused.clear();
    this.agentProjects.clear();
    this.assignmentHistory.clear();
    this.dailyAssignments.clear();
    this.lastAssignmentTime.clear();
  }
}
