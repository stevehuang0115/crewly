// Frontend types (mirrors backend types exactly)
export interface TeamMember {
  id: string;
  name: string;
  sessionName: string; // terminal session name
  role: string; // Now accepts any role key from configuration
  avatar?: string; // URL or emoji
  systemPrompt: string;
  agentStatus: 'inactive' | 'starting' | 'started' | 'active' | 'suspended' | 'activating'; // Connection/registration status (activating is deprecated)
  workingStatus: 'idle' | 'in_progress'; // Activity level status
  runtimeType: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent'; // AI runtime to use
  modelId?: string; // AI model override for crewly-agent runtime (format: provider/modelId)
  skillOverrides?: string[]; // Additional skill IDs beyond what the role provides
  excludedRoleSkills?: string[]; // Role skills to exclude for this specific member
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
}

/** Supported AI models for crewly-agent runtime dropdown */
export const SUPPORTED_MODELS = [
  { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
  { id: 'google/gemini-2.5-flash-preview-05-20', label: 'Gemini 2.5 Flash' },
  { id: 'anthropic/claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { id: 'anthropic/claude-haiku-4-20250514', label: 'Claude Haiku 4' },
  { id: 'openai/gpt-4o', label: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o Mini' },
  { id: 'ollama/llama3', label: 'Llama 3 (Ollama)' },
] as const;

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

  /** Template ID this team was created from. */
  templateId?: string;

  /** Parent team ID for team organization/grouping. null/undefined = top-level team. */
  parentTeamId?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  path: string; // absolute filesystem path
  teams: Record<string, string[]>; // team assignments
  status: 'active' | 'paused' | 'completed';
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
}

export interface ScheduledCheck {
  id: string;
  targetSession: string;
  message: string;
  scheduledFor: string;
  intervalMinutes?: number;
  isRecurring: boolean;
  createdAt: string;
}

export interface TerminalOutput {
  sessionName: string;
  content: string;
  timestamp: string;
  type: 'stdout' | 'stderr';
}

export interface WebSocketMessage {
  type: 'terminal_output' | 'file_change' | 'team_status' | 'schedule_update';
  payload: unknown;
  timestamp: string;
}

/**
 * WebSocket event data for team member status changes
 * Used by Teams and TeamDetail pages for real-time status updates
 */
export interface TeamMemberStatusChangeEvent {
  teamId: string;
  memberId: string;
  sessionName: string;
  agentStatus: TeamMember['agentStatus'];
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * A previously running session that can be resumed after app restart
 */
export interface PreviousSession {
  name: string;
  role?: string;
  teamId?: string;
  runtimeType: string;
  hasResumeId: boolean;
}

/**
 * Status of the teams backup compared to current state
 */
export interface TeamsBackupStatus {
  /** Whether current teams are empty but backup has data */
  hasMismatch: boolean;
  /** Number of teams in the backup file */
  backupTeamCount: number;
  /** Number of teams currently in storage */
  currentTeamCount: number;
  /** ISO timestamp of the most recent backup */
  backupTimestamp: string | null;
}

/**
 * Result of a teams restore operation
 */
export interface TeamsRestoreResult {
  /** Number of teams successfully restored */
  restoredCount: number;
  /** Total number of teams that were in the backup */
  totalInBackup: number;
  /** Error messages for individual team restore failures */
  errors?: string[];
}

// =============================================================================
// Message Queue Types
// =============================================================================

/**
 * Status of a message in the queue
 */
export type QueueMessageStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

/**
 * A message in the processing queue
 */
export interface QueuedMessage {
  /** Unique queue entry ID */
  id: string;
  /** Message content */
  content: string;
  /** Conversation ID for routing */
  conversationId: string;
  /** Source of the message */
  source: 'web_chat' | 'slack';
  /** Current status in the queue */
  status: QueueMessageStatus;
  /** ISO timestamp when enqueued */
  enqueuedAt: string;
  /** ISO timestamp when processing started */
  processingStartedAt?: string;
  /** ISO timestamp when completed or failed */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
  /** Response content from the orchestrator */
  response?: string;
}

/**
 * Queue status summary for monitoring
 */
export interface QueueStatus {
  /** Number of messages waiting */
  pendingCount: number;
  /** Whether a message is currently being processed */
  isProcessing: boolean;
  /** The message currently being processed, if any */
  currentMessage?: QueuedMessage;
  /** Total messages processed since startup */
  totalProcessed: number;
  /** Total messages that failed since startup */
  totalFailed: number;
  /** Number of completed messages in history */
  historyCount: number;
}

// =============================================================================
// Cloud Connection Types
// =============================================================================

/**
 * Cloud subscription tier levels
 */
export type CloudTier = 'free' | 'pro' | 'enterprise';

/**
 * Cloud connection status
 */
export type CloudConnectionStatus = 'disconnected' | 'connected' | 'error';

/**
 * Status of the CrewlyAI Cloud connection
 */
export interface CloudStatus {
  /** Whether the client is currently connected to cloud */
  connected: boolean;
  /** Current subscription tier when connected */
  tier: CloudTier | null;
  /** Cloud API URL when connected */
  cloudUrl: string | null;
  /** Connection status label */
  status: CloudConnectionStatus;
}

/**
 * Result of a cloud connect operation
 */
export interface CloudConnectResult {
  /** Whether the connection succeeded */
  connected: boolean;
  /** Subscription tier of the connected account */
  tier: CloudTier;
  /** Cloud API URL */
  cloudUrl: string;
}

// Re-export auth types
export * from './auth.types';

// Re-export factory types
export * from './factory.types';

// Re-export role types
export * from './role.types';

// Re-export settings types
export * from './settings.types';

// Re-export chat types
export * from './chat.types';

// Re-export skill types
export * from './skill.types';

// =============================================================================
// Knowledge Document Types
// =============================================================================

/**
 * Scope of a knowledge document
 */
export type KnowledgeScope = 'global' | 'project';

/**
 * Full knowledge document with markdown content
 */
export interface KnowledgeDocument {
  /** Unique document identifier */
  id: string;
  /** Document title */
  title: string;
  /** Document category */
  category: string;
  /** Tags for filtering/search */
  tags: string[];
  /** Full markdown content */
  content: string;
  /** Document scope */
  scope: KnowledgeScope;
  /** Project path if scope is 'project' */
  projectPath?: string;
  /** Who created the document */
  createdBy: string;
  /** Who last updated the document */
  updatedBy: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Summary of a knowledge document for list views
 */
export interface KnowledgeDocumentSummary {
  /** Unique document identifier */
  id: string;
  /** Document title */
  title: string;
  /** Document category */
  category: string;
  /** Tags for filtering/search */
  tags: string[];
  /** Short preview of content */
  preview: string;
  /** Document scope */
  scope: KnowledgeScope;
  /** Who created the document */
  createdBy: string;
  /** Who last updated the document */
  updatedBy: string;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}
