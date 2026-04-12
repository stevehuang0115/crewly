/**
 * Live Reconciler Data Provider — Wires the Reconciler to real services
 *
 * Replaces the stub data provider with actual Task Pool, Claim Service,
 * Storage Service, and Agent Suspend integrations. This enables the
 * Reconciler to perform real reconciliation passes including:
 * - Detecting expired claims and revoking them
 * - Finding stuck WorkItems and re-queuing them
 * - Hybrid Wake: waking dormant agents when tasks go unclaimed
 *
 * @module services/reconciler/reconciler-data-provider
 */

import type { ReconcilerDataProvider } from './reconciler.service.js';
import type { AgentHealth } from './reconcile-rules.js';
import type {
  WorkItem,
  Request,
  TaskClaim,
  ReconcileCorrection,
  WakeAction,
} from '../../types/v2/index.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { ClaimService } from '../task-pool/claim.service.js';
import { PoolStorage } from '../task-pool/pool-storage.js';
import { StorageService } from '../core/storage.service.js';
import { RequestService } from '../v3/request.service.js';
import { AgentSuspendService } from '../agent/agent-suspend.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long an agent can be unseen before we consider it stale (5 min). */
const AGENT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// LiveReconcilerDataProvider
// ---------------------------------------------------------------------------

/**
 * Production-ready ReconcilerDataProvider that connects to live services.
 *
 * Reads WorkItems and Claims from the Task Pool, builds the agent health
 * map from StorageService team data, and executes wake actions via
 * AgentSuspendService.
 *
 * @example
 * ```typescript
 * const provider = new LiveReconcilerDataProvider();
 * const reconciler = new ReconcilerService(provider);
 * reconciler.start();
 * ```
 */
