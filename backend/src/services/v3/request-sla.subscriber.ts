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
 *   (b) {@link handleWorkItemQueued} (INBOUND-1.f1) — when the orc decomposes
 *       a Request into other WorkItems via `taskPool.addToPool`, every new
 *       WI fires `workitem:queued`. The handler treats decomposition as
 *       "the orc has done the right thing" and resolves the tracked
 *       respond_to_user WI with reason `workitem_decompose`. Self-recursion
 *       is prevented by an id-shape guard
 *       (`request:${requestId}:respond_to_user`) — the respond_to_user WI's
 *       own enqueue cannot trigger its own resolution.
 *   (c) Timer self-check — every breach handler reads the WI status before
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
import {
  type Request,
  type RequestStatus,
  TERMINAL_REQUEST_STATUSES,
  isValidRequestTransition,
} from '../../types/v2/request.types.js';
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
 * Event types the subscriber listens to.
 *
 * - `request:created` (INBOUND-1) — seed a respond_to_user WI for inbound
 *   user messages.
 * - `workitem:queued` (INBOUND-1.f1) — auto-close path b: when the orc
 *   decomposes a Request into other WorkItems, the respond_to_user WI for
 *   that Request resolves automatically.
 *
 * Future iterations may add `request:cancelled` etc. for cleanup.
 */
export const REQUEST_SLA_SUBSCRIBED_EVENTS: readonly EventType[] = [
  'request:created',
  'workitem:queued',
] as const;

/**
 * Build the deterministic respond_to_user WorkItem id for a Request. The
 * SLA subscriber uses this both for creating the WI and as the id-shape
 * guard against self-resolve recursion in {@link handleWorkItemQueued}.
 *
 * @param requestId - The Request id
 * @returns The deterministic WI id
 */
export function respondToUserWorkItemId(requestId: string): string {
  return `request:${requestId}:respond_to_user`;
}

/**
 * Pick the legal terminal status for resolving an SLA-tracked WI. The V3
 * `WORK_ITEM_TRANSITIONS` matrix (see `types/v2/work-item.types.ts`)
 * forbids `queued → done`, so the previous `markResolved` always-`'done'`
 * path was throwing in production while the test fake silently accepted it.
 *
 * Mapping:
 *   - `running`        → `done`      (someone explicitly claimed; close cleanly).
 *   - `done_by_worker` → `verified`  (the only edge `done_by_worker` permits
 *     toward terminal-success; `done_by_worker → cancelled` is illegal).
 *   - `proposed`       → `accepted` then handled separately — but in practice
 *     the SLA WI never lands here, so we route to `cancelled` (legal).
 *   - everything else  → `cancelled` (the V3 matrix permits `* → cancelled`
 *     from all of `queued`/`scheduled`/`accepted`/`blocked`/`escalated`).
 *
 * @param current - The WI's current (non-terminal) status.
 * @returns The legal terminal status to transition into.
 */
export function pickResolveTarget(current: WorkItemStatus): WorkItemStatus {
  if (current === 'running') return 'done';
  if (current === 'done_by_worker') return 'verified';
  return 'cancelled';
}

/**
 * Pick the legal terminal status for FAILING an SLA-tracked WI on
 * escalation timeout (10-minute miss).
 *
 * Mapping:
 *   - `running`        → `failed`    (canonical fail edge).
 *   - `done_by_worker` → `rejected`  (the only fail-shaped edge from
 *     `done_by_worker`; `done_by_worker → failed` is illegal).
 *   - everything else  → `cancelled` (queued/scheduled/etc. cannot reach
 *     `failed` directly, so we route them to `cancelled` — matches the
 *     "we gave up tracking, nothing actually failed" semantic).
 *
 * @param current - The WI's current (non-terminal) status.
 * @returns The legal terminal status to transition into.
 */
export function pickFailTarget(current: WorkItemStatus): WorkItemStatus {
  if (current === 'running') return 'failed';
  if (current === 'done_by_worker') return 'rejected';
  return 'cancelled';
}

