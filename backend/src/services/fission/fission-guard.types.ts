/**
 * Fission Guard Type Definitions
 *
 * Types for the FissionGuardService — prevents agents from creating
 * unbounded sub-tasks. Implements 6 guardrails: maxDepth, maxTasks,
 * rate limit, branching factor, TTL, and budget gate.
 *
 * @module services/fission/fission-guard.types
 */

// ---------------------------------------------------------------------------
// Guard Result
// ---------------------------------------------------------------------------

/**
 * Result of a fission guard check.
 * Returned by canCreateSubTask() to indicate whether creation is allowed.
 */
export interface GuardResult {
  /** Whether the sub-task creation is allowed */
  allowed: boolean;
  /** Human-readable reason when blocked */
  reason?: string;
  /** Which guardrail was violated (for programmatic handling) */
  violationType?: FissionViolationType;
}

/**
 * Types of fission violations.
 */
export type FissionViolationType =
  | 'max_depth'
  | 'max_tasks'
  | 'rate_limit'
  | 'branching_factor'
  | 'ttl_exceeded'
  | 'budget_exceeded';

/** All valid FissionViolationType values. */
export const FISSION_VIOLATION_TYPES: readonly FissionViolationType[] = [
  'max_depth',
  'max_tasks',
  'rate_limit',
  'branching_factor',
  'ttl_exceeded',
  'budget_exceeded',
] as const;

// ---------------------------------------------------------------------------
// Fission Violation (Audit Trail)
// ---------------------------------------------------------------------------

/**
 * A recorded fission guard violation.
 * Stored for auditing — shows what was blocked and why.
 */
export interface FissionViolation {
  /** UUID of the violation record */
  id: string;
  /** Which guardrail was triggered */
  violationType: FissionViolationType;
  /** Agent that attempted the creation */
  agentId: string;
  /** Parent WorkItem ID (the would-be parent) */
  parentWorkItemId: string;
  /** Mission ID if applicable */
  missionId?: string;
  /** Human-readable reason for the block */
  reason: string;
  /** Current value that exceeded the limit (e.g., depth=4) */
  currentValue: number;
  /** The configured limit that was exceeded (e.g., maxDepth=3) */
  configuredLimit: number;
  /** ISO8601 timestamp */
  violatedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for all fission guardrails.
 * Each field controls one specific guardrail.
 */
export interface FissionGuardConfig {
  /** Maximum depth of parentWorkItemId chain (default: 3) */
  maxDepth: number;
  /** Maximum tasks per Mission (default: 50, hard limit: 200) */
  maxTasksPerMission: number;
  /** Absolute hard limit on tasks per Mission — cannot be overridden */
  hardMaxTasksPerMission: number;
  /** Rate limit window in milliseconds (default: 600_000 = 10 minutes) */
  rateLimitWindowMs: number;
  /** Maximum sub-tasks an agent can create within the rate limit window */
  rateLimitMaxCreations: number;
  /** Maximum children per single WorkItem (default: 5) */
  maxBranchingFactor: number;
  /** Default TTL for new WorkItems in milliseconds (default: 86_400_000 = 24h) */
  defaultTtlMs: number;
  /** Maximum allowed TTL in milliseconds (default: 604_800_000 = 7 days) */
  maxTtlMs: number;
  /** Budget threshold in USD — exceeding triggers approval requirement */
  budgetThresholdUsd: number;
  /** Whether the budget gate is enabled */
  budgetGateEnabled: boolean;
  /** Maximum violation history entries retained */
  maxViolationHistory: number;
}

/**
 * Default fission guard configuration.
 * Values match CEO requirements from the implementation checklist.
 */
export const DEFAULT_FISSION_CONFIG: Readonly<FissionGuardConfig> = {
  maxDepth: 3,
  maxTasksPerMission: 50,
  hardMaxTasksPerMission: 200,
  rateLimitWindowMs: 600_000,       // 10 minutes
  rateLimitMaxCreations: 5,
  maxBranchingFactor: 5,
  defaultTtlMs: 86_400_000,         // 24 hours
  maxTtlMs: 604_800_000,            // 7 days
  budgetThresholdUsd: 10.0,
  budgetGateEnabled: true,
  maxViolationHistory: 500,
} as const;

// ---------------------------------------------------------------------------
// Rate Limit Tracking
// ---------------------------------------------------------------------------

/**
 * Tracks an agent's recent sub-task creation timestamps
 * for rate limiting.
 */
export interface AgentCreationRecord {
  /** Agent ID */
  agentId: string;
  /** Timestamps (epoch ms) of recent sub-task creations */
  timestamps: number[];
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid FissionViolationType.
 *
 * @param value - The string to check
 * @returns True if value is a valid FissionViolationType
 */
export function isValidViolationType(value: string): value is FissionViolationType {
  return (FISSION_VIOLATION_TYPES as readonly string[]).includes(value);
}

/**
 * Validates that an unknown value conforms to GuardResult.
 *
 * @param value - Unknown value to validate
 * @returns True if value is a valid GuardResult
 */
export function isGuardResult(value: unknown): value is GuardResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.allowed !== 'boolean') return false;
  if (obj.reason !== undefined && typeof obj.reason !== 'string') return false;
  if (obj.violationType !== undefined) {
    if (typeof obj.violationType !== 'string') return false;
    if (!isValidViolationType(obj.violationType)) return false;
  }
  return true;
}

