/**
 * OrcDeliveryEnforcerService
 *
 * **Why this exists** (2026-05-23 incident, the "affiliate research" case):
 *
 * Steve asked the team to research affiliate programs at 12:59 PM. ORC
 * acknowledged at 1:00 PM with "Atlas + Sage/Kai 派出去了, ETA 30-40min".
 * Sage finished Phase 1 at 1:15, Kai finished Phase 2 at 1:28 — but
 * Steve never saw the result. ORC's terminal logs claimed the pipeline
 * was "closed" and the result "already routed to Steve at Slack thread
 * ...", but there were zero `/api/slack/send` calls all day. ORC's
 * internal mental model believed delivery happened; the actual skill
 * call didn't.
 *
 * Root cause: ORC's prompt has a HARD pre-yield gate ("any `[CHAT:slack-…]`
 * MUST have a `reply-slack` before yielding"). But for a long-running
 * delegation, the user-visible deliverable comes from the *agent* via
 * `[DONE]`-style status reports — long AFTER ORC's initial ack. ORC
 * reads the agent's `[DONE]` as internal team chatter, narrates "pipeline
 * closed", and yields without delivering to Steve. The prompt rule
 * doesn't catch this case because the prompt looks for `[CHAT:slack-…]`
 * (user-originating) not `[DONE]` (agent-originating).
 *
 * **What this service does:**
 *
 *   1. When a worker agent posts `[DONE]` / `[COMPLETED]` to a
 *      slack-prefixed conversation (chat.controller's "Agent status
 *      routed to orchestrator" path), call {@link markPendingDelivery}.
 *      The service records a pending delivery with `dueBy = now + 3 min`.
 *
 *   2. When ORC successfully posts via `/api/slack/send` to the same
 *      thread, call {@link markDelivered}. Pending delivery cleared.
 *
 *   3. A timer scans every 30 s. For any pending delivery whose `dueBy`
 *      has passed AND ORC hasn't replied, enqueue a `[DELIVER_REQUIRED]`
 *      system message to ORC via MessageQueueService. ORC's prompt
 *      treats `[DELIVER_REQUIRED]` exactly like `[CHAT:slack-…]` for
 *      the pre-yield gate.
 *
 *   4. Exponential backoff between reminders for the same thread, to
 *      avoid spamming ORC if it's genuinely stuck or rate-limited.
 *      First reminder at 3 min, then 10 min, then 30 min, then stop.
 *
 * Fire-and-forget on all writes — a fault in the enforcer MUST NOT
 * block chat or slack flow.
 *
 * @module services/orc/orc-delivery-enforcer.service
 */

import { LoggerService, ComponentLogger } from '../core/logger.service.js';

/** Reminder cadence (ms): first reminder at 3 min, then 10 min, then 30 min, then stop. */
const REMINDER_CADENCE_MS = [
  3 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
] as const;

const DEFAULT_TICK_INTERVAL_MS = 30 * 1000;

/** Markers in agent output that indicate user-facing delivery is ready. */
const DELIVERY_MARKERS = ['[DONE]', '[COMPLETED]', '[DELIVERED]'];

/**
 * Identifier for a slack thread — channelId + threadTs (or empty if
 * not a slack conversation, in which case we skip tracking entirely).
 */
export interface SlackThreadKey {
  channelId: string;
  threadTs: string;
}

export interface PendingDelivery {
  key: SlackThreadKey;
  /** The full conversation id, e.g. `slack-D0AC…-1779…`. Stored for the reminder text. */
  conversationId: string;
  /** Session name of the agent that posted [DONE]. */
  agentSender: string;
  /** First ~200 chars of the agent's [DONE] message — surfaces in the reminder. */
  deliverableSummary: string;
  /** When the agent posted (ms). */
  doneAt: number;
  /** Number of reminders fired so far (drives REMINDER_CADENCE_MS index). */
  remindersFired: number;
  /** Next eligible reminder time (ms). */
  nextDueAt: number;
}

/**
 * Function the enforcer uses to send a `[DELIVER_REQUIRED]` message to
 * ORC. Injected at construction time so tests can stub it and so the
 * service has no hard dep on MessageQueueService.
 */
