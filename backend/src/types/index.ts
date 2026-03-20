/**
 * Role types available for team members.
 * 'team-leader' manages a sub-team of workers in hierarchical mode.
 */
export type TeamMemberRole =
  | 'orchestrator'
  | 'team-leader'
  | 'tpm'
  | 'architect'
  | 'pgm'
  | 'developer'
  | 'frontend-developer'
  | 'backend-developer'
  | 'fullstack-dev'
  | 'qa'
  | 'qa-engineer'
  | 'tester'
  | 'designer'
  | 'product-manager'
  | 'sales'
  | 'support';

export interface TeamMember {
  id: string;
  name: string;
  sessionName: string; // tmux session name
  role: TeamMemberRole;
  avatar?: string; // URL or emoji for member avatar
  systemPrompt: string;
  agentStatus: 'inactive' | 'starting' | 'started' | 'active' | 'suspended' | 'activating'; // Connection/registration status (activating is deprecated)
  workingStatus: 'idle' | 'in_progress'; // Activity level status
  runtimeType: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent'; // AI runtime to use
  /** Model ID for crewly-agent runtime (format: provider/modelId, e.g. google/gemini-3-flash-preview) */
  modelId?: string;
  skillOverrides?: string[]; // Additional skill IDs beyond what the role provides
  excludedRoleSkills?: string[]; // Role skills to exclude for this specific member
  enableBrowserAutomation?: boolean; // Per-agent browser override (undefined = use global setting)
  currentTickets?: string[];
  readyAt?: string; // ISO timestamp when agent reported ready
  capabilities?: string[]; // Agent-reported capabilities
  lastActivityCheck?: string; // ISO timestamp of last activity monitoring
  createdAt: string;
  updatedAt: string;

  // === Hierarchy fields (for hierarchical team management) ===

  /** Parent member ID in the hierarchy. undefined = root (orchestrator). */
  parentMemberId?: string;

  /**
   * Position in hierarchy: 0=orchestrator, 1=team leader, 2=worker.
   * Supports N-level depth for future expansion.
   */
  hierarchyLevel?: number;

  /** IDs of direct subordinate members. Maintained by backend. */
  subordinateIds?: string[];

  /** Whether this member can delegate tasks to subordinates. */
  canDelegate?: boolean;

  /** Maximum number of concurrent tasks this member can handle. */
  maxConcurrentTasks?: number;

  /** #235: Reason the agent last went inactive */
  dropoutReason?: 'idle_exit' | 'update_exit' | 'crash' | 'manual' | 'task_complete';
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  members: TeamMember[];
  projectIds: string[];
  createdAt: string;
  updatedAt: string;

  // === Hierarchy fields ===

  /** Whether this team uses hierarchical management (TL → Workers). Default: false. */
  hierarchical?: boolean;

  /**
   * @deprecated Use `leaderIds` instead. Retained for backward compatibility.
   * When both exist, `leaderId` equals `leaderIds[0]`.
   */
  leaderId?: string;

  /** Member IDs of the team leaders. Supports multiple TLs per team. */
  leaderIds?: string[];

  /** Template ID this team was created from (see TeamTemplate system). */
  templateId?: string;

  /** Parent team ID for team organization/grouping. null/undefined = top-level team. */
  parentTeamId?: string;

  /** Whether this team is archived. Archived teams are hidden from default listings. (#171) */
  archived?: boolean;

  /** ISO timestamp when the team was archived. (#171) */
  archivedAt?: string;

  // === Org Chart fields (#173) ===

  /** Team mission statement — displayed in get-team-status and org chart. */
  mission?: string;

  /** Token/cost budget configuration for the team. */
  budget?: TeamBudget;

  /** Quality gate configuration for task review. */
  qualityGate?: TeamQualityGate;
}

/**
 * Token and cost budget for a team (#173).
 */
export interface TeamBudget {
  /** Maximum tokens per day across all team members. */
  maxTokensPerDay?: number;
  /** Maximum USD spend per month. */
  maxUsdPerMonth?: number;
  /** Percentage (0-100) at which to alert (e.g., 80 = alert at 80% usage). */
  alertThreshold?: number;
}

/**
 * Quality gate configuration for task review (#173).
 */
export interface TeamQualityGate {
  /** Member ID of the designated reviewer. */
  reviewerId?: string;
  /** Whether tasks below minQualityScore are auto-approved. */
  autoApprove?: boolean;
  /** Minimum quality score (0-100) required for auto-approval. */
  minQualityScore?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string; // absolute filesystem path
  teams: Record<string, string[]>; // team assignments
  status: 'active' | 'paused' | 'completed' | 'stopped';
  scheduledMessageId?: string; // ID of auto-assignment scheduled message
  createdAt: string;
  updatedAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'review' | 'done' | 'blocked';
  assignedTo?: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  labels?: string[];
  projectId: string;
  createdAt: string;
  updatedAt: string;
  // YAML frontmatter + markdown body
}

