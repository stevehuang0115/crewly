/**
 * WorkItem Dispatch Subscriber
 *
 * Pushes a `[CREWLY-DISPATCH]` system message to the **target session** every
 * time a WorkItem is added to the pool with a specific target. Closes the
 * "queued → claimed" gap that {@link AgentAutoClaimService} cannot cover:
 * AutoClaim is *pull* (reacts to `agent:idle` / `task:done`); this subscriber
 * is *push* (reacts to `workitem:queued`). The two compose:
 *
 *   - Fresh queued WI lands → this fires → target sees the prompt, runs
 *     `poll-tasks`, claims the WI.
 *   - Agent later goes idle → AutoClaim fires → it picks the next WI.
 *
 * **Why both are needed.** AutoClaim's startup recovery
 * ({@link AgentAutoClaimService.recoverPendingTasks}) skips WIs whose
 * target agent is already `active` on the assumption that "an active agent
 * will claim it on its own". Empirically (2026-05-06 dogfood) that's false:
 * an agent in the middle of a long thought stream never emits the
 * `agent:idle` event AutoClaim listens to, so targeted WIs sit in the pool
 * untouched. This subscriber covers exactly that case.
 *
 * **Integration with AgentAutoClaim.** The recovery path's `active` branch
 * delegates here via {@link WorkItemDispatchSubscriber.dispatchTo}, so both
 * paths emit the identical message. No double-fire because the dedup Set
 * is shared across both call-sites.
 *
 * **Dedup contract.** Each WI is dispatched at most once per process
 * lifetime (in-memory `Set<workItemId>`). Backend restart resets the set —
 * which is the desired behavior since startup backfill needs to re-fire for
 * the queued WIs that survived the restart.
 *
 * @module services/v3/workitem-dispatch.subscriber
 */

import axios from 'axios';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Service identifier for logs and the X-Agent-Session caller header. */
const SERVICE_NAME = 'WorkItemDispatch';

/** Loopback API used by {@link tl-auto-verify.service.ts} et al. */
const API_BASE = 'http://localhost:8787';

/**
 * SLA tracker WIs use a deterministic id pattern `request:<rid>:respond_to_user`
 * (see `request-sla.subscriber.ts`). They're internal bookkeeping items, not
 * dispatchable work — the orc never "claims and executes" one; the WI is
 * passively tracked and resolved by the SLA path when orc actually replies
 * via the reply-slack skill.
 *
 * Exported so {@link AgentAutoClaimService} can apply the same filter when
 * scoring claimable WIs. Before that fix (2026-05-12), AutoClaim would
 * happily claim a `respond_to_user` WI for crewly-orc, then call
 * `dispatchTo` which short-circuits here on the same regex — leaving the
 * WI stuck in `running` with no PTY delivery. 5/10-min SLA breach fired,
 * claim revoked, WI cycled back to `queued`, AutoClaim re-claimed it,
 * loop repeated indefinitely. From the user's perspective: "Request never
 * progresses, only heartbeats and SLA-breach DMs."
 */
export const SLA_TRACKER_ID_PATTERN = /^request:.+:respond_to_user$/;

/** Per-WI delay between backfill pushes — keeps the burst polite. */
const BACKFILL_THROTTLE_MS = 200;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Singleton subscriber that pushes dispatch prompts to target sessions.
 */
export class WorkItemDispatchSubscriber {
  private static instance: WorkItemDispatchSubscriber | null = null;

