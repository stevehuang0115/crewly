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
import { isUnderMemoryPressure, getMemoryStats } from '../core/system-health.util.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import { WEB_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long an agent can be unseen before we consider it stale (5 min). */
const AGENT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Heuristic: detect "storage not yet hydrated" errors so the data
 * provider can demote them from `error` to `debug` log level.
 *
 * Symptom in production (F-CYCLE7-3, 2026-05-07 11:19→11:21Z): when
 * the Reconciler's 10s fast-loop runs before the Task Pool's
 * `pool.json` finishes loading after a SQLite-related restart, an
 * inner method calls `.filter()` on a still-undefined array slot. The
 * thrown TypeError carries the canonical V8 message
 * "Cannot read properties of undefined (reading 'filter')". The catch
 * already returns `[]`, but it logs at `error` — every 10s for ~110s
 * — flooding logs and hiding real errors.
 *
 * **F-CYCLE7-3-FU (2026-05-07, PR review #511 follow-up):** The original
 * implementation enumerated `'filter'|'find'|'map'|'forEach'|'length'`
 * in the message. That whitelist was brittle — adjacent reconciler /
 * future-consumer code reaches for `.some()` / `.every()` / `.reduce()` /
 * `.includes()` / `.indexOf()` / `.slice()` / property accesses that
 * throw the SAME V8 TypeError shape during the same hydration window
 * but are silently dropped from this classifier, re-introducing the
 * noise pattern this PR is trying to silence.
 *
 * The fix mirrors the discipline used in
 * `backend/src/utils/native-binding.utils.ts#isNativeArchMismatchError`
 * (F-CYCLE7-1): match the **structural** error shape, not enumerated
 * call sites.
 *
 * Contract:
 *   1. Must be a real `TypeError` (not just any thrown value with a
 *      matching string — that narrows the false-positive surface).
 *   2. Message must carry both readonly anchors of the V8 shape:
 *      `"Cannot read"` AND `"of undefined"`. The middle (`property` /
 *      `properties of undefined (reading 'X')` / older `property 'X'
 *      of undefined`) varies between Node versions; we don't anchor
 *      on it.
 *
 * Negative cases this MUST reject (all tested):
 *   - `Cannot read properties of null (reading 'filter')` — a null
 *     pointer is a different bug class from hydration-not-ready.
 *   - `TypeError: foo is not a function` — symptom of a missing API.
 *   - Non-TypeError throws (`new Error('Cannot read … of undefined')`)
 *     — strings can match by accident; the type narrow guards.
 *   - `'Database connection refused'` — genuine downstream failure.
 *
 * @param error - The thrown value to classify. Anything not a
 *   TypeError fails immediately, so callers can pass `error: unknown`
 *   without pre-checks.
 * @returns True iff the error is the V8 hydration-not-ready shape.
 */
function isStorageNotReadyError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const lower = error.message.toLowerCase();
  // The two readonly anchors of the V8 / Node error shape, present
  // across all engine versions and all property/method accesses on
  // an undefined value:
  //   modern V8: "Cannot read properties of undefined (reading 'X')"
  //   older V8:  "Cannot read property 'X' of undefined"
  return lower.includes('cannot read') && lower.includes('of undefined');
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Cap on concurrent active agents while the system is under memory
 * pressure. Named `WAKE_FLOOR` for historical reasons — the value
 * acts as a CEILING on wake actions under pressure, not a guaranteed
 * floor. The reconciler does not proactively bring the active count
 * up to this value; it only permits wakes when `activeCount < N` and
 * blocks them otherwise.
 *
 * Behaviour:
 *  - `activeCount <  N` AND memory pressure → wake allowed (keeps the
 *    system minimally productive instead of fully wedged).
 *  - `activeCount >= N` AND memory pressure → wake blocked (prevents
 *    an OOM cascade by capping additional spawns during a crisis).
 *  - No memory pressure → this gate is not consulted.
 *
 * History: an earlier implementation blocked EVERY wake under memory
 * pressure, which wedged the system on 2026-05-13 (6+ hours, free RAM
 * 16-33 MB, queued WIs piling up). On 2026-05-14 the system stalled
 * again — this gate worked as designed, but `IdleDetectionService`
 * silently stopped releasing idle agents, so `activeCount` stayed
 * above N for ~20 hours. The cap itself is not the bug; the absence
 * of forward progress when the cap is held is. See the heartbeat
 * additions in `idle-detection.service.ts`.
 */
export const WAKE_FLOOR_UNDER_PRESSURE = 3;

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
  private eventBus: EventBusService | null = null;

  // Memory-pressure broadcast state. Per-instance to keep counters
  // isolated, but the publish throttle ensures we don't flood orc even
  // if multiple providers exist (each will throttle independently and
  // EventBus deduplicates on event id).
  private consecutivePressureSkips = 0;
  private lastPressureNotifiedAt = 0;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('ReconcilerDataProvider');
    this.storage = StorageService.getInstance();
  }

  /**
   * Inject the EventBus used to broadcast `system:memory_pressure` to
   * orc. Optional — when not set, the reconciler still functions but
   * no user-facing notification is emitted. Called once from the
   * server bootstrap after both services are constructed.
   *
   * @param eventBus - The EventBusService singleton wired in `index.ts`
   */
  setEventBus(eventBus: EventBusService): void {
    this.eventBus = eventBus;
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
   * **F-CYCLE7-3 (2026-05-07):** Returns `[]` defensively if the pool
   * returns a non-array (e.g. partial post-restart hydration where
   * `pool.json` is missing the `claims` field). Storage-not-ready is
   * logged at `debug`, not `error`, to avoid the post-restart error
   * storm seen at 11:19→11:21Z. Genuine failures (thrown errors) keep
   * their `error`-level log.
   *
   * @returns Active claims (always an array)
   */
  async getActiveClaims(): Promise<TaskClaim[]> {
    try {
      const pool = TaskPoolService.getInstance();
      const claims = await pool.getActiveClaims();
      if (!Array.isArray(claims)) {
        this.logger.debug('Active claims unavailable (storage not yet hydrated)', {
          received: typeof claims,
        });
        return [];
      }
      return claims;
    } catch (error) {
      // Storage-not-ready manifests as ".filter() / .some() / etc. on
      // undefined" during the post-restart hydration window. The
      // classifier checks `instanceof TypeError` + the V8 message
      // shape — see the doc-comment on `isStorageNotReadyError` for
      // why we no longer enumerate method names.
      if (isStorageNotReadyError(error)) {
        this.logger.debug('Active claims unavailable (storage not yet hydrated)', {
          error: (error as Error).message,
        });
        return [];
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to get active claims', { error: msg });
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

      // Add the orchestrator. orc is a virtual team member — it does NOT
      // appear in `storage.getTeams()`, so the loop above misses it. Without
      // this entry, any WorkItem with `target=crewly-orc` that transitions
      // to `running` is mis-identified by `detectStuckWorkItems` as having
      // a "missing agent", and gets force-demoted back to `blocked`. The
      // dogfood symptom (2026-05-09): a Plan WI auto-claimed by orc bounced
      // running → blocked → running → blocked in a wedged loop, the chained
      // Execute + Review never unlocked, and the parent Slack Request
      // emitted hours of identical "still 3 blocked" heartbeats.
      //
      // We treat any orchestrator status persisted via OrchestratorStatus
      // as `active` for health-map purposes — the reconciler only needs
      // "exists / does not exist" granularity here. If the orc isn't
      // running we'd rather skip the entry than fabricate a stale one,
      // so we honour the persisted agentStatus when available.
      try {
        const orcStatus = await this.storage.getOrchestratorStatus();
        if (orcStatus?.sessionName) {
          healthMap.set(orcStatus.sessionName, {
            sessionName: orcStatus.sessionName,
            status: this.mapAgentStatus(orcStatus.agentStatus),
            lastSeenAt: orcStatus.updatedAt,
            role: 'orchestrator',
            tags: [],
            activeWorkItemCount: 0,
            // teamId/memberId intentionally undefined — orc is virtual.
          });
        }
      } catch (orcErr) {
        this.logger.debug('Failed to add orchestrator to health map (non-fatal)', {
          error: orcErr instanceof Error ? orcErr.message : String(orcErr),
        });
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
        // Forward the reconciler's reason (e.g. "queued for 61 minutes
        // without pickup", "Cascade cancel: ancestor failed") through
        // to the WorkItem so it persists alongside the status flip.
        // The activity timeline reads this field for cancelled items.
        await pool.updateItemStatus(
          correction.entityId,
          correction.newState as WorkItem['status'],
          'system',
          correction.reason,
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
   * **F-CYCLE7-3 (2026-05-07):** Returns `[]` defensively if the pool
   * returns a non-array (e.g. partial post-restart hydration where
   * `pool.json` is missing the `workItems` field). Storage-not-ready is
   * logged at `debug`, not `error`, to avoid the post-restart error
   * storm seen at 11:19→11:21Z.
   *
   * @returns Available pool items (always an array)
   */
  async getAvailablePoolItems(): Promise<WorkItem[]> {
    try {
      const pool = TaskPoolService.getInstance();
      const items = await pool.getAvailableItems();
      if (!Array.isArray(items)) {
        this.logger.debug('Available pool items unavailable (storage not yet hydrated)', {
          received: typeof items,
        });
        return [];
      }
      return items;
    } catch (error) {
      if (isStorageNotReadyError(error)) {
        this.logger.debug('Available pool items unavailable (storage not yet hydrated)', {
          error: (error as Error).message,
        });
        return [];
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to get available pool items', { error: msg });
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
  /**
   * Count agent sessions currently in an alive state. Used by the
   * memory-pressure gate in {@link executeWakeAction} to decide whether
   * a new wake would push us past the concurrency floor.
   *
   * Counts `'active'`, `'started'`, and `'starting'` — anything that
   * has a live process consuming RAM. `started` and `starting` cover
   * in-flight wakes from prior reconciler ticks that haven't fully
   * promoted to active yet. `suspended` / `inactive` are NOT alive and
   * don't contribute (suspended drops the runtime; inactive never had
   * one).
   *
   * @returns The number of agent sessions currently alive
   */
  private async countActiveAgentSessions(): Promise<number> {
    try {
      const teams = await this.storage.getTeams();
      let count = 0;
      for (const team of teams) {
        for (const member of team.members || []) {
          const s = member.agentStatus;
          if (s === 'active' || s === 'started' || s === 'starting') {
            count += 1;
          }
        }
      }
      return count;
    } catch (err) {
      // Storage hiccup → fail closed (assume floor reached, skip wake).
      // Better to defer a wake than to overshoot under crisis pressure.
      this.logger.debug('countActiveAgentSessions failed — assuming floor reached', {
        error: err instanceof Error ? err.message : String(err),
      });
      return WAKE_FLOOR_UNDER_PRESSURE;
    }
  }

  /**
   * Broadcast `system:memory_pressure` to the EventBus when wake actions
   * have been skipped enough consecutive times to indicate a sustained
   * stall. Throttled so a long pressure episode emits at most one event
   * per `MEMORY_PRESSURE_REFIRE_MS` window — orc only needs to surface
   * the condition once per stuck period, not on every reconciler tick.
   *
   * The 2026-05-14 incident skipped wakes ~4,200 times across 20 hours
   * with zero user-visible signal. After this change, orc receives a
   * critical event within ~50 seconds of the stall starting and every
   * ~5 minutes thereafter until pressure clears.
   *
   * @param stats - Snapshot of memory stats at the skip moment
   * @param activeCount - Current active agent count (already computed)
   */
  private maybeBroadcastMemoryPressure(
    stats: { usedPercent: number; freeMB: number },
    activeCount: number,
  ): void {
    this.consecutivePressureSkips += 1;

    if (!this.eventBus) {
      return;
    }

    // First-fire threshold: 5 consecutive skips (~50s at 10s reconciler
    // tick). Picked so a transient pressure spike that resolves on its
    // own doesn't page orc; sustained pressure does.
    const FIRST_FIRE_THRESHOLD = 5;
    // Re-fire window: don't re-broadcast more often than once per 5min
    // while pressure persists. Matches the EventBus dedup window order
    // of magnitude and avoids spamming orc's terminal.
    const MEMORY_PRESSURE_REFIRE_MS = 5 * 60 * 1000;

    if (this.consecutivePressureSkips < FIRST_FIRE_THRESHOLD) {
      return;
    }

    const now = Date.now();
    if (this.lastPressureNotifiedAt > 0 && now - this.lastPressureNotifiedAt < MEMORY_PRESSURE_REFIRE_MS) {
      return;
    }

    try {
      this.eventBus.publish({
        id: `system-memory-pressure-${now}`,
        type: 'system:memory_pressure',
        timestamp: new Date(now).toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: 'system',
        sessionName: 'system',
        previousValue: 'ok',
        newValue: 'critical',
        changedField: 'agentStatus',
      });
      this.lastPressureNotifiedAt = now;
      this.logger.warn('Broadcast system:memory_pressure to EventBus', {
        memoryUsedPercent: stats.usedPercent,
        freeMemMB: stats.freeMB,
        activeAgents: activeCount,
        consecutiveSkips: this.consecutivePressureSkips,
      });
    } catch (err) {
      // Failure isolation — never let a telemetry failure break the
      // reconciler's primary control flow.
      this.logger.warn('Failed to broadcast system:memory_pressure (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Reset the memory-pressure broadcast state. Called on every wake
   * that runs without pressure so the next sustained episode re-fires
   * the first-time threshold instead of being silenced by stale state.
   */
  private resetMemoryPressureBroadcast(): void {
    if (this.consecutivePressureSkips > 0 || this.lastPressureNotifiedAt > 0) {
      this.consecutivePressureSkips = 0;
      this.lastPressureNotifiedAt = 0;
    }
  }

  async executeWakeAction(action: WakeAction): Promise<boolean> {
    const { agentSessionName, strategy } = action;

    // Memory-pressure gate with a concurrency floor.
    //
    // Previous behaviour (unconditional skip on >=90% used) wedged the
    // system in the 2026-05-13 dogfood scenario: free RAM hovered at
    // 16-33 MB for hours, the reconciler refused EVERY wake, and the
    // user saw orc/think-tank/marketing all stuck inactive with queued
    // WIs piling up. Nothing made progress until manual intervention.
    //
    // New behaviour: under memory pressure, still allow wakes up to
    // `WAKE_FLOOR_UNDER_PRESSURE` concurrent active agents so the
    // system stays minimally productive. Wakes beyond that cap are
    // still blocked — we don't want to spawn an unbounded number of
    // agents under crisis pressure and trigger an OOM cascade.
    //
    // The count includes 'active' and 'started' sessions (counting
    // 'started' covers an in-flight wake from a prior reconciler tick
    // that hasn't fully promoted to 'active' yet). Slight overshoot
    // is possible across concurrent pass executions; acceptable
    // because the cap is a SAFETY FLOOR, not a hard limit.
    if (isUnderMemoryPressure()) {
      const stats = getMemoryStats();
      const activeCount = await this.countActiveAgentSessions();
      if (activeCount >= WAKE_FLOOR_UNDER_PRESSURE) {
        this.logger.warn('Skipping wake action — memory pressure AND at concurrency floor', {
          agent: agentSessionName,
          strategy,
          memoryUsedPercent: stats.usedPercent,
          freeMemMB: stats.freeMB,
          activeAgents: activeCount,
          wakeFloor: WAKE_FLOOR_UNDER_PRESSURE,
        });
        this.maybeBroadcastMemoryPressure(stats, activeCount);
        return false;
      }
      this.logger.info('Memory pressure detected — allowing wake (under concurrency floor)', {
        agent: agentSessionName,
        strategy,
        memoryUsedPercent: stats.usedPercent,
        freeMemMB: stats.freeMB,
        activeAgents: activeCount,
        wakeFloor: WAKE_FLOOR_UNDER_PRESSURE,
      });
      // Pressure persists but a wake is proceeding — clear the skip
      // counter so the FIRST_FIRE_THRESHOLD must be crossed again
      // before the next broadcast. Keep `lastPressureNotifiedAt` so
      // the 5min refire throttle still applies — we don't want the
      // skip→wake→skip oscillation to slip past the throttle window.
      // (Follow-up #6 from PR #543 review.)
      this.consecutivePressureSkips = 0;
    } else {
      // Pressure cleared — reset state so the next episode re-fires.
      this.resetMemoryPressureBroadcast();
    }

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
        // The agent session creation is complex — use the team-member-start API endpoint.
        const { teamId, memberId } = action;

        // Follow-up #10 from PR #543 review: replace the hardcoded
        // 8787 with the canonical backend port constant. `process.env.PORT`
        // still wins when set so deployments overriding the default keep
        // working unchanged.
        const port = process.env.PORT || WEB_CONSTANTS.PORTS.BACKEND;
        let url = `http://localhost:${port}/api/teams/members/start`;
        if (teamId && memberId) {
          url = `http://localhost:${port}/api/teams/${teamId}/members/${memberId}/start`;
        }

        // Pass `workItemId` so the team-controller wake-gate can verify
        // that this wake is pool-driven (path 1 of the gate). Reconciler
        // hybrid-wake has already decided which WI triggered the wake;
        // the gate trusts that decision rather than re-scanning the pool.
        // Without this, the gate would still pass via path 2 (pool scan)
        // — but explicit is better when we already have the evidence.
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionName: agentSessionName, workItemId: action.workItemId }),
        });

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
