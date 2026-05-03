/**
 * Orchestrator State Persistence Types
 *
 * Types for saving and restoring orchestrator state across
 * restarts, enabling continuous operation and self-improvement.
 *
 * @module types/orchestrator-state
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * State file paths configuration
 */
export const STATE_PATHS = {
  STATE_DIR: '.crewly/state',
  CURRENT_STATE: 'orchestrator-state.json',
  BACKUP_DIR: 'backups',
  SELF_IMPROVEMENT_DIR: 'self-improvement',
} as const;

/**
 * State version for migrations
 */
export const STATE_VERSION = '1.0.0';

/**
 * Maximum messages to persist per conversation
 */
export const MAX_PERSISTED_MESSAGES = 50;

/**
 * Checkpoint interval in milliseconds (1 minute)
 */
export const CHECKPOINT_INTERVAL_MS = 60000;

// =============================================================================
// Orchestrator Mode (Onboarding v3 — B2)
// =============================================================================

/**
 * Top-level orchestrator runtime mode.
 *
 * - `'normal'` — Standard orchestrator behavior; the role prompt at
 *   `config/roles/orchestrator/prompt.md` is loaded and the full skill set
 *   is available.
 * - `'onboarding'` — Cold-start onboarding mode. The `ONBOARDING_MODE_SYSTEM_PROMPT`
 *   is loaded instead of the normal role prompt, and the skill set is
 *   filtered to the `ONBOARDING_SKILL_ALLOWLIST` (recall/remember/record-learning
 *   + 2 onboarding-specific skills). `delegate-task`, `start-agent`, `stop-agent`
 *   are disabled — orc cannot delegate while onboarding the customer.
 * - `'onboarding-provisioning'` — Future-reserved (Onboarding v3 W3+, materializer
 *   2-phase commit). Declared now so persisted states from later milestones
 *   round-trip cleanly through `state-persistence.service`. Not wired in W1.
 *
 * Detection of the cold-start condition lives in `OnboardingBootstrapService`
 * (B1); the mode is set during orc bootstrap by `crewly-agent-runtime.service`
 * before the system prompt is composed.
 */
export type OrchestratorMode =
  | 'normal'
  | 'onboarding'
  | 'onboarding-provisioning';

/**
 * Valid orchestrator modes array — single source of truth for runtime
 * validation and the type guard below.
 */
export const ORCHESTRATOR_MODES: readonly OrchestratorMode[] = [
  'normal',
  'onboarding',
  'onboarding-provisioning',
] as const;

/**
 * Default orchestrator mode used when state is freshly initialized or
 * round-tripped from an older state file that predates the `mode` field.
 */
export const DEFAULT_ORCHESTRATOR_MODE: OrchestratorMode = 'normal';

// =============================================================================
// Checkpoint Reasons
// =============================================================================

/**
 * Reasons for state checkpoint
 */
export type CheckpointReason =
  | 'scheduled' // Periodic checkpoint
  | 'before_restart' // Graceful shutdown
  | 'task_completed' // Major task milestone
  | 'user_request' // Manual checkpoint
  | 'self_improvement' // Before code changes
  | 'error_recovery'; // After error

/**
 * Valid checkpoint reasons array
 */
export const CHECKPOINT_REASONS: CheckpointReason[] = [
  'scheduled',
  'before_restart',
  'task_completed',
  'user_request',
  'self_improvement',
  'error_recovery',
];

// =============================================================================
// Message and Conversation State
// =============================================================================

/**
 * Persisted message (minimal for storage)
 */
export interface PersistedMessage {
  /** Role of the message sender */
  role: 'user' | 'orchestrator' | 'agent';
  /** Message content */
  content: string;
  /** ISO timestamp */
  timestamp: string;
  /** Agent name if from agent */
  agentName?: string;
}

/**
 * Conversation source types
 */
export type ConversationSource = 'chat' | 'slack' | 'api';

/**
 * Conversation state for persistence
 */
