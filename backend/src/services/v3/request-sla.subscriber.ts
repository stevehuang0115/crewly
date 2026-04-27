/**
 * RequestSlaSubscriber (INBOUND-1)
 *
 * Closes the user-facing reliability gap noted by Steve on 2026-04-27:
 * inbound user messages on Slack/Chat-v2 land as Requests today
 * (`slack-orchestrator-bridge.ts:377`), but no WorkItem is auto-created on
 * the orchestrator's plate. The orc therefore has no SLA to track and can
 * silently drop a user request when busy with other work.
 *
 * This subscriber listens to `request:created` and — when the Request was
 * sourced from an inbound user channel (tags include `slack` or `chat-v2`)
 * — auto-creates a `respond_to_user` WorkItem assigned to the orc with a
 * 5-minute SLA deadline. If the orc has not transitioned the WI to a
 * terminal status by 5 minutes, the subscriber emits `request:sla_breached`
 * (CRITICAL — surfaces in the orc terminal). At 10 minutes the subscriber
 * fires the *escalation* hook, which the production wiring uses to send a
 * Slack DM nudge back to the user (so they're never blind to the miss).
 *
 * Auto-close paths:
 *   (a) {@link markResolvedByThread} — `slack-orchestrator-bridge` calls
 *       this when the orc replies in a thread, so the WI auto-transitions
 *       to `done` and the SLA timers no-op against a terminal status.
 *   (b) Timer self-check — every breach handler reads the WI status before
 *       publishing or escalating, so a manual orc completeItem() also
 *       silences the chain.
 *
 * Idempotency contract (Arch Veto V1):
 *   The respond_to_user WorkItem id is deterministic
 *   (`request:${requestId}:respond_to_user`); the underlying
 *   {@link TaskPoolService.addToPool} already short-circuits on duplicate
 *   id. A redelivered `request:created` event therefore fires the handler
 *   again, the bridge re-builds the same id, and addToPool no-ops — no
 *   separate idempotency store is needed.
 *
 * No new ingress event types (Arch Veto V7 spirit):
 *   The orc's revised framing on 2026-04-27 explicitly preferred reusing
 *   the existing Request creation path over adding new `inbound:*` event
 *   vocabulary. INBOUND-1 adds two events (`request:created`,
 *   `request:sla_breached`) that match the Request lifecycle the rest of
 *   the system already knows about — no parallel ingress entity.
 *
 * @module services/v3/request-sla.subscriber
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { formatError } from '../../utils/format-error.js';
import {
  type WorkItem,
  type WorkItemStatus,
  DEFAULT_MAX_RETRIES,
} from '../../types/v2/work-item.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import type { EventBusService, InProcessUnsubscribe } from '../event-bus/event-bus.service.js';
import type { TaskPoolService } from '../task-pool/task-pool.service.js';
import type { RequestService } from './request.service.js';

// ---------------------------------------------------------------------------
// Module-level singleton accessor (DI for slack-orchestrator-bridge)
// ---------------------------------------------------------------------------

/**
 * The currently-wired RequestSlaSubscriber instance, set by the backend
 * boot path. The slack-orchestrator-bridge calls
 * {@link getRequestSlaSubscriber} from a lazy import so we don't form a
 * static cycle between the bridge and the subscriber at module load.
 */
let injectedSubscriber: RequestSlaSubscriber | null = null;

/**
 * Wire the subscriber instance accessible via {@link getRequestSlaSubscriber}.
 * Called once from boot before the slack listener can dispatch a reply.
 *
 * @param sub - The live subscriber, or null to clear (tests)
 */
export function setRequestSlaSubscriber(sub: RequestSlaSubscriber | null): void {
  injectedSubscriber = sub;
}

/**
 * Read the currently-wired subscriber, or null if boot has not finished yet.
 * Returns null in test setups that don't wire one — callers must tolerate.
 */
