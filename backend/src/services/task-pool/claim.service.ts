/**
 * ClaimService — Manages task claim lifecycle (lease, heartbeat, grace period)
 *
 * Agents claim WorkItems from the Task Pool via this service. Each claim has:
 * - Lease (default 10min): agent must complete or extend before expiry
 * - Heartbeat (2min interval): agent signals liveness
 * - Grace period (3min): buffer after lease expiry before forced revocation
 * - Max extensions (3): how many times a lease can be renewed
 *
 * The Reconciler uses this service to detect expired/grace-exceeded claims.
 *
 * @module services/task-pool/claim.service
 */

import { PoolStorage } from './pool-storage.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import {
  type TaskClaim,
  type CreateClaimInput,
  type ClaimStatus,
  createTaskClaim,
  extendClaim,
  isLeaseExpired,
  isGracePeriodExceeded,
  canExtendLease,
  validateCreateClaimInput,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_MAX_EXTENSIONS,
} from '../../types/v2/claim.types.js';

/**
 * Consecutive grace-period revocations (with NO intervening heartbeat) after
 * which an agent's session is considered HUNG — it keeps claiming work but
 * never proves liveness. This is the Irissair orchestrator 假死 signature:
 * claimed hourly, never heartbeated, revoked ~13 min later, repeat. Surfaced
 * via {@link ClaimService.getHungAgents}.
 */
export const HUNG_SESSION_GRACE_REVOKE_THRESHOLD = 3;

/** Prefix of the reconciler's revoke reason for grace-period revocations. */
const GRACE_REVOKE_REASON_PREFIX = 'Grace period exceeded';

// ---------------------------------------------------------------------------
// Result Types
// ---------------------------------------------------------------------------

/**
 * Result of a heartbeat operation.
 */
export interface HeartbeatResult {
  /** Whether the heartbeat was accepted */
  success: boolean;
  /** Updated claim (if success) */
  claim?: TaskClaim;
  /** Error reason (if failure) */
  reason?: string;
}

/**
 * Result of a lease extension attempt.
 */
export interface ExtendLeaseResult {
  /** Whether the extension was granted */
  success: boolean;
  /** Updated claim (if success) */
  claim?: TaskClaim;
  /** Error reason (if failure) */
  reason?: string;
}

/**
 * Summary of expired claims found during a scan.
 */
export interface ExpiredClaimsSummary {
  /** Claims past lease expiry but within grace period */
  expiring: TaskClaim[];
  /** Claims past grace period — should be revoked */
  graceExceeded: TaskClaim[];
}

// ---------------------------------------------------------------------------
// ClaimService
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of task claims in the Task Pool.
 *
 * Responsibilities:
 * - Create claims when agents claim work items
 * - Process heartbeats from agents to prove liveness
 * - Extend leases when agents need more time
 * - Release claims when agents finish or give up
 * - Revoke claims when grace period is exceeded
 * - Scan for expired claims (used by Reconciler)
 *
 * @example
 * ```typescript
 * const claimService = new ClaimService(storage);
 *
 * // Agent claims a work item
 * const claim = await claimService.createClaim({
 *   workItemId: 'wi-123',
 *   agentId: 'agent-leo',
 * });
 *
 * // Agent sends heartbeats periodically
 * await claimService.heartbeat(claim.id, 'agent-leo');
 *
 * // Agent finishes
 * await claimService.release(claim.id, 'completed');
 * ```
 */
export class ClaimService {
  private readonly storage: PoolStorage;
  private readonly logger: ComponentLogger;

  /**
   * Per-agent count of consecutive grace-period revocations with NO intervening
   * heartbeat. Incremented on each grace revoke, reset to 0 on any successful
   * heartbeat (proof the session is alive). Powers hung-session detection
   * ({@link getHungAgents}).
   */
  private readonly consecutiveGraceRevokes = new Map<string, number>();

  constructor(storage: PoolStorage) {
    this.storage = storage;
    this.logger = LoggerService.getInstance().createComponentLogger('ClaimService');
  }

  // -----------------------------------------------------------------------
  // Claim Creation
  // -----------------------------------------------------------------------