export interface SessionInfo {
  sessionName: string;
  pid: number;
  windows: number;
  created: string;
  attached: boolean;
}

export interface ScheduledCheck {
  id: string;
  targetSession: string;
  message: string;
  scheduledFor: string;
  intervalMinutes?: number;
  isRecurring: boolean;
  label?: string;
  persistent?: boolean;
  timezone?: string;
  recurrenceType?: 'interval' | 'daily' | 'weekdays' | 'weekly';
  timeOfDay?: string;
  dayOfWeek?: number;
  maxOccurrences?: number;
  currentOccurrence?: number;
  createdAt: string;
  /** Optional session name of the agent being monitored (for status enrichment) */
  watchedSession?: string;
  /** Task ID that this schedule monitors — auto-cancels when task completes */
  taskId?: string;
  /** Cron expression for cron-based scheduling (e.g., '0 9 * * *'). Overrides intervalMinutes when set. (#167) */
  cronExpression?: string;
  /** Session ID that created this check — used to auto-cancel stale checks from previous sessions on restart (#169) */
  sessionId?: string;
}

export interface ScheduledMessage {
  id: string;
  name: string;
  targetTeam: string; // e.g. 'orchestrator', 'frontend-team-pm', 'frontend-team-dev'
  targetProject?: string; // project ID, optional
  message: string; // message content to send
  delayAmount: number; // numeric amount
  delayUnit: 'seconds' | 'minutes' | 'hours'; // time unit
  isRecurring: boolean; // one-time or recurring
  isActive: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDeliveryLog {
  id: string;
  scheduledMessageId: string;
  messageName: string;
  targetTeam: string;
  targetProject?: string;
  message: string;
  sentAt: string;
  success: boolean;
  error?: string;
}

export interface FileChange {
  type: 'created' | 'updated' | 'deleted';
  path: string;
  timestamp: string;
}

export interface TicketFilter {
  status?: string;
  assignedTo?: string;
  projectId?: string;
  priority?: string;
}

export interface TeamMemberConfig {
  name: string;
  role: TeamMemberRole;
  systemPrompt: string;
  skillOverrides?: string[];
  excludedRoleSkills?: string[];
}

export interface TeamConfig {
  name: string;
  description?: string;
  members: TeamMemberConfig[];
  projectPath?: string;
}

/**
 * Subordinate info resolved from TeamMember data, used by the prompt builder
 * to tell a Team Lead who their direct reports are.
 */
export interface SubordinateInfo {
  name: string;
  sessionName: string;
  role: TeamMemberRole;
  memberId: string;
}

export interface TeamMemberSessionConfig {
  name: string;
  role: TeamMemberRole;
  systemPrompt: string;
  projectPath?: string;
  memberId?: string;
  runtimeType?: TeamMember['runtimeType'];
  skillOverrides?: string[];
  excludedRoleSkills?: string[];

  // === Team Lead fields (for TL-aware prompt building) ===

  /** The team ID this member belongs to (used for TL skill template variables). */
  teamId?: string;

  /** Whether this member can delegate tasks to subordinates. */
  canDelegate?: boolean;

  /** Resolved subordinate details for prompt injection. */
  subordinates?: SubordinateInfo[];
}

export interface TerminalOutput {
  sessionName: string;
  content: string;
  timestamp: string;
  type: 'stdout' | 'stderr';
}

export interface WebSocketMessage {
  type: 'terminal_output' | 'file_change' | 'team_status' | 'schedule_update'
       | 'connection_established' | 'subscription_confirmed' | 'unsubscription_confirmed'
       | 'session_not_found' | 'session_pending' | 'input_error' | 'initial_terminal_state'
       | 'terminal_state_error' | 'system_notification' | 'orchestrator_status_changed'
       | 'team_member_status_changed' | 'team_activity_updated' | 'read_only';
  payload: any;
  timestamp: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface StartupConfig {
  webPort: number;
  crewlyHome: string;
  defaultCheckInterval: number;
  autoCommitInterval: number;
  /** When true, skip frontend serving (API-only mode for cloud deployment) */
  headless: boolean;
}

// Re-export memory types
export * from './memory.types.js';

// Re-export continuation types
export * from './continuation.types.js';

// Re-export quality gate types
export * from './quality-gate.types.js';

// Re-export SOP types
export * from './sop.types.js';

// Re-export auto-assignment types
export * from './auto-assign.types.js';

// Re-export budget types
export * from './budget.types.js';

// Re-export scheduler types
export * from './scheduler.types.js';

// Re-export role types
export * from './role.types.js';

// Re-export settings types
export * from './settings.types.js';

// Re-export skill types
export * from './skill.types.js';

// Re-export chat types
export * from './chat.types.js';

// Re-export task output types
export * from './task-output.types.js';