export interface ConversationState {
  /** Unique conversation ID */
  id: string;
  /** Source of the conversation */
  source: ConversationSource;
  /** Last N messages for context */
  recentMessages: PersistedMessage[];
  /** Summary of older conversation */
  summary?: string;
  /** User ID if applicable */
  userId?: string;
  /** Channel/thread info for Slack */
  slackContext?: {
    channelId: string;
    threadTs: string;
  };
  /** Conversation topic/intent */
  currentTopic?: string;
  /** Last activity timestamp */
  lastActivityAt: string;
}

// =============================================================================
// Task State
// =============================================================================

/**
 * Task status values
 */
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'paused' | 'completed';

/**
 * Task priority levels
 */
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

/**
 * Task progress information
 */
export interface TaskProgress {
  /** Percentage complete (0-100) */
  percentComplete: number;
  /** Current step description */
  currentStep?: string;
  /** Completed steps */
  completedSteps: string[];
  /** Remaining steps */
  remainingSteps?: string[];
  /** Any blockers */
  blockers?: string[];
}

/**
 * Task checkpoint for detailed resume
 */
export interface TaskCheckpoint {
  /** Step index when checkpointed */
  stepIndex: number;
  /** Partial work data */
  workData?: Record<string, unknown>;
  /** Files modified */
  modifiedFiles?: string[];
  /** Agent context */
  agentContext?: string;
  /** Commands/actions pending */
  pendingActions?: string[];
}

/**
 * Task state for persistence
 */
export interface TaskState {
  /** Unique task ID */
  id: string;
  /** Task title */
  title: string;
  /** Task description */
  description: string;
  /** Current status */
  status: TaskStatus;
  /** Priority level */
  priority: TaskPriority;

  /** Assignment info */
  assignedTo?: string; // Agent session name
  /** Team ID if assigned to team */
  teamId?: string;
  /** Project ID */
  projectId?: string;

  /** Progress tracking */
  progress: TaskProgress;

  /** Dependencies */
  blockedBy?: string[];
  /** Tasks this blocks */
  blocks?: string[];

  /** Creation timestamp */
  createdAt: string;
  /** Start timestamp */
  startedAt?: string;
  /** Last activity timestamp */
  lastActivityAt?: string;
  /** Completion timestamp */
  completedAt?: string;

  /** Checkpoint for resume */
  checkpoint?: TaskCheckpoint;
}

// =============================================================================
// Agent State
// =============================================================================

/**
 * Agent status values
 */
export type AgentStateStatus = 'active' | 'inactive' | 'busy' | 'error';

/**
 * Agent last activity info
 */
export interface AgentLastActivity {
  /** Activity type */
  type: string;
  /** Activity timestamp */
  timestamp: string;
  /** Activity description */
  description?: string;
}

/**
 * Agent state for persistence
 */
export interface AgentState {
  /** Session name */
  sessionName: string;
  /** Agent ID */
  agentId: string;
  /** Agent role */
  role: string;
  /** Current status */
  status: AgentStateStatus;

  /** Current task ID */
  currentTaskId?: string;
  /** Current project path */
  currentProjectPath?: string;

  /** Context summary for resume */
  contextSummary?: string;

  /** Last known activity */
  lastActivity?: AgentLastActivity;
}

// =============================================================================
// Project State
// =============================================================================

/**
 * Project status values
 */
export type ProjectStateStatus = 'active' | 'paused' | 'completed';

/**
 * Git state information
 */
export interface GitState {
  /** Current branch */
  branch: string;
  /** Last commit hash */
  lastCommit: string;
  /** Whether there are uncommitted changes */
  hasUncommittedChanges: boolean;
}

/**
 * Build state information
 */
export interface BuildState {
  /** Last build status */
  lastBuildStatus: 'success' | 'failed' | 'unknown';
  /** Last build timestamp */
  lastBuildAt?: string;
  /** Whether tests pass */
  testsPass: boolean;
}

/**
 * Project state for persistence
 */