export function getRequestSlaSubscriber(): RequestSlaSubscriber | null {
  return injectedSubscriber;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default SLA breach threshold — orc must respond within this window or
 * `request:sla_breached` fires with breachLevel=5.
 */
export const DEFAULT_SLA_MS = 5 * 60 * 1000;

/**
 * Default escalation threshold — at this point the user-facing escalation
 * hook fires (production: Slack DM back to user).
 */
export const DEFAULT_ESCALATION_MS = 10 * 60 * 1000;

/**
 * Tags we treat as "user-facing inbound channels" — Requests with any of
 * these tags get an SLA-tracked respond_to_user WI. Slack is wired today;
 * `chat-v2` is reserved for the channel-rail Phase E surface.
 */
export const DEFAULT_INBOUND_TAGS: readonly string[] = ['slack', 'chat-v2'];

/**
 * Event types the subscriber listens to. Single-event for now —
 * future iterations may add `request:cancelled` etc. for cleanup.
 */
export const REQUEST_SLA_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'request:created',
] as const;

/**
 * Terminal WorkItem statuses — the SLA timers no-op when the WI has reached
 * any of these by the time the timer fires. Typed as
 * `ReadonlySet<WorkItemStatus>` so a future addition (e.g.
 * `'verified_with_warnings'`) or a typo'd member fails compilation here
 * rather than silently leaking through. Aligns the JSDoc claim with reality.
 */