export class LiveReconcilerDataProvider implements ReconcilerDataProvider {
  private readonly logger: ComponentLogger;
  private readonly storage: StorageService;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('ReconcilerDataProvider');
    this.storage = StorageService.getInstance();
  }

  /**
   * Returns all non-terminal WorkItems from the Task Pool.
   * Non-terminal means items that are not 'done' or 'cancelled'.
   *
   * @returns Active WorkItems
   */
  async getActiveWorkItems(): Promise<WorkItem[]> {
    try {
      const pool = TaskPoolService.getInstance();
      const allItems = await pool.getAllItems();
      return allItems.filter(
        (wi) => wi.status !== 'done' && wi.status !== 'cancelled',
      );
    } catch (error) {
      this.logger.error('Failed to get active WorkItems', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Returns WorkItems belonging to a specific Request.
   *
   * @param requestId - The Request ID
   * @returns WorkItems for the given request
   */
  async getWorkItemsForRequest(requestId: string): Promise<WorkItem[]> {
    try {
      const pool = TaskPoolService.getInstance();
      const allItems = await pool.getAllItems();
      return allItems.filter((wi) => wi.requestId === requestId);
    } catch (error) {
      this.logger.error('Failed to get WorkItems for request', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Returns all non-terminal Requests.
   *
   * Note: V3 Requests are not yet fully persisted — returns empty
   * until the Request storage layer is implemented. The Reconciler
   * gracefully handles empty arrays.
   *
   * @returns Active Requests
   */
  async getActiveRequests(): Promise<Request[]> {
    try {
      const service = RequestService.getInstance();
      const all = await service.listAll();
      // Filter for non-terminal statuses: anything except 'done' or 'cancelled'
      return all.filter(
        (r) => r.status !== 'done' && r.status !== 'cancelled',
      );
    } catch (error) {
      this.logger.error('Failed to get active Requests', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Returns all active/expiring TaskClaims.
   *
   * @returns Active claims
   */
  async getActiveClaims(): Promise<TaskClaim[]> {
    try {
      const pool = TaskPoolService.getInstance();
      return await pool.getActiveClaims();
    } catch (error) {
      this.logger.error('Failed to get active claims', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Builds the agent health map from StorageService team data.
   *
   * Iterates all teams and members to produce a Map<sessionName, AgentHealth>
   * representing the current state of all known agents.
   *
   * @returns Map of agent session name to health info
   */
  async getAgentHealthMap(): Promise<Map<string, AgentHealth>> {
    const healthMap = new Map<string, AgentHealth>();

    try {
      const teams = await this.storage.getTeams();

      for (const team of teams) {
        for (const member of team.members || []) {
          if (!member.sessionName) continue;

          // Map TeamMember agentStatus to AgentHealth status
          const status = this.mapAgentStatus(member.agentStatus);

          const health: AgentHealth = {
            sessionName: member.sessionName,
            status,
            lastSeenAt: member.lastActivityCheck || member.updatedAt,
            role: member.role,
            tags: member.capabilities || [],
            activeWorkItemCount: 0, // Updated below from pool data
            teamId: team.id,
            memberId: member.id,
          };

          healthMap.set(member.sessionName, health);
        }
      }

      // Enrich with active claim counts from the pool
      try {
        const pool = TaskPoolService.getInstance();
        const activeClaims = await pool.getActiveClaims();
        for (const claim of activeClaims) {
          const agent = healthMap.get(claim.agentId);
          if (agent) {
            agent.activeWorkItemCount = (agent.activeWorkItemCount || 0) + 1;
          }
        }
      } catch {
        // Pool may not be initialized yet — safe to ignore
      }
    } catch (error) {
      this.logger.error('Failed to build agent health map', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return healthMap;
  }

  /**
   * Applies a reconciliation correction by updating entity status.
   *
   * @param correction - The correction to apply
   */
  async applyCorrection(correction: ReconcileCorrection): Promise<void> {
    try {
      if (correction.entityType === 'work_item') {
        const pool = TaskPoolService.getInstance();
        await pool.updateItemStatus(
          correction.entityId,
          correction.newState as WorkItem['status'],
        );
        this.logger.info('Applied work item correction', {
          workItemId: correction.entityId,
          from: correction.previousState,
          to: correction.newState,
          reason: correction.reason,
        });
      } else if (correction.entityType === 'request') {
        const service = RequestService.getInstance();
        await service.update(correction.entityId, {
          status: correction.newState as Request['status'],
        });
        this.logger.info('Applied request correction', {
          requestId: correction.entityId,
          from: correction.previousState,
          to: correction.newState,
          reason: correction.reason,
        });
      }
    } catch (error) {
      this.logger.error('Failed to apply correction', {
        correction,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Releases a WorkItem back to the Task Pool for re-claiming.
   *
   * @param workItemId - The WorkItem ID to release
   * @param reason - Why the item is being released
   */
  async releaseToPool(workItemId: string, reason: string): Promise<void> {
    try {
      const pool = TaskPoolService.getInstance();
      await pool.releaseBack(workItemId, reason);
      this.logger.info('Released work item to pool', { workItemId, reason });
    } catch (error) {
      this.logger.error('Failed to release to pool', {
        workItemId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Re-queues a WorkItem (increments retryCount, sets status to 'queued').
   *
   * @param workItemId - The WorkItem ID to re-queue
   */
  async requeueWorkItem(workItemId: string): Promise<void> {
    try {
      const pool = TaskPoolService.getInstance();
      await pool.releaseBack(workItemId, 'reconciler_requeue');
      this.logger.info('Re-queued work item', { workItemId });
    } catch (error) {
      this.logger.error('Failed to re-queue work item', {
        workItemId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Marks a claim as 'expiring' (lease expired, within grace period).
   *
   * @param claimId - The claim ID to mark
   */
  async markClaimExpiring(claimId: string): Promise<void> {
    try {
      const pool = TaskPoolService.getInstance();
      await pool.markClaimExpiring(claimId);
      this.logger.info('Marked claim as expiring', { claimId });
    } catch (error) {
      this.logger.error('Failed to mark claim expiring', {
        claimId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Revokes a claim and releases its WorkItem back to the pool.
   *
   * @param claimId - The claim ID to revoke
   * @param reason - Why the claim is being revoked
   */
  async revokeClaimAndRelease(claimId: string, reason: string): Promise<void> {
    try {
      const pool = TaskPoolService.getInstance();
      await pool.revokeAndRelease(claimId, reason);
      this.logger.info('Revoked claim and released work item', { claimId, reason });
    } catch (error) {
      this.logger.error('Failed to revoke claim', {
        claimId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Returns all available (queued, unclaimed) WorkItems from the Task Pool.
   * Used by Hybrid Wake to find items that need agents.
   *
   * @returns Available pool items
   */
  async getAvailablePoolItems(): Promise<WorkItem[]> {
    try {
      const pool = TaskPoolService.getInstance();
      return await pool.getAvailableItems();
    } catch (error) {
      this.logger.error('Failed to get available pool items', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Executes a wake action — rehydrates a suspended agent or starts an inactive one.
   *
   * Strategy mapping:
   * - 'rehydrate' → AgentSuspendService.rehydrateAgent()
   * - 'start' → AgentRegistrationService.createAgentSession() (via start-agent API)
   *
   * @param action - The wake action to execute
   * @returns True if the wake was initiated successfully
   */
  async executeWakeAction(action: WakeAction): Promise<boolean> {
    const { agentSessionName, strategy } = action;

    this.logger.info('Executing wake action', {
      agent: agentSessionName,
      strategy,
      workItemId: action.workItemId,
      score: action.score,
    });

    try {
      if (strategy === 'rehydrate') {
        const suspendService = AgentSuspendService.getInstance();
        if (!suspendService.isSuspended(agentSessionName)) {
          this.logger.warn('Agent not in suspended map, cannot rehydrate', {
            agent: agentSessionName,
          });
          return false;
        }
        return await suspendService.rehydrateAgent(agentSessionName);
      } else if (strategy === 'start') {
        // For inactive agents, we need to start them via the registration service.
        // The agent session creation is complex — use the start-agent API endpoint.
        const response = await fetch(
          `http://localhost:${process.env.PORT || 8787}/api/teams/members/start`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionName: agentSessionName }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error('Start agent API failed', {
            agent: agentSessionName,
            status: response.status,
            error: errorText,
          });
          return false;
        }

        this.logger.info('Start agent initiated via API', {
          agent: agentSessionName,
        });
        return true;
      } else {
        this.logger.warn('Unknown wake strategy', { strategy, agent: agentSessionName });
        return false;
      }
    } catch (error) {
      this.logger.error('Wake action failed', {
        agent: agentSessionName,
        strategy,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Backfill token usage on completed WorkItems that still show 0 tokens.
   *
   * Scans all done/failed WorkItems with zero inputTokens, looks up token
   * usage from TokenUsageService by the agent session (target field), and
   * writes the data to the WorkItem.
   *
   * @returns Number of WorkItems updated
   */
  async backfillTokenUsage(): Promise<number> {
    try {
      const pool = TaskPoolService.getInstance();
      const allItems = await pool.getAllItems();
      const tokenService = TokenUsageService.getInstance();
      const sessionUsage = tokenService.getUsageBySessions();

      // Build a lookup map: sessionName -> usage summary
      const usageMap = new Map(sessionUsage.map(s => [s.sessionName, s]));

      let updated = 0;
      for (const wi of allItems) {
        // Only backfill done/failed items with no token data
        if (wi.status !== 'done' && wi.status !== 'failed') continue;
        if ((wi.inputTokens ?? 0) > 0 || (wi.outputTokens ?? 0) > 0) continue;
        if (!wi.target) continue;

        const usage = usageMap.get(wi.target);
        if (!usage) continue;

        const totalInput = usage.totalInput || 0;
        const totalOutput = usage.totalOutput || 0;
        const totalCost = usage.cost || 0;

        if (totalInput > 0 || totalOutput > 0) {
          await pool.updateTokenUsage(wi.id, totalInput, totalOutput, totalCost);
          updated++;
        }
      }

      if (updated > 0) {
        this.logger.debug('Backfilled token usage on WorkItems', { count: updated });
      }
      return updated;
    } catch (error) {
      this.logger.debug('Token backfill failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Maps TeamMember agentStatus to AgentHealth status.
   *
   * @param agentStatus - The TeamMember's agentStatus field
   * @returns Normalized status for reconcile rules
   */
  private mapAgentStatus(
    agentStatus: string,
  ): AgentHealth['status'] {
    switch (agentStatus) {
      case 'active':
        return 'active';
      case 'starting':
      case 'started':
      case 'activating':
        return 'started';
      case 'inactive':
        return 'inactive';
      case 'suspended':
        return 'suspended';
      default:
        return 'unknown';
    }
  }
}