/**
 * Compute the legal Request status path from the current state to `done`.
 * Returns an empty array if the Request is already terminal (no work to
 * do) — the call site is expected to guard for this.
 *
 * Per `REQUEST_TRANSITIONS` in `types/v2/request.types.ts`:
 *   - `open` → `done`                         (direct)
 *   - `running` → `done`                      (direct)
 *   - `waiting_confirmation` → `done`         (direct)
 *   - `ready` → `running` → `done`            (two-step; ready→done illegal)
 *   - `blocked` → `running` → `done`          (two-step; blocked→done illegal)
 *
 * @param from - Current Request status (must be non-terminal).
 * @returns Ordered array of statuses to transition through (excluding `from`).
 */
export function closeRequestPath(from: RequestStatus): RequestStatus[] {
  if (from === 'done' || from === 'cancelled') return [];
  if (isValidRequestTransition(from, 'done')) return ['done'];
  // ready / blocked: route via running.
  if (isValidRequestTransition(from, 'running') && isValidRequestTransition('running', 'done')) {
    return ['running', 'done'];
  }
  return [];
}

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

/**
 * Reason tags that represent a VERIFIED actual reply / decomposition by an
 * agent and therefore permit the parent Request to cascade-close to `done`.
 *
 * Defense-in-depth gate for {@link RequestSlaSubscriber.maybeCloseRequest}
 * (Steve 2026-04-30 incident): even if an upstream caller somehow invokes
 * `markResolved` with a non-reply reason, the Request must NOT be flipped
 * to `done` unless the reason is one of these verified paths.
 *
 * - `orc_reply`           — slackResolve callback fired (real orc reply via
 *                           reply-slack skill). Gated by the `fromOrcReply`
 *                           flag on the orchestrator bridge so timeout
 *                           placeholders cannot reach this branch.
 * - `chatv2_reply`        — chat-v2 controller persisted an agent-typed
 *                           reply to the channel (real agent reply).
 * - `workitem_decompose`  — the orc decomposed the Request into other WIs;
 *                           those WIs carry the actual work, so the
 *                           respond_to_user tracker is silenced and the
 *                           Request close is gated separately by the
 *                           sibling-count check.
 *
 * Any other reason ({@link RequestSlaSubscriber.failOrphanRespondWi} fires
 * `escalation_timeout`, callers MAY pass arbitrary diagnostic strings) is
 * treated as "do NOT auto-close the parent Request".
 */
