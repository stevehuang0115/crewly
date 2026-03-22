/**
 * Type definitions for the Unified Scheduler Service.
 *
 * The Unified Scheduler consolidates cron, interval, and idle-based
 * scheduling into a single interface with persistent storage and
 * agent auto-start capabilities.
 *
 * @module services/workflow/unified-scheduler.types
 */

// =============================================================================
// Schedule Configuration
// =============================================================================

/** Supported schedule trigger types. */
export type ScheduleType = 'cron' | 'interval' | 'idle';

/** Runtime status of a schedule. */
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'error';

/**
 * A unified schedule definition.
 *
 * Combines cron expressions, fixed intervals, and idle detection
 * into a single structure. Only the fields relevant to the `type`
 * are used at runtime:
 * - type=cron: uses `cron`
 * - type=interval: uses `intervalMinutes`
 * - type=idle: uses `idleTimeoutMinutes`
 */
export interface UnifiedSchedule {
  /** Unique schedule identifier (UUID) */
  id: string;
  /** Target agent session name */
  target: string;
  /** Schedule type determines which timing field is used */
  type: ScheduleType;
  /** Cron expression (5-field, e.g., "0 8,14,20 * * *") — required when type=cron */
  cron?: string;
  /** Interval in minutes between triggers — required when type=interval */
  intervalMinutes?: number;
  /** Minutes of idle time before triggering — required when type=idle */
  idleTimeoutMinutes?: number;
  /** Message to send to the target agent when triggered */
  message: string;
  /** Whether the schedule is actively running */
  enabled: boolean;
  /** Auto-start the target agent if it's offline when triggered */
  autoStart: boolean;
  /** Maximum consecutive triggers before auto-pausing (default: 10) */
  maxConsecutiveTriggers: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last modification */
  updatedAt: string;
  /** ISO timestamp of last trigger, or null if never triggered */
  lastTriggeredAt: string | null;
  /** Total number of times this schedule has triggered */
  triggerCount: number;
  /** Consecutive triggers since last agent activity/response */
  consecutiveTriggers: number;
  /** Current runtime status */
  status: ScheduleStatus;
  /** Error message if status is 'error' */
  error?: string;
}

// =============================================================================
// Request Types
// =============================================================================

/** Request body for creating a new schedule. */
export interface CreateScheduleRequest {
  /** Target agent session name */
  target: string;
  /** Schedule type */
  type: ScheduleType;
  /** Cron expression (required when type=cron) */
  cron?: string;
  /** Interval in minutes (required when type=interval) */
  intervalMinutes?: number;
  /** Idle timeout in minutes (required when type=idle) */
  idleTimeoutMinutes?: number;
  /** Message to send to the agent */
  message: string;
  /** Whether to activate immediately (default: true) */
  enabled?: boolean;
  /** Auto-start agent if offline (default: true) */
  autoStart?: boolean;
  /** Max consecutive triggers before auto-pause (default: 10) */
  maxConsecutiveTriggers?: number;
}

/** Request body for updating an existing schedule. */
export interface UpdateScheduleRequest {
  /** Updated cron expression */
  cron?: string;
  /** Updated interval */
  intervalMinutes?: number;
  /** Updated idle timeout */
  idleTimeoutMinutes?: number;
  /** Updated message */
  message?: string;
  /** Enable/disable */
  enabled?: boolean;
  /** Auto-start toggle */
  autoStart?: boolean;
  /** Updated max consecutive triggers */
  maxConsecutiveTriggers?: number;
}

// =============================================================================
// Storage
// =============================================================================

/** Persistent storage format for ~/.crewly/unified-schedules.json */
export interface UnifiedScheduleStore {
  /** Schema version for future migrations */
  version: string;
  /** Last persistence timestamp */
  updatedAt: string;
  /** All schedule definitions */
  schedules: UnifiedSchedule[];
}

// =============================================================================
// Health
// =============================================================================

/** Scheduler health/stats response. */
export interface SchedulerHealth {
  /** Whether the scheduler loop is running */
  running: boolean;
  /** Number of active schedules */
  activeCount: number;
  /** Number of paused schedules */
  pausedCount: number;
  /** Total schedules (all statuses) */
  totalCount: number;
  /** Total triggers executed since service start */
  totalTriggers: number;
  /** Timestamp of last evaluation cycle */
  lastEvaluatedAt: string | null;
  /** Schedules grouped by type */
  byType: Record<ScheduleType, number>;
}

// =============================================================================
// Constants
// =============================================================================

/** Default values for the unified scheduler. */
export const UNIFIED_SCHEDULER_CONSTANTS = {
  /** Evaluation loop interval (60 seconds — matches cron granularity) */
  EVAL_INTERVAL_MS: 60_000,
  /** Storage file path (relative to ~/.crewly/) */
  STORAGE_FILE: 'unified-schedules.json',
  /** Default max consecutive triggers before auto-pause */
  DEFAULT_MAX_CONSECUTIVE: 10,
  /** Storage schema version */
  SCHEMA_VERSION: '1.0.0',
  /** Default idle timeout if not specified (30 minutes) */
  DEFAULT_IDLE_TIMEOUT_MINUTES: 30,
} as const;

// =============================================================================
// Validation
// =============================================================================

/** Valid schedule types for request validation. */
export const VALID_SCHEDULE_TYPES: ReadonlySet<string> = new Set(['cron', 'interval', 'idle']);

/**
 * Validate a cron expression (basic 5-field format).
 *
 * Checks that the expression has exactly 5 space-separated fields
 * and each field contains only valid cron characters.
 *
 * @param expr - Cron expression to validate
 * @returns True if valid
 */
export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const validChars = /^[\d,\-\*\/]+$/;
  return fields.every(f => validChars.test(f));
}

/**
 * Validate a CreateScheduleRequest.
 *
 * @param req - Request to validate
 * @returns Error message or null if valid
 */
export function validateCreateRequest(req: CreateScheduleRequest): string | null {
  if (!req.target || typeof req.target !== 'string') return 'target is required';
  if (!req.message || typeof req.message !== 'string') return 'message is required';
  if (!req.type || !VALID_SCHEDULE_TYPES.has(req.type)) {
    return `type must be one of: ${[...VALID_SCHEDULE_TYPES].join(', ')}`;
  }

  switch (req.type) {
    case 'cron':
      if (!req.cron) return 'cron expression is required when type=cron';
      if (!isValidCronExpression(req.cron)) return `Invalid cron expression: ${req.cron}`;
      break;
    case 'interval':
      if (!req.intervalMinutes || req.intervalMinutes <= 0) {
        return 'intervalMinutes must be a positive number when type=interval';
      }
      break;
    case 'idle':
      if (!req.idleTimeoutMinutes || req.idleTimeoutMinutes <= 0) {
        return 'idleTimeoutMinutes must be a positive number when type=idle';
      }
      break;
  }

  return null;
}
