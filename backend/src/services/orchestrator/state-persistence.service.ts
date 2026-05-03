/**
 * State Persistence Service
 *
 * Manages saving and restoring orchestrator state for
 * continuous operation across restarts.
 *
 * @module services/orchestrator/state-persistence
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJson } from '../../utils/file-io.utils.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import {
  OrchestratorState,
  ConversationState,
  TaskState,
  AgentState,
  ProjectState,
  SelfImprovementState,
  OrchestratorMetadata,
  CheckpointReason,
  OrchestratorMode,
  ResumeInstructions,
  STATE_PATHS,
  STATE_VERSION,
  MAX_PERSISTED_MESSAGES,
  CHECKPOINT_INTERVAL_MS,
  DEFAULT_ORCHESTRATOR_MODE,
  isValidOrchestratorMode,
} from '../../types/orchestrator-state.types.js';

/**
 * State persistence service singleton
 */
let statePersistenceInstance: StatePersistenceService | null = null;

/**
 * StatePersistenceService class
 *
 * Handles all state persistence operations including:
 * - Saving/loading orchestrator state
 * - Creating and restoring backups
 * - Generating resume instructions after restart
 * - Periodic checkpointing
 *
 * @example
 * ```typescript
 * const service = getStatePersistenceService();
 * const previousState = await service.initialize();
 *
 * if (previousState) {
 *   const instructions = service.generateResumeInstructions(previousState);
 *   // Resume tasks and conversations
 * }
 * ```
 */
export class StatePersistenceService {
  private stateDir: string;
  private currentState: OrchestratorState | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private startTime: Date;
  private restartCount: number = 0;
  private initialized: boolean = false;
  private logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('StatePersistence');

  /**
   * Create a new StatePersistenceService
   *
   * @param baseDir - Base directory for state storage (defaults to home directory)
   */
  constructor(baseDir?: string) {
    this.stateDir = path.join(baseDir || os.homedir(), STATE_PATHS.STATE_DIR);
    this.startTime = new Date();
  }

  /**
   * Initialize the state persistence service
   *
   * Creates state directories and loads previous state if available.
   *
   * @returns Previous state if available, null otherwise
   */
  async initialize(): Promise<OrchestratorState | null> {
    // Ensure state directory exists
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.mkdir(path.join(this.stateDir, STATE_PATHS.BACKUP_DIR), {
      recursive: true,
    });
    await fs.mkdir(path.join(this.stateDir, STATE_PATHS.SELF_IMPROVEMENT_DIR), {
      recursive: true,
    });

    // Try to load existing state
    const previousState = await this.loadState();

    if (previousState) {
      this.restartCount = (previousState.metadata.restartCount || 0) + 1;
      this.logger.info('Loaded state', { checkpointedAt: previousState.checkpointedAt });
      this.logger.info('Restart count', { restartCount: this.restartCount });
    }

    // Initialize current state
    this.currentState = this.createEmptyState();

    // Onboarding v3 (B2): top-level scalars on `OrchestratorState` (mode)
    // restore automatically into the fresh currentState so `getMode()`
    // returns the correct value across restart. Entity collections
    // (conversations, tasks, agents, projects) intentionally do NOT
    // auto-restore here — callers consume `previousState` from the return
    // value and re-add entities they want to resume. This matches the
    // existing "fresh currentState, generate resume instructions" pattern.
    if (previousState && isValidOrchestratorMode(previousState.mode)) {
      this.currentState.mode = previousState.mode;
    }

    this.initialized = true;

    // Start periodic checkpointing
    this.startPeriodicCheckpoint();

    return previousState;
  }

  /**
   * Check if service is initialized
   *
   * @returns True if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Create empty state structure
   *
   * @returns A new empty orchestrator state
   */
  private createEmptyState(): OrchestratorState {
    return {
      id: `state-${Date.now()}`,
      version: STATE_VERSION,
      checkpointedAt: new Date().toISOString(),
      checkpointReason: 'scheduled',
      // Onboarding v3 (B2): always start with the default mode. The orc
      // bootstrap path (`crewly-agent-runtime.service`) flips this to
      // `'onboarding'` via `setMode()` if cold-start detection (B1) fires.
      mode: DEFAULT_ORCHESTRATOR_MODE,
      conversations: [],
      tasks: [],
      agents: [],
      projects: [],
      metadata: this.createMetadata(),
    };
  }