export const VERIFIED_REPLY_REASONS: ReadonlySet<string> = new Set<string>([
  'orc_reply',
  'chatv2_reply',
  'workitem_decompose',
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

/**
 * Inter-field delimiter inside a chat-v2 sourceConversationItemId.
 * Picked as the double-underscore `__` because production channel +
 * message ids are minted via `randomUUID()` (4 dashes per UUID) — a
 * single-dash delimiter would collide with the embedded UUID dashes
 * and corrupt the round-trip. UUIDs are hex-digits + dashes only and
 * cannot contain `_`, so `__` is collision-free against any current
 * or future hex-shaped id. See Arch on PR #364 / INBOUND-2.f1.
 */
const CHATV2_FIELD_DELIM = '__';

/**
 * Extract the chat-v2 channel id from a Request's
 * `sourceConversationItemId`. The chat-v2 controller (INBOUND-2) stamps
 * these as `chatv2-${channelId}__${messageId}` — UUID-safe delimiter.
 *
 * @param sourceId - The Request's sourceConversationItemId
 * @returns The channelId, or null if the id doesn't match the chat-v2 shape
 */
export function extractChatV2ChannelId(sourceId: string | undefined): string | null {
  if (!sourceId || !sourceId.startsWith('chatv2-')) return null;
  const rest = sourceId.slice('chatv2-'.length);
  const sep = rest.indexOf(CHATV2_FIELD_DELIM);
  if (sep < 1) return null;
  return rest.slice(0, sep);
}

/**
 * Extract the chat-v2 message id from a `chatv2-${channelId}__${messageId}`
 * sourceConversationItemId. The messageId acts as the auto-close lookup
 * key analog to a Slack threadTs.
 *
 * @param sourceId - The Request's sourceConversationItemId
 * @returns The messageId, or null if the id doesn't match the chat-v2 shape
 */
export function extractChatV2MessageId(sourceId: string | undefined): string | null {
  if (!sourceId || !sourceId.startsWith('chatv2-')) return null;
  const rest = sourceId.slice('chatv2-'.length);
  const sep = rest.indexOf(CHATV2_FIELD_DELIM);
  if (sep < 0) return null;
  const id = rest.slice(sep + CHATV2_FIELD_DELIM.length);
  if (id.length === 0) return null;
  return id;
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
 * Source channel kind for a tracked respond_to_user WI. Used by the
 * escalation handler to pick the right user-facing nudge path (Slack DM
 * vs chat-v2 channel reply).
 */
type InboundSourceKind = 'slack' | 'chat-v2' | 'unknown';

/**
 * Internal record per-tracked respond_to_user WI. Held in memory so
 * {@link markResolvedByThread} (Slack) and {@link markResolvedByChatV2}
 * (chat-v2) can map their lookup key → WI in O(1).
 */
interface TrackedRespondWi {
  workItemId: string;
  requestId: string;
  /** Source surface — slack | chat-v2 | unknown. INBOUND-2 addition. */
  source: InboundSourceKind;
  /** Slack threadTs (only when source='slack'). */
  threadTs: string | null;
  /** Slack channelId (only when source='slack'). */
  channelId: string | null;
  /** chat-v2 channel id (only when source='chat-v2'). INBOUND-2. */
  chatV2ChannelId: string | null;
  /** chat-v2 message id (only when source='chat-v2'). INBOUND-2. */
  chatV2MessageId: string | null;
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
  /** Slack threadTs → requestId; secondary index for {@link markResolvedByThread}. */
  private threadIndex: Map<string, string> = new Map();
  /**
   * chat-v2 channelId → requestId. INBOUND-2 secondary index used by
   * {@link markResolvedByChatV2}. Last-write-wins when multiple inbound
   * Requests pile up in the same channel — v1 polish accepts the simpler
   * 1:1 semantics; the orphan handler still cleans the WI on escalation.
   */
  private chatV2Index: Map<string, string> = new Map();
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
    this.chatV2Index.clear();
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
   * INBOUND-2: mark the in-flight respond_to_user WI as done because an
   * agent replied in the chat-v2 channel where the user's message arrived.
   * Called by `chat-v2.controller.sendMessage` after a `senderType=agent`
   * message persists to the channel.
   *
   * Best-effort: a non-tracked or unknown channelId is a no-op.
   *
   * @param channelId - The chat-v2 channel where the agent just replied
   */
  async markResolvedByChatV2(channelId: string): Promise<void> {
    if (!channelId) return;
    const requestId = this.chatV2Index.get(channelId);
    if (!requestId) return;
    await this.markResolved(requestId, 'chatv2_reply');
  }

  /**
   * Mark an in-flight respond_to_user WI as resolved by Request id (e.g. the
   * orc replied on Slack, or decomposed the Request into other WorkItems and
   * we want to silence the SLA chain). After the WI transitions, we also
   * cascade the close to the parent Request when this was the last
   * non-terminal WI for it (Steve 2026-04-29: Requests stuck on "Active" in
   * /tasks UI even after the team replied).
   *
   * Transition path is selected from the WI's current status to satisfy the
   * V3 state machine — `transitionStatus` enforces `WORK_ITEM_TRANSITIONS`
   * and `queued → done` is NOT a legal edge:
   *   - `queued` → `cancelled`: SLA tracker was a placeholder, never claimed.
   *     Semantic: "no longer needed because the orc handled this directly".
   *   - `running` → `done`:    Someone explicitly claimed the SLA WI; close
   *     it as a normal completion.
   *   - terminal status:        no-op (already settled).
   *
   * Before this fix, `markResolved` always called `transitionStatus(_, 'done')`
   * which threw on the queued case, the catch swallowed it at warn level, the
   * WI stayed `queued` forever, and the Request never closed — the
   * user-reported "Active count never goes down" bug.
   *
   * @param requestId - The Request whose SLA chain should be silenced
   * @param reason    - Diagnostic tag (`orc_reply` / `chatv2_reply` /
   *   `workitem_decompose`) recorded in WI metadata + Request `result`.
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
    if (tracked.chatV2ChannelId) this.chatV2Index.delete(tracked.chatV2ChannelId);

    try {
      const wi = await this.taskPool.findWorkItem(tracked.workItemId);
      if (wi && !TERMINAL_WI_STATUSES.has(wi.status)) {
        const target = pickResolveTarget(wi.status);
        await this.taskPool.transitionStatus(tracked.workItemId, target, 'system', (item) => {
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
          fromStatus: wi.status,
          toStatus: target,
        });
      }

      // Cascade: close the parent Request when this was the last live WI.
      // Runs even if the WI was already terminal — covers the case where
      // the WI was closed out-of-band but the Request didn't get cascaded.
      await this.maybeCloseRequest(requestId, reason);
    } catch (err) {
      this.logger.warn('SLA auto-resolve threw', {
        workItemId: tracked.workItemId,
        requestId,
        error: formatError(err),
      });
    }
  }

  /**
   * Cascade close the parent Request after an SLA-tracked WI resolves.
   *
   * The Request is moved to `done` only when ALL of:
   *   1. `reason` is in {@link VERIFIED_REPLY_REASONS} (defense-in-depth
   *      against false-resolve paths — see Steve 2026-04-30 incident,
   *      where a `responseTimeoutMs` placeholder fired
   *      `markResolvedByThread` and cascaded the Request to `done`
   *      without an actual orc reply).
   *   2. it exists and is not already terminal (`done`/`cancelled`), AND
   *   3. no other non-terminal WIs remain for it (the orc may have
   *      decomposed the Request into other WIs that are still in flight —
   *      in that case we leave the Request alone and let the existing
   *      `cascadeRequestStatus` machinery in v3-data.service close it
   *      when those WIs finish).
   *
   * Picks the shortest legal transition path per `REQUEST_TRANSITIONS`:
   *   - `open` / `running` / `waiting_confirmation` → `done` (direct)
   *   - `ready` / `blocked`                         → `running` → `done`
   *
   * Errors are caught at the call site (markResolved); this method must
   * never propagate, so a Request-update failure does not leak into the
   * Slack-reply flow.
   *
   * @param requestId - The Request to close.
   * @param reason    - The same reason tag recorded on the WI; passed
   *   through to `Request.result` so the UI shows why it auto-closed.
   */
  private async maybeCloseRequest(requestId: string, reason: string): Promise<void> {
    // Defense-in-depth: even if an upstream caller wires `markResolved` with
    // a non-reply reason in the future, the cascade close is suppressed
    // unless the reason is one we recognise as a verified actual reply or
    // decomposition path. The primary fix lives in the orchestrator bridge
    // (`fromOrcReply` flag); this gate is the second line of defense.
    if (!VERIFIED_REPLY_REASONS.has(reason)) {
      this.logger.debug('Request cascade close skipped — reason not in verified-reply set', {
        requestId,
        reason,
      });
      return;
    }

    const request = await this.requestService.getById(requestId);
    if (!request) return;
    if (TERMINAL_REQUEST_STATUSES.has(request.status)) return;

    const otherActiveCount = await this.countOtherActiveWorkItems(requestId);
    if (otherActiveCount > 0) {
      this.logger.debug('Request kept open — other non-terminal WIs still in flight', {
        requestId,
        otherActiveCount,
        reason,
      });
      return;
    }

    const path = closeRequestPath(request.status);
    if (path.length === 0) {
      // Should be impossible given the TERMINAL guard above, but be defensive.
      return;
    }

    try {
      for (const next of path) {
        await this.requestService.update(requestId, {
          status: next,
          ...(next === 'done' ? { result: `Auto-closed by SLA: ${reason}` } : {}),
        });
      }
      this.logger.info('Request auto-closed by SLA cascade', {
        requestId,
        from: request.status,
        path,
        reason,
      });
    } catch (err) {
      this.logger.warn('Request auto-close threw', {
        requestId,
        from: request.status,
        path,
        error: formatError(err),
      });
    }
  }

  /**
   * Count WorkItems linked to the given Request that are NOT the SLA tracker
   * AND are still non-terminal. Returns 0 when only the SLA tracker existed.
   *
   * @param requestId - The Request id to scan.
   * @returns Count of other in-flight WorkItems.
   */
  private async countOtherActiveWorkItems(requestId: string): Promise<number> {
    const slaWiId = respondToUserWorkItemId(requestId);
    const all = await this.taskPool.getAllItems();
    let count = 0;
    for (const wi of all) {
      if (wi.requestId !== requestId) continue;
      if (wi.id === slaWiId) continue;
      if (TERMINAL_WI_STATUSES.has(wi.status)) continue;
      count += 1;
    }
    return count;
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

    const wiId = respondToUserWorkItemId(request.id);

    // Detect source kind from sourceConversationItemId shape. Slack ids
    // start with `slack-`; chat-v2 ids start with `chatv2-` (INBOUND-2).
    const threadTs = extractSlackThreadTs(request.sourceConversationItemId);
    const channelId = extractSlackChannelId(request.sourceConversationItemId);
    const chatV2ChannelId = extractChatV2ChannelId(request.sourceConversationItemId);
    const chatV2MessageId = extractChatV2MessageId(request.sourceConversationItemId);
    const source: InboundSourceKind = threadTs
      ? 'slack'
      : chatV2ChannelId
        ? 'chat-v2'
        : 'unknown';

    const wi = this.buildRespondWorkItem(request, wiId, {
      source,
      threadTs,
      channelId,
      chatV2ChannelId,
      chatV2MessageId,
    });

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
      source,
      threadTs,
      channelId,
      chatV2ChannelId,
      chatV2MessageId,
      breachTimer,
      escalationTimer,
      request,
    });
    if (threadTs) this.threadIndex.set(threadTs, request.id);
    if (chatV2ChannelId) this.chatV2Index.set(chatV2ChannelId, request.id);

    this.logger.info('SLA respond_to_user WorkItem queued', {
      workItemId: wiId,
      requestId: request.id,
      source,
      threadTs,
      chatV2ChannelId,
      slaMs: this.slaMs,
    });
  };

  /**
   * `workitem:queued` handler (INBOUND-1.f1, auto-close path b).
   *
   * Treats decomposition of a Request into other WorkItems as "the orc has
   * done the right thing" and resolves the tracked respond_to_user WI for
   * that Request.
   *
   * Self-recursion guard: the respond_to_user WI itself fires
   * `workitem:queued` from {@link handleRequestCreated}'s `addToPool` call.
   * Without a guard this handler would call markResolved against its own
   * enqueue and prematurely close the SLA chain. The id-shape check
   * (`incomingId === respondToUserWorkItemId(requestId)`) is more reliable
   * than reading `wi.metadata.slaSource` — the metadata can in principle
   * be mutated, the id cannot.
   *
   * No-ops:
   *   - event missing `requestId` (orphan WI, can't correlate)
   *   - event missing `workItemId` (malformed publisher)
   *   - the respond_to_user WI's own enqueue (id-shape match)
   *   - no tracked respond_to_user WI for the requestId (already resolved
   *     or never tracked because the source Request wasn't inbound-tagged)
   *
   * @param event - The `workitem:queued` event from TaskPoolService.addToPool
   */
  private handleWorkItemQueued = async (event: AgentEvent): Promise<void> => {
    const requestId = event.requestId;
    const incomingWorkItemId = event.workItemId;
    if (!requestId) {
      // Per the f1 spec: undefined requestId = no auto-close. Most enqueues
      // fall here (queue mutations not derived from a Request).
      this.logger.debug('workitem:queued event missing requestId — auto-close no-op', {
        eventId: event.id,
        workItemId: incomingWorkItemId,
      });
      return;
    }
    if (!incomingWorkItemId) {
      this.logger.warn('workitem:queued event missing workItemId — malformed', {
        eventId: event.id,
        requestId,
      });
      return;
    }

    // Self-recursion guard. The respond_to_user WI's own enqueue must NOT
    // trigger its own resolution.
    if (incomingWorkItemId === respondToUserWorkItemId(requestId)) {
      this.logger.debug('workitem:queued is the respond_to_user WI itself — skip', {
        workItemId: incomingWorkItemId,
        requestId,
      });
      return;
    }

    // Only act when we're actively tracking this Request — otherwise the
    // queue mutation is for a Request we never SLA-tracked (no inbound tag,
    // already resolved, etc.).
    if (!this.trackedByRequest.has(requestId)) {
      this.logger.debug('workitem:queued for untracked Request — skip', {
        workItemId: incomingWorkItemId,
        requestId,
      });
      return;
    }

    await this.markResolved(requestId, 'workitem_decompose');
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

    // INBOUND-2: chat-v2 source has no DM-back analog yet. Log the
    // escalation, clean up tracking, and close the orphan WI. A follow-up
    // ticket can wire a chat-v2 nudge (e.g. agent-side reply via
    // reply-channel).
    if (stillTracked.source === 'chat-v2') {
      this.logger.warn('SLA escalation reached 10min on chat-v2 — no chat-v2 nudge hook wired', {
        requestId,
        chatV2ChannelId: stillTracked.chatV2ChannelId,
      });
      this.cleanupTracked(requestId);
      await this.failOrphanRespondWi(wiId, requestId);
      return;
    }

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
      // Same state-machine constraint as markResolved: `queued → failed`
      // is illegal per WORK_ITEM_TRANSITIONS. Route queued WIs to
      // `cancelled`; running WIs go to `failed` as before.
      const target = pickFailTarget(wi.status);
      await this.taskPool.transitionStatus(workItemId, target, 'system', (item) => {
        item.metadata = {
          ...(item.metadata ?? {}),
          slaResolvedReason: 'escalation_timeout',
          slaResolvedAt: new Date().toISOString(),
        };
      });
      this.logger.info('SLA escalation orphan WI auto-closed', {
        workItemId,
        requestId,
        fromStatus: wi.status,
        toStatus: target,
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
    if (tracked.chatV2ChannelId) this.chatV2Index.delete(tracked.chatV2ChannelId);
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
   *
   * INBOUND-2: metadata embeds slack-* OR chatV2-* fields based on the
   * source surface so downstream consumers (status panes, escalation
   * hooks) can branch without re-parsing `sourceConversationItemId`.
   */
  private buildRespondWorkItem(
    request: Request,
    wiId: string,
    sourceContext: {
      source: InboundSourceKind;
      threadTs: string | null;
      channelId: string | null;
      chatV2ChannelId: string | null;
      chatV2MessageId: string | null;
    },
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
        inboundSource: sourceContext.source,
        slackThreadTs: sourceContext.threadTs,
        slackChannelId: sourceContext.channelId,
        chatV2ChannelId: sourceContext.chatV2ChannelId,
        chatV2MessageId: sourceContext.chatV2MessageId,
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
        } else if (eventType === 'workitem:queued') {
          await this.handleWorkItemQueued(event);
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
