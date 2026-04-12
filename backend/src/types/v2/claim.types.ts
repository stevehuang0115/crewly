/**
 * V2 Task Claim Type Definitions
 *
 * Claims represent an agent's active hold on a WorkItem from the Task Pool.
 * The claim system uses lease + heartbeat to ensure liveness:
 * - Lease: 10 minutes default, agent must renew before expiry
 * - Heartbeat: 2 minutes, agent signals it's still working
 * - Grace period: 3 minutes after lease expiry before forced release
 *
 * @module types/v2/claim.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Enums & Literals
// ---------------------------------------------------------------------------

/**
 * Lifecycle statuses for a TaskClaim.
 */
export type ClaimStatus =
  | 'active'        // Agent is actively working, heartbeat healthy
  | 'expiring'      // Lease expired, in grace period
  | 'released'      // Agent voluntarily released (done or gave up)
  | 'revoked';      // System force-revoked (grace period exceeded)

/** All valid ClaimStatus values. */
export const CLAIM_STATUSES: readonly ClaimStatus[] = [
  'active',
  'expiring',
  'released',
  'revoked',
] as const;

// ---------------------------------------------------------------------------
// Core Interface
// ---------------------------------------------------------------------------

/**
 * Represents an agent's claim on a WorkItem from the Task Pool.
 *
 * The claim lifecycle:
 *   1. Agent calls claimFromPool() → TaskClaim created (status: 'active')
 *   2. Agent sends heartbeats every 2 minutes → lastHeartbeatAt updated
 *   3a. Agent finishes → releases claim (status: 'released')
 *   3b. Lease expires → Reconciler sets 'expiring', starts grace period
 *   4. Grace period exceeded → Reconciler revokes (status: 'revoked'), WorkItem back to pool
 */
export interface TaskClaim {
  /** UUID v4 */
  id: string;
  /** WorkItem ID being claimed */
  workItemId: string;
  /** Agent session name that holds the claim */
  agentId: string;
  /** Current claim status */
  status: ClaimStatus;
  /** ISO8601 — when the claim was created */
  claimedAt: string;
  /** ISO8601 — when the lease expires (claimedAt + leaseDurationMs) */
  leaseExpiresAt: string;
  /** ISO8601 — last heartbeat received from the agent */
  lastHeartbeatAt: string;
  /** Number of lease extensions granted */
  extensionCount: number;
  /** Maximum allowed extensions (default: 3) */
  maxExtensions: number;
  /** Lease duration in ms (default: 600000 = 10 min) */
  leaseDurationMs: number;
  /** ISO8601 — when the claim ended (release or revoke) */
  endedAt?: string;
  /** Reason for release or revocation */
  endReason?: string;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new claim.
 */
export interface CreateClaimInput {
  workItemId: string;
  agentId: string;
  leaseDurationMs?: number;
  maxExtensions?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lease duration: 10 minutes. */
export const DEFAULT_LEASE_DURATION_MS = 600_000;

/** Default heartbeat interval: 2 minutes. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;

/** Default grace period after lease expiry: 3 minutes. */
export const DEFAULT_GRACE_PERIOD_MS = 180_000;

/** Default maximum lease extensions. */
export const DEFAULT_MAX_EXTENSIONS = 3;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid ClaimStatus.
 *
 * @param value - The string to check
 * @returns True if value is a valid ClaimStatus
 */
export function isValidClaimStatus(value: string): value is ClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(value);
}

/**
 * Validates that an unknown value is structurally a valid TaskClaim.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to the TaskClaim interface
 */
export function isTaskClaim(value: unknown): value is TaskClaim {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.workItemId === 'string' &&
    typeof obj.agentId === 'string' &&
    typeof obj.status === 'string' &&
    isValidClaimStatus(obj.status) &&
    typeof obj.claimedAt === 'string' &&
    typeof obj.leaseExpiresAt === 'string' &&
    typeof obj.lastHeartbeatAt === 'string' &&
    typeof obj.extensionCount === 'number' &&
    typeof obj.maxExtensions === 'number' &&
    typeof obj.leaseDurationMs === 'number'
  );
}