/**
 * Validates that an unknown value conforms to FissionViolation.
 *
 * @param value - Unknown value to validate
 * @returns True if value is a valid FissionViolation
 */
export function isFissionViolation(value: unknown): value is FissionViolation {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.violationType === 'string' &&
    isValidViolationType(obj.violationType) &&
    typeof obj.agentId === 'string' &&
    typeof obj.parentWorkItemId === 'string' &&
    typeof obj.reason === 'string' &&
    typeof obj.currentValue === 'number' &&
    typeof obj.configuredLimit === 'number' &&
    typeof obj.violatedAt === 'string'
  );
}

/**
 * Validates that an unknown value conforms to FissionGuardConfig.
 *
 * @param value - Unknown value to validate
 * @returns True if value is a valid FissionGuardConfig
 */
export function isValidFissionGuardConfig(value: unknown): value is FissionGuardConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.maxDepth === 'number' && obj.maxDepth > 0 &&
    typeof obj.maxTasksPerMission === 'number' && obj.maxTasksPerMission > 0 &&
    typeof obj.hardMaxTasksPerMission === 'number' && obj.hardMaxTasksPerMission > 0 &&
    typeof obj.rateLimitWindowMs === 'number' && obj.rateLimitWindowMs > 0 &&
    typeof obj.rateLimitMaxCreations === 'number' && obj.rateLimitMaxCreations > 0 &&
    typeof obj.maxBranchingFactor === 'number' && obj.maxBranchingFactor > 0 &&
    typeof obj.defaultTtlMs === 'number' && obj.defaultTtlMs > 0 &&
    typeof obj.maxTtlMs === 'number' && obj.maxTtlMs > 0 &&
    typeof obj.budgetThresholdUsd === 'number' && obj.budgetThresholdUsd >= 0 &&
    typeof obj.budgetGateEnabled === 'boolean' &&
    typeof obj.maxViolationHistory === 'number' && obj.maxViolationHistory > 0
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a GuardResult indicating the action is allowed.
 *
 * @returns A GuardResult with allowed=true
 */
export function createAllowedResult(): GuardResult {
  return { allowed: true };
}

/**
 * Creates a GuardResult indicating the action is blocked.
 *
 * @param violationType - Which guardrail was violated
 * @param reason - Human-readable explanation
 * @returns A GuardResult with allowed=false
 */
export function createBlockedResult(
  violationType: FissionViolationType,
  reason: string,
): GuardResult {
  return { allowed: false, reason, violationType };
}
