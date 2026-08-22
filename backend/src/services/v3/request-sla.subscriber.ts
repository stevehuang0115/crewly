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
  SLA_TERMINAL_WORK_ITEM_STATUSES,
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
 * Defensive retry delay for {@link RequestSlaSubscriber.markResolvedByThread}
 * and {@link RequestSlaSubscriber.markResolvedByChatV2} on index miss.
 *
 * The Slack bridge fires `slackResolve('')` from the queue processor right
 * after delivering a message — within ~10ms of `request:created`. The
 * `handleRequestCreated` reordering covers the common case (timer/index
 * setup is now synchronous, before the `taskPool.addToPool` await), but
 * the leading `await requestService.getById(...)` still leaves a ~1ms
 * window. This single delayed retry absorbs that residual race without
 * adding latency to the happy path.
 *
 * 250ms is comfortably above any reasonable in-memory lookup + microtask
 * scheduling latency, well below the 5min SLA window. Verified for the
 * 2026-05-03 ESTestNode auto-nudge variant 2 incident.
 */
export const MARK_RESOLVED_RETRY_MS = 250;

/**
 * Retry parameters for {@link RequestSlaSubscriber.findWorkItemWithRetry}.
 * Cover the case where {@link RequestSlaSubscriber.markResolved} is called
 * before {@link RequestSlaSubscriber.handleRequestCreated} has completed
 * its `taskPool.addToPool(wi)` await — i.e. the WI's tracking entry exists
 * in memory but the pool persistence is still in flight.
 *
 * 5 attempts × 50ms = 250ms worst-case wait, matching MARK_RESOLVED_RETRY_MS
 * so both race windows close on the same upper bound.
 */
export const FIND_WI_MAX_ATTEMPTS = 5;
export const FIND_WI_RETRY_INTERVAL_MS = 50;

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
 * any of these by the time the timer fires. Aliases
 * {@link SLA_TERMINAL_WORK_ITEM_STATUSES} (work-item.types.ts) per Arch's
 * N2 hoist on PR #357 — single source of truth for the broader 5-element
 * "exited active queue" set, replacing the previously duplicated local
 * constant. The local alias is retained so the existing call sites in
 * this file stay terse and the diff stays minimal.
 */
const TERMINAL_WI_STATUSES: ReadonlySet<WorkItemStatus> =
  SLA_TERMINAL_WORK_ITEM_STATUSES;

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
  // Pipeline-#4 fix (spec 2026-05-05-request-decompose-pipeline-gap.md, Patch E):
  // second-pass close-attempt after the orc_reply grace window has elapsed.
  // The first attempt that defers via setTimeout always re-enters with this
  // reason, so it must be in the verified set to pass the
  // {@link RequestSlaSubscriber.maybeCloseRequest} defense gate.
  'orc_reply_recheck',
  // 2026-05-21 closie incident: orc replied directly AFTER decomposition
  // already cleared the SLA indexes. The fallback path in
  // {@link RequestSlaSubscriber.resolveOrphanedRequestByThread} /
  // {@link RequestSlaSubscriber.resolveOrphanedRequestByChatV2}
  // re-enters {@link RequestSlaSubscriber.maybeCloseRequest} with these
  // tags; both must pass the verified-reply gate.
  'orc_reply_after_decompose',
  'chatv2_reply_after_decompose',
]);

/**
 * Pipeline-#4 fix (Patch E) — grace window for the orc_reply cascade-close.
 *
 * When the orc replies to a Slack thread within {@link ORC_REPLY_GRACE_AGE_MS}
 * of Request creation AND the Request has zero linked WorkItems, defer the
 * cascade close by {@link ORC_REPLY_GRACE_MS} for one re-check. If the orc
 * decomposed the Request during the window, the sibling-count gate inside
 * {@link RequestSlaSubscriber.maybeCloseRequest} catches the new WIs on the
 * second pass and the close is suppressed for normal lifecycle.
 *
 * Older Requests (creation-age ≥ grace) skip the deferral and close
 * immediately to preserve legacy behaviour.
 */