  /**
   * Create metadata for state
   *
   * @returns Metadata object with current system info
   */
  private createMetadata(): OrchestratorMetadata {
    return {
      version: STATE_VERSION,
      hostname: os.hostname(),
      pid: process.pid,
      startedAt: this.startTime.toISOString(),
      uptimeSeconds: Math.floor(
        (Date.now() - this.startTime.getTime()) / 1000
      ),
      restartCount: this.restartCount,
    };
  }

  /**
   * Load state from disk
   *
   * @returns Previous state or null if not found
   */
  private async loadState(): Promise<OrchestratorState | null> {
    const statePath = path.join(this.stateDir, STATE_PATHS.CURRENT_STATE);

    try {
      const data = await fs.readFile(statePath, 'utf-8');
      const state = JSON.parse(data) as OrchestratorState;

      // Version check
      if (state.version !== STATE_VERSION) {
        this.logger.info('State version mismatch, migration needed');
        return await this.migrateState(state);
      }

      // Onboarding v3 (B2): backfill `mode` for state files written before
      // the field existed, and sanitize unknown values from a future
      // version that this code doesn't recognize. Treat anything we can't
      // identify as the safe default; corrupt values must not crash boot.
      if (!isValidOrchestratorMode(state.mode)) {
        if (state.mode !== undefined) {
          this.logger.warn('Persisted orchestrator mode is unknown; defaulting', {
            persistedMode: state.mode,
            defaultedTo: DEFAULT_ORCHESTRATOR_MODE,
          });
        }
        state.mode = DEFAULT_ORCHESTRATOR_MODE;
      }

      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null; // No previous state
      }
      this.logger.error('Error loading state', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * Save current state to disk
   *
   * Uses atomic file write (temp file + rename) to prevent corruption.
   *
   * @param reason - Reason for this checkpoint
   */
  async saveState(reason: CheckpointReason = 'scheduled'): Promise<void> {
    if (!this.currentState) return;

    this.currentState.checkpointedAt = new Date().toISOString();
    this.currentState.checkpointReason = reason;
    this.currentState.metadata = this.createMetadata();

    const statePath = path.join(this.stateDir, STATE_PATHS.CURRENT_STATE);
    await atomicWriteJson(statePath, this.currentState);

    this.logger.info('Checkpointed state', { reason });
  }

  /**
   * Create backup before risky operations
   *
   * @param label - Label for the backup (e.g., 'before-upgrade')
   * @returns Backup ID for restoration
   */
  async createBackup(label: string): Promise<string> {
    const backupId = `backup-${Date.now()}-${label}`;
    const backupPath = path.join(
      this.stateDir,
      STATE_PATHS.BACKUP_DIR,
      `${backupId}.json`
    );

    await this.saveState('scheduled');

    // Copy current state to backup
    const statePath = path.join(this.stateDir, STATE_PATHS.CURRENT_STATE);
    await fs.copyFile(statePath, backupPath);

    this.logger.info('Created backup', { backupId });
    return backupId;
  }

  /**
   * Restore from backup
   *
   * @param backupId - ID of backup to restore
   * @returns True if restoration succeeded
   */
  async restoreFromBackup(backupId: string): Promise<boolean> {
    const backupPath = path.join(
      this.stateDir,
      STATE_PATHS.BACKUP_DIR,
      `${backupId}.json`
    );

    try {
      const data = await fs.readFile(backupPath, 'utf-8');
      this.currentState = JSON.parse(data);

      // Save restored state as current
      await this.saveState('error_recovery');

      this.logger.info('Restored from backup', { backupId });
      return true;
    } catch (error) {
      this.logger.error('Failed to restore backup', { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * List available backups
   *
   * @returns Array of backup IDs sorted by date (newest first)
   */
  async listBackups(): Promise<string[]> {
    const backupDir = path.join(this.stateDir, STATE_PATHS.BACKUP_DIR);

    try {
      const files = await fs.readdir(backupDir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace('.json', ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Update conversation state
   *
   * Adds new conversation or updates existing one.
   * Automatically trims messages to MAX_PERSISTED_MESSAGES.
   *
   * @param conversation - Conversation state to update
   */
  updateConversation(conversation: ConversationState): void {
    if (!this.currentState) return;

    // Trim messages to max
    if (conversation.recentMessages.length > MAX_PERSISTED_MESSAGES) {
      conversation.recentMessages = conversation.recentMessages.slice(
        -MAX_PERSISTED_MESSAGES
      );
    }

    const index = this.currentState.conversations.findIndex(
      (c) => c.id === conversation.id
    );

    if (index >= 0) {
      this.currentState.conversations[index] = conversation;
    } else {
      this.currentState.conversations.push(conversation);
    }
  }

  /**
   * Remove a conversation
   *
   * @param conversationId - ID of conversation to remove
   */
  removeConversation(conversationId: string): void {
    if (!this.currentState) return;
    this.currentState.conversations = this.currentState.conversations.filter(
      (c) => c.id !== conversationId
    );
  }

  /**
   * Update task state
   *
   * @param task - Task state to update
   */
  updateTask(task: TaskState): void {
    if (!this.currentState) return;

    const index = this.currentState.tasks.findIndex((t) => t.id === task.id);

    if (index >= 0) {
      this.currentState.tasks[index] = task;
    } else {
      this.currentState.tasks.push(task);
    }
  }

  /**
   * Remove a task
   *
   * @param taskId - ID of task to remove
   */
  removeTask(taskId: string): void {
    if (!this.currentState) return;
    this.currentState.tasks = this.currentState.tasks.filter(
      (t) => t.id !== taskId
    );
  }

  /**
   * Update agent state
   *
   * @param agent - Agent state to update
   */
  updateAgent(agent: AgentState): void {
    if (!this.currentState) return;

    const index = this.currentState.agents.findIndex(
      (a) => a.sessionName === agent.sessionName
    );

    if (index >= 0) {
      this.currentState.agents[index] = agent;
    } else {
      this.currentState.agents.push(agent);
    }
  }

  /**
   * Remove an agent
   *
   * @param sessionName - Session name of agent to remove
   */
  removeAgent(sessionName: string): void {
    if (!this.currentState) return;
    this.currentState.agents = this.currentState.agents.filter(
      (a) => a.sessionName !== sessionName
    );
  }

  /**
   * Update project state
   *
   * @param project - Project state to update
   */
  updateProject(project: ProjectState): void {
    if (!this.currentState) return;

    const index = this.currentState.projects.findIndex(
      (p) => p.id === project.id
    );

    if (index >= 0) {
      this.currentState.projects[index] = project;
    } else {
      this.currentState.projects.push(project);
    }
  }

  /**
   * Remove a project
   *
   * @param projectId - ID of project to remove
   */
  removeProject(projectId: string): void {
    if (!this.currentState) return;
    this.currentState.projects = this.currentState.projects.filter(
      (p) => p.id !== projectId
    );
  }

  /**
   * Update self-improvement state
   *
   * @param state - Self-improvement state to set
   */
  updateSelfImprovement(state: SelfImprovementState): void {
    if (!this.currentState) return;
    this.currentState.selfImprovement = state;
  }

  /**
   * Set the orchestrator's runtime mode (Onboarding v3 — B2).
   *
   * Called by the orc bootstrap path (`crewly-agent-runtime.service`)
   * after cold-start detection. Idempotent — repeated calls with the same
   * mode are no-ops aside from a debug log. The mode is persisted on the
   * next checkpoint (`saveState`), which the bootstrap path triggers
   * explicitly so a restart mid-conversation resumes in the right mode.
   *
   * @param mode - The new orchestrator mode
   */
  setMode(mode: OrchestratorMode): void {
    if (!this.currentState) return;
    if (this.currentState.mode === mode) {
      this.logger.debug('Orchestrator mode unchanged', { mode });
      return;
    }
    this.logger.info('Orchestrator mode changed', {
      from: this.currentState.mode ?? DEFAULT_ORCHESTRATOR_MODE,
      to: mode,
    });
    this.currentState.mode = mode;
  }

  /**
   * Get the orchestrator's current runtime mode.
   *
   * Returns `DEFAULT_ORCHESTRATOR_MODE` when state is uninitialized or the
   * field is missing; never returns undefined so callers can branch
   * unambiguously on the union value.
   *
   * @returns Current orchestrator mode (defaults to `'normal'`)
   */
  getMode(): OrchestratorMode {
    return this.currentState?.mode ?? DEFAULT_ORCHESTRATOR_MODE;
  }

  /**
   * Clear self-improvement state
   */
  clearSelfImprovement(): void {
    if (!this.currentState) return;
    this.currentState.selfImprovement = undefined;
  }

  /**
   * Generate resume instructions from previous state
   *
   * Creates instructions for the orchestrator to resume work
   * after a restart.
   *
   * @param previousState - The state from before restart
   * @returns Instructions for resuming work
   */
  generateResumeInstructions(
    previousState: OrchestratorState
  ): ResumeInstructions {
    const instructions: ResumeInstructions = {
      resumeOrder: [],
      conversationsToResume: [],
      tasksToResume: [],
      notifications: [],
    };

    // Find in-progress tasks to resume
    const inProgressTasks = previousState.tasks.filter(
      (t) => t.status === 'in_progress' || t.status === 'paused'
    );

    for (const task of inProgressTasks) {
      instructions.tasksToResume.push({
        id: task.id,
        resumeFromCheckpoint: !!task.checkpoint,
      });
      instructions.resumeOrder.push(`task:${task.id}`);
    }

    // Find active conversations (activity in last hour)
    const oneHourAgo = Date.now() - 3600000;
    const activeConversations = previousState.conversations.filter(
      (c) => new Date(c.lastActivityAt).getTime() > oneHourAgo
    );

    for (const conv of activeConversations) {
      instructions.conversationsToResume.push({
        id: conv.id,
        resumeMessage: `I'm back after a restart. Let me continue where we left off.`,
      });
    }

    // Add notification about restart
    instructions.notifications.push({
      type: 'slack',
      message: `Crewly has restarted (restart #${
        previousState.metadata.restartCount + 1
      }). Resuming ${inProgressTasks.length} tasks and ${
        activeConversations.length
      } conversations.`,
    });

    // Check for self-improvement state
    if (previousState.selfImprovement?.currentTask) {
      const siTask = previousState.selfImprovement.currentTask;
      if (siTask.status === 'implementing' || siTask.status === 'testing') {
        instructions.notifications.push({
          type: 'slack',
          message: `:warning: Self-improvement task "${siTask.description}" was in progress. Status: ${siTask.status}. Please verify the changes.`,
        });
      }
    }

    return instructions;
  }

  /**
   * Start periodic checkpoint timer
   */
  private startPeriodicCheckpoint(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
    }

    this.checkpointTimer = setInterval(async () => {
      await this.saveState('scheduled');
    }, CHECKPOINT_INTERVAL_MS);
  }

  /**
   * Stop periodic checkpointing
   */
  stopPeriodicCheckpoint(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  /**
   * Get current state (for inspection)
   *
   * @returns Current orchestrator state or null
   */
  getState(): OrchestratorState | null {
    return this.currentState;
  }

  /**
   * Get state directory path
   *
   * @returns Path to state directory
   */
  getStateDir(): string {
    return this.stateDir;
  }

  /**
   * Prepare for shutdown
   *
   * Stops periodic checkpointing and saves final state.
   */
  async prepareForShutdown(): Promise<void> {
    this.stopPeriodicCheckpoint();
    await this.saveState('before_restart');
    this.logger.info('State saved before shutdown');
  }

  /**
   * Migrate state from older version
   *
   * @param oldState - State from older version
   * @returns Migrated state or null if migration failed
   */
  private async migrateState(
    oldState: OrchestratorState
  ): Promise<OrchestratorState | null> {
    // For now, just return the state as-is
    // Add migration logic as versions evolve
    this.logger.info('Migrating state from older version', { version: oldState.version });
    return oldState;
  }

  /**
   * Clean up old backups
   *
   * Keeps the most recent backups and deletes older ones.
   *
   * @param keepCount - Number of backups to keep (default: 10)
   */
  async cleanupOldBackups(keepCount: number = 10): Promise<void> {
    const backupDir = path.join(this.stateDir, STATE_PATHS.BACKUP_DIR);

    try {
      const files = await fs.readdir(backupDir);
      const backupFiles = files.filter((f) => f.endsWith('.json')).sort().reverse();

      // Delete oldest backups beyond keepCount
      for (const file of backupFiles.slice(keepCount)) {
        await fs.unlink(path.join(backupDir, file));
        this.logger.info('Deleted old backup', { file });
      }
    } catch (error) {
      this.logger.error('Error cleaning backups', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Get singleton instance
 *
 * @returns StatePersistenceService instance
 */
export function getStatePersistenceService(): StatePersistenceService {
  if (!statePersistenceInstance) {
    statePersistenceInstance = new StatePersistenceService();
  }
  return statePersistenceInstance;
}

/**
 * Reset instance (for testing)
 */
export function resetStatePersistenceService(): void {
  if (statePersistenceInstance) {
    statePersistenceInstance.stopPeriodicCheckpoint();
  }
  statePersistenceInstance = null;
}