export interface ProjectState {
  /** Project ID */
  id: string;
  /** Project name */
  name: string;
  /** Project path */
  path: string;
  /** Current status */
  status: ProjectStateStatus;

  /** Active task IDs */
  activeTasks: string[];
  /** Active agent session names */
  activeAgents: string[];

  /** Git state */
  gitState?: GitState;
  /** Build/test state */
  buildState?: BuildState;
}

// =============================================================================
// Self-Improvement State
// =============================================================================

/**
 * Self-improvement task status
 */
export type SelfImprovementStatus =
  | 'planning'
  | 'implementing'
  | 'testing'
  | 'validating'
  | 'completed'
  | 'rolled_back';

/**
 * Change risk level
 */
export type ChangeRisk = 'low' | 'medium' | 'high';

/**
 * Planned code change
 */
export interface PlannedChange {
  /** Target file path */
  file: string;
  /** Change type */
  type: 'create' | 'modify' | 'delete';
  /** Change description */
  description: string;
  /** Estimated risk level */
  risk: ChangeRisk;
}

/**
 * File backup for rollback
 */
export interface FileBackup {
  /** Original file path */
  path: string;
  /** Original file content */
  originalContent: string;
  /** Backup file path */
  backupPath: string;
  /** Content checksum */
  checksum: string;
}

/**
 * Validation check type
 */
export type ValidationCheckType = 'build' | 'test' | 'lint' | 'custom';

/**
 * Validation check definition
 */
export interface ValidationCheck {
  /** Check name */
  name: string;
  /** Check type */
  type: ValidationCheckType;
  /** Command to run */
  command?: string;
  /** Whether this check is required */
  required: boolean;
  /** Whether the check passed */
  passed?: boolean;
  /** Check output */
  output?: string;
}

/**
 * Self-improvement backup state
 */
export interface SelfImprovementBackup {
  /** Backup ID */
  id: string;
  /** Creation timestamp */
  createdAt: string;
  /** Backed up files */
  files: FileBackup[];
  /** Git commit before changes */
  gitCommit?: string;
}

/**
 * Self-improvement current task
 */
export interface SelfImprovementTask {
  /** Task ID */
  id: string;
  /** Task description */
  description: string;
  /** Target files */
  targetFiles: string[];
  /** Planned changes */
  plannedChanges: PlannedChange[];
  /** Current status */
  status: SelfImprovementStatus;
}

/**
 * Rollback plan
 */
export interface RollbackPlan {
  /** Rollback steps */
  steps: string[];
  /** Git commit to revert to */
  gitCommit?: string;
}

/**
 * Self-improvement specific state
 */
export interface SelfImprovementState {
  /** Current improvement task */
  currentTask?: SelfImprovementTask;
  /** Backup state before changes */
  backup?: SelfImprovementBackup;
  /** Validation requirements */
  validationChecks: ValidationCheck[];
  /** Rollback instructions */
  rollbackPlan?: RollbackPlan;
}

// =============================================================================
// Orchestrator Metadata
// =============================================================================

/**
 * Orchestrator metadata
 */
export interface OrchestratorMetadata {
  /** Crewly version */
  version: string;
  /** Hostname for identification */
  hostname: string;
  /** Process ID */
  pid: number;
  /** Start time */
  startedAt: string;
  /** Total uptime before checkpoint */
  uptimeSeconds: number;
  /** Number of restarts */
  restartCount: number;
}

// =============================================================================
// Overall State
// =============================================================================

/**
 * Overall orchestrator state
 */
export interface OrchestratorState {
  /** Unique state ID */
  id: string;
  /** Version for migration compatibility */
  version: string;
  /** State checkpoint timestamp */
  checkpointedAt: string;
  /** Reason for checkpoint */
  checkpointReason: CheckpointReason;

  /**
   * Top-level orchestrator runtime mode (Onboarding v3 — B2).
   *
   * Optional for backwards compatibility: state files written by versions
   * predating the field load with `mode === undefined`. Loaders should
   * default to `DEFAULT_ORCHESTRATOR_MODE` when absent.
   */
  mode?: OrchestratorMode;

