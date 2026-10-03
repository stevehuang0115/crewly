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
 * **Direct hand-overs.** team-leader `delegate-task` creates the WI and then
 * delivers the full brief itself through `/terminal/:s/deliver` with the
 * WI id. That deliver claims the same dedup key
 * ({@link WorkItemDispatchSubscriber.claimDirectDelivery}), and WIs it
 * creates carry `metadata.directDelivery`, for which the `workitem:queued`
 * push waits {@link DIRECT_DELIVERY_CONSTANTS.GRACE_MS} and then only fires
 * if nobody delivered the task — so the task reaches the agent once and the
 * fresh-conversation clear runs once, before that first delivery.
 *
 * **Not the orchestrator.** The `workitem:queued` push skips `crewly-orc`
 * targets: the orc's WIs keep reaching it through the reconciler (which has
 * per-item cooldowns), so reviving this listener does not add orc wakes.
 *
 * @module services/v3/workitem-dispatch.subscriber
 */

import axios from 'axios';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { TeamBudgetGateService } from '../budget/team-budget-gate.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { getLocalApiBaseUrl } from '../../utils/local-api-url.utils.js';
import { DIRECT_DELIVERY_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { spendCapStopOf } from '../spend/spend-cap.gate.js';
import {
  FreshTaskConversationService,
  freshConversationNote,
  type PrepareForTaskResult,
} from '../agent/fresh-task-conversation.service.js';
import { traceHarness, workItemTraceMarker } from '../trace/trace-recorder.js';
import { noteScheduledTurn } from '../slack/slack-auto-working.service.js';
import { originOfWorkItem } from '../orc/work-item-destination.js';
import { internalAgentHeaders } from '../core/owner-auth.service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Service identifier for logs and the X-Agent-Session caller header. */
const SERVICE_NAME = 'WorkItemDispatch';

/**
 * Whether a work item was started by a schedule (a trigger or a cron task),
 * not by anyone asking for it.
 *
 * @param workItem - Work item
 * @returns True for trigger/cron work
 */
export function isScheduledWorkItem(workItem: WorkItem): boolean {
  try {
    return originOfWorkItem(workItem)?.kind === 'trigger';
  } catch {
    return false;
  }
}

/**
 * Whether a `/terminal/:s/write` answer says the message was held back by
 * the daily token cap (HTTP 202 `{ queued: true, spendCapped: true }`). The
 * message sits on the agent's queue until the stop lifts; it did not reach
 * the agent.
 *
 * @param body - Response body
 * @returns True when the write was queued by the token cap
 */
export function isSpendCappedReply(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { spendCapped?: unknown }).spendCapped === true;
}

/** Tag every dispatch notice starts with. */
const DISPATCH_TAG = '[CREWLY-DISPATCH]';

/**
 * WorkItem statuses after which a "queued for you" notice is stale: the work
 * is finished (or abandoned) and there is nothing left to claim.
 */
const FINISHED_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(['done', 'verified', 'cancelled', 'failed']);

/**
 * The WorkItem ids a dispatch notice announces, in order.
 *
 * Handles both shapes this module writes: the single notice
 * (`[CREWLY-DISPATCH] WorkItem <id> queued for you`) and the batch reminder
 * (`  1. <id> (type=…) — title`, one line per item).
 *
 * @param message - Text that was (or will be) written to an agent terminal
 * @returns The announced ids, or null when the text is not a dispatch notice
 */
