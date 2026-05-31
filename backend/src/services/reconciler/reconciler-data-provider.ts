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
import { WorkItemDispatchSubscriber } from '../v3/workitem-dispatch.subscriber.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { isUnderMemoryPressure, getMemoryStats } from '../core/system-health.util.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import { WEB_CONSTANTS, AGENT_SUSPEND_CONSTANTS } from '../../constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long an agent can be unseen before we consider it stale (5 min). */
const AGENT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Minimum gap between redelivering the SAME WorkItem brief. The reconciler
 * fast loop fires every ~10s; this caps a queued WI's re-POSTs to once per
 * window so an unclaimed-but-read WI can't flood the agent's PTY. Override
 * with `CREWLY_RECONCILER_REDELIVER_COOLDOWN_MS`.
 */
const REDELIVER_COOLDOWN_MS = (() => {
  const raw = Number(process.env['CREWLY_RECONCILER_REDELIVER_COOLDOWN_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000; // 5 min
})();

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

/**
 * Minimal slice of `AgentRegistrationService` the provider needs for the
 * memory-pressure eviction path. Declared narrowly so test fixtures can
 * stub a single method without simulating the full registration surface.
 */
export interface IAgentRegistrationServiceLike {
  terminateAgentSession(
    sessionName: string,
    role?: string,
  ): Promise<{ success: boolean; message?: string; error?: string }>;
}

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
  // Injected at boot time by `index.ts` so eviction can terminate an
  // agent's full session (monitors + tmux + in-process runtime). The
  // dep is optional — tests that don't exercise the pressure path leave
  // it null, which makes `evictIdleAgent` fall back to "no candidate"
  // and the wake-pressure path skips as before.
  private agentRegistration: IAgentRegistrationServiceLike | null = null;

  // Memory-pressure broadcast state. Per-instance to keep counters
  // isolated, but the publish throttle ensures we don't flood orc even
  // if multiple providers exist (each will throttle independently and
  // EventBus deduplicates on event id).
  private consecutivePressureSkips = 0;
  private lastPressureNotifiedAt = 0;

  /**
   * Per-WorkItem redeliver cooldown. The reconciler fast loop runs every
   * ~10s and re-emits a `redeliver` wake for any queued WI whose target is
   * active-but-idle — with NO per-WI rate-limit in the rule. Without this
   * gate a queued-but-unclaimed WI (e.g. one the orc has read but not yet
   * claimed) is re-POSTed to its PTY every 10s (~50-60/hr), which is the
   * wiki-bridge "spam" the user saw and the same class as the 2026-05-27
   * PTY-flood incident. We cap redelivery of a given WI to once per
   * {@link REDELIVER_COOLDOWN_MS}.
   */
  private readonly lastRedeliverAt = new Map<string, number>();

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
   * Inject the AgentRegistrationService so the memory-pressure eviction
   * path can terminate idle agents (the same primitive
   * `IdleDetectionService` uses). Optional — when not wired, eviction
   * is disabled and the reconciler falls back to the prior skip-on-floor
   * behaviour.
   *
   * @param svc - AgentRegistrationService instance from the bootstrap
   */
  setAgentRegistrationService(svc: IAgentRegistrationServiceLike): void {
    this.agentRegistration = svc;
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
        // #607 (2026-05-28): the `failed → queued` retry path MUST go
        // through `requeueAfterFailure`, NOT `updateItemStatus`. The
        // generic status setter doesn't bump `retryCount` — so without
        // this branch, `detectRetryableFailedWorkItems` would correct
        // `failed → queued` keeping retryCount frozen at its prior
        // value, the next failure flips it back to `failed`, the
        // reconciler retries again with the same retryCount, and the
        // `maxRetries=3` ceiling never trips. Observed 2026-05-23 with
        // 4 misrouted WIs that looped indefinitely.
        if (
          correction.previousState === 'failed' &&
          correction.newState === 'queued'
        ) {
          await pool.requeueAfterFailure(correction.entityId, correction.reason);
          this.logger.info('Applied work item correction (failed → queued via requeueAfterFailure)', {
            workItemId: correction.entityId,
            from: correction.previousState,
            to: correction.newState,
            reason: correction.reason,
          });
          return;
        }
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

        // Reconciler-driven failures bypass the canonical task:failed
        // event path (which lives in V3DataService.onTaskFailed and is
        // wired to agent-reported failures). Without this hook, a
        // reconciler-cancelled "agent inactive" WI silently flips to
        // failed and the user is never told. Escalate directly here so
        // the failure surfaces through the same EscalationRouter path
        // an agent-reported terminal failure would take. By definition
        // these are terminal (the reconciler only fails a WI after its
        // retry/grace policies have run out), so we skip retry logic.
        if (correction.newState === 'failed') {
          try {
            const failed = await pool.findWorkItem(correction.entityId);
            if (failed) {
              const { EscalationRouterService } = await import('../v3/escalation-router.service.js');
              await EscalationRouterService.getInstance().escalateFailedWorkItem(
                failed,
                correction.reason,
              );
              this.logger.info('Escalated reconciler-driven failure', {
                workItemId: correction.entityId,
                reason: correction.reason,
              });
            }
          } catch (escErr) {
            // Best-effort — never strand applyCorrection on an
            // escalation glitch (parallels v3-data.service.ts:500).
            this.logger.warn('escalateFailedWorkItem from reconciler threw (non-fatal)', {
              workItemId: correction.entityId,
              error: escErr instanceof Error ? escErr.message : String(escErr),
            });
          }
        }
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

  /**
   * Per-WI dedup of `task:queued_too_long` broadcasts. Maps WI id to the
   * ISO timestamp at which we last fired. A WI is only re-broadcast
   * after {@link STUCK_WI_REBROADCAST_MS} has elapsed since the last
   * fire — keeps the orc terminal sane when many WIs accumulate.
   *
   * Cleaned on every reconcile pass that observes the WI is no longer
   * `queued`, so a successful resume cancels the dedup naturally.
   */
  private lastStuckWiNotifiedAt: Map<string, number> = new Map();

  /**
   * Re-broadcast window for the same WI. Picked to roughly match the
   * reconciler's own staleness threshold so a long-stuck WI gets a
   * follow-up reminder ~hourly without flooding.
   */
  private static readonly STUCK_WI_REBROADCAST_MS = 60 * 60 * 1000;

  /**
   * Broadcast `task:queued_too_long` for WIs the reconciler has just
   * detected as stale-queued past the threshold. Public so the
   * reconciler service can call it after the existing log line at
   * reconciler.service.ts:213.
   *
   * Per-WI dedup ensures a long-stuck WI fires at most once per
   * {@link STUCK_WI_REBROADCAST_MS}. Missing target/owner is fine — the
   * subscription filter side handles defaults.
   *
   * @param staleWorkItems - List of `{id, target, owner, createdAt}` for
   *   each WI past the staleness threshold. The reconciler resolves
   *   these from {@link getTaskPoolService}.findWorkItem before calling.
   */
  broadcastStaleQueuedWIs(
    staleWorkItems: ReadonlyArray<{
      id: string;
      target?: string;
      owner?: string;
      createdAt: string;
    }>,
  ): void {
    if (!this.eventBus || staleWorkItems.length === 0) return;

    const now = Date.now();
    for (const wi of staleWorkItems) {
      const last = this.lastStuckWiNotifiedAt.get(wi.id) ?? 0;
      if (now - last < LiveReconcilerDataProvider.STUCK_WI_REBROADCAST_MS) {
        continue;
      }

      try {
        const ageMs = now - new Date(wi.createdAt).getTime();
        this.eventBus.publish({
          // Composite id makes redelivery dedup-friendly without
          // colliding across re-fires (the timestamp segment changes).
          id: `task-queued-too-long-${wi.id}-${now}`,
          type: 'task:queued_too_long',
          timestamp: new Date(now).toISOString(),
          // teamId/teamName/memberId/memberName are conventionally empty
          // for pool-level events; subscriber routing uses workItemId.
          teamId: '',
          teamName: '',
          memberId: '',
          memberName: 'reconciler',
          sessionName: wi.target ?? '',
          previousValue: 'queued',
          newValue: 'queued_stale',
          changedField: 'taskStatus',
          workItemId: wi.id,
          // Carry the owner (typically 'orchestrator' or a team-lead
          // session) so a subscriber can filter `owner === self` to
          // catch ONLY its own stuck delegations.
          ...(wi.owner ? { owner: wi.owner } : {}),
          // Age in seconds so the orc can decide between re-deliver
          // (short stuck) and re-target / fail (long stuck).
          ...(ageMs > 0 ? { ageSeconds: Math.floor(ageMs / 1000) } : {}),
        } as Parameters<EventBusService['publish']>[0]);
        this.lastStuckWiNotifiedAt.set(wi.id, now);
      } catch (err) {
        // Failure isolation — telemetry failures must not break the
        // reconciler's primary control flow.
        this.logger.warn('Failed to broadcast task:queued_too_long (non-fatal)', {
          workItemId: wi.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Drop dedup entries for WIs that are no longer stuck. Called by the
   * reconciler each pass with the current set of `queued` WI ids — any
   * id in our map that is NOT in the current set has been resolved
   * (claimed, completed, cancelled) and its dedup window should be
   * released so a future re-stale gets a fresh first-fire.
   */
  clearResolvedStuckWiDedup(currentlyQueuedIds: ReadonlySet<string>): void {
    if (this.lastStuckWiNotifiedAt.size === 0) return;
    for (const id of [...this.lastStuckWiNotifiedAt.keys()]) {
      if (!currentlyQueuedIds.has(id)) {
        this.lastStuckWiNotifiedAt.delete(id);
      }
    }
  }

  /**
   * Find one idle, evictable agent that can be terminated to free a wake
   * slot under memory pressure.
   *
   * An agent is "evictable" when ALL of the following hold:
   *   - `agentStatus === 'active'` (no point evicting an already-dead one)
   *   - `workingStatus === 'idle'` (don't kill a mid-task agent)
   *   - role is NOT in `ALWAYS_ON_ROLES` (orchestrator, auditor)
   *   - no non-terminal WorkItem in the pool targets this sessionName
   *     (otherwise eviction would orphan that WI just like Atlas's)
   *   - sessionName !== `incomingAgent` (don't evict ourselves)
   *
   * Among eligible agents, returns the longest-idle one (oldest
   * `updatedAt`). This biases towards freeing agents that have been sitting
   * quietly without work — the freshest idle agent might be about to claim
   * something via the auto-claim path.
   *
   * @param incomingAgent - sessionName of the agent we want to wake;
   *   excluded from the eviction pool so we never recommend evicting the
   *   very agent we're trying to wake.
   * @returns Eviction candidate metadata, or `null` if no agent qualifies.
   */
  private async findEvictableIdleAgent(incomingAgent: string): Promise<{
    sessionName: string;
    teamId: string;
    memberId: string;
    role: string;
    idleMs: number;
  } | null> {
    let teams;
    try {
      teams = await this.storage.getTeams();
    } catch (err) {
      this.logger.warn('findEvictableIdleAgent: failed to load teams', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Collect sessions that have any non-terminal WorkItem targeting them.
    // Eviction would orphan those WIs (recreating the very stall we're
    // trying to fix), so they're excluded.
    const targetedSessions = new Set<string>();
    try {
      const pool = TaskPoolService.getInstance();
      const allItems = await pool.getAllItems();
      for (const wi of allItems) {
        if (wi.status === 'done' || wi.status === 'cancelled') continue;
        const t = (wi as { target?: string }).target;
        if (typeof t === 'string' && t.length > 0) targetedSessions.add(t);
      }
    } catch (err) {
      // Pool unavailable → be conservative, refuse eviction so we don't
      // accidentally kill an agent who's about to claim a queued WI.
      this.logger.warn('findEvictableIdleAgent: pool query failed — refusing eviction', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const now = Date.now();
    type Candidate = {
      sessionName: string;
      teamId: string;
      memberId: string;
      role: string;
      idleMs: number;
    };
    const candidates: Candidate[] = [];

    for (const team of teams) {
      for (const member of team.members || []) {
        if (member.agentStatus !== 'active') continue;
        if (member.workingStatus !== 'idle') continue;
        if (
          (AGENT_SUSPEND_CONSTANTS.ALWAYS_ON_ROLES as readonly string[]).includes(member.role)
        ) {
          continue;
        }
        if (member.sessionName === incomingAgent) continue;
        if (targetedSessions.has(member.sessionName)) continue;

        const lastActive = member.updatedAt
          ? new Date(member.updatedAt).getTime()
          : member.createdAt
            ? new Date(member.createdAt).getTime()
            : 0;
        const idleMs = lastActive > 0 ? Math.max(0, now - lastActive) : 0;
        candidates.push({
          sessionName: member.sessionName,
          teamId: team.id,
          memberId: member.id,
          role: member.role,
          idleMs,
        });
      }
    }
    if (candidates.length === 0) return null;
    // Longest-idle first.
    candidates.sort((a, b) => b.idleMs - a.idleMs);
    return candidates[0];
  }

  /**
   * Terminate an evicted agent so the wake slot is freed.
   *
   * Uses the same `terminateAgentSession` + `updateAgentStatus(..,
   * 'idle_exit_pressure')` pair that `IdleDetectionService` uses for the
   * regular auto-stop path, just with a different dropoutReason so the
   * pressure-driven evictions are distinguishable in audit logs.
   *
   * @param victim - Eviction candidate returned by `findEvictableIdleAgent`
   * @returns `true` if the agent was terminated AND marked inactive;
   *   `false` if either step failed (the caller falls back to skip).
   */
  private async evictIdleAgent(victim: {
    sessionName: string;
    teamId: string;
    memberId: string;
    role: string;
  }): Promise<boolean> {
    if (!this.agentRegistration) {
      this.logger.warn(
        'evictIdleAgent: AgentRegistrationService not wired — eviction disabled',
        { sessionName: victim.sessionName },
      );
      return false;
    }
    try {
      await this.agentRegistration.terminateAgentSession(victim.sessionName, victim.role);
      // `terminateAgentSession` already marks the row inactive without a
      // dropoutReason; overwrite it with `idle_exit_pressure` so this
      // path is distinguishable from the IdleDetectionService auto-stop
      // path (`idle_exit`) in audit logs.
      await this.storage.updateAgentStatus(
        victim.sessionName,
        'inactive' as never,
        'idle_exit_pressure' as never,
      );
      return true;
    } catch (err) {
      this.logger.error('evictIdleAgent failed', {
        sessionName: victim.sessionName,
        role: victim.role,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async executeWakeAction(action: WakeAction): Promise<boolean> {
    const { agentSessionName, strategy } = action;

    // Redeliver is a cheap repost to an already-alive agent — no new session
    // is created, no extra RAM is consumed. It must bypass the memory-
    // pressure gate; otherwise the very stuckness the pressure gate is
    // designed to prevent would block its own primary remediation path.
    if (strategy === 'redeliver') {
      this.logger.info('Executing wake action', {
        agent: agentSessionName,
        strategy,
        workItemId: action.workItemId,
      });
      try {
        const pool = TaskPoolService.getInstance();
        const wi = await pool.findWorkItem(action.workItemId);
        if (!wi || wi.status !== 'queued') {
          this.logger.info('Redeliver skipped — WI no longer queued', {
            agent: agentSessionName,
            workItemId: action.workItemId,
            currentStatus: wi?.status,
          });
          // WI left the queue (claimed/terminal) — drop its cooldown record.
          this.lastRedeliverAt.delete(action.workItemId);
          return false;
        }
        // Per-WI redeliver cooldown — the fast loop re-emits this every ~10s
        // while the WI stays queued; without the gate that floods the PTY.
        const lastAt = this.lastRedeliverAt.get(action.workItemId);
        if (lastAt !== undefined && Date.now() - lastAt < REDELIVER_COOLDOWN_MS) {
          this.logger.debug('Redeliver suppressed — within cooldown', {
            agent: agentSessionName,
            workItemId: action.workItemId,
            sinceMs: Date.now() - lastAt,
          });
          return false;
        }
        const subscriber = WorkItemDispatchSubscriber.getInstance();
        const delivered = await subscriber.redispatch(wi);
        if (delivered) this.lastRedeliverAt.set(action.workItemId, Date.now());
        if (delivered) {
          this.logger.info('Redelivered WorkItem brief to active-but-idle agent', {
            agent: agentSessionName,
            workItemId: action.workItemId,
          });
        }
        return delivered;
      } catch (error) {
        this.logger.error('Redeliver wake action failed', {
          agent: agentSessionName,
          workItemId: action.workItemId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

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
        // Last-resort eviction: rather than silently skipping forever,
        // look for an idle agent that is doing nothing productive and
        // terminate it to free a slot for `agentSessionName` (which has
        // a queued WI waiting). This is the failure mode that stranded
        // Atlas on 2026-05-16 — the wake floor was held by idle product
        // / marketing agents while a queued WI for an inactive Atlas
        // never made progress.
        //
        // Eviction is intentionally narrow: ALWAYS_ON_ROLES are exempt,
        // agents with any non-terminal WI of their own are exempt, and
        // anything mid-task (workingStatus=in_progress) is exempt.
        // We pick the longest-idle eligible agent (oldest `updatedAt`)
        // so a freshly-idle agent that may auto-claim something stays
        // alive.
        const victim = await this.findEvictableIdleAgent(agentSessionName);
        if (!victim) {
          this.logger.warn('Skipping wake action — memory pressure AND at concurrency floor', {
            agent: agentSessionName,
            strategy,
            memoryUsedPercent: stats.usedPercent,
            freeMemMB: stats.freeMB,
            activeAgents: activeCount,
            wakeFloor: WAKE_FLOOR_UNDER_PRESSURE,
            reason: 'no evictable idle agent — all active agents are busy or always-on',
          });
          this.maybeBroadcastMemoryPressure(stats, activeCount);
          return false;
        }
        this.logger.warn('Evicting idle agent under memory pressure to free wake slot', {
          evictingAgent: victim.sessionName,
          evictingRole: victim.role,
          idleMs: victim.idleMs,
          incomingAgent: agentSessionName,
          incomingStrategy: strategy,
          memoryUsedPercent: stats.usedPercent,
          freeMemMB: stats.freeMB,
          activeAgents: activeCount,
          wakeFloor: WAKE_FLOOR_UNDER_PRESSURE,
        });
        const evicted = await this.evictIdleAgent(victim);
        if (!evicted) {
          // Eviction failed — fall back to the historical skip behaviour
          // rather than overshooting the floor with both agents alive.
          this.logger.warn('Eviction failed — falling back to skip', {
            agent: agentSessionName,
            evictAttempted: victim.sessionName,
            memoryUsedPercent: stats.usedPercent,
            freeMemMB: stats.freeMB,
            activeAgents: activeCount,
          });
          this.maybeBroadcastMemoryPressure(stats, activeCount);
          return false;
        }
        // Slot freed — proceed with the wake. Net activeCount stays
        // the same (one out, one in), so the floor invariant holds.
        this.consecutivePressureSkips = 0;
      } else {
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
      }
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
        // `redeliver` is handled by the early-return path above, before
        // the memory-pressure gate. Reaching here means an unrecognised
        // strategy was supplied.
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