/**
 * Checks whether a claim's lease has expired (not counting grace period).
 *
 * @param claim - The claim to check
 * @param now - Current time (defaults to Date.now())
 * @returns True if the lease has expired
 */
export function isLeaseExpired(claim: TaskClaim, now: number = Date.now()): boolean {
  return now > new Date(claim.leaseExpiresAt).getTime();
}

/**
 * Checks whether a claim is past its grace period and should be revoked.
 *
 * @param claim - The claim to check
 * @param gracePeriodMs - Grace period duration in ms
 * @param now - Current time (defaults to Date.now())
 * @returns True if grace period has exceeded
 */
export function isGracePeriodExceeded(
  claim: TaskClaim,
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  now: number = Date.now(),
): boolean {
  const leaseExpiry = new Date(claim.leaseExpiresAt).getTime();
  return now > leaseExpiry + gracePeriodMs;
}

/**
 * Checks whether a claim can be extended (has not exhausted max extensions).
 *
 * @param claim - The claim to check
 * @returns True if another extension is allowed
 */
export function canExtendLease(claim: TaskClaim): boolean {
  return claim.status === 'active' && claim.extensionCount < claim.maxExtensions;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates CreateClaimInput and returns an array of error messages.
 *
 * @param input - The creation input to validate
 * @returns Array of validation error strings (empty = valid)
 */
export function validateCreateClaimInput(input: CreateClaimInput): string[] {
  const errors: string[] = [];
  if (!input.workItemId || typeof input.workItemId !== 'string') {
    errors.push('workItemId is required and must be a string');
  }
  if (!input.agentId || typeof input.agentId !== 'string') {
    errors.push('agentId is required and must be a string');
  }
  if (input.leaseDurationMs !== undefined) {
    if (input.leaseDurationMs < 60_000) {
      errors.push('leaseDurationMs must be at least 60000 (1 minute)');
    }
    if (input.leaseDurationMs > 3_600_000) {
      errors.push('leaseDurationMs must not exceed 3600000 (1 hour)');
    }
  }
  if (input.maxExtensions !== undefined && (input.maxExtensions < 0 || !Number.isInteger(input.maxExtensions))) {
    errors.push('maxExtensions must be a non-negative integer');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new TaskClaim with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated TaskClaim object
 *
 * @example
 * ```typescript
 * const claim = createTaskClaim({
 *   workItemId: 'wi-abc-123',
 *   agentId: 'crewly-product-leo-member-n',
 * });
 * // claim.leaseExpiresAt will be 10 minutes from now
 * ```
 */
export function createTaskClaim(input: CreateClaimInput): TaskClaim {
  const now = new Date();
  const leaseDuration = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const leaseExpiry = new Date(now.getTime() + leaseDuration);

  return {
    id: uuidv4(),
    workItemId: input.workItemId,
    agentId: input.agentId,
    status: 'active',
    claimedAt: now.toISOString(),
    leaseExpiresAt: leaseExpiry.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    extensionCount: 0,
    maxExtensions: input.maxExtensions ?? DEFAULT_MAX_EXTENSIONS,
    leaseDurationMs: leaseDuration,
  };
}

/**
 * Extends a claim's lease by the original lease duration.
 * Returns a new claim object (immutable pattern).
 *
 * @param claim - The claim to extend
 * @returns New TaskClaim with extended lease, or null if extension not allowed
 */
export function extendClaim(claim: TaskClaim): TaskClaim | null {
  if (!canExtendLease(claim)) return null;
  const now = new Date();
  const newExpiry = new Date(now.getTime() + claim.leaseDurationMs);

  return {
    ...claim,
    leaseExpiresAt: newExpiry.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    extensionCount: claim.extensionCount + 1,
  };
}