  private readonly logger: ComponentLogger;
  private eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void } | null = null;

  /**
   * Dispatch dedup keyed by `${workItemId}::${target}`. Reset on restart —
   * which is intentional, the startup backfill re-reads the pool.
   *
   * 2026-05-15 Steve dogfood: previously keyed by `workItemId` alone, which
   * silently dropped re-dispatches after a WI was reassigned to a different
   * target. Concrete repro from crewly-2026-05-15.log:
   *   - 14:55:26 WI 20a778bc dispatched to strategy-ethan-c36c18bd
   *   - ethan never started work, claim expired, WI requeued
   *   - 15:36:55 AgentAutoClaim reassigned to crewly-orc
   *   - dispatchTo short-circuited (dispatched.has('20a778bc') === true)
   *   - orc never saw [CREWLY-DISPATCH], claim expired 13min later
   *   - loop repeated
   * The composite key fixes this: a re-target gets a fresh dispatch.
   * Within a (workItemId, target) pair the dedup still holds, so the
   * `workitem:queued` event and the AutoClaim post-claim hand-off don't
   * double-fire on the same target.
   */
  private readonly dispatched = new Set<string>();

  /** Composite dedup key — workItem id alone is not enough (see above). */
  private dispatchKey(workItemId: string, target: string): string {
    return `${workItemId}::${target}`;
  }

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(SERVICE_NAME);
  }

  public static getInstance(): WorkItemDispatchSubscriber {
    if (!WorkItemDispatchSubscriber.instance) {
      WorkItemDispatchSubscriber.instance = new WorkItemDispatchSubscriber();
    }
    return WorkItemDispatchSubscriber.instance;
  }

  public static resetInstance(): void {
    WorkItemDispatchSubscriber.instance = null;
  }

  /**
   * Wire the EventBus. Must be called before {@link start}.
   *
   * @param eventBusService - The shared EventBusService instance
   */
  initialize(
    eventBusService: { on: (event: string, handler: (...args: unknown[]) => void) => void },
  ): void {
    this.eventBusService = eventBusService;
  }

  /**
   * Begin listening for `workitem:queued` events and schedule the one-shot
   * backfill that catches WIs that survived a backend restart.
   */
  start(): void {
    if (!this.eventBusService) {
      this.logger.warn('Cannot start — EventBusService not initialized');
      return;
    }

    this.eventBusService.on('event_published', (payload: unknown) => {
      const event = payload as { eventType?: string; workItemId?: string };
      if (event?.eventType !== 'workitem:queued') return;
      if (!event.workItemId) return;

      // Fire-and-forget — dispatch must not block the bus.
      this.handleQueuedEvent(event.workItemId).catch((err) => {
        this.logger.debug('Dispatch on workitem:queued failed (non-fatal)', {
          workItemId: event.workItemId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Backfill runs after AgentAutoClaim's recoverPendingTasks (which uses a
    // 15s setTimeout — see agent-auto-claim.service.ts:122). Wait a bit
    // longer so the wake-then-dispatch ordering is deterministic: offline
    // agents get woken first, then we push to the still-active ones.
    const timer = setTimeout(() => {
      this.runStartupBackfill().catch((err) => {
        this.logger.warn('Startup backfill failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, 25_000);
    // Don't keep the event loop alive in tests / one-shot scripts.
    timer.unref?.();

    this.logger.info('WorkItemDispatchSubscriber started');
  }

  // -------------------------------------------------------------------------
  // Public dispatch (also called from AgentAutoClaim.recoverPendingTasks)
  // -------------------------------------------------------------------------

  /**
   * Push a dispatch message to the WI's target session. Idempotent within
   * the process: a second call with the same WI id is a no-op.
   *
   * Returns true if a message was actually written, false if skipped.
   *
   * @param workItem - WorkItem to dispatch
   * @returns Whether the dispatch was actually performed
   */
  async dispatchTo(workItem: WorkItem): Promise<boolean> {
    if (!workItem.target) return false;
    if (SLA_TRACKER_ID_PATTERN.test(workItem.id)) return false;
    const key = this.dispatchKey(workItem.id, workItem.target);
    if (this.dispatched.has(key)) return false;

    const message = this.buildDispatchMessage(workItem);

    try {
      await axios.post(
        `${API_BASE}/api/terminal/${encodeURIComponent(workItem.target)}/write`,
        { data: message, mode: 'message' },
        {
          headers: { 'X-Agent-Session': SERVICE_NAME },
          timeout: 5_000,
        },
      );
      this.dispatched.add(key);
      this.logger.info('Dispatched WorkItem to target session', {
        workItemId: workItem.id,
        target: workItem.target,
        type: workItem.type,
      });
      return true;
    } catch (err) {
      // Common non-fatal cases: 404 (session not found — agent gone),
      // 503 (backend not ready), connection refused. We do NOT mark
      // dispatched on failure so a later retry path can succeed.
      const status = (err as { response?: { status?: number } })?.response?.status;
      this.logger.debug('Dispatch HTTP write failed (non-fatal)', {
        workItemId: workItem.id,
        target: workItem.target,
        status: status ?? 'no-response',
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal — workitem:queued event path
  // -------------------------------------------------------------------------

  /**
   * Fetch the WI by id and dispatch it. Called from the event listener.
   *
   * @param workItemId - The id from the workitem:queued event payload
   */
  private async handleQueuedEvent(workItemId: string): Promise<void> {
    const taskPool = TaskPoolService.getInstance();
    const wi = await taskPool.findWorkItem(workItemId);
    if (!wi) return;
    if (wi.status !== 'queued') return; // Race: already moved on
    await this.dispatchTo(wi);
  }

  // -------------------------------------------------------------------------
  // Internal — startup backfill
  // -------------------------------------------------------------------------

  /**
   * Scan the pool once for queued+targeted WIs that lost their dispatch
   * push to the previous backend instance, and re-fire each. Runs ~25s
   * after start so AgentAutoClaim's recovery (which wakes offline agents)
   * has a chance to settle first.
   */
  private async runStartupBackfill(): Promise<void> {
    const taskPool = TaskPoolService.getInstance();
    const items = await taskPool.getAvailableItems();
    const targeted = items.filter(
      (wi) => wi.target && wi.status === 'queued' && !SLA_TRACKER_ID_PATTERN.test(wi.id),
    );

    if (targeted.length === 0) {
      this.logger.debug('Startup backfill: nothing to dispatch');
      return;
    }

    this.logger.info('Startup backfill: dispatching pre-existing queued WIs', {
      count: targeted.length,
      targets: [...new Set(targeted.map((wi) => wi.target))],
    });

    let dispatched = 0;
    for (const wi of targeted) {
      const ok = await this.dispatchTo(wi);
      if (ok) dispatched += 1;
      // Polite pacing — terminal writes hit the same backend HTTP path.
      await new Promise((resolve) => setTimeout(resolve, BACKFILL_THROTTLE_MS));
    }

    this.logger.info('Startup backfill complete', {
      total: targeted.length,
      dispatched,
      skipped: targeted.length - dispatched,
    });
  }

  // -------------------------------------------------------------------------
  // Internal — message formatting
  // -------------------------------------------------------------------------

  /**
   * Compose the prompt the worker sees in their terminal. Format choices:
   *
   *   - Tagged prefix `[CREWLY-DISPATCH]` so the line is grep-able and
   *     visually distinguishable from natural-language ORC messages.
   *   - Includes WI id + title + type so the worker can sanity-check before
   *     running the claim command.
   *   - Closes with a runnable `poll-tasks` command — the worker can
   *     copy-paste or the harness can auto-execute. We deliberately do NOT
   *     pass the WI id to poll-tasks; the skill is role-driven and will
   *     pick whatever matches first, which preserves AutoClaim's scoring
   *     contract.
   *
   * @param workItem - WI being dispatched
   * @returns Multi-line message suitable for terminal write
   */
  private buildDispatchMessage(workItem: WorkItem): string {
    const titleSnippet = workItem.title.length > 80
      ? workItem.title.substring(0, 77) + '...'
      : workItem.title;

    return [
      '',
      `[CREWLY-DISPATCH] WorkItem ${workItem.id} queued for you (type=${workItem.type}).`,
      `  Title: ${titleSnippet}`,
      '  Run poll-tasks to claim:',
      `    bash $AGENT_SKILLS_PATH/core/poll-tasks/execute.sh '{"sessionName":"${workItem.target}"}'`,
      '',
    ].join('\n');
  }
}
