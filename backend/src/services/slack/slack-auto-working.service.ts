/**
 * Harness-posted "working on it" placeholders.
 *
 * An owner's Slack message that reaches agents who were only *told* (an
 * un-@'d channel message broadcast to the room) got no placeholder unless
 * the agent itself chose to call `reply-channel --working`. Owen worked
 * 3.5 minutes on such a message in #pro-ce without calling it, and the
 * owner, seeing nothing, thought Crewly was down (2026-09-30).
 *
 * This watches each owner delivery for a short window. The first recipient
 * seen starting a turn — idle → busy — gets the placeholder, posted exactly
 * as `/api/slack/working` posts it (same key, same bot identity), so the
 * existing answer-replaces-placeholder and settle-on-idle rules apply
 * unchanged. It stands down when the thread already has a placeholder or an
 * answer, and never guesses about an agent that was busy before the message
 * arrived (its busy state says nothing about this message).
 *
 * @module services/slack/slack-auto-working.service
 */

import { SLACK_TYPING_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { SlackTypingPlaceholderService, TypingIdentity, TypingKeyParts } from './slack-typing-placeholder.service.js';
import type { DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';

/** The slice of the placeholder service this one uses. */
export type AutoWorkingTypingApi = Pick<SlackTypingPlaceholderService, 'begin' | 'owes'>;

/** Constructor dependencies. */
export interface SlackAutoWorkingDeps {
  typing: AutoWorkingTypingApi;
  /** Whether the agent is mid-turn right now (latest observed workingStatus). */
  isAgentBusy: (agentSession: string) => boolean;
  /** Override for {@link SLACK_TYPING_CONSTANTS.AUTO_WORKING_WINDOW_MS} (tests). */
  windowMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

/** One owner message about to be delivered over Slack. */
export interface AutoWorkingDelivery {
  /** Slack channel or DM the message is in (and the reply goes to). */
  slackChannelId: string;
  /** Thread the reply goes in — the same one `/api/slack/working` resolves. */
  threadTs?: string;
  /** The owner's message (gets the ✅ if the agent settles without replying). */
  sourceTs: string;
  /** Agents the message may be delivered to. */
  candidates: readonly string[];
  /** Who posts for an agent; null when that agent cannot post here. */
  identityFor: (agentSession: string) => TypingIdentity | null;
}

/** Handle on one watched delivery. */
export interface AutoWorkingWatch {
  /**
   * Delivery finished: these agents hold the message. Busy transitions seen
   * while delivery was running count, and the window starts now.
   */
  delivered(agentSessions: readonly string[]): void;
  /** Stop watching (delivery failed, or the message needs no placeholder). */
  cancel(): void;
}

interface Watch {
  id: number;
  delivery: AutoWorkingDelivery;
  /** Busy when the message arrived — never trigger. */
  busyAtDelivery: Set<string>;
  /** Null while delivery is running; then who holds the message. */
  deliveredTo: Set<string> | null;
  /** Busy transitions seen while delivery was running, in order. */
  busyWhileDelivering: string[];
  /** Epoch ms after which a busy transition no longer counts (set once delivered). */
  deadline: number | null;
  /** When watching started (a delivery that never reports back is dropped). */
  openedAt: number;
}

/**
 * Posts a "working on it" placeholder for the first recipient of an owner's
 * Slack message that starts working on it.
 */
export class SlackAutoWorkingService {
  private readonly logger: ComponentLogger;
  private readonly watches = new Map<number, Watch>();
  private nextId = 1;

  /**
   * @param deps - Placeholder service, busy probe, optional window/clock overrides
   */
  constructor(private readonly deps: SlackAutoWorkingDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackAutoWorking');
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Start watching an owner's message. Call before delivering it, so a turn
   * that starts while other recipients are still being delivered to counts.
   *
   * @param delivery - Where the message is, who may get it, and who posts for whom
   * @returns Handle to report the delivery outcome on
   */
  watch(delivery: AutoWorkingDelivery): AutoWorkingWatch {
    const id = this.nextId++;
    const busyAtDelivery = new Set(delivery.candidates.filter((s) => this.deps.isAgentBusy(s)));
    this.watches.set(id, { id, delivery, busyAtDelivery, deliveredTo: null, busyWhileDelivering: [], deadline: null, openedAt: this.now() });
    if (this.watches.size > SLACK_TYPING_CONSTANTS.AUTO_WORKING_MAX_WATCHES) {
      const oldest = this.watches.keys().next().value;
      if (oldest !== undefined) this.watches.delete(oldest);
    }
    return {
      delivered: (sessions) => this.delivered(id, sessions),
      cancel: () => {
        this.watches.delete(id);
      },
    };
  }

  private delivered(id: number, sessions: readonly string[]): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    watch.deliveredTo = new Set(sessions.filter((s) => !watch.busyAtDelivery.has(s)));
    watch.deadline = this.now() + (this.deps.windowMs ?? SLACK_TYPING_CONSTANTS.AUTO_WORKING_WINDOW_MS);
    if (watch.deliveredTo.size === 0) {
      this.watches.delete(id);
      return;
    }
    const first = watch.busyWhileDelivering.find((s) => watch.deliveredTo!.has(s));
    if (first) this.trigger(watch, first);
  }

  /**
   * An agent was just seen starting a turn (idle → busy).
   *
   * @param agentSession - The agent
   */
  noteBusy(agentSession: string): void {
    const now = this.now();
    for (const watch of [...this.watches.values()]) {
      const stale =
        watch.deadline !== null
          ? now > watch.deadline
          : now - watch.openedAt > SLACK_TYPING_CONSTANTS.AUTO_WORKING_DELIVERY_MAX_MS;
      if (stale) {
        this.watches.delete(watch.id);
        continue;
      }
      if (watch.busyAtDelivery.has(agentSession)) continue;
      if (watch.deliveredTo === null) {
        if (watch.delivery.candidates.includes(agentSession) && !watch.busyWhileDelivering.includes(agentSession)) {
          watch.busyWhileDelivering.push(agentSession);
        }
        continue;
      }
      if (watch.deliveredTo.has(agentSession)) this.trigger(watch, agentSession);
    }
  }

  /**
   * A thread got a placeholder or an answer: the watches on it are done.
   *
   * @param slackChannelId - Slack channel or DM
   * @param threadTs - Thread (undefined = top level)
   */
  noteThreadActivity(slackChannelId: string, threadTs?: string): void {
    for (const watch of [...this.watches.values()]) {
      if (watch.delivery.slackChannelId === slackChannelId && (watch.delivery.threadTs ?? '') === (threadTs ?? '')) {
        this.watches.delete(watch.id);
      }
    }
  }

  /** Watches still open (tests / diagnostics). */
  get watchCount(): number {
    return this.watches.size;
  }

  private keyFor(watch: Watch, agentSession: string): TypingKeyParts {
    const { slackChannelId, threadTs } = watch.delivery;
    return { agentSession, slackChannelId, ...(threadTs ? { threadTs } : {}) };
  }

  /**
   * Post the placeholder for `agentSession` unless one is already showing
   * for any recipient. The watch ends either way: one placeholder per message.
   */
  private trigger(watch: Watch, agentSession: string): void {
    this.watches.delete(watch.id);
    const recipients = new Set([...watch.delivery.candidates, agentSession]);
    if ([...recipients].some((s) => this.deps.typing.owes(this.keyFor(watch, s)))) return;
    const identity = watch.delivery.identityFor(agentSession);
    if (!identity) return;
    const key = this.keyFor(watch, agentSession);
    this.logger.info('Agent started on an owner message — posting its working placeholder', {
      agentSession,
      slackChannelId: key.slackChannelId,
      threaded: Boolean(key.threadTs),
    });
    void this.deps.typing.begin(key, identity, 'typing', watch.delivery.sourceTs).catch((err: unknown) => {
      this.logger.warn('Harness working placeholder not posted', {
        agentSession,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * The agents a dispatch actually handed the message to.
 *
 * @param dispatch - Dispatcher outcome (null when nothing was dispatched)
 * @param dmSession - The DM's agent, for the 1:1 strategy (its result names no session)
 * @returns Sessions that hold the message
 */
export function deliveredSessions(dispatch: DispatchMessageResult | null, dmSession?: string): string[] {
  if (!dispatch?.dispatched) return [];
  if (dispatch.strategy === 'dm') return dmSession ? [dmSession] : [];
  if (dispatch.strategy === 'huddle-broadcast') {
    return (dispatch.huddleOutcomes ?? []).filter((o) => o.dispatched).map((o) => o.sessionName);
  }
  if (dispatch.strategy === 'channel-mentions') {
    return (dispatch.mentionOutcomes ?? []).filter((o) => o.dispatched).map((o) => o.target.sessionName);
  }
  return [];
}

/**
 * Whether a Slack message was written by the owner — not by an agent (on
 * any machine) and, when the owner is known, by the owner's user id. Same
 * rule as ticket intake's `isOwner`.
 *
 * @param message - Author fields of the inbound message
 * @param ownerUserId - The workspace owner's Slack user id, when known
 * @returns True for an owner-authored message
 */
export function isOwnerAuthored(
  message: { userId?: string; authorAgentSession?: string },
  ownerUserId: string | null | undefined,
): boolean {
  if (message.authorAgentSession) return false;
  if (!message.userId) return false;
  return !ownerUserId || message.userId === ownerUserId;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SlackAutoWorkingService | null = null;

/** @returns The wired service, or null before Slack started. */
export function getSlackAutoWorkingService(): SlackAutoWorkingService | null {
  return instance;
}

/** @param service - The service to expose (null to clear, for tests) */
export function setSlackAutoWorkingService(service: SlackAutoWorkingService | null): void {
  instance = service;
}
