/**
 * Extended task status — backwards-compatible superset.
 *
 * Original 5 statuses preserved for existing flat workflows.
 * New A2A-inspired statuses added for hierarchical workflows.
 */
export type InProgressTaskStatus =
  // Original statuses (unchanged)
  | 'assigned'
  | 'active'
  | 'blocked'
  | 'pending_assignment'
  | 'completed'
  // A2A-inspired statuses for hierarchical workflows
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'verifying'
  | 'failed'
  | 'cancelled'
  // Architecture Upgrade: task acceptance & clarification
  | 'accepted'
  | 'needs_clarification'
  | 'backlog'
  | 'ready'
  | 'done'
  | 'verified';

/**
 * Structured report required when an executor reports a task as blocked or failed.
 * Enforces the Try-Before-Refuse protocol — a blocked report without attempt records is invalid.
 */
export interface BlockedReport {
  /** What approaches the agent attempted before reporting blocked */
  whatTried: string[];
  /** Specific errors or obstacles encountered */
  whatFailed: string;
  /** What would unblock the agent */
  whatNeeded: string;
  /** Any partial solution that exists */
  partialResult?: string;
}

/**
 * Structured artifact produced by a task.
 * Inspired by A2A Artifact concept.
 */
export interface TaskArtifact {
  /** Unique artifact identifier */
  id: string;
  /** Human-readable artifact name */
  name: string;
  /** Artifact content type */
  type: 'file' | 'text' | 'url' | 'structured';
  /** File path, text content, URL, or JSON string */
  content: string;
  /** MIME type hint (e.g. 'application/json') */
  mediaType?: string;
  /** ISO timestamp */
  createdAt: string;
}

/**
 * A single entry in the task status history.
 * Provides audit trail for task lifecycle.
 */
export interface TaskStatusEntry {
  /** ISO timestamp of the status change */
  timestamp: string;
  /** Previous status */
  fromStatus: InProgressTaskStatus;
  /** New status */
  toStatus: InProgressTaskStatus;
  /** Human-readable explanation of the change */
  message?: string;
  /** Member ID who triggered the change */
  reportedBy: string;
}

/**
 * Verification result from a delegator (Team Leader or Orchestrator).
 * Set when the delegator reviews task output.
 */
export interface TaskVerificationResult {
  /** Verification outcome */
  verdict: 'approved' | 'rejected' | 'revision_needed';
  /** Feedback for the assignee */
  feedback?: string;
  /** Member ID of the verifier */
  verifiedBy: string;
  /** ISO timestamp of the verification */
  verifiedAt: string;
}

export interface InProgressTask {
  id: string;
  projectId: string;
  teamId: string;
  taskFilePath: string; // e.g. "/path/to/project/.crewly/tasks/m1_foundation/open/01_setup_tpm.md"
  taskName: string;
  targetRole: string; // tpm, pgm, dev, qa
  assignedTeamMemberId: string;
  assignedSessionName: string;
  assignedAt: string; // ISO timestamp
  status: InProgressTaskStatus;
  lastCheckedAt?: string;
  blockReason?: string;
  priority?: 'low' | 'medium' | 'high';
  /** IDs of scheduled checks linked to this task for auto-cleanup on completion */
  scheduleIds?: string[];
  /** IDs of event subscriptions linked to this task for auto-cleanup on completion */
  subscriptionIds?: string[];

  // === Hierarchy & Delegation fields ===

  /** Member ID who created/delegated this task. */
  delegatedBy?: string;
  /** Session name of the delegator (for direct reply routing). */
  delegatedBySession?: string;
  /** Parent task ID for sub-task decomposition (supports recursive nesting). */
  parentTaskId?: string;
  /** Child task IDs decomposed from this task. */
  childTaskIds?: string[];
  /** Hierarchy level of the assignee (denormalized for query efficiency). */
  assigneeHierarchyLevel?: number;

  // === A2A-inspired structured results ===