const TERMINAL_WI_STATUSES: ReadonlySet<WorkItemStatus> = new Set<WorkItemStatus>([
  'done',
  'cancelled',
  'failed',
  'verified',
  'rejected',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Slack thread timestamp from a Request's
 * `sourceConversationItemId`. The slack-orchestrator-bridge stamps these
 * as `slack-${channelId}-${ts}` (see slack-orchestrator-bridge.ts:372),
 * so the trailing dotted-decimal segment is the threadTs.
 *
 * @param sourceId - The Request's sourceConversationItemId
 * @returns The threadTs, or null if the id doesn't match the Slack shape
 */
export function extractSlackThreadTs(sourceId: string | undefined): string | null {
  if (!sourceId || !sourceId.startsWith('slack-')) return null;
  // slack-${channelId}-${ts}; channelId may not contain dashes, but ts is
  // dotted-decimal. We split on '-' and take the last segment as ts.
  const lastDash = sourceId.lastIndexOf('-');
  if (lastDash < 0 || lastDash === sourceId.length - 1) return null;
  const ts = sourceId.slice(lastDash + 1);
  // ts looks like 1772899923.865659 — at minimum digits + '.'
  if (!/^\d+\.\d+$/.test(ts)) return null;
  return ts;
}

/**
 * Extract the Slack channel id from a sourceConversationItemId.
 *
 * @param sourceId - The Request's sourceConversationItemId
 * @returns The channelId, or null if the id doesn't match the Slack shape
 */
export function extractSlackChannelId(sourceId: string | undefined): string | null {
  if (!sourceId || !sourceId.startsWith('slack-')) return null;
  const rest = sourceId.slice('slack-'.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash < 1) return null;
  return rest.slice(0, lastDash);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the subscriber cannot resolve a Request for an event. The
 * Request was deleted between publish and dispatch — rare, but observable
 * in tests, so we encode the case as a typed error.
 */
export class RequestNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Pluggable callback that performs the user-facing 10-minute escalation —
 * production wires this to {@link SlackService.sendMessage} so we DM the
 * user back. Tests can fake.
 */
export type EscalationSlackCallback = (args: {
  channelId: string;
  threadTs: string;
  messageText: string;
  request: Request;
  workItem: WorkItem | null;
}) => Promise<void>;

/**
 * Optional dependency container. Production wiring uses
 * {@link RequestSlaSubscriber.boot}; tests construct directly with fakes.
 */
export interface RequestSlaSubscriberDependencies {
  /** Live event bus. */
  eventBus: EventBusService;
  /** TaskPool for addToPool + transitionStatus + findWorkItem. */
  taskPool: TaskPoolService;
  /** RequestService for tag/source lookups by id. */
  requestService: RequestService;
  /** Slack DM hook — fires at 10min escalation. Optional; subscriber
   *  no-ops if missing (logs at warn level instead). */
  sendEscalationDm?: EscalationSlackCallback;
  /** Override the orchestrator session (testing). */
  orchestratorSession?: string;
  /** Override the SLA window (testing). */
  slaMs?: number;
  /** Override the escalation window (testing). */
  escalationMs?: number;
  /** Override the inbound tag list (testing / future channel sources). */
  inboundTags?: readonly string[];
  /** Optional logger. */
  logger?: ComponentLogger;
}

/**
 * Internal record per-tracked respond_to_user WI. Held in memory so
 * {@link markResolvedByThread} can map threadTs → WI in O(1).
 */
interface TrackedRespondWi {
  workItemId: string;
  requestId: string;
  threadTs: string | null;
  channelId: string | null;
  breachTimer: NodeJS.Timeout;
  escalationTimer: NodeJS.Timeout;
  request: Request;
}

/**
 * RequestSlaSubscriber — the INBOUND-1 deliverable.
 *
 * @example
 * ```typescript
 * const sub = RequestSlaSubscriber.boot(eventBus, slackEscalationFn);
 * sub.start();
 * // … on shutdown:
 * sub.stop();
 * ```
 */
export class RequestSlaSubscriber {
  private readonly eventBus: EventBusService;
  private readonly taskPool: TaskPoolService;
  private readonly requestService: RequestService;
  private readonly sendEscalationDm?: EscalationSlackCallback;
  private readonly orchestratorSession: string;
  private readonly slaMs: number;
  private readonly escalationMs: number;
  private readonly inboundTags: ReadonlySet<string>;
  private readonly logger: ComponentLogger;
  private unsubscribers: InProcessUnsubscribe[] = [];
  private started = false;
  /** requestId → tracked record; primary index for breach handlers. */
  private trackedByRequest: Map<string, TrackedRespondWi> = new Map();
  /** threadTs → requestId; secondary index for {@link markResolvedByThread}. */
  private threadIndex: Map<string, string> = new Map();
  /** In-flight async dispatch promises (test affordance). */
  private pendingDispatches: Set<Promise<void>> = new Set();

  constructor(deps: RequestSlaSubscriberDependencies) {
    this.eventBus = deps.eventBus;
    this.taskPool = deps.taskPool;
    this.requestService = deps.requestService;
    this.sendEscalationDm = deps.sendEscalationDm;
    this.orchestratorSession = deps.orchestratorSession ?? ORCHESTRATOR_SESSION_NAME;
    this.slaMs = deps.slaMs ?? DEFAULT_SLA_MS;
    this.escalationMs = deps.escalationMs ?? DEFAULT_ESCALATION_MS;
    this.inboundTags = new Set(deps.inboundTags ?? DEFAULT_INBOUND_TAGS);
    this.logger =
      deps.logger ?? LoggerService.getInstance().createComponentLogger('RequestSlaSubscriber');
  }

  /**
   * Production wiring helper. Tests should use the constructor directly.
   *
   * @param eventBus - Live event bus
   * @param requestService - Live RequestService
   * @param taskPool - Live TaskPoolService
   * @param sendEscalationDm - Slack DM callback for the 10-minute escalation
   * @returns A subscriber ready to `start()`
   */
  static boot(
    eventBus: EventBusService,
    requestService: RequestService,
    taskPool: TaskPoolService,
    sendEscalationDm?: EscalationSlackCallback,
  ): RequestSlaSubscriber {
    return new RequestSlaSubscriber({
      eventBus,
      taskPool,
      requestService,
      sendEscalationDm,
    });
  }

  /**
   * Subscribe + register the in-process handlers. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    for (const eventType of REQUEST_SLA_SUBSCRIBED_EVENTS) {
      this.unsubscribers.push(
        this.eventBus.onInProcess(eventType, (e) => this.safeDispatch(eventType, e)),
      );
    }

    this.logger.info('RequestSlaSubscriber subscribed', {
      eventTypes: REQUEST_SLA_SUBSCRIBED_EVENTS,
      slaMs: this.slaMs,
      escalationMs: this.escalationMs,
      orchestratorSession: this.orchestratorSession,
    });
  }

  /**
   * Wait for in-flight async dispatches to settle. Test affordance.
   */
  async flushPending(): Promise<void> {
    while (this.pendingDispatches.size > 0) {
      const inFlight = Array.from(this.pendingDispatches);
      await Promise.allSettled(inFlight);
    }
  }

  /**
   * Detach subscriptions + clear all SLA timers. Safe to call repeatedly.
   */
  stop(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger.warn('SLA unsubscribe threw', { error: formatError(err) });
      }
    }
    this.unsubscribers = [];

    for (const tracked of this.trackedByRequest.values()) {
      clearTimeout(tracked.breachTimer);
      clearTimeout(tracked.escalationTimer);
    }
    this.trackedByRequest.clear();
    this.threadIndex.clear();
    this.started = false;
    this.logger.info('RequestSlaSubscriber stopped');
  }

  /**
   * Mark an in-flight respond_to_user WI as done because the orchestrator
   * just replied to the matching Slack thread. Called by
   * {@link slack-orchestrator-bridge.sendSlackResponse}.
   *
   * Best-effort: a non-Slack-shaped or unknown threadTs is a no-op.
   *
   * @param threadTs - The Slack message timestamp the orc replied to
   */
  async markResolvedByThread(threadTs: string): Promise<void> {
    if (!threadTs) return;
    const requestId = this.threadIndex.get(threadTs);
    if (!requestId) return;
    await this.markResolved(requestId, 'orc_reply');
  }

  /**
   * Mark an in-flight respond_to_user WI as done by Request id (e.g. the
   * orc decomposed the Request into other WorkItems and we want to silence
   * the SLA chain). v1 is called by {@link markResolvedByThread} only;
   * follow-up tickets may wire a Request-status hook.
   *
   * @param requestId - The Request whose SLA chain should be silenced
   * @param reason - Diagnostic tag for the resolution log entry
   */
  async markResolved(requestId: string, reason: string): Promise<void> {
    const tracked = this.trackedByRequest.get(requestId);
    if (!tracked) return;

    // Clear timers BEFORE the await so a concurrent breach can't fire after
    // we've decided to resolve.
    clearTimeout(tracked.breachTimer);
    clearTimeout(tracked.escalationTimer);
    this.trackedByRequest.delete(requestId);
    if (tracked.threadTs) this.threadIndex.delete(tracked.threadTs);

    try {
      const wi = await this.taskPool.findWorkItem(tracked.workItemId);
      if (!wi) return;
      if (TERMINAL_WI_STATUSES.has(wi.status)) {
        // Already terminal — nothing to do.
        return;
      }
      await this.taskPool.transitionStatus(tracked.workItemId, 'done', 'system', (item) => {
        item.metadata = {
          ...(item.metadata ?? {}),
          slaResolvedReason: reason,
          slaResolvedAt: new Date().toISOString(),
        };
      });
      this.logger.info('SLA WorkItem auto-resolved', {
        workItemId: tracked.workItemId,
        requestId,
        reason,
      });
    } catch (err) {
      this.logger.warn('SLA auto-resolve threw', {
        workItemId: tracked.workItemId,
        requestId,
        error: formatError(err),
      });
    }
  }

  /**
   * Snapshot of the tracked-WI count. Test affordance.
   */
  get trackedCount(): number {
    return this.trackedByRequest.size;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * `request:created` handler. Filters by inbound tag, creates the
   * respond_to_user WI, and schedules the breach + escalation timers.
   */
  private handleRequestCreated = async (event: AgentEvent): Promise<void> => {
    if (!event.requestId) {
      this.logger.debug('request:created event missing requestId', { eventId: event.id });
      return;
    }

    const request = await this.requestService.getById(event.requestId);
    if (!request) {
      // Persistence failed asynchronously, or the Request was deleted
      // between publish and dispatch. Log and bail.
      this.logger.warn('request:created references unknown Request', {
        requestId: event.requestId,
      });
      return;
    }

    if (!this.matchesInboundTag(request.tags)) {
      this.logger.debug('request:created skipping non-inbound source', {
        requestId: request.id,
        tags: request.tags,
      });
      return;
    }

    const wiId = `request:${request.id}:respond_to_user`;
    const threadTs = extractSlackThreadTs(request.sourceConversationItemId);
    const channelId = extractSlackChannelId(request.sourceConversationItemId);

    const wi = this.buildRespondWorkItem(request, wiId, threadTs, channelId);

    // addToPool short-circuits on duplicate id (V1 dedup).
    await this.taskPool.addToPool(wi);

    // Schedule the breach + escalation timers. We unref the timers so a
    // hung subscriber on shutdown doesn't keep the node process alive.
    const breachTimer = setTimeout(() => {
      void this.handleBreach(request.id, /*level*/ 5);
    }, this.slaMs);
    breachTimer.unref?.();
    const escalationTimer = setTimeout(() => {
      void this.handleEscalation(request.id);
    }, this.escalationMs);
    escalationTimer.unref?.();

    this.trackedByRequest.set(request.id, {
      workItemId: wiId,
      requestId: request.id,
      threadTs,
      channelId,
      breachTimer,
      escalationTimer,
      request,
    });
    if (threadTs) this.threadIndex.set(threadTs, request.id);

    this.logger.info('SLA respond_to_user WorkItem queued', {
      workItemId: wiId,
      requestId: request.id,
      threadTs,
      slaMs: this.slaMs,
    });
  };

  /**
   * 5-minute breach handler. Re-checks the WI status and emits
   * `request:sla_breached` if the WI is still non-terminal.
   *
   * @param requestId - The Request whose breach is firing
   * @param level - Breach level: 5 (first SLA) or 10 (escalation)
   */
  private async handleBreach(requestId: string, level: number): Promise<void> {
    const tracked = this.trackedByRequest.get(requestId);
    if (!tracked) return;

    try {
      const wi = await this.taskPool.findWorkItem(tracked.workItemId);
      if (!wi || TERMINAL_WI_STATUSES.has(wi.status)) {
        // Auto-resolved before the timer fired — clean up tracking.
        this.cleanupTracked(requestId);
        return;
      }

      this.eventBus.publish({
        id: `request:sla_breached:${requestId}:${level}`,
        type: 'request:sla_breached',
        timestamp: new Date().toISOString(),
        teamId: '',
        teamName: '',
        memberId: '',
        memberName: '',
        sessionName: this.orchestratorSession,
        previousValue: 'in_sla',
        newValue: `breached_${level}m`,
        changedField: 'taskStatus',
        requestId,
        workItemId: tracked.workItemId,
      });

      this.logger.warn('SLA breach', {
        requestId,
        workItemId: tracked.workItemId,
        level,
      });
    } catch (err) {
      this.logger.error('SLA breach handler threw', {
        requestId,
        error: formatError(err),
      });
    }
  }

  /**
   * 10-minute escalation handler. Emits the level-10 breach event and —
   * if a Slack DM callback is wired — sends the user a "still working on
   * it" nudge so they're never blind to the miss. After the DM (or DM-skip),
   * transitions the orphaned respond_to_user WI to `'failed'` with
   * `slaResolvedReason: 'escalation_timeout'` so the orc queue does not keep
   * a stale `queued` WI forever (Arch N3 on PR #357).
   */
  private async handleEscalation(requestId: string): Promise<void> {
    const tracked = this.trackedByRequest.get(requestId);
    if (!tracked) return;

    // Re-emit the breach event at level=10 so the orc terminal sees the
    // escalation arc explicitly.
    await this.handleBreach(requestId, 10);

    // Re-fetch in case the breach handler cleaned up.
    const stillTracked = this.trackedByRequest.get(requestId);
    if (!stillTracked) return;

    // Capture the WI id BEFORE cleanupTracked() drops the record so we can
    // still transition the orphan WI to 'failed' afterwards.
    const wiId = stillTracked.workItemId;

    if (!this.sendEscalationDm) {
      this.logger.warn('SLA escalation reached 10min — no Slack DM hook wired', {
        requestId,
      });
      this.cleanupTracked(requestId);
      await this.failOrphanRespondWi(wiId, requestId);
      return;
    }

    if (!stillTracked.channelId || !stillTracked.threadTs) {
      this.logger.warn('SLA escalation missing Slack thread context — skipping DM', {
        requestId,
      });
      this.cleanupTracked(requestId);
      await this.failOrphanRespondWi(wiId, requestId);
      return;
    }

    try {
      const wi = await this.taskPool.findWorkItem(stillTracked.workItemId);
      const messageText =
        ":hourglass: It's been a few minutes — I'm still on this. " +
        'I will reply as soon as I have an answer. (auto-nudge)';
      await this.sendEscalationDm({
        channelId: stillTracked.channelId,
        threadTs: stillTracked.threadTs,
        messageText,
        request: stillTracked.request,
        workItem: wi,
      });
      this.logger.info('SLA escalation Slack DM sent', {
        requestId,
        channelId: stillTracked.channelId,
      });
    } catch (err) {
      this.logger.error('SLA escalation DM failed', {
        requestId,
        error: formatError(err),
      });
    } finally {
      // Escalation is the terminal hook in v1 — drop tracking + close the
      // orphan WI either way (DM success or failure).
      this.cleanupTracked(requestId);
      await this.failOrphanRespondWi(wiId, requestId);
    }
  }

  /**
   * Transition an escalated respond_to_user WI to `'failed'` with
   * `slaResolvedReason: 'escalation_timeout'` so the orc queue does not
   * keep a stale `queued` WI forever after a 10-min escalation. No-op if
   * the WI is already terminal (e.g. user gave up + an out-of-band cleanup
   * already closed it).
   *
   * Mirrors {@link markResolved}'s terminal-status guard. Errors are
   * logged but never propagated — the SLA chain is already terminal at
   * this point and we do not want to mask the original DM-path outcome.
   *
   * @param workItemId - The respond_to_user WI id to close.
   * @param requestId  - The originating Request id (logging context only).
   */
  private async failOrphanRespondWi(
    workItemId: string,
    requestId: string,
  ): Promise<void> {
    try {
      const wi = await this.taskPool.findWorkItem(workItemId);
      if (!wi) return;
      if (TERMINAL_WI_STATUSES.has(wi.status)) {
        // Already terminal — nothing to do.
        return;
      }
      await this.taskPool.transitionStatus(workItemId, 'failed', 'system', (item) => {
        item.metadata = {
          ...(item.metadata ?? {}),
          slaResolvedReason: 'escalation_timeout',
          slaResolvedAt: new Date().toISOString(),
        };
      });
      this.logger.info('SLA escalation orphan WI auto-failed', {
        workItemId,
        requestId,
      });
    } catch (err) {
      this.logger.warn('SLA escalation orphan-fail threw', {
        workItemId,
        requestId,
        error: formatError(err),
      });
    }
  }

  /**
   * Drop tracking + clear timers for a Request. Used both on auto-resolve
   * and on terminal escalation — once we reach 10min the SLA chain is done.
   */
  private cleanupTracked(requestId: string): void {
    const tracked = this.trackedByRequest.get(requestId);
    if (!tracked) return;
    clearTimeout(tracked.breachTimer);
    clearTimeout(tracked.escalationTimer);
    this.trackedByRequest.delete(requestId);
    if (tracked.threadTs) this.threadIndex.delete(tracked.threadTs);
  }

  /**
   * Check whether a Request's tags include any of the configured inbound
   * channel tags.
   */
  private matchesInboundTag(tags: readonly string[]): boolean {
    for (const t of tags) {
      if (this.inboundTags.has(t)) return true;
    }
    return false;
  }

  /**
   * Build the respond_to_user WorkItem with the standard metadata invariants.
   */
  private buildRespondWorkItem(
    request: Request,
    wiId: string,
    threadTs: string | null,
    channelId: string | null,
  ): WorkItem {
    const now = new Date().toISOString();
    const slaDeadline = new Date(Date.now() + this.slaMs).toISOString();
    const escalationDeadline = new Date(Date.now() + this.escalationMs).toISOString();
    return {
      id: wiId,
      type: 'review',
      owner: 'orchestrator',
      target: this.orchestratorSession,
      title: `Respond to user: ${request.title.slice(0, 60)}`,
      description:
        `Inbound user message arrived as Request ${request.id}.\n\n` +
        `Original message:\n${request.description.slice(0, 400)}`,
      status: 'queued',
      createdAt: now,
      retryCount: 0,
      maxRetries: DEFAULT_MAX_RETRIES,
      requestId: request.id,
      missionId: request.missionId,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      metadata: {
        idempotencyKey: wiId,
        triggerSource: 'event',
        slaSource: 'inbound-1',
        slaDeadline,
        slaEscalationDeadline: escalationDeadline,
        slaBreachLevel: 0,
        inboundTag: request.tags.find((t) => this.inboundTags.has(t)),
        slackThreadTs: threadTs,
        slackChannelId: channelId,
      },
    };
  }

  /**
   * Wrap a dispatch so a thrown handler is logged and isolated. Mirrors
   * EventToWorkItemBridge.safeDispatch.
   */
  private safeDispatch(eventType: EventType, event: AgentEvent): Promise<void> {
    const dispatch = (async () => {
      try {
        if (eventType === 'request:created') {
          await this.handleRequestCreated(event);
        }
      } catch (err) {
        this.logger.error('SLA subscriber handler threw', {
          eventType,
          eventId: event.id,
          error: formatError(err),
        });
      }
    })();
    this.pendingDispatches.add(dispatch);
    dispatch
      .finally(() => {
        this.pendingDispatches.delete(dispatch);
      })
      .catch(() => {
        // suppress unhandled-rejection — flushPending owners use allSettled.
      });
    return dispatch;
  }
}