export function dispatchNoticeWorkItemIds(message: string): string[] | null {
  if (!message.includes(DISPATCH_TAG)) return null;
  const single = message.match(/\[CREWLY-DISPATCH\] WorkItem (\S+) queued for you/);
  if (single) return [single[1]];
  const ids = [...message.matchAll(/^\s+\d+\.\s+(\S+) \(type=/gm)].map((m) => m[1]);
  return ids.length > 0 ? ids : null;
}

/**
 * Whether a dispatch notice no longer announces any work: every WorkItem it
 * names is finished (done, verified, cancelled, failed) or gone from the pool.
 *
 * Notices that wait in the persisted agent message queue survive a restart.
 * Without this check they were delivered hours after their WorkItems were
 * verified, one per notification, and the agent re-checked the pool for work
 * that was not there (#836). Text that is not a dispatch notice is never stale.
 *
 * @param message - Queued message text
 * @param findWorkItem - Looks up a WorkItem's current state by id
 * @returns True when the notice should be dropped instead of delivered
 */
export async function isStaleDispatchNotice(
  message: string,
  findWorkItem: (id: string) => Promise<Pick<WorkItem, 'status'> | null>,
): Promise<boolean> {
  const ids = dispatchNoticeWorkItemIds(message);
  if (!ids) return false;
  for (const id of ids) {
    const current = await findWorkItem(id);
    if (current && !FINISHED_WORK_ITEM_STATUSES.has(current.status)) return false;
  }
  return true;
}

/** Starts a fresh conversation before a new task (see FreshTaskConversationService). */
type TaskConversationPreparer = {
  prepareForTask: (sessionName: string, workItem: Pick<WorkItem, 'id' | 'metadata'>) => Promise<PrepareForTaskResult>;
};

/**
 * The deterministic workdir a WorkItem would get from its own git worktree
 * (see WorkItemWorktreeService.resolveHint) — computed up front, without
 * waiting for `git worktree add` to finish, so the FIRST dispatch brief can
 * already name it (#829 review: a later, separate "worktree ready" terminal
 * message arrives too late — the agent has already started in the shared
 * checkout by then).
 */
type WorktreeHintResolver = {
  resolveHint: (workItem: Pick<WorkItem, 'id' | 'target' | 'metadata'>) => Promise<{ workdir: string; branch: string } | null>;
};

/** Loopback API used by {@link tl-auto-verify.service.ts} et al. */

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

  /** Pending direct-delivery grace timers, keyed like {@link dispatched} */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();

  /** Composite dedup key — workItem id alone is not enough (see above). */
  private dispatchKey(workItemId: string, target: string): string {
    return `${workItemId}::${target}`;
  }

  /**
   * Team budget gate consulted before pushing a brief. Wired from the
   * backend boot path via {@link setTeamBudgetGate}; `null` (default)
   * bypasses the check so tests / CLI never touch the team store.
   */
  private teamBudgetGate: Pick<TeamBudgetGateService, 'checkForSession'> | null = null;

  /**
   * Fresh-conversation preparer consulted right before a brief is written.
   * Defaults to the {@link FreshTaskConversationService} singleton; tests
   * inject a stub via {@link setTaskConversationPreparer}.
   */
  private taskConversationPreparer: TaskConversationPreparer | null = null;

  /**
   * Worktree hint resolver consulted right before a brief is written.
   * No default singleton (WorkItemWorktreeService is not one) — `null` until
   * the backend boot path wires it with {@link setWorktreeHintResolver}, and
   * every WorkItem simply gets no hint until then.
   */
  private worktreeHintResolver: WorktreeHintResolver | null = null;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger(SERVICE_NAME);
  }

  /**
   * Wire (or disable with `null`) the team budget gate used by
   * {@link dispatchTo}. Called from the backend boot path.
   *
   * @param gate - Gate implementation, or null to bypass budget checks
   */
  setTeamBudgetGate(gate: Pick<TeamBudgetGateService, 'checkForSession'> | null): void {
    this.teamBudgetGate = gate;
  }

  /**
   * Override the fresh-conversation preparer (tests), or `null` to restore
   * the default singleton.
   *
   * @param preparer - Preparer implementation
   */
  setTaskConversationPreparer(preparer: TaskConversationPreparer | null): void {
    this.taskConversationPreparer = preparer;
  }

  /**
   * Wire (or disable with `null`) the worktree hint resolver used by
   * {@link dispatchTo} to name the workdir in the first dispatch brief.
   * Called from the backend boot path with the same WorkItemWorktreeService
   * instance {@link WorkItemWorktreeSubscriber} uses.
   *
   * @param resolver - Resolver implementation, or null to disable hints
   */
  setWorktreeHintResolver(resolver: WorktreeHintResolver | null): void {
    this.worktreeHintResolver = resolver;
  }

  /**
   * Give the target a fresh conversation when this is a new task (Claude
   * Code members only; the service decides). Never throws.
   *
   * @param workItem - WI about to be written (target set)
   * @returns The note to put in front of the brief, or null
   */
  private async prepareConversation(workItem: WorkItem): Promise<string | null> {
    try {
      const preparer = this.taskConversationPreparer ?? FreshTaskConversationService.getInstance();
      const result = await preparer.prepareForTask(workItem.target as string, workItem);
      return result.cleared && result.handoverPath ? freshConversationNote(result.handoverPath) : null;
    } catch (err) {
      this.logger.debug('Fresh-conversation prepare failed (non-fatal)', {
        workItemId: workItem.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The workdir a WorkItem's own worktree would give it, named up front —
   * before `git worktree add` has necessarily finished — so the agent never
   * starts in the shared checkout while waiting for a separate, later
   * notification. Never throws.
   *
   * @param workItem - WI about to be dispatched
   * @returns The hint, or null when it gets no worktree (or no resolver is wired)
   */
  private async resolveWorktreeHint(workItem: WorkItem): Promise<{ workdir: string; branch: string } | null> {
    if (!this.worktreeHintResolver) return null;
    try {
      return await this.worktreeHintResolver.resolveHint(workItem);
    } catch (err) {
      this.logger.debug('Worktree hint resolve failed (non-fatal)', {
        workItemId: workItem.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  public static getInstance(): WorkItemDispatchSubscriber {
    if (!WorkItemDispatchSubscriber.instance) {
      WorkItemDispatchSubscriber.instance = new WorkItemDispatchSubscriber();
    }
    return WorkItemDispatchSubscriber.instance;
  }

  public static resetInstance(): void {
    WorkItemDispatchSubscriber.instance?.stop();
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

    // The bus's `event_published` signal carries the WI id and target for
    // `workitem:queued` (TaskPoolService.publishWorkItemQueued). Before
    // 2026-09-28 it carried only eventId/eventType/sessionName, so this
    // listener returned on every event and nothing was pushed on queue.
    this.eventBusService.on('event_published', (payload: unknown) => {
      const event = payload as { eventType?: string; workItemId?: string; target?: string };
      if (event?.eventType !== 'workitem:queued') return;
      if (!event.workItemId) return;
      if (event.target === ORCHESTRATOR_SESSION_NAME) return;

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

    // Daily token cap: an agent over its cap takes no new turn. Do not write
    // (the write would only be queued) and do not mark the item delivered,
    // so it is dispatched once the stop lifts.
    const capStop = spendCapStopOf(workItem.target);
    if (capStop) {
      this.logger.info('Dispatch skipped — target is over its daily token cap', {
        workItemId: workItem.id,
        target: workItem.target,
        capTokens: capStop.capTokens,
      });
      return false;
    }

    // Team budget gate: do not wake an agent whose team is over budget. The
    // WI stays queued (not marked dispatched) so it is picked up once the
    // window resets or the budget is raised. Fail-open on gate errors.
    const budgetGate = this.teamBudgetGate;
    if (budgetGate) {
      const budget = await budgetGate.checkForSession(workItem.target).catch(() => null);
      if (budget && !budget.allowed) {
        this.logger.info('Dispatch skipped — team budget exceeded', {
          workItemId: workItem.id,
          target: workItem.target,
          teamId: budget.teamId,
          detail: budget.detail,
        });
        return false;
      }
    }

    // Reserve the key before the (slow) prepare + write, so a direct
    // hand-over of the same task arriving meanwhile does not deliver it a
    // second time. Released below if the write fails.
    if (this.dispatched.has(key)) return false;
    this.dispatched.add(key);
    this.cancelGraceTimer(key);

    // A new task starts in a fresh conversation (old one saved first) so it
    // does not re-read the previous task's history on every turn.
    const freshNote = await this.prepareConversation(workItem);
    const worktreeHint = await this.resolveWorktreeHint(workItem);
    const message = this.buildDispatchMessage(workItem, freshNote, worktreeHint);

    try {
      const res = await axios.post(
        `${getLocalApiBaseUrl()}/api/terminal/${encodeURIComponent(workItem.target)}/write`,
        { data: message, mode: 'message' },
        {
          headers: internalAgentHeaders(SERVICE_NAME),
          timeout: 5_000,
        },
      );
      if (isSpendCappedReply(res?.data)) {
        // The cap fired between the check above and the write: the brief is
        // on the agent's queue, not in front of it. Not delivered.
        this.dispatched.delete(key);
        this.logger.info('Dispatch held by the daily token cap — not delivered', {
          workItemId: workItem.id,
          target: workItem.target,
        });
        return false;
      }
      this.logger.info('Dispatched WorkItem to target session', {
        workItemId: workItem.id,
        target: workItem.target,
        type: workItem.type,
      });
      if (isScheduledWorkItem(workItem)) noteScheduledTurn(workItem.target);
      return true;
    } catch (err) {
      // Common non-fatal cases: 404 (session not found — agent gone),
      // 503 (backend not ready), connection refused. We do NOT keep the
      // key on failure so a later retry path can succeed.
      this.dispatched.delete(key);
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

  /**
   * Called by a direct hand-over (`/terminal/:s/deliver` or `/write` with a
   * `workItemId`) right before it writes the task to `target`. Takes the
   * same dedup key {@link dispatchTo} uses, so the dispatcher will not push
   * its own brief for this (WI, target) afterwards.
   *
   * @param workItemId - WorkItem being handed over
   * @param target - Session it is written to
   * @returns True when this call took the key (first delivery); false when
   *   the dispatcher (or an earlier hand-over) already delivered it
   */
  claimDirectDelivery(workItemId: string, target: string): boolean {
    const key = this.dispatchKey(workItemId, target);
    // The grace timer is left running: if this hand-over fails and gives the
    // key back, the timer is what still delivers the task.
    if (this.dispatched.has(key)) return false;
    this.dispatched.add(key);
    return true;
  }

  /**
   * Give back a key taken by {@link claimDirectDelivery} when the hand-over
   * failed, so the dispatcher's fallback (grace timer, reconciler, backfill)
   * can still deliver the task.
   *
   * @param workItemId - WorkItem whose hand-over failed
   * @param target - Session it was meant for
   */
  releaseDirectDelivery(workItemId: string, target: string): void {
    this.dispatched.delete(this.dispatchKey(workItemId, target));
  }

  /**
   * Whether a (WI, target) pair was already delivered in this process.
   *
   * @param workItemId - WorkItem id
   * @param target - Session
   * @returns True when dispatched or handed over directly
   */
  isDelivered(workItemId: string, target: string): boolean {
    return this.dispatched.has(this.dispatchKey(workItemId, target));
  }

  /** Stop every pending direct-delivery grace timer (tests / shutdown). */
  stop(): void {
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
  }

  private cancelGraceTimer(key: string): void {
    const t = this.graceTimers.get(key);
    if (t) clearTimeout(t);
    this.graceTimers.delete(key);
  }

  /**
   * Force-redeliver a WorkItem brief to its target, bypassing the in-process
   * dedup cache. Used by Hybrid Wake's `redeliver` strategy (2026-05-20):
   * when a queued WI lingers past threshold but its target is `active` and
   * `activeWorkItemCount === 0`, the original `dispatchTo` write likely
   * landed during claude-code's startup banner and was silently dropped.
   * Resetting the dedup key and reposting the brief gives the now-idle
   * agent a second chance to see it.
   *
   * Returns true if the redelivered write succeeded.
   *
   * @param workItem - WorkItem whose brief should be re-pushed
   * @returns Whether the redelivery write succeeded
   */
  async redispatch(workItem: WorkItem): Promise<boolean> {
    if (!workItem.target) return false;
    const key = this.dispatchKey(workItem.id, workItem.target);
    this.dispatched.delete(key);
    const ok = await this.dispatchTo(workItem);
    traceHarness('harness.redelivery', {
      workItem,
      session: workItem.target,
      summary: `Brief of work item re-pushed to ${workItem.target}: ${workItem.title}`,
      outcome: ok ? 'ok' : 'failed',
    });
    return ok;
  }

  /**
   * Redeliver several queued WorkItems that share a target as ONE reminder.
   *
   * The reconciler calls this instead of {@link redispatch} per item when an
   * active-but-idle agent has more than one stale WI: each PTY write is a
   * full model turn for the agent, so N reminders cost N turns while one
   * combined reminder costs one (2026-09-16 token-burn finding).
   *
   * @param workItems - Queued WIs with the same `target`; items whose target
   *   differs from the first one are dropped
   * @returns Whether the combined write succeeded (false for an empty batch)
   */
  async redispatchMany(workItems: ReadonlyArray<WorkItem>): Promise<boolean> {
    const target = workItems[0]?.target;
    if (!target) return false;
    const batch = workItems.filter((wi) => wi.target === target && !SLA_TRACKER_ID_PATTERN.test(wi.id));
    if (batch.length === 0) return false;
    if (batch.length === 1) return this.redispatch(batch[0]);
    if (spendCapStopOf(target)) {
      this.logger.info('Batch redispatch skipped — target is over its daily token cap', { target, count: batch.length });
      return false;
    }

    for (const wi of batch) this.dispatched.delete(this.dispatchKey(wi.id, target));
    // No fresh-conversation prepare here: a batch is a reminder for work that
    // was already delivered to this agent, so its context is what the agent
    // needs; clearing would drop it. (A single-item reminder goes through
    // dispatchTo, where only a root different from the last delivered one
    // can clear — and never while other work is running.)
    const message = this.buildBatchDispatchMessage(batch, target);
    try {
      const res = await axios.post(
        `${getLocalApiBaseUrl()}/api/terminal/${encodeURIComponent(target)}/write`,
        { data: message, mode: 'message' },
        {
          headers: internalAgentHeaders(SERVICE_NAME),
          timeout: 5_000,
        },
      );
      if (isSpendCappedReply(res?.data)) {
        this.logger.info('Batch redispatch held by the daily token cap — not delivered', { target, count: batch.length });
        return false;
      }
      for (const wi of batch) this.dispatched.add(this.dispatchKey(wi.id, target));
      if (batch.some(isScheduledWorkItem)) noteScheduledTurn(target);
      for (const wi of batch) {
        traceHarness('harness.redelivery', {
          workItem: wi,
          session: target,
          summary: `Reminder of ${batch.length} queued work items sent to ${target}: ${wi.title}`,
          outcome: 'ok',
          data: { batch: batch.length },
        });
      }
      this.logger.info('Redispatched WorkItem batch to target session', {
        target,
        count: batch.length,
        workItemIds: batch.map((wi) => wi.id),
      });
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      this.logger.debug('Batch dispatch HTTP write failed (non-fatal)', {
        target,
        count: batch.length,
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
    if (!wi.target || wi.target === ORCHESTRATOR_SESSION_NAME) return;

    // The creator delivers this task itself (delegate-task). Give that
    // hand-over time to land; push our brief only if it never did.
    if (wi.metadata?.[DIRECT_DELIVERY_CONSTANTS.METADATA_FLAG] === true) {
      const key = this.dispatchKey(wi.id, wi.target);
      if (this.dispatched.has(key) || this.graceTimers.has(key)) return;
      const timer = setTimeout(() => {
        this.graceTimers.delete(key);
        void (async () => {
          if (this.dispatched.has(key)) return;
          const now = await TaskPoolService.getInstance().findWorkItem(workItemId);
          if (!now || now.status !== 'queued' || now.target !== wi.target) return;
          this.logger.info('Direct hand-over never arrived — dispatching the queued WorkItem', {
            workItemId,
            target: now.target,
          });
          await this.dispatchTo(now);
        })().catch((err: unknown) => {
          this.logger.debug('Deferred dispatch failed (non-fatal)', {
            workItemId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, DIRECT_DELIVERY_CONSTANTS.GRACE_MS);
      timer.unref?.();
      this.graceTimers.set(key, timer);
      return;
    }
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
  /**
   * Compose one reminder covering every queued WI for a target. Same tag and
   * closing command as {@link buildDispatchMessage}, one line per item.
   *
   * @param workItems - Queued WIs sharing `target`
   * @param target - Session the reminder is written to
   * @returns Multi-line message suitable for terminal write
   */
  private buildBatchDispatchMessage(workItems: ReadonlyArray<WorkItem>, target: string): string {
    const lines = workItems.map((wi, i) => {
      const titleSnippet = wi.title.length > 80 ? wi.title.substring(0, 77) + '...' : wi.title;
      const trace = workItemTraceMarker(wi);
      return `  ${i + 1}. ${wi.id} (type=${wi.type}) — ${titleSnippet}${trace ? ` ${trace}` : ''}`;
    });
    return [
      '',
      `[CREWLY-DISPATCH] ${workItems.length} WorkItems are still queued for you — this one message covers all of them.`,
      ...lines,
      '  Take them ONE AT A TIME, in this order: claim one, finish it and complete it, then claim the next.',
      '  Do not start an item you have not claimed. Run poll-tasks to claim the next one:',
      `    bash $AGENT_SKILLS_PATH/core/poll-tasks/execute.sh '{"sessionName":"${target}"}'`,
      '',
    ].join('\n');
  }

  private buildDispatchMessage(
    workItem: WorkItem,
    freshNote: string | null = null,
    worktreeHint: { workdir: string; branch: string } | null = null,
  ): string {
    const titleSnippet = workItem.title.length > 80
      ? workItem.title.substring(0, 77) + '...'
      : workItem.title;
    const trace = workItemTraceMarker(workItem);

    return [
      '',
      ...(freshNote ? [freshNote] : []),
      `[CREWLY-DISPATCH] WorkItem ${workItem.id} queued for you (type=${workItem.type}).`,
      `  Title: ${titleSnippet}`,
      ...(trace ? [`  Trace: ${trace}`] : []),
      ...(worktreeHint
        ? [
            `  This WorkItem has its own git worktree. Work ONLY in:`,
            `    ${worktreeHint.workdir}`,
            `  (branch ${worktreeHint.branch}). cd there before editing; do not edit the shared checkout directly.`,
          ]
        : []),
      '  Run poll-tasks to claim:',
      `    bash $AGENT_SKILLS_PATH/core/poll-tasks/execute.sh '{"sessionName":"${workItem.target}"}'`,
      '',
    ].join('\n');
  }
}
