/**
 * Cron Task & Agent Heartbeat Types
 *
 * Type definitions for cron job management and agent heartbeat monitoring.
 * Mirrors backend types from backend/src/types/cron-task.types.ts and
 * backend/src/services/agent/agent-heartbeat.service.ts.
 *
 * @module types/cron-task.types
 */

// =============================================================================
// Cron Task Types
// =============================================================================

/** Who created the cron task */
export type CronTaskCreator = 'user' | 'orchestrator';

/**
 * A scheduled cron task that delegates work to an agent on a recurring basis.
 *
 * Stored in ~/.crewly/cron-tasks.json. Evaluated every 60 seconds by the
 * CronTaskService backend loop.
 */
export interface CronTask {
  /** Unique task identifier (format: cron-xxxx) */
  id: string;
  /** Standard cron expression (e.g. "0 9 * * *") */
  cronExpression: string;
  /** IANA timezone (e.g. "Asia/Shanghai") */
  timezone: string;
  /** Target agent session name */
  targetAgent: string;
  /** Team ID the target agent belongs to */
  targetTeamId: string;
  /** Description of the task to delegate */
  taskDescription: string;
  /** Who created this task */
  createdBy: CronTaskCreator;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Whether this task is currently enabled */
  enabled: boolean;
  /** ISO timestamp of last execution, null if never run */
  lastRunAt: string | null;
  /** ISO timestamp of next scheduled run, null if disabled */
  nextRunAt: string | null;
}

/**
 * Request body for creating a new cron task
 */
export interface CreateCronTaskRequest {
  /** Standard cron expression */
  cronExpression: string;
  /** IANA timezone */
  timezone: string;
  /** Target agent session name */
  targetAgent: string;
  /** Team ID the target agent belongs to */
  targetTeamId: string;
  /** Description of the task to delegate */
  taskDescription: string;
  /** Who created this task */
  createdBy: CronTaskCreator;
}

/**
 * Request body for updating a cron task (all fields optional)
 */
export interface UpdateCronTaskRequest {
  /** Updated cron expression */
  cronExpression?: string;
  /** Updated timezone */
  timezone?: string;
  /** Updated task description */
  taskDescription?: string;
  /** Enable or disable the task */
  enabled?: boolean;
}

// =============================================================================
// Agent Heartbeat Types
// =============================================================================

/** Agent connection/registration status (for heartbeat monitoring) */
export type HeartbeatAgentStatus = 'inactive' | 'starting' | 'started' | 'active' | 'suspended' | 'activating';

/** Agent working activity level */
export type WorkingStatus = 'idle' | 'in_progress';

/**
 * Heartbeat record for a single agent, tracking its liveness and status.
 *
 * Updated automatically by the backend on every API request that includes
 * the X-Agent-Session header (via agentHeartbeatMiddleware).
 */
export interface AgentHeartbeat {
  /** Agent identifier ('orchestrator' or team member ID) */
  agentId: string;
  /** PTY session name */
  sessionName: string;
  /** Team member ID (only for team members, not orchestrator) */
  teamMemberId?: string;
  /** Current agent status */
  agentStatus: HeartbeatAgentStatus;
  /** ISO timestamp of last proof-of-life */
  lastActiveTime: string;
  /** ISO timestamp when heartbeat was first created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Full heartbeat status file structure from ~/.crewly/teamAgentStatus.json
 */
export interface TeamAgentStatusFile {
  /** Orchestrator heartbeat */
  orchestrator: AgentHeartbeat;
  /** Team member heartbeats indexed by teamMemberId */
  teamMembers: Record<string, AgentHeartbeat>;
  /** File metadata */
  metadata: {
    lastUpdated: string;
    version: string;
  };
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if a value is a valid CronTask
 *
 * @param value - Value to check
 * @returns True if value matches CronTask shape
 */
export function isCronTask(value: unknown): value is CronTask {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.cronExpression === 'string' &&
    typeof obj.timezone === 'string' &&
    typeof obj.targetAgent === 'string' &&
    typeof obj.targetTeamId === 'string' &&
    typeof obj.taskDescription === 'string' &&
    (obj.createdBy === 'user' || obj.createdBy === 'orchestrator') &&
    typeof obj.createdAt === 'string' &&
    typeof obj.enabled === 'boolean'
  );
}

/**
 * Type guard to check if a value is a valid AgentHeartbeat
 *
 * @param value - Value to check
 * @returns True if value matches AgentHeartbeat shape
 */
export function isAgentHeartbeat(value: unknown): value is AgentHeartbeat {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.agentId === 'string' &&
    typeof obj.sessionName === 'string' &&
    typeof obj.agentStatus === 'string' &&
    typeof obj.lastActiveTime === 'string'
  );
}