  /** Structured artifacts produced by this task. */
  artifacts?: TaskArtifact[];
  /** Chronological record of status changes (audit trail). */
  statusHistory?: TaskStatusEntry[];
  /** ISO timestamp when task reached a terminal state. */
  completedAt?: string;
  /** Verification result from the delegator. */
  verificationResult?: TaskVerificationResult;

  // === Communication context ===

  /** Slack thread context for threaded notifications (#137). */
  slackContext?: {
    channelId: string;
    threadTs: string;
  };

  // === Quality Scoring (#174) ===

  // === Architecture Upgrade: Task Acceptance fields ===

  /** ISO timestamp when the agent accepted this task */
  acceptedAt?: string;
  /** Agent's structured understanding of the task (from accept handshake) */
  acceptanceNote?: string;
  /** What the agent needs clarified (set when status is needs_clarification) */
  clarificationRequest?: string;
  /** Structured block report (required when status is blocked) */
  blockedReport?: BlockedReport;

  /** Quality score (0-100) assigned by the auditor after task completion. */
  qualityScore?: number;

  /** ISO timestamp when qualityScore was assigned. */
  scoredAt?: string;

  /** Member/session that scored this task. */
  scoredBy?: string;

  // === Working Memory (Memory v2 Phase 2) ===

  /** Free-form working notes persisted across sessions.
   *  Agent saves current hypothesis, retry state, partial results here. */
  workingNotes?: string;

  /** ISO timestamp of last working notes update */
  workingNotesUpdatedAt?: string;
}

export interface TaskTrackingData {
  tasks: InProgressTask[];
  lastUpdated: string;
  version: string;
}

export interface TaskStatus {
  status: 'open' | 'in_progress' | 'done' | 'blocked';
  folder: string; // open/, in_progress/, done/, blocked/
}

export interface TaskFileInfo {
  filePath: string;
  fileName: string;
  taskName: string;
  targetRole: string;
  milestoneFolder: string;
  statusFolder: 'open' | 'in_progress' | 'done' | 'blocked';
}

// ============================================
// Iteration Tracking
// ============================================

/**
 * Record of a single continuation iteration
 */
export interface IterationRecord {
  /** ISO timestamp of the iteration */
  timestamp: string;
  /** What triggered this iteration */
  trigger: 'pty_exit' | 'activity_idle' | 'heartbeat_stale' | 'explicit_request';
  /** Action taken in response */
  action: 'inject_prompt' | 'assign_next_task' | 'notify_owner' | 'retry_with_hints' | 'pause_agent' | 'no_action';
  /** Conclusion of the analysis */
  conclusion: 'TASK_COMPLETE' | 'WAITING_INPUT' | 'STUCK_OR_ERROR' | 'INCOMPLETE' | 'MAX_ITERATIONS' | 'UNKNOWN';
  /** Optional notes about this iteration */
  notes?: string;
}

/**
 * Continuation tracking data stored with a ticket
 */
export interface ContinuationTrackingData {
  /** Current iteration count */
  iterations: number;
  /** Maximum allowed iterations */
  maxIterations: number;
  /** ISO timestamp of last iteration */
  lastIteration?: string;
  /** History of iterations (max 20) */
  iterationHistory: IterationRecord[];
}

// ============================================
// Quality Gates
// ============================================

/**
 * Status of a single quality gate
 */
export interface QualityGateStatus {
  /** Whether the gate passed */
  passed: boolean;
  /** ISO timestamp of last run */
  lastRun?: string;
  /** Output from the gate (truncated if too long) */
  output?: string;
}

/**
 * Collection of quality gates for a ticket
 */
export interface QualityGates {
  /** TypeScript type checking */
  typecheck?: QualityGateStatus;
  /** Test suite */
  tests?: QualityGateStatus;
  /** Lint check */
  lint?: QualityGateStatus;
  /** Build check */
  build?: QualityGateStatus;
  /** Allow custom gates */
  [customGate: string]: QualityGateStatus | undefined;
}

/**
 * Required gates that must pass for task completion
 */
export const REQUIRED_QUALITY_GATES = ['typecheck', 'tests', 'build'] as const;