  /**
   * Creates a new claim for a work item.
   *
   * Validates input, checks for duplicate claims, and creates the claim
   * with default or specified lease parameters.
   *
   * @param input - Claim creation parameters
   * @returns The created TaskClaim
   * @throws Error if input is invalid or work item already has an active claim
   */
  async createClaim(input: CreateClaimInput): Promise<TaskClaim> {
    const errors = validateCreateClaimInput(input);
    if (errors.length > 0) {
      throw new Error(`Invalid claim input: ${errors.join('; ')}`);
    }

    // Check for existing active claim on the work item
    const existingByItem = await this.storage.findActiveClaimByWorkItem(input.workItemId);
    if (existingByItem) {
      throw new Error(
        `WorkItem ${input.workItemId} already has an active claim (${existingByItem.id}) by agent ${existingByItem.agentId}`,
      );
    }

    // Check if agent already has an active claim
    const existingByAgent = await this.storage.findActiveClaimByAgent(input.agentId);
    if (existingByAgent) {
      throw new Error(
        `Agent ${input.agentId} already has an active claim (${existingByAgent.id}) on WorkItem ${existingByAgent.workItemId}`,
      );
    }

    const claim = createTaskClaim(input);
    await this.storage.addClaim(claim);

    this.logger.info('Claim created', {
      claimId: claim.id,
      workItemId: input.workItemId,
      agentId: input.agentId,
      leaseExpiresAt: claim.leaseExpiresAt,
    });

    return claim;
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  /**
   * Processes a heartbeat from an agent for a specific claim.
   *
   * Updates the lastHeartbeatAt timestamp. The heartbeat is only accepted
   * if the claim is active and belongs to the requesting agent.
   *
   * @param claimId - The claim ID
   * @param agentId - The agent sending the heartbeat (must match claim owner)
   * @returns HeartbeatResult indicating success or failure
   */
  async heartbeat(claimId: string, agentId: string): Promise<HeartbeatResult> {
    const claims = await this.storage.getClaims();
    const claim = claims.find((c) => c.id === claimId);

    if (!claim) {
      return { success: false, reason: `Claim not found: ${claimId}` };
    }

    if (claim.agentId !== agentId) {
      return {
        success: false,
        reason: `Agent ${agentId} does not own claim ${claimId} (owned by ${claim.agentId})`,
      };
    }

    if (claim.status !== 'active' && claim.status !== 'expiring') {
      return {
        success: false,
        reason: `Cannot heartbeat claim in status '${claim.status}'`,
      };
    }

    const now = new Date().toISOString();
    const updated = await this.storage.updateClaim(claimId, (c) => {
      c.lastHeartbeatAt = now;
      // If claim was expiring but agent is alive, restore to active
      // (only if lease hasn't been fully exceeded + grace)
      if (c.status === 'expiring') {
        c.status = 'active';
      }
    });

    if (!updated) {
      return { success: false, reason: `Failed to update claim ${claimId}` };
    }

    const updatedClaim = claims.find((c) => c.id === claimId)!;
    this.logger.debug?.('Heartbeat received', { claimId, agentId });

    // Liveness proof — clear any accumulated grace-revoke count for this agent
    // so hung-session detection only fires on agents that NEVER heartbeat.
    this.consecutiveGraceRevokes.delete(agentId);

    return { success: true, claim: updatedClaim };
  }

  // -----------------------------------------------------------------------
  // Lease Extension
  // -----------------------------------------------------------------------

  /**
   * Extends the lease on a claim, giving the agent more time.
   *
   * Extension is only allowed if:
   * - Claim is active
   * - Extension count < maxExtensions
   * - Agent owns the claim
   *
   * @param claimId - The claim ID
   * @param agentId - The agent requesting extension (must match claim owner)
   * @returns ExtendLeaseResult indicating success or failure
   */
  async extendLease(claimId: string, agentId: string): Promise<ExtendLeaseResult> {
    const claims = await this.storage.getClaims();
    const claim = claims.find((c) => c.id === claimId);

    if (!claim) {
      return { success: false, reason: `Claim not found: ${claimId}` };
    }

    if (claim.agentId !== agentId) {
      return {
        success: false,
        reason: `Agent ${agentId} does not own claim ${claimId}`,
      };
    }

    if (!canExtendLease(claim)) {
      const reason =
        claim.status !== 'active'
          ? `Claim is in '${claim.status}' status, must be 'active'`
          : `Max extensions reached (${claim.extensionCount}/${claim.maxExtensions})`;
      return { success: false, reason };
    }

    const extended = extendClaim(claim);
    if (!extended) {
      return { success: false, reason: 'Extension failed (internal)' };
    }

    // Apply the extension to storage
    await this.storage.updateClaim(claimId, (c) => {
      c.leaseExpiresAt = extended.leaseExpiresAt;
      c.lastHeartbeatAt = extended.lastHeartbeatAt;
      c.extensionCount = extended.extensionCount;
    });

    const updatedClaim = claims.find((c) => c.id === claimId)!;
    this.logger.info('Lease extended', {
      claimId,
      agentId,
      extensionCount: updatedClaim.extensionCount,
      newExpiresAt: updatedClaim.leaseExpiresAt,
    });

    return { success: true, claim: updatedClaim };
  }

  // -----------------------------------------------------------------------
  // Release & Revoke
  // -----------------------------------------------------------------------

  /**
   * Voluntarily releases a claim (agent finished or gave up).
   *
   * @param claimId - The claim ID to release
   * @param reason - Why the claim is being released
   * @throws Error if claim not found
   */
  async release(claimId: string, reason: string): Promise<void> {
    const claims = await this.storage.getClaims();
    const claim = claims.find((c) => c.id === claimId);

    if (!claim) {
      throw new Error(`Claim not found: ${claimId}`);
    }

    if (claim.status === 'released' || claim.status === 'revoked') {
      this.logger.warn('Claim already ended, skipping release', {
        claimId,
        status: claim.status,
      });
      return;
    }

    const now = new Date().toISOString();
    await this.storage.updateClaim(claimId, (c) => {
      c.status = 'released';
      c.endedAt = now;
      c.endReason = reason;
    });

    this.logger.info('Claim released', { claimId, reason, agentId: claim.agentId });
  }

  /**
   * Force-revokes a claim (system action when grace period exceeded).
   *
   * @param claimId - The claim ID to revoke
   * @param reason - Why the claim is being revoked
   * @throws Error if claim not found
   */
  async revoke(claimId: string, reason: string): Promise<void> {
    const claims = await this.storage.getClaims();
    const claim = claims.find((c) => c.id === claimId);

    if (!claim) {
      throw new Error(`Claim not found: ${claimId}`);
    }

    if (claim.status === 'revoked') {
      this.logger.warn('Claim already revoked, skipping', { claimId });
      return;
    }

    const now = new Date().toISOString();
    await this.storage.updateClaim(claimId, (c) => {
      c.status = 'revoked';
      c.endedAt = now;
      c.endReason = reason;
    });

    this.logger.info('Claim revoked', { claimId, reason, agentId: claim.agentId });

    // Hung-session detection: a grace-period revoke means the agent held a lease
    // but never heartbeated. Track consecutive occurrences per agent (reset on
    // the next heartbeat). Repeated grace revokes with no heartbeat = a session
    // that keeps claiming work but never executes it (the Irissair 假死).
    if (reason.startsWith(GRACE_REVOKE_REASON_PREFIX)) {
      const next = (this.consecutiveGraceRevokes.get(claim.agentId) ?? 0) + 1;
      this.consecutiveGraceRevokes.set(claim.agentId, next);
      if (next >= HUNG_SESSION_GRACE_REVOKE_THRESHOLD) {
        this.logger.error(
          'Agent session looks HUNG — repeated grace-period revokes with no heartbeat',
          {
            agentId: claim.agentId,
            consecutiveGraceRevokes: next,
            threshold: HUNG_SESSION_GRACE_REVOKE_THRESHOLD,
          },
        );
      }
    }
  }

  /**
   * Consecutive grace-period revocations (with no intervening heartbeat) for an
   * agent. Resets to 0 on the agent's next successful heartbeat.
   *
   * @param agentId - The agent/session id.
   * @returns The current consecutive grace-revoke count (0 if none).
   */
  getConsecutiveGraceRevokes(agentId: string): number {
    return this.consecutiveGraceRevokes.get(agentId) ?? 0;
  }

  /**
   * Agents whose consecutive grace-revoke count is at or above `threshold` —
   * their sessions keep claiming work but never heartbeat, i.e. they look HUNG.
   *
   * @param threshold - Minimum consecutive grace-revokes (default
   *   {@link HUNG_SESSION_GRACE_REVOKE_THRESHOLD}).
   * @returns Agent ids that currently look hung.
   */
  getHungAgents(threshold: number = HUNG_SESSION_GRACE_REVOKE_THRESHOLD): string[] {
    const hung: string[] = [];
    for (const [agentId, count] of this.consecutiveGraceRevokes) {
      if (count >= threshold) hung.push(agentId);
    }
    return hung;
  }

  /**
   * Clear an agent's consecutive grace-revoke count. Called by the hung-session
   * watchdog after it triggers a recovery (session restart) so the freshly
   * restarted session is not immediately re-flagged as hung before it has had a
   * chance to heartbeat.
   *
   * @param agentId - The agent/session id to clear.
   */
  clearGraceRevokes(agentId: string): void {
    this.consecutiveGraceRevokes.delete(agentId);
  }

  // -----------------------------------------------------------------------
  // Expiry Detection (used by Reconciler)
  // -----------------------------------------------------------------------

  /**
   * Scans all active claims and categorizes expired ones.
   *
   * Returns two lists:
   * - `expiring`: lease expired but within grace period (should be marked 'expiring')
   * - `graceExceeded`: past grace period (should be revoked and work item released)
   *
   * @param now - Current timestamp in ms (default: Date.now())
   * @param gracePeriodMs - Grace period duration (default: DEFAULT_GRACE_PERIOD_MS)
   * @returns Summary of expired claims
   */
  async scanExpiredClaims(
    now: number = Date.now(),
    gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  ): Promise<ExpiredClaimsSummary> {
    const claims = await this.storage.getClaims();
    const activeClaims = claims.filter(
      (c) => c.status === 'active' || c.status === 'expiring',
    );

    const expiring: TaskClaim[] = [];
    const graceExceeded: TaskClaim[] = [];

    for (const claim of activeClaims) {
      if (isGracePeriodExceeded(claim, gracePeriodMs, now)) {
        graceExceeded.push(claim);
      } else if (isLeaseExpired(claim, now)) {
        expiring.push(claim);
      }
    }

    return { expiring, graceExceeded };
  }

  /**
   * Marks claims as 'expiring' status (called by Reconciler fast loop).
   *
   * @param claimIds - IDs of claims to mark as expiring
   */
  async markExpiring(claimIds: string[]): Promise<void> {
    for (const claimId of claimIds) {
      await this.storage.updateClaim(claimId, (c) => {
        if (c.status === 'active') {
          c.status = 'expiring';
        }
      });
    }
    this.logger.info('Claims marked as expiring', { count: claimIds.length });
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Gets an active claim for a specific agent.
   *
   * @param agentId - Agent session name
   * @returns The active claim, or undefined
   */
  async getActiveClaimByAgent(agentId: string): Promise<TaskClaim | undefined> {
    return this.storage.findActiveClaimByAgent(agentId);
  }

  /**
   * Gets an active claim for a specific work item.
   *
   * @param workItemId - The work item ID
   * @returns The active claim, or undefined
   */
  async getActiveClaimByWorkItem(workItemId: string): Promise<TaskClaim | undefined> {
    return this.storage.findActiveClaimByWorkItem(workItemId);
  }

  /**
   * Gets all active claims.
   *
   * @returns Array of active/expiring claims
   */
  async getActiveClaims(): Promise<TaskClaim[]> {
    const claims = await this.storage.getClaims();
    return claims.filter((c) => c.status === 'active' || c.status === 'expiring');
  }

  /**
   * Gets a claim by ID.
   *
   * @param claimId - The claim ID
   * @returns The claim, or undefined
   */
  async getClaimById(claimId: string): Promise<TaskClaim | undefined> {
    const claims = await this.storage.getClaims();
    return claims.find((c) => c.id === claimId);
  }

  /**
   * Checks whether an agent's heartbeat is stale (no heartbeat within expected interval).
   *
   * @param claim - The claim to check
   * @param heartbeatIntervalMs - Expected heartbeat interval (default: 2min)
   * @param toleranceMs - Additional tolerance before considering stale (default: 30s)
   * @param now - Current timestamp in ms
   * @returns True if the last heartbeat is older than interval + tolerance
   */
  isHeartbeatStale(
    claim: TaskClaim,
    heartbeatIntervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
    toleranceMs: number = 30_000,
    now: number = Date.now(),
  ): boolean {
    const lastHb = new Date(claim.lastHeartbeatAt).getTime();
    return now - lastHb > heartbeatIntervalMs + toleranceMs;
  }

  // -----------------------------------------------------------------------
  // Flush
  // -----------------------------------------------------------------------

  /**
   * Flushes pending storage writes to disk.
   */
  async flush(): Promise<void> {
    await this.storage.flush();
  }
}