export type DeliveryReminderSink = (params: {
  conversationId: string;
  text: string;
}) => void;

export interface OrcDeliveryEnforcerOptions {
  /** Wired from index.ts to enqueue the reminder via MessageQueueService. */
  reminderSink: DeliveryReminderSink;
  /** Scan interval. Default 30 s. */
  tickIntervalMs?: number;
}

/**
 * Singleton scope — there's one ORC, one queue of pending deliveries.
 */
export class OrcDeliveryEnforcerService {
  private static instance: OrcDeliveryEnforcerService | null = null;
  private readonly logger: ComponentLogger;
  private readonly reminderSink: DeliveryReminderSink;
  private readonly tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  /** key = `${channelId}::${threadTs}` */
  private readonly pending = new Map<string, PendingDelivery>();

  constructor(opts: OrcDeliveryEnforcerOptions) {
    this.logger = LoggerService.getInstance().createComponentLogger('OrcDeliveryEnforcer');
    this.reminderSink = opts.reminderSink;
    this.tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  static getInstance(): OrcDeliveryEnforcerService | null {
    return this.instance;
  }

  static setInstance(next: OrcDeliveryEnforcerService | null): void {
    if (this.instance && this.instance !== next) this.instance.stop();
    this.instance = next;
  }

  /** Start the periodic scan. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
    this.logger.info('OrcDeliveryEnforcer started', {
      tickIntervalMs: this.tickIntervalMs,
      cadenceMinutes: REMINDER_CADENCE_MS.map((n) => Math.round(n / 60000)),
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('OrcDeliveryEnforcer stopped');
    }
  }

  /**
   * Call this from `chat.controller` when an agent posts a `[DONE]`-style
   * status to a slack-prefixed conversation. Safe to call multiple times
   * for the same thread — the most recent agent message wins (we
   * surface only the latest deliverable summary in the reminder).
   */
  markPendingDelivery(input: {
    conversationId: string;
    agentSender: string;
    text: string;
  }): void {
    if (!isAgentDeliveryMarker(input.text)) return;
    const key = parseSlackConversationId(input.conversationId);
    if (!key) return; // not a slack thread — ignore

    const k = serializeKey(key);
    const now = Date.now();
    const summary = input.text.slice(0, 200);
    this.pending.set(k, {
      key,
      conversationId: input.conversationId,
      agentSender: input.agentSender,
      deliverableSummary: summary,
      doneAt: now,
      remindersFired: 0,
      nextDueAt: now + REMINDER_CADENCE_MS[0],
    });
    this.logger.info('OrcDeliveryEnforcer pending delivery recorded', {
      conversationId: input.conversationId,
      agentSender: input.agentSender,
      summaryPreview: summary.slice(0, 80),
      firstReminderInSec: REMINDER_CADENCE_MS[0] / 1000,
    });
  }

  /**
   * Call this from `slack.controller` after a successful `/api/slack/send`.
   * Cleared regardless of which agent originated the underlying deliverable.
   */
  markDelivered(input: { channelId: string; threadTs?: string | null }): void {
    if (!input.channelId || !input.threadTs) return;
    const k = serializeKey({ channelId: input.channelId, threadTs: input.threadTs });
    const had = this.pending.delete(k);
    if (had) {
      this.logger.info('OrcDeliveryEnforcer delivery cleared by reply-slack', {
        channelId: input.channelId,
        threadTs: input.threadTs,
      });
    }
  }

  /** Test affordance — peek at the in-memory ledger. */
  _peekPending(): PendingDelivery[] {
    return [...this.pending.values()];
  }

  /**
   * Public for tests + the manual-trigger endpoint. Otherwise driven by
   * the internal timer.
   */
  tick(now: number = Date.now()): { firedFor: string[] } {
    const firedFor: string[] = [];
    for (const [k, item] of this.pending) {
      if (now < item.nextDueAt) continue;
      if (item.remindersFired >= REMINDER_CADENCE_MS.length) {
        // Out of reminder budget — drop the entry so we stop spamming.
        this.pending.delete(k);
        this.logger.warn('OrcDeliveryEnforcer reminder budget exhausted — giving up', {
          conversationId: item.conversationId,
          remindersFired: item.remindersFired,
        });
        continue;
      }

      const text = this.formatReminder(item);
      try {
        this.reminderSink({
          conversationId: item.conversationId,
          text,
        });
        firedFor.push(item.conversationId);
        this.logger.info('OrcDeliveryEnforcer reminder fired', {
          conversationId: item.conversationId,
          agentSender: item.agentSender,
          reminderIndex: item.remindersFired,
          minutesSinceDone: Math.round((now - item.doneAt) / 60000),
        });
      } catch (err) {
        this.logger.warn('OrcDeliveryEnforcer reminderSink threw (swallowed)', {
          error: (err as Error).message,
          conversationId: item.conversationId,
        });
      }
      item.remindersFired += 1;
      const nextOffset = REMINDER_CADENCE_MS[item.remindersFired];
      if (nextOffset === undefined) {
        // Final reminder fired — drop the entry now so we don't keep
        // re-evaluating it on every tick.
        this.pending.delete(k);
      } else {
        item.nextDueAt = now + nextOffset;
      }
    }
    return { firedFor };
  }

  private formatReminder(item: PendingDelivery): string {
    const minutes = Math.round((Date.now() - item.doneAt) / 60000);
    return [
      `[DELIVER_REQUIRED] Steve is waiting on a deliverable in Slack thread ${item.conversationId}.`,
      ``,
      `Agent \`${item.agentSender}\` posted [DONE] ${minutes} min ago with this content (preview):`,
      `> ${item.deliverableSummary.slice(0, 200)}${item.deliverableSummary.length > 200 ? '…' : ''}`,
      ``,
      `Action required: call reply-slack now with the deliverable. Treat this`,
      `the same as a [CHAT:slack-...] message — do NOT yield the turn until`,
      `the reply lands on the thread. If the agent's output isn't the final`,
      `deliverable yet (e.g. it's "Phase 1 done" out of 2), send Steve a status`,
      `update via reply-slack saying so + revised ETA, then continue waiting.`,
    ].join('\n');
  }
}

// =============================================================================
// Helpers (exported for testing)
// =============================================================================

export function isAgentDeliveryMarker(text: string): boolean {
  if (!text) return false;
  const upper = text.toUpperCase();
  return DELIVERY_MARKERS.some((m) => upper.includes(m));
}

/**
 * Parse a chat-v2 conversation id of the form `slack-<channelId>-<ts>`
 * into { channelId, threadTs }. Returns null for non-slack ids. Mirrors
 * the regex in `request-sla.subscriber` so the enforcer agrees with the
 * SLA layer on what "the same thread" means.
 */
export function parseSlackConversationId(
  conversationId: string,
): SlackThreadKey | null {
  if (!conversationId || !conversationId.startsWith('slack-')) return null;
  // Strip any per-message suffix (`-msg-<ts>`) so we key on thread root.
  const stripped = conversationId.replace(/-msg-\d+\.\d+$/, '');
  const rest = stripped.slice('slack-'.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash < 1) return null;
  const channelId = rest.slice(0, lastDash);
  let threadTs = rest.slice(lastDash + 1);
  // Some producers serialize ts as `1779555555-588569` (dash) or
  // `1779555555.588569` (dot). Normalize to dotted form to match
  // Slack-API ts shape.
  if (/^\d+$/.test(threadTs)) {
    // No fractional segment in URL form — try one more split.
    const beforeRest = rest.slice(0, lastDash);
    const prevDash = beforeRest.lastIndexOf('-');
    if (prevDash > 0) {
      const candidate = `${beforeRest.slice(prevDash + 1)}.${threadTs}`;
      if (/^\d+\.\d+$/.test(candidate)) {
        return { channelId: beforeRest.slice(0, prevDash), threadTs: candidate };
      }
    }
  }
  // If threadTs already contains a dot (dotted form), keep as-is.
  return { channelId, threadTs };
}

function serializeKey(k: SlackThreadKey): string {
  return `${k.channelId}::${k.threadTs}`;
}