const ORC_REPLY_GRACE_AGE_MS = 60_000; // 60s after Request creation
const ORC_REPLY_GRACE_MS = 30_000;     // 30s second-pass deferral

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
  // 2026-05-13 dogfood fix: thread-reply Requests use the encoding
  // `slack-{channelId}-{threadRoot}-msg-{messageTs}` so the SLA index
  // keys on the thread root (which is what orc replies to). Strip the
  // optional `-msg-{ts}` suffix before extracting the trailing ts.
  // Top-level message ids (`slack-{channelId}-{ts}`) are unchanged.
  const stripped = sourceId.replace(/-msg-\d+\.\d+$/, '');
  // slack-${channelId}-${ts}; channelId may not contain dashes, but ts is
  // dotted-decimal. We split on '-' and take the last segment as ts.
  const lastDash = stripped.lastIndexOf('-');
  if (lastDash < 0 || lastDash === stripped.length - 1) return null;
  const ts = stripped.slice(lastDash + 1);
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
  // Strip the optional `-msg-{ts}` suffix (thread-reply encoding) so the
  // channelId is sliced from the threadRoot form, not from the messageTs.
  const stripped = sourceId.replace(/-msg-\d+\.\d+$/, '');
  const rest = stripped.slice('slack-'.length);
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
   * Number of inbound user Requests still awaiting an orchestrator response —
   * i.e. live `respond_to_user` SLA trackers that have neither been answered
   * nor breached-and-cleared. Powers the `/health` orchestrator-liveness signal
   * (issue #686): `agents.active === 0` while this is `> 0` means inbound user
   * messages are queued with no one to answer them (the silent 假死 symptom).
   *
   * @returns Count of pending tracked `respond_to_user` work items.
   */
  getPendingUserRequestCount(): number {
    return this.trackedByRequest.size;
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
   * Defensive retry (Steve 2026-05-03 auto-nudge variant 2): the bridge
   * may call this *before* {@link handleRequestCreated} has populated
   * `threadIndex` (e.g. QueueProcessor fires `slackResolve('')` right
   * after delivery, ~10ms before the SLA subscriber finishes its async
   * `request:created` handler). On index-miss we schedule a single
   * delayed retry to absorb that race without holding up the caller.
   * The reordering inside {@link handleRequestCreated} is the primary
   * fix; this retry is belt-and-suspenders to absorb any residual
   * `await requestService.getById` skew.
   *
   * @param threadTs - The Slack message timestamp the orc replied to
   */
  async markResolvedByThread(threadTs: string): Promise<void> {
    if (!threadTs) return;
    const requestId = this.threadIndex.get(threadTs);
    if (requestId) {
      await this.markResolved(requestId, 'orc_reply');
      return;
    }
    // Index miss — schedule a single retry after the
    // `request:created` handler has had time to populate the index.
    // 250ms covers in-memory getById + microtask scheduling + a margin.
    const retry = setTimeout(async () => {
      const retryRequestId = this.threadIndex.get(threadTs);
      if (retryRequestId) {
        void this.markResolved(retryRequestId, 'orc_reply');
        return;
      }
      // Retry still missed. The most common reason isn't a race — it's
      // that the Request was already decomposed (workitem_decompose),
      // which clears `threadIndex` even though the Request is still
      // open with non-terminal child WIs. Orc just replied directly
      // anyway (e.g. the question turned out to be a one-shot answer),
      // so those child WIs are now orphaned and would otherwise sit
      // queued/blocked forever.
      //
      // 2026-05-21 closie incident: Request 2adc23a3 decomposed into
      // Plan/Execute/Review, orc replied at 04:01 directly, but the 3
      // children stayed queued/blocked for 8+ hours until manual
      // cleanup. The status-check skill kept reporting "0/3 done".
      try {
        await this.resolveOrphanedRequestByThread(threadTs);
      } catch (err) {
        this.logger.warn('Orphaned-Request fallback failed (non-fatal)', {
          threadTs,
          error: formatError(err),
        });
      }
    }, MARK_RESOLVED_RETRY_MS);
    retry.unref?.();
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
    if (requestId) {
      await this.markResolved(requestId, 'chatv2_reply');
      return;
    }
    // Mirror the markResolvedByThread retry. Same race shape applies on
    // chat-v2: an agent reply may land before the `request:created`
    // handler has populated `chatV2Index`.
    const retry = setTimeout(async () => {
      const retryRequestId = this.chatV2Index.get(channelId);
      if (retryRequestId) {
        void this.markResolved(retryRequestId, 'chatv2_reply');
        return;
      }
      // Retry still missed — same orphan-after-decompose path as the
      // Slack case in {@link markResolvedByThread}. Look up the Request
      // by source convo id directly and clean up.
      try {
        await this.resolveOrphanedRequestByChatV2(channelId);
      } catch (err) {
        this.logger.warn('Orphaned-Request fallback failed (non-fatal)', {
          channelId,
          error: formatError(err),
        });
      }
    }, MARK_RESOLVED_RETRY_MS);
    retry.unref?.();
  }

  /**
   * Orphan-cleanup path for the Slack case in {@link markResolvedByThread}.
   *
   * The threadIndex / chatV2Index are populated when an SLA tracker is
   * registered for the Request and cleared whenever {@link markResolved}
   * runs — including the `workitem_decompose` resolve. After decomposition,
   * the Request stays open with non-terminal child WIs while the SLA
   * indexes are empty. If the orc then replies directly in the original
   * thread, neither the primary `threadIndex` lookup nor the 250ms retry
   * will find anything, and the orphan child WIs sit queued/blocked
   * indefinitely (closie incident, 2026-05-21).
   *
   * This fallback authoritatively scans `RequestService.listAll()` for an
   * open Request whose `sourceConversationItemId` references `threadTs`,
   * then force-removes any non-terminal child WIs from the pool and
   * cascades the close. We bypass the index because the index is the
   * very thing that's stale.
   *
   * @param threadTs - The Slack message timestamp the orc replied to
   */
  private async resolveOrphanedRequestByThread(threadTs: string): Promise<void> {
    const all = await this.requestService.listAll();
    const match = all.find(
      (r) =>
        !TERMINAL_REQUEST_STATUSES.has(r.status) &&
        extractSlackThreadTs(r.sourceConversationItemId) === threadTs,
    );
    if (!match) {
      this.logger.debug('No open Request matches threadTs — nothing to clean up', { threadTs });
      return;
    }
    await this.cancelOrphansAndCloseRequest(match.id, 'orc_reply_after_decompose');
  }

  /**
   * Orphan-cleanup path for the chat-v2 case in
   * {@link markResolvedByChatV2}. Mirrors {@link resolveOrphanedRequestByThread}
   * but matches on `chatV2-` source id shape.
   *
   * @param channelId - The chat-v2 channel id where the agent replied
   */
  private async resolveOrphanedRequestByChatV2(channelId: string): Promise<void> {
    const all = await this.requestService.listAll();
    const match = all.find(
      (r) =>
        !TERMINAL_REQUEST_STATUSES.has(r.status) &&
        extractChatV2ChannelId(r.sourceConversationItemId) === channelId,
    );
    if (!match) {
      this.logger.debug('No open Request matches channelId — nothing to clean up', { channelId });
      return;
    }
    await this.cancelOrphansAndCloseRequest(match.id, 'chatv2_reply_after_decompose');
  }

  /**
   * Cancel all non-terminal WorkItems belonging to a Request, then cascade
   * the Request to `done`. Shared tail of
   * {@link resolveOrphanedRequestByThread} and
   * {@link resolveOrphanedRequestByChatV2}.
   *
   * Each WI is transitioned individually so a single failure (illegal
   * transition, stale claim) does not block the others — the cascade
   * close at the end only fires if at least one WI flipped to terminal
   * (otherwise `countOtherActiveWorkItems` will keep the Request open
   * via {@link maybeCloseRequest}'s sibling-count gate).
   *
   * @param requestId - The Request to clean up
   * @param reason    - Diagnostic tag recorded on each cancelled WI's
   *   metadata and on the Request's `result` field
   */
  private async cancelOrphansAndCloseRequest(requestId: string, reason: string): Promise<void> {
    const all = await this.taskPool.getAllItems();
    let cancelled = 0;
    for (const wi of all) {
      if (wi.requestId !== requestId) continue;
      if (TERMINAL_WI_STATUSES.has(wi.status)) continue;
      try {
        await this.taskPool.transitionStatus(
          wi.id,
          'cancelled',
          'system',
          (item) => {
            item.metadata = {
              ...(item.metadata ?? {}),
              slaResolvedReason: reason,
              slaResolvedAt: new Date().toISOString(),
            };
          },
          `SLA auto-resolved: ${reason}`,
        );
        cancelled += 1;
      } catch (err) {
        // Most likely cause: a transition we can't satisfy in the state
        // machine (e.g. a status we didn't anticipate). Log + skip — the
        // cascade close's sibling-count gate will keep the Request open
        // if any WIs remain non-terminal, which is the safer outcome.
        this.logger.warn('Could not cancel orphan WI; leaving in current state', {
          workItemId: wi.id,
          status: wi.status,
          error: formatError(err),
        });
      }
    }
    this.logger.info('Orphaned-Request cleanup: cancelled non-terminal child WIs', {
      requestId,
      reason,
      cancelled,
    });
    await this.maybeCloseRequest(requestId, reason);
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
      // The bridge can call markResolved within ~10ms of `request:created`,
      // which means `taskPool.addToPool(wi)` inside `handleRequestCreated`
      // may not have completed yet. Brief retry on null lookup absorbs
      // that window without blocking the happy path.
      const wi = await this.findWorkItemWithRetry(tracked.workItemId);
      if (wi && !TERMINAL_WI_STATUSES.has(wi.status)) {
        const target = pickResolveTarget(wi.status);
        // Surface the SLA reason as cancelReason when the target is
        // 'cancelled' so the activity timeline shows WHY (instead of
        // an opaque "WorkItem was cancelled.").
        await this.taskPool.transitionStatus(
          tracked.workItemId,
          target,
          'system',
          (item) => {
            item.metadata = {
              ...(item.metadata ?? {}),
              slaResolvedReason: reason,
              slaResolvedAt: new Date().toISOString(),
            };
          },
          target === 'cancelled' ? `SLA auto-resolved: ${reason}` : undefined,
        );
        this.logger.info('SLA WorkItem auto-resolved', {
          workItemId: tracked.workItemId,
          requestId,
          reason,
          fromStatus: wi.status,
          toStatus: target,
        });
      } else if (!wi) {
        this.logger.warn('SLA auto-resolve: WorkItem never appeared in pool after retry — addToPool likely failed silently', {
          workItemId: tracked.workItemId,
          requestId,
          reason,
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
   * Find a WorkItem in the task pool, retrying briefly on null. Covers the
   * race where {@link markResolved} is called before
   * {@link handleRequestCreated} has finished `taskPool.addToPool(wi)`
   * (Steve 2026-05-03 auto-nudge variant 2).
   *
   * Up to {@link FIND_WI_MAX_ATTEMPTS} attempts spaced by
   * {@link FIND_WI_RETRY_INTERVAL_MS}. Total worst-case wait stays well
   * below the 5min SLA window. Resolves with `null` if the WI never
   * appears (e.g. addToPool persistently failed); the caller logs and
   * moves on.
   *
   * @param workItemId - The deterministic respond_to_user WI id
   * @returns The WorkItem if found, or null after all retries exhausted
   */
  private async findWorkItemWithRetry(workItemId: string): Promise<WorkItem | null> {
    for (let attempt = 0; attempt < FIND_WI_MAX_ATTEMPTS; attempt += 1) {
      const wi = await this.taskPool.findWorkItem(workItemId);
      if (wi) return wi;
      if (attempt === FIND_WI_MAX_ATTEMPTS - 1) break;
      await new Promise<void>((res) => {
        const t = setTimeout(res, FIND_WI_RETRY_INTERVAL_MS);
        t.unref?.();
      });
    }
    return null;
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

    // Pipeline-#4 fix (spec 2026-05-05-request-decompose-pipeline-gap.md, Patch E):
    // grace window for the orc_reply cascade. If the orc has replied within
    // {@link ORC_REPLY_GRACE_AGE_MS} of Request creation AND no WorkItems are
    // linked yet, defer the close by {@link ORC_REPLY_GRACE_MS} for one
    // re-check pass. This gives a parallel decomposition (e.g. via
    // break-down-request) time to land its WIs and trip the sibling-count
    // gate below. Older Requests skip the grace and close immediately so
    // legacy paths are unchanged.
    //
    // The recheck re-enters with reason='orc_reply_recheck' (in
    // VERIFIED_REPLY_REASONS), so the second pass succeeds the gate and either
    // closes (no siblings appeared) or is suppressed by the sibling-count
    // gate (siblings appeared during the window).
    if (reason === 'orc_reply') {
      const ageMs = Date.now() - new Date(request.createdAt).getTime();
      // `linkedSiblings` reflects FIRST-pass state; the recheck re-enters via
      // setTimeout below and re-fetches `request` at the top of this method,
      // so the second pass sees fresh `workItemIds` if decomposition landed
      // during the grace window. Do not move the `linkedSiblings` calculation
      // outside this block — its semantics are decision-local to the first
      // pass.
      const linkedSiblings = (request.workItemIds ?? []).length;
      if (ageMs < ORC_REPLY_GRACE_AGE_MS && linkedSiblings === 0) {
        this.logger.debug('Request close deferred — orc_reply grace window active', {
          requestId,
          ageMs,
          graceMs: ORC_REPLY_GRACE_MS,
        });
        const t = setTimeout(() => {
          void this.maybeCloseRequest(requestId, 'orc_reply_recheck').catch((err) => {
            this.logger.warn('orc_reply_recheck cascade threw', {
              requestId,
              error: formatError(err),
            });
          });
        }, ORC_REPLY_GRACE_MS);
        // unref(): the recheck timer must not keep the process alive on
        // graceful shutdown. Trade-off: pending rechecks at shutdown silently
        // skip — acceptable for a long-running PM2 process where the
        // observable window is bounded by SLA timers anyway. Tests use
        // jest.advanceTimersByTime to assert the recheck path explicitly.
        t.unref?.();
        return;
      }
    }

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

    // CRITICAL ORDERING (Steve 2026-05-03 auto-nudge variant 2):
    // Populate `trackedByRequest` + `threadIndex`/`chatV2Index` BEFORE the
    // `await taskPool.addToPool(wi)` below. The Slack bridge fires
    // `slackResolve('')` from `queue-processor.service.ts:690` immediately
    // when QueueProcessor delivers the message — within ~10ms of
    // `request:created` being published. If we await `addToPool` first,
    // the bridge's early `markResolvedByThread(threadTs)` lookup misses
    // the index, the SLA never closes, and the user sees the 5min/10min
    // `escalation_dm` "auto-nudge" cascade even though the orc replied
    // promptly.
    //
    // The timer + tracking setup is fully synchronous; only `addToPool`
    // yields the event loop, and now it does so AFTER the indices are
    // visible to a concurrent `markResolvedByThread`. If `addToPool`
    // fails downstream, the catch block below rolls back the in-memory
    // tracking so we don't leak timers.
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

    const wi = this.buildRespondWorkItem(request, wiId, {
      source,
      threadTs,
      channelId,
      chatV2ChannelId,
      chatV2MessageId,
    });

    // addToPool short-circuits on duplicate id (V1 dedup). On failure we
    // roll back the in-memory tracking populated above to keep the two
    // states consistent.
    try {
      await this.taskPool.addToPool(wi);
    } catch (err) {
      clearTimeout(breachTimer);
      clearTimeout(escalationTimer);
      this.trackedByRequest.delete(request.id);
      if (threadTs) this.threadIndex.delete(threadTs);
      if (chatV2ChannelId) this.chatV2Index.delete(chatV2ChannelId);
      this.logger.warn('addToPool failed — rolled back SLA tracking', {
        requestId: request.id,
        wiId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

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

    // Pipeline-#4 fix (spec 2026-05-05-request-decompose-pipeline-gap.md, Patch A):
    // bidirectional link pool-entry → Request.workItemIds[]. Idempotent —
    // linkWorkItem already short-circuits on duplicate (request.service.ts).
    //
    // Runs BEFORE the trackedByRequest gate so it serves BOTH SLA-tracked
    // (Slack/chat-v2) AND directly-POSTed Requests. The only other site that
    // calls linkWorkItem is V3DataService.onTaskDelegated, which subscribes
    // to v3:task_delegated — an event /api/task-pool/add does not emit. So
    // WorkItems created via the orc's normal materialisation path
    // (break-down-request, delegate-task) were never linked. Wiring it here
    // is the architecturally-correct producer side.
    //
    // Failure-isolated: a link failure must NOT block markResolved (the SLA
    // correctness path — Steve 2026-04-30 incident). Logged at warn.
    try {
      await this.requestService.linkWorkItem(requestId, incomingWorkItemId);
    } catch (err) {
      this.logger.warn('linkWorkItem from workitem:queued failed (non-fatal)', {
        requestId,
        workItemId: incomingWorkItemId,
        error: formatError(err),
      });
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
      // Capture BEFORE the transition: `transitionStatus` mutates the stored
      // record in place, so reading `wi.status` afterwards yields the status we
      // just wrote, not the one we came from. The audit reason and the log
      // below both need the origin.
      const fromStatus = wi.status;
      const target = pickFailTarget(fromStatus);

      await this.taskPool.transitionStatus(
        workItemId,
        target,
        'system',
        (item) => {
          item.metadata = {
            ...(item.metadata ?? {}),
            slaResolvedReason: 'escalation_timeout',
            slaResolvedAt: new Date().toISOString(),
          };
        },
        target === 'cancelled' ? 'SLA escalation timeout' : undefined,
      );
      // The item is terminal now, so its claim must not stay active.
      //
      // This path cannot delegate to `failItem` — the code that normally
      // releases the claim — because `failItem` always transitions to
      // `failed`, whereas `pickFailTarget` yields `cancelled`, `failed` OR
      // `rejected` depending on the origin status. `disposeFailedWorkItem`
      // does not cover it either: that owns disposition and touches no
      // claims. So the release is made explicitly here.
      //
      // Ordering is deliberate on both sides:
      //  - AFTER the transition, so the claim is released only once the item
      //    actually reached a terminal state. Releasing first would, on a
      //    failed transition, free the claim on an item that is still
      //    `running` and still being worked — a worse outcome than the leak.
      //  - BEFORE disposition, because the funnel may requeue the item; a
      //    requeued item carrying an active claim cannot be claimed by
      //    anyone, which is the very stranding this fix exists to prevent.
      await this.taskPool.releaseClaim(
        workItemId,
        `sla escalation timeout (from ${fromStatus})`,
      );

      this.logger.info('SLA escalation orphan WI auto-closed', {
        workItemId,
        requestId,
        fromStatus,
        toStatus: target,
      });

      // `cancelled` is strictly terminal and needs nothing further. `failed`
      // and `rejected` do: their only outbound edge is `→ queued`, so without
      // a disposition the item stops here permanently. This path writes them
      // via `transitionStatus` directly rather than `failItem`/`verifyItem`,
      // so neither the `task:failed` retry/escalate branch in
      // `V3DataService.onTaskFailed` nor the `task:rejected` bridge successor
      // ever fires for it — it was the reproducible stranding path. Route it
      // through the funnel so the item is retried, succeeded, or deliberately
      // closed with an audit record.
      if (target === 'failed' || target === 'rejected') {
        await this.taskPool.disposeFailedWorkItem(workItemId, {
          reason: `SLA escalation timeout (from ${fromStatus})`,
        });
      }
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