  /** Active conversation contexts */
  conversations: ConversationState[];
  /** Pending/in-progress tasks */
  tasks: TaskState[];
  /** Agent assignments and status */
  agents: AgentState[];
  /** Project contexts */
  projects: ProjectState[];

  /** Self-improvement specific state */
  selfImprovement?: SelfImprovementState;

  /** Metadata */
  metadata: OrchestratorMetadata;
}

// =============================================================================
// State Changes and Diffs
// =============================================================================

/**
 * State change types
 */
export type StateChangeType =
  | 'conversation'
  | 'task'
  | 'agent'
  | 'project'
  | 'self_improvement';

/**
 * State change operations
 */
export type StateChangeOperation = 'add' | 'update' | 'delete';

/**
 * Individual state change
 */
export interface StateChange {
  /** Type of entity changed */
  type: StateChangeType;
  /** Operation performed */
  operation: StateChangeOperation;
  /** Entity ID */
  id: string;
  /** Change data */
  data?: unknown;
}

/**
 * State diff for incremental updates
 */
export interface StateDiff {
  /** Diff timestamp */
  timestamp: string;
  /** Changes in this diff */
  changes: StateChange[];
}

// =============================================================================
// Resume Instructions
// =============================================================================

/**
 * Conversation resume info
 */
export interface ConversationResumeInfo {
  /** Conversation ID */
  id: string;
  /** Optional message to send on resume */
  resumeMessage?: string;
}

/**
 * Task resume info
 */
export interface TaskResumeInfo {
  /** Task ID */
  id: string;
  /** Whether to resume from checkpoint */
  resumeFromCheckpoint: boolean;
}

/**
 * Resume notification
 */
export interface ResumeNotification {
  /** Notification type */
  type: 'slack' | 'log';
  /** Notification message */
  message: string;
}

/**
 * Resume instructions after restart
 */
export interface ResumeInstructions {
  /** Priority order for resumption (entity IDs) */
  resumeOrder: string[];
  /** Conversations to re-engage */
  conversationsToResume: ConversationResumeInfo[];
  /** Tasks to continue */
  tasksToResume: TaskResumeInfo[];
  /** Notifications to send */
  notifications: ResumeNotification[];
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if a value is a valid CheckpointReason
 *
 * @param value - Value to check
 * @returns True if valid CheckpointReason
 */
export function isValidCheckpointReason(value: string): value is CheckpointReason {
  return CHECKPOINT_REASONS.includes(value as CheckpointReason);
}

/**
 * Check if a value is a valid OrchestratorMode (Onboarding v3 — B2).
 *
 * Used by `state-persistence.service` when round-tripping a persisted
 * state to fall back to `DEFAULT_ORCHESTRATOR_MODE` if the file contains
 * a corrupted or future-unknown value. Narrows the input to the union.
 *
 * @param value - Value to check
 * @returns True if valid OrchestratorMode
 */
export function isValidOrchestratorMode(value: unknown): value is OrchestratorMode {
  return typeof value === 'string' && ORCHESTRATOR_MODES.includes(value as OrchestratorMode);
}

/**
 * Check if a value is a valid TaskStatus
 *
 * @param value - Value to check
 * @returns True if valid TaskStatus
 */
export function isValidTaskStatus(value: string): value is TaskStatus {
  return ['pending', 'in_progress', 'blocked', 'paused', 'completed'].includes(value);
}

/**
 * Check if a value is a valid TaskPriority
 *
 * @param value - Value to check
 * @returns True if valid TaskPriority
 */
export function isValidTaskPriority(value: string): value is TaskPriority {
  return ['low', 'medium', 'high', 'critical'].includes(value);
}

/**
 * Check if a value is a valid ConversationSource
 *
 * @param value - Value to check
 * @returns True if valid ConversationSource
 */
export function isValidConversationSource(value: string): value is ConversationSource {
  return ['chat', 'slack', 'api'].includes(value);
}
