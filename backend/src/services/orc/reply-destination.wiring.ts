/**
 * Effects of the reply destination resolver
 * (specs/2026-10-02-harness-owned-routing.md): the real collaborators, and
 * delivering a message where the resolver says — or saying exactly why it
 * could not be delivered.
 *
 * @module services/orc/reply-destination.wiring
 */

import { createHash } from 'node:crypto';
import { SubAgentMessageQueue } from '../messaging/sub-agent-message-queue.service.js';
import { ORCHESTRATOR_SESSION_NAME, REPLY_ROUTING_CONSTANTS, TURN_TRIGGER_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { parseSlackThreadKey } from '../slack/slack-thread-key.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { AgentPromptReferenceService } from './agent-prompt-reference.service.js';
import {
  fixCommand,
  latestInputOf,
  resolveReplyDestination,
  type ReplyDestination,
  type ReplyHints,
  type ReplyReference,
  type ReplyResolution,
  type ReplyResolverDeps,
} from './reply-destination-resolver.js';
import { noticeRefusedDecisionReply, type RefusedReplyNoticeDeps } from './refused-decision-reply-notice.js';
import { defaultWorkDestinationDeps, deliverToWorkDestination, type WorkDestinationDeps } from './work-item-destination.wiring.js';
import { originOfWorkItem } from './work-item-destination.js';
import { comparePostPlace, placeOfOwnerRoute, routeOfTrigger, type MessageRoute, type PostPlace, type RouteCheckOutcome } from './message-route.js';
import { isSlackDm } from './orc-reply-route.service.js';
import { traceOutboundReply } from '../trace/trace-recorder.js';
import { stripTraceMarkers } from '../trace/trace-markers.js';
import { getTraceContext } from '../trace/trace-context.service.js';
import { getTurnTriggerTracker, type TurnTrigger } from '../trace/turn-trigger.js';
import { triggeredByMetadata, triggeredByPhrase, withTriggeredByLine } from './triggered-by.js';
import { stripOwnerTextIds } from '../../utils/owner-text-ids.utils.js';
import { memberNameFromSession } from '../../utils/member-session-name.utils.js';

/** How long an identical reply from one agent counts as a duplicate send. */
const REPLY_DUPLICATE_WINDOW_MS = 120_000;
/** Deliveries that landed recently, by agent + text hash. */
const recentDeliveries = new Map<string, { at: number; delivery: ReplyDelivery }>();

/** Forget recent deliveries (tests). */
export function resetReplyDeliveryGuardForTesting(): void {
  recentDeliveries.clear();
}

const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ReplyDestination');

/** Delivery into a chat-v2 conversation (chat.controller `deliverAgentReplyToConversation`). */
export type ConversationDeliver = (input: {
  conversationId: string;
  thread?: string;
  agentSession: string;
  content: string;
  interim?: boolean;
  metadata?: Record<string, unknown>;
}) => Promise<string | null>;

/** Collaborators of {@link deliverReply}. */
export interface ReplyDeliveryDeps {
  resolver: ReplyResolverDeps;
  deliverToConversation: ConversationDeliver;
  workDestination: () => Promise<WorkDestinationDeps>;
  /**
   * The reply gate: the answer a different agent already gave to the
   * owner's latest message in this room thread, when it did
   * (specs/2026-10-03-one-responder-per-message.md §2). Omitted: no gate.
   */
  priorRoomAnswer?: (input: { conversationId: string; thread?: string; agentSession: string }) => Promise<{ by: string; excerpt: string } | null>;
  /**
   * The decision whose card lives in a Slack thread (CREW-438): decision
   * cards leave no chat thread-root row, so an answer to one is addressed
   * with `reply --decision D-n`. Omitted: no card lookup.
   */
  decisionOfCardThread?: (slackChannelId: string, threadTs: string) => Promise<string | null>;
  /**
   * What started the agent's current turn (turn-trigger.ts), for the
   * "Triggered by" line and the provenance stored on the row. Omitted: none.
   */
  turnTrigger?: (session: string) => TurnTrigger | null;
  /** The owner wrote to the agent in this conversation recently (its post there is an answer). Omitted: no. */
  ownerAskedRecently?: (session: string, conversationId: string) => boolean;
  /**
   * The owner wrote to the agent in this conversation earlier in its working
   * window: a post there answers that, not the agent's newest owner message
   * elsewhere (R8: Pia's #flopost answer said "Triggered by your message in
   * #awesome-videos"). Omitted: no.
   */
  ownerAskedEarlier?: (session: string, conversationId: string) => boolean;
  /**
   * The owner wrote in this thread recently (to anyone): a post there is part
   * of the owner's conversation and gets no "Triggered by" line (message
   * audit 2026-10-20). Omitted: no.
   */
  ownerWroteInThread?: (conversationId: string, thread: string) => boolean;
  /**
   * The latest trigger that names what the agent answers (turn-trigger.ts
   * `routedTrigger`), for the route check. Omitted: no check.
   */
  routedTrigger?: (session: string) => TurnTrigger | null;
  /** The session's current run trace id. Omitted: none. */
  currentTrace?: (session: string) => string | null;
  /** A conversation as the owner knows it (`#content-team`, `the DM with Ella`). Omitted: unnamed. */
  conversationPlace?: (conversationId: string) => string | null;
  /**
   * Send an agent's answer to another agent's message back to that agent
   * (crewly#1375), as a message carrying the replier's sender header. True
   * when taken. Omitted: the work-destination messenger is used as is.
   */
  answerAgent?: (fromSession: string, toSession: string, text: string) => Promise<boolean>;
  /**
   * Who is told when a reply to an owner-answered decision is refused and no
   * fallback took it (CREW-372). Omitted: nobody (the agent still gets the error).
   */
  refusedReplyNotice?: RefusedReplyNoticeDeps;
}

/** What a delivery did. */
export type ReplyDelivery =
  | {
      ok: true;
      destination: Exclude<ReplyDestination, { kind: 'unresolved' }>;
      messageId?: string;
      conversationId?: string;
      slackChannelId?: string;
      threadTs?: string;
      messageTs?: string;
      /** The agent an internal message went to (work with an agent origin, crewly#1357) */
      agentSession?: string;
    }
  | { ok: false; error: string; destination: ReplyDestination; held?: boolean };

/** Input of {@link deliverReply}. */
export interface DeliverReplyInput {
  session: string;
  content: string;
  reference?: ReplyReference;
  hints?: ReplyHints;
  interim?: boolean;
  noOwnerDm?: boolean;
  /** Post even when a colleague already answered the owner here (`--adds-new`) */
  addsNew?: boolean;
}

/**
 * Resolve and deliver an agent's message. Never guesses: a destination that
 * does not take the message is reported as an error with the command to run.
 *
 * When the chosen place refuses the message, only the SAME place is tried
 * by another way (each logged): the Slack thread a delegate was handed, or
 * the Slack thread a chat thread with no row stands for. It is never moved
 * to another place — not a new top-level post, not the owner DM, not the
 * agent's last owner conversation (message-routing audit 2026-10-18, R2):
 * the agent gets the error and the command that works.
 *
 * @param input - Agent, text, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns Where it landed, or an English error
 */
export async function deliverReply(input: DeliverReplyInput, deps?: ReplyDeliveryDeps): Promise<ReplyDelivery> {
  // Trace ids are harness plumbing: never shown to the owner.
  const clean = { ...input, content: stripTraceMarkers(input.content) };
  // Double-send guard (#1109): the same text from the same agent within a
  // short window is the retry of a message that already landed.
  const dupKey = clean.interim === true ? undefined : `${clean.session}\u0000${createHash('sha1').update(JSON.stringify([clean.content.trim(), clean.reference ?? null, clean.hints ?? null, clean.addsNew === true])).digest('hex')}`;
  if (dupKey) {
    const prior = recentDeliveries.get(dupKey);
    if (prior && Date.now() - prior.at < REPLY_DUPLICATE_WINDOW_MS) {
      logger.warn('Identical reply sent again within the guard window — not posting it twice', { session: clean.session });
      return prior.delivery;
    }
  }
  const result = await deliverReplyUntraced(clean, deps);
  if (dupKey && result.ok) {
    if (recentDeliveries.size > 200) {
      const cutoff = Date.now() - REPLY_DUPLICATE_WINDOW_MS;
      for (const [k, v] of recentDeliveries) if (v.at < cutoff) recentDeliveries.delete(k);
    }
    recentDeliveries.set(dupKey, { at: Date.now(), delivery: result });
  }
  traceOutboundReply(clean, result);
  if (result.ok) await checkLandedRoute(clean, result, deps).catch(() => undefined);
  return result;
}

/** Route check outcomes since boot (the regression check of the routing invariant). */
const routeCheckStats: Record<RouteCheckOutcome, number> = { match: 0, mismatch: 0, unknown: 0 };

/**
 * Counts of the route check since boot.
 *
 * @returns match / mismatch / unknown counts
 */
export function getRouteCheckStats(): Readonly<Record<RouteCheckOutcome, number>> {
  return { ...routeCheckStats };
}

/** Zero the route check counts (tests). */
export function resetRouteCheckStatsForTesting(): void {
  routeCheckStats.match = 0;
  routeCheckStats.mismatch = 0;
  routeCheckStats.unknown = 0;
}

/**
 * Compare where a delivered post landed with the place of the request it
 * answers (the route of the agent's latest routed input), and log a
 * mismatch. A post the agent addressed by an explicit reference answers that
 * reference and is not checked; an internal message to an agent has no
 * Slack place. Never throws, never blocks: it is a regression signal.
 *
 * @param input - The delivered input
 * @param delivery - Where it landed
 * @param deps - Collaborators (default: the real ones)
 * @returns The outcome, or null when not checked
 */
export async function checkLandedRoute(input: DeliverReplyInput, delivery: Extract<ReplyDelivery, { ok: true }>, deps?: ReplyDeliveryDeps): Promise<RouteCheckOutcome | null> {
  const dest = delivery.destination;
  if (REFERENCE_SOURCES.has(dest.source) || dest.source === 'prompt' || delivery.agentSession) return null;
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const trigger = d.routedTrigger?.(input.session) ?? null;
  const route = routeOfTrigger(trigger, d.resolver.turnOrigin(input.session));
  if (!route) return null;
  const expected = await expectedPlaceOf(route, d);
  const landed: PostPlace = {
    ...(delivery.conversationId ? { conversationId: delivery.conversationId } : {}),
    ...(dest.kind === 'conversation' && dest.thread ? { thread: dest.thread } : {}),
    ...(delivery.slackChannelId ? { slackChannelId: delivery.slackChannelId } : {}),
    ...(delivery.threadTs ? { threadTs: delivery.threadTs } : {}),
  };
  const outcome = expected === 'internal' ? 'mismatch' : comparePostPlace(expected, landed);
  routeCheckStats[outcome] += 1;
  if (outcome === 'mismatch') {
    logger.warn('[RouteCheck] Post landed outside the thread of the request it answers', {
      session: input.session,
      route,
      expected: expected === 'internal' ? 'internal (agent-to-agent)' : expected,
      landed,
      source: dest.source,
      mismatches: routeCheckStats.mismatch,
    });
  }
  return outcome;
}

/**
 * The place a route's answer belongs in: an owner route's thread, a work
 * item's owner origin, or `internal` for work an agent delegated (its answer
 * goes to that agent, never to Slack).
 *
 * @param route - The route
 * @param d - Collaborators
 * @returns The place, `internal`, or null when unknown
 */
async function expectedPlaceOf(route: MessageRoute, d: ReplyDeliveryDeps): Promise<PostPlace | 'internal' | null> {
  if (route.kind === 'owner') return placeOfOwnerRoute(route);
  const wi = await d.resolver.workItem(route.workItemId).catch(() => null);
  const origin = wi ? originOfWorkItem(wi) : null;
  if (!origin) return null;
  if (origin.kind === 'agent') return 'internal';
  if (origin.kind !== 'owner') return null;
  return {
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    ...(origin.chatThreadId ? { thread: origin.chatThreadId } : {}),
    ...(origin.slackChannelId ? { slackChannelId: origin.slackChannelId } : {}),
    ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
  };
}

/**
 * {@link deliverReply} without the run-trace record.
 *
 * @param input - Agent, text, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns Where it landed, or an English error
 */
async function deliverReplyUntraced(input: DeliverReplyInput, deps?: ReplyDeliveryDeps): Promise<ReplyDelivery> {
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const resolve = async (hints: ReplyHints | undefined) => {
    const resolution = await resolveReplyDestination(
      { session: input.session, ...(input.reference ? { reference: input.reference } : {}), ...(hints ? { hints } : {}), ...(input.noOwnerDm ? { noOwnerDm: true } : {}) },
      d.resolver,
    );
    logResolution(input.session, resolution);
    return resolution.destination;
  };
  const prompt = d.resolver.promptReference(input.session)?.reference;
  let dest = await resolve(input.hints);
  if (dest.kind === 'unresolved') {
    return { ok: false, destination: dest, error: notDelivered(dest.reason, dest.fix) };
  }
  let result = await attempt(input, dest, prompt, d);
  if (result.ok || ('held' in result && result.held)) return result;

  // Work handed over from the owner's DM with another agent (a lead's
  // delegation): this agent's bot cannot post there, so the answer goes to
  // its own DM with the owner, opened with the work's topic (crewly#1083).
  // Work delegated into a Slack thread the agent is not a member of: answer
  // in that thread itself, never in a new DM (#1109).
  const delegated = await postToDelegatedThread(input, dest, d);
  if (delegated) return delegated;

  // Work handed over from another agent's DM with the owner: this agent
  // cannot post there, and its answer is not moved to its own DM — it goes
  // to the agent the owner asked (message-routing audit 2026-10-18, R2).
  if (!result.ok && dest.kind === 'conversation' && (await isOthersOwnerDm(input.session, dest.conversationId, d))) {
    const delegator = await delegatorOfWork(input, d);
    return {
      ...result,
      error: notDelivered(
        `conversation ${dest.conversationId} is another agent's DM with the owner, where you cannot post`,
        delegator ? `send-message --to ${delegator} "<your answer>"  (${delegator} answers the owner there)` : 'send your answer to the agent who handed you this work (send-message --to <agent>)',
      ),
    };
  }

  const hintedThread = dest.source === 'hint' && dest.kind === 'conversation' ? dest.thread : undefined;
  if (dest.source === 'hint') {
    // CREW-438: a Slack thread of a mapped channel the agent is in, with no
    // chat thread-root row behind it (a decision card's): post to it directly.
    if (dest.kind === 'conversation') {
      const direct = await postToHintedSlackThread(input, dest, d);
      if (direct) return direct;
    }
    // An explicit hint that does not take the message is an error the agent
    // sees; it is never resolved to a guessed place (#1136).
    logger.warn('The conversation the agent named did not take its message', { session: input.session, error: result.error });
    return withCardFix(result, hintedThread, d);
  }

  // An answered reference (decision / ticket / work item / message / route)
  // must not die in a thread the conversation could not post into: post
  // straight to that same Slack thread. Never a new top-level post instead.
  if (dest.kind === 'conversation' && (REFERENCE_SOURCES.has(dest.source) || dest.source === 'route' || dest.source === 'current-work' || dest.source === 'turn-origin')) {
    for (const fallback of await referenceFallbacks(input.session, dest, d)) {
      logger.warn('Referenced conversation did not take the reply — trying the next real place', {
        session: input.session,
        source: dest.source,
        from: dest.conversationId,
        to: fallback.kind === 'work' ? fallback.destination.kind : 'conversation',
      });
      const retry = await attempt(input, fallback, prompt, d);
      if (retry.ok) return retry;
    }
  }
  const fixed = await withCardFix(result, hintedThread, d);
  if (dest.source === 'decision' && !fixed.ok) await noticeRefusal(input, dest, fixed.error, d);
  return fixed;
}

/**
 * Every way of delivering a reply to an owner-answered decision has failed:
 * tell the agent's lead (CREW-372). Best-effort; never changes the result.
 *
 * @param input - The reply
 * @param dest - The decision destination that refused
 * @param error - The error the agent is shown
 * @param d - Collaborators
 */
async function noticeRefusal(input: DeliverReplyInput, dest: Exclude<ReplyDestination, { kind: 'unresolved' }>, error: string, d: ReplyDeliveryDeps): Promise<void> {
  if (!d.refusedReplyNotice) return;
  const decisionId = input.reference?.decisionId ?? /\bD-\d+\b/.exec(dest.reason)?.[0];
  if (!decisionId) return;
  const firstLine = error.split('\n')[0].trim();
  const outcome = await noticeRefusedDecisionReply({ decisionId, agentSession: input.session, failedStep: firstLine || dest.reason }, d.refusedReplyNotice);
  if (outcome.sent) logger.warn('Reply to an answered decision was refused — told the lead', { session: input.session, decisionId, to: outcome.to, target: outcome.target });
  else logger.warn('Reply to an answered decision was refused — no notice sent', { session: input.session, decisionId, reason: outcome.reason });
}

/**
 * Post into the Slack thread a lead delegated work into, for an agent that is
 * not a member of that thread's conversation (#1109).
 *
 * @param input - Agent, text
 * @param dest - The conversation destination that refused
 * @param d - Collaborators
 * @returns The delivery, or null when the thread was not delegated to this agent / the post failed
 */
async function postToDelegatedThread(
  input: DeliverReplyInput,
  dest: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  d: ReplyDeliveryDeps,
): Promise<ReplyDelivery | null> {
  if (dest.kind !== 'conversation' || !d.resolver.delegatedThread) return null;
  const key = parseSlackThreadKey(dest.thread);
  if (!key || isSlackDm(key.slackChannelId)) return null;
  if (!(await d.resolver.delegatedThread(input.session, key.slackChannelId, key.threadTs).catch(() => false))) return null;
  try {
    const wd = await d.workDestination();
    const posted = await deliverToWorkDestination(
      input.session,
      { kind: 'slack', target: key.slackChannelId, threadTs: key.threadTs, reason: 'the Slack thread this work was delegated into' },
      input.content,
      wd,
    );
    if (!posted) return null;
    logger.info('Delegated member answered in the delegated Slack thread', { session: input.session, slackChannelId: key.slackChannelId, threadTs: key.threadTs });
    return { ok: true, destination: dest, slackChannelId: posted.slackChannelId, messageTs: posted.messageTs, threadTs: key.threadTs };
  } catch (err) {
    logger.warn('Post into the delegated Slack thread failed', { session: input.session, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Post straight to the Slack thread an agent named with `--conversation` +
 * `--thread` when the chat conversation did not take it (CREW-438).
 *
 * Only when the thread key is of the Slack channel that conversation is
 * mapped to and the agent is a member there, so a key cannot send a message
 * to a channel the agent was never in.
 *
 * @param input - Agent, text
 * @param dest - The hinted conversation destination that refused
 * @param d - Collaborators
 * @returns The delivery, or null when the conditions do not hold / the post failed
 */
async function postToHintedSlackThread(
  input: DeliverReplyInput,
  dest: Extract<ReplyDestination, { kind: 'conversation' }>,
  d: ReplyDeliveryDeps,
): Promise<ReplyDelivery | null> {
  const key = parseSlackThreadKey(dest.thread);
  if (!key) return null;
  if (d.resolver.slackChannelOfConversation(dest.conversationId) !== key.slackChannelId) return null;
  if (!(await d.resolver.ownsConversation(input.session, dest.conversationId).catch(() => false))) return null;
  try {
    const wd = await d.workDestination();
    const posted = await deliverToWorkDestination(
      input.session,
      { kind: 'slack', target: key.slackChannelId, threadTs: key.threadTs, reason: 'the Slack thread you named (no chat row behind it — e.g. a decision card)' },
      input.content,
      wd,
    );
    if (!posted) return null;
    logger.warn('Hinted conversation did not take the reply — posted straight to the Slack thread it named', {
      session: input.session,
      conversationId: dest.conversationId,
      slackChannelId: key.slackChannelId,
      threadTs: key.threadTs,
    });
    return {
      ok: true,
      destination: dest,
      slackChannelId: posted.slackChannelId,
      messageTs: posted.messageTs,
      threadTs: posted.threadTs ?? key.threadTs,
    };
  } catch (err) {
    logger.warn('Direct post to the named Slack thread failed', { session: input.session, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * When a refused reply was aimed at a decision card's thread, make the error
 * name `reply --decision D-n` (CREW-438).
 *
 * @param result - The failed delivery
 * @param thread - The thread the agent named (Slack thread key), if any
 * @param d - Collaborators
 * @returns The result, with the error rewritten when the thread is a card's
 */
async function withCardFix(result: ReplyDelivery, thread: string | undefined, d: ReplyDeliveryDeps): Promise<ReplyDelivery> {
  if (result.ok || !d.decisionOfCardThread) return result;
  const key = parseSlackThreadKey(thread);
  if (!key) return result;
  const id = await d.decisionOfCardThread(key.slackChannelId, key.threadTs).catch(() => null);
  if (!id) return result;
  return { ...result, error: notDelivered(`that thread is the card of decision ${id}, not a chat thread`, `reply --decision ${id} "<your message>"`) };
}

/** Destination sources that answer something the agent was asked about by id. */
const REFERENCE_SOURCES: ReadonlySet<string> = new Set(['decision', 'ticket', 'work-item', 'message']);

/**
 * Where an answered reference goes when its conversation refused the post:
 * the Slack thread it names (a card posted straight to Slack has no chat
 * row). Only that same thread — never a new top-level post.
 *
 * @param session - Agent
 * @param failed - The conversation destination that refused
 * @param d - Collaborators
 * @returns Fallback destinations in order
 */
async function referenceFallbacks(
  session: string,
  failed: Extract<ReplyDestination, { kind: 'conversation' }>,
  d: ReplyDeliveryDeps,
): Promise<Array<Exclude<ReplyDestination, { kind: 'unresolved' }>>> {
  const out: Array<Exclude<ReplyDestination, { kind: 'unresolved' }>> = [];
  const key = parseSlackThreadKey(failed.thread);
  const slackChannel = d.resolver.slackChannelOfConversation(failed.conversationId);
  if (key && slackChannel && key.slackChannelId === slackChannel) {
    out.push({
      kind: 'work',
      destination: { kind: 'slack', target: key.slackChannelId, threadTs: key.threadTs, reason: `thread ${failed.thread} has no chat row — posting into its Slack thread` },
      source: failed.source,
      reason: `conversation ${failed.conversationId} could not post into thread ${failed.thread} — Slack thread post`,
    });
  }
  void session;
  return out;
}

/**
 * What to tell the agent after a refused conversation post: never the command
 * that just failed (CREW-335: the error told Nova to run `reply --decision
 * D-457` right after it had run exactly that).
 *
 * @param dest - The destination that refused
 * @param prompt - The agent's prompt reference
 * @returns A different instruction, or empty when there is none
 */
/**
 * What to do when the place a reply resolved to cannot take it. Resending
 * the same `reply` would resolve to the same place, so the advice names
 * the explicit alternatives (message-routing audit 2026-10-18: refusals
 * must be actionable).
 */
const UNPOSTABLE_ADVICE =
  'reply --conversation <id> --thread <thread> "<message>" to name a place you can post in, or tell whoever gave you this work (send-message --to <session> "<message>")';

function retryAdvice(dest: Exclude<ReplyDestination, { kind: 'unresolved' }>, prompt: ReplyReference | undefined): string {
  const same = REFERENCE_SOURCES.has(dest.source) || dest.source === 'prompt';
  const cmd = fixCommand(prompt);
  return same && cmd !== 'reply "<your message>"' ? '' : cmd;
}

/**
 * Whether a conversation is another agent's DM with the owner (a Slack DM
 * the replying agent is not in).
 *
 * @param session - Replying agent
 * @param conversationId - The conversation that refused
 * @param d - Collaborators
 * @returns True for another agent's owner DM
 */
async function isOthersOwnerDm(session: string, conversationId: string, d: ReplyDeliveryDeps): Promise<boolean> {
  const slack = d.resolver.slackChannelOfConversation(conversationId);
  if (!slack || !isSlackDm(slack)) return false;
  return !(await d.resolver.ownsConversation(session, conversationId).catch(() => true));
}

/**
 * The agent that handed the replier the work it is answering, when known.
 *
 * @param input - Agent, reference
 * @param d - Collaborators
 * @returns The delegator's session, or null
 */
async function delegatorOfWork(input: DeliverReplyInput, d: ReplyDeliveryDeps): Promise<string | null> {
  const id = input.reference?.workItemId ?? d.resolver.latestInput?.(input.session)?.workItemId;
  const wi = id ? await d.resolver.workItem(id).catch(() => null) : null;
  const by = (wi?.metadata as Record<string, unknown> | undefined)?.delegatedBy;
  return typeof by === 'string' && by && by !== input.session ? by : null;
}

/**
 * Why the agent is posting: the provenance record for the row and the text
 * with the "Triggered by" line, when the post is not a direct answer to the
 * owner's message in the same conversation. Interim notes get the record but
 * no line (the final answer carries it). Never throws.
 *
 * @param input - Agent, text, interim flag
 * @param postedConversationId - Conversation the post lands in (undefined: a Slack place outside chat)
 * @param d - Collaborators
 * @param answering - The work item the post names, when it names one
 * @param thread - The thread the post lands in, when it lands in one
 * @returns Metadata and the text to post, or null when no trigger is known
 */
async function provenanceOf(
  input: Pick<DeliverReplyInput, 'session' | 'content' | 'interim'>,
  postedConversationId: string | undefined,
  d: Pick<ReplyDeliveryDeps, 'resolver' | 'turnTrigger' | 'ownerAskedRecently' | 'ownerAskedEarlier' | 'ownerWroteInThread' | 'currentTrace' | 'conversationPlace'>,
  answering?: { workItemId?: string },
  thread?: string,
): Promise<{ metadata: Record<string, unknown>; content?: string } | null> {
  try {
    const trigger = triggerOfAnsweredInput(input.session, d, answering);
    if (!trigger) return null;
    const workItem = trigger.workItemId ? await d.resolver.workItem(trigger.workItemId).catch(() => null) : null;
    // The post answers the owner's message in the conversation it lands in
    // when the owner wrote to the agent there — even when a newer owner
    // message elsewhere is the agent's latest (R8).
    const answersOwnerHere =
      !!postedConversationId &&
      ((d.ownerAskedRecently?.(input.session, postedConversationId) ?? false) ||
        (trigger.triggerKind === 'owner_message' && trigger.conversationId !== postedConversationId && (d.ownerAskedEarlier?.(input.session, postedConversationId) ?? false)) ||
        (!!thread && (d.ownerWroteInThread?.(postedConversationId, thread) ?? false)));
    const phrase = triggeredByPhrase(trigger, {
      ...(postedConversationId ? { postedConversationId } : {}),
      ownerAskedHere: answersOwnerHere,
      workItem,
      ...(d.conversationPlace ? { conversationPlace: d.conversationPlace } : {}),
    });
    const shown = input.interim === true ? null : phrase;
    return {
      metadata: { [TURN_TRIGGER_CONSTANTS.METADATA_KEY]: triggeredByMetadata(trigger, shown, d.currentTrace?.(input.session)) },
      ...(shown ? { content: withTriggeredByLine(input.content, shown) } : {}),
    };
  } catch (err) {
    logger.debug('Reply provenance not added', { session: input.session, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * The trigger of the input a post answers: for a post addressed to a work
 * item, that work item's dispatch (the session's own trigger when it is that
 * dispatch), never whatever was delivered to the agent last (R8).
 *
 * @param session - Agent
 * @param d - Collaborators
 * @param answering - The work item the post names, when it names one
 * @returns The trigger, or null
 */
function triggerOfAnsweredInput(session: string, d: Pick<ReplyDeliveryDeps, 'turnTrigger'>, answering?: { workItemId?: string }): TurnTrigger | null {
  const current = d.turnTrigger?.(session) ?? null;
  const id = answering?.workItemId;
  if (!id || current?.workItemId === id) return current;
  return { triggerKind: 'dispatch', workItemId: id, rootKind: 'dispatch', rootRef: id, viaAgents: [], at: Date.now(), ...(current?.traceId ? { traceId: current.traceId } : {}) };
}

/**
 * Provenance for a post an agent makes straight into a conversation
 * (`reply-channel`, `POST /chat/channels/:id/messages`), outside
 * {@link deliverReply}: the record to store and the text with the
 * "Triggered by" line when one is shown. Never throws.
 *
 * @param input - Agent, conversation, text, interim flag, thread
 * @param deps - Collaborators (default: the real ones)
 * @returns The text to store and the record, if any
 */
export async function provenanceForAgentPost(
  input: { session: string; conversationId: string; content: string; interim?: boolean; thread?: string },
  deps?: Pick<ReplyDeliveryDeps, 'resolver' | 'turnTrigger' | 'ownerAskedRecently' | 'ownerAskedEarlier' | 'ownerWroteInThread' | 'currentTrace' | 'conversationPlace'>,
): Promise<{ content: string; triggeredBy?: Record<string, unknown> }> {
  try {
    const d = deps ?? (await defaultReplyDeliveryDeps());
    const p = await provenanceOf({ session: input.session, content: input.content, interim: input.interim }, input.conversationId, d, undefined, input.thread);
    if (!p) return { content: stripOwnerTextIds(input.content) };
    const record = p.metadata[TURN_TRIGGER_CONSTANTS.METADATA_KEY] as Record<string, unknown> | undefined;
    return { content: stripOwnerTextIds(p.content ?? input.content), ...(record ? { triggeredBy: record } : {}) };
  } catch {
    return { content: stripOwnerTextIds(input.content) };
  }
}

/**
 * Deliver to one resolved destination.
 *
 * @param input - Agent, text
 * @param dest - Destination
 * @param prompt - The agent's prompt reference (for the error's fix command)
 * @param d - Collaborators
 * @returns Delivery result
 */
async function attempt(
  input: DeliverReplyInput,
  dest: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  prompt: ReplyReference | undefined,
  d: ReplyDeliveryDeps,
): Promise<ReplyDelivery> {
  // A follow-up delivered by naming its ticket is the delivery (open items close it).
  const ticket = dest.source === 'ticket' ? input.reference?.ticket : dest.source === 'prompt' ? prompt?.ticket : undefined;
  const deliversTicket = ticket ? { [REPLY_ROUTING_CONSTANTS.DELIVERS_TICKET_METADATA_KEY]: ticket } : undefined;
  const answeredReference = dest.source === 'prompt' || dest.source === 'ticket' || dest.source === 'decision' || dest.source === 'work-item' || dest.source === 'message';
  const answeredWorkItem = dest.source === 'work-item' ? input.reference?.workItemId : dest.source === 'prompt' ? prompt?.workItemId : undefined;
  const provenance = await provenanceOf(
    input,
    dest.kind === 'conversation' ? dest.conversationId : undefined,
    d,
    answeredWorkItem ? { workItemId: answeredWorkItem } : undefined,
    dest.kind === 'conversation' ? dest.thread : undefined,
  );
  const metadata = { ...(deliversTicket ?? {}), ...(provenance?.metadata ?? {}) };
  if (provenance?.content !== undefined) input = { ...input, content: provenance.content };
  input = { ...input, content: stripOwnerTextIds(input.content) };
  if (dest.kind === 'conversation') {
    if (input.interim !== true && input.addsNew !== true && dest.thread && d.priorRoomAnswer) {
      const prior = await d.priorRoomAnswer({ conversationId: dest.conversationId, thread: dest.thread, agentSession: input.session }).catch(() => null);
      if (prior) {
        const { heldReplyMessage } = await import('../slack/room-responder.js');
        logger.info('Agent reply held: a colleague already answered the owner in this room thread', {
          session: input.session,
          conversationId: dest.conversationId,
          answeredBy: prior.by,
        });
        return { ok: false, destination: dest, error: heldReplyMessage(prior), held: true };
      }
    }
    const messageId = await d.deliverToConversation({
      conversationId: dest.conversationId,
      ...(dest.thread ? { thread: dest.thread } : {}),
      agentSession: input.session,
      content: input.content,
      interim: input.interim === true,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
    if (!messageId) {
      const member = await d.resolver.ownsConversation(input.session, dest.conversationId).catch(() => false);
      const why = member
        ? `conversation ${dest.conversationId} (${dest.reason}) could not post it into its Slack thread`
        : `conversation ${dest.conversationId} (${dest.reason}) did not take it — you are not a member there`;
      // A work item's place is fixed by the item: resending the same reply lands there again.
      const advice = dest.source === 'work-item' || dest.source === 'current-work' || dest.source === 'route' ? UNPOSTABLE_ADVICE : retryAdvice(dest, prompt);
      return { ok: false, destination: dest, error: notDelivered(why, advice) };
    }
    if (answeredReference && input.interim !== true) AgentPromptReferenceService.getInstance().clear(input.session);
    return { ok: true, destination: dest, messageId, conversationId: dest.conversationId };
  }
  if (dest.source === 'agent-message' && dest.destination.kind === 'agent' && d.answerAgent) {
    const to = dest.destination.sessionName;
    const taken = await d.answerAgent(input.session, to, input.content).catch(() => false);
    if (!taken) return { ok: false, destination: dest, error: notDelivered(`${dest.reason}: ${to} could not be reached`, `send-message --to ${to} "<your answer>"`) };
    return { ok: true, destination: dest, agentSession: to };
  }
  try {
    const wd = await d.workDestination();
    const posted = await deliverToWorkDestination(input.session, dest.destination, input.content, wd);
    if (!posted) {
      const why = dest.destination.kind === 'agent' ? `${dest.reason}: ${dest.destination.sessionName} could not be reached` : `${dest.reason}: there is no Slack channel to post in`;
      return { ok: false, destination: dest, error: notDelivered(why, UNPOSTABLE_ADVICE) };
    }
    if (answeredReference && input.interim !== true) AgentPromptReferenceService.getInstance().clear(input.session);
    return {
      ok: true,
      destination: dest,
      ...(posted.slackChannelId ? { slackChannelId: posted.slackChannelId } : {}),
      ...(posted.messageTs ? { messageTs: posted.messageTs } : {}),
      ...(posted.threadTs ? { threadTs: posted.threadTs } : {}),
      ...(posted.agentSession ? { agentSession: posted.agentSession } : {}),
    };
  } catch (err) {
    return { ok: false, destination: dest, error: notDelivered(`posting to Slack failed (${err instanceof Error ? err.message : String(err)})`, UNPOSTABLE_ADVICE) };
  }
}

/**
 * Whether a chat thread is agent-to-agent coordination kept inside Crewly
 * (crewly#1340): the message, or the root of its thread, carries
 * `agentCoordinationInternal`. `reply-channel` keeps a post in such a thread
 * internal; a file must not go to the Slack thread key stored on that
 * message either (Pia's v3/v4 videos for Ella landed in Steve's thread,
 * 2026-10-18).
 *
 * @param threadId - A chat message id (anything else is not internal)
 * @param deps - Collaborators (default: the real ones)
 * @returns Why the thread is internal, or null
 */
export async function internalCoordinationThread(threadId: unknown, deps?: ReplyDeliveryDeps): Promise<string | null> {
  if (typeof threadId !== 'string' || !threadId.trim() || parseSlackThreadKey(threadId)) return null;
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const { AGENT_COORDINATION_CONSTANTS } = await import('../../constants.js');
  const reasonOf = (id: string | undefined): string | null => {
    const v = id ? d.resolver.getMessage(id)?.metadata?.[AGENT_COORDINATION_CONSTANTS.INTERNAL_METADATA_KEY] : undefined;
    return typeof v === 'string' && v ? v : null;
  };
  const msg = d.resolver.getMessage(threadId.trim());
  if (!msg) return null;
  return reasonOf(msg.id) ?? reasonOf(msg.threadId);
}

/**
 * The Slack place (channel + thread) the resolver gives, without posting —
 * for files and the `[DONE]` notice. Ticket threads that do not exist yet
 * yield their team channel only.
 *
 * @param input - Agent, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns The place, or null (not a Slack place / unresolved)
 */
export async function resolveSlackPlace(
  input: Omit<DeliverReplyInput, 'content' | 'interim'>,
  deps?: ReplyDeliveryDeps,
): Promise<{ slackChannelId: string; threadTs?: string; topic?: string; conversationId?: string; destination: ReplyDestination } | null> {
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const resolution = await resolveReplyDestination(
    { session: input.session, ...(input.reference ? { reference: input.reference } : {}), ...(input.hints ? { hints: input.hints } : {}), ...(input.noOwnerDm ? { noOwnerDm: true } : {}) },
    d.resolver,
  );
  logResolution(input.session, resolution);
  const dest = resolution.destination;
  if (dest.kind === 'unresolved') return null;
  if (dest.kind === 'conversation') {
    const key = parseSlackThreadKey(dest.thread);
    if (key) return { slackChannelId: key.slackChannelId, threadTs: key.threadTs, conversationId: dest.conversationId, destination: dest };
    const channel = d.resolver.slackChannelOfConversation(dest.conversationId);
    if (!channel) return null;
    if (dest.thread) {
      const root = d.resolver.getMessage(dest.thread);
      const ts = typeof root?.metadata?.slackThreadTs === 'string' ? (root.metadata.slackThreadTs as string) : undefined;
      if (ts) return { slackChannelId: channel, threadTs: ts, conversationId: dest.conversationId, destination: dest };
    }
    return { slackChannelId: channel, conversationId: dest.conversationId, destination: dest };
  }
  const wd = await d.workDestination();
  const w = dest.destination;
  switch (w.kind) {
    case 'slack': {
      const id = w.target.startsWith('#') ? await wd.findChannelId?.(w.target.slice(1)).catch(() => null) : w.target;
      if (!id) return null;
      return w.threadTs ? { slackChannelId: id, threadTs: w.threadTs, destination: dest } : { slackChannelId: id, ...(w.topic ? { topic: w.topic } : {}), destination: dest };
    }
    case 'ticket-thread': {
      const existing = await wd.ticketThreads()?.get(w.projectPath, w.ticketId);
      if (existing) return { slackChannelId: existing.slackChannelId, threadTs: existing.threadTs, destination: dest };
      const info = await wd.ticketInfo(w.projectPath, w.ticketId).catch(() => null);
      const channel = await wd.teamChannelOf(input.session, w.teamId ?? info?.team ?? null);
      return channel ? { slackChannelId: channel.slackChannelId, topic: `${w.ticketId}${info?.title ? ` · ${info.title}` : ''}`, destination: dest } : null;
    }
    case 'new-top-level': {
      const channel = await wd.teamChannelOf(input.session, w.teamId ?? null);
      return channel ? { slackChannelId: channel.slackChannelId, ...(w.topic ? { topic: w.topic } : {}), destination: dest } : null;
    }
    case 'agent':
      // An internal message to the delegating agent is not a Slack place.
      return null;
  }
}

/**
 * The English error an agent gets for an undelivered message.
 *
 * @param why - What went wrong
 * @param fix - Command to run
 * @returns Error text
 */
export function notDelivered(why: string, fix: string): string {
  return fix ? `Your message was NOT delivered: ${why}. Run: ${fix}` : `Your message was NOT delivered: ${why}. Tell your team leader — repeating the same command will not help.`;
}

/**
 * Log the decision; ignored hints at warn (an agent passed ids the harness overrode).
 *
 * @param session - Agent
 * @param r - Resolution
 */
function logResolution(session: string, r: ReplyResolution): void {
  const d = r.destination;
  if (r.ignoredHints.length > 0) {
    logger.warn('Agent-supplied ids ignored — they do not name a conversation the agent is in', { session, ignored: r.ignoredHints });
  }
  logger.info('Reply destination resolved', {
    session,
    kind: d.kind,
    ...(d.kind === 'conversation' ? { conversationId: d.conversationId, thread: d.thread } : {}),
    ...(d.kind === 'work' ? { work: d.destination.kind } : {}),
    ...(d.kind !== 'unresolved' ? { source: d.source } : {}),
    reason: d.reason,
  });
}

/**
 * The real {@link ReplyDeliveryDeps.answerAgent}: the answer goes to the
 * other agent with the replier's sender header (so it can answer back), and
 * the replier's open ask from that agent counts as answered.
 *
 * @param fromSession - Replying agent
 * @param toSession - Agent whose message it answers
 * @param text - Answer
 * @returns True when the message was taken
 */
async function defaultAnswerAgent(fromSession: string, toSession: string, text: string): Promise<boolean> {
  const [{ getAgentMessenger }, { describeAgentSender, wrapAgentMessage }, { StorageService }, { getAgentAskLedger }] = await Promise.all([
    import('./work-item-destination.wiring.js'),
    import('../messaging/agent-message-envelope.js'),
    import('../core/storage.service.js'),
    import('../messaging/agent-ask-ledger.service.js'),
  ]);
  const messenger = getAgentMessenger();
  if (!messenger) return false;
  const sender = (await describeAgentSender(fromSession, (s) => StorageService.getInstance().findMemberBySessionName(s))) ?? { session: fromSession };
  const taken = await messenger(toSession, wrapAgentMessage(text, sender));
  if (taken) {
    try {
      getAgentAskLedger()?.noteAnswered(fromSession, toSession);
    } catch {
      /* best effort */
    }
  }
  return taken;
}

/**
 * The real collaborators (lazy imports keep this module light for tests).
 *
 * @returns Deps
 */
export async function defaultReplyDeliveryDeps(): Promise<ReplyDeliveryDeps> {
  const [{ getChatV2Service }, { getSlackTeamChannelService }, { getSlackAgentDmService }, { TaskPoolService }, { OrcReplyRouteService }, { RequestService }, { slackPlaceOf }, { DecisionService }, { ProjectTicketService }] =
    await Promise.all([
      import('../chat-v2/chat-v2.singleton.js'),
      import('../slack/slack-team-channel.service.js'),
      import('../slack/slack-agent-dm.service.js'),
      import('../task-pool/task-pool.service.js'),
      import('./orc-reply-route.service.js'),
      import('../v3/request.service.js'),
      import('../open-items/open-items.service.js'),
      import('../decisions/decision.service.js'),
      import('../project-tickets/project-ticket.service.js'),
    ]);
  const { getOwnerMessageWatchdog } = await import('../messaging/owner-message-watchdog.service.js');
  const { SLACK_AGENT_DM_CONSTANTS } = await import('../../constants.js');
  const chat = () => {
    try {
      return getChatV2Service();
    } catch {
      return null;
    }
  };
  const pool = () => TaskPoolService.getInstance().getAllItems().catch(() => [] as WorkItem[]);
  const resolver: ReplyResolverDeps = {
    getMessage: (id) => {
      const m = chat()?.getMessageForBridge(id);
      return m ? { id: m.id, channelId: m.channelId, ...(m.threadId ? { threadId: m.threadId } : {}), ...(m.metadata ? { metadata: m.metadata as Record<string, unknown> } : {}) } : null;
    },
    ownsConversation: async (session, conversationId) => {
      const c = chat();
      if (!c) return false;
      const channel = c.getChannelForBridge(conversationId);
      if (!channel || channel.archivedAt) return false;
      if (channel.type === 'dm') return channel.agentSession === session;
      return c.queryHuddleMembersForDispatch(conversationId).includes(session);
    },
    slackChannelOfConversation: (conversationId) =>
      getSlackTeamChannelService()?.findByChatChannelId(conversationId)?.slackChannelId ??
      getSlackAgentDmService()?.findByChatChannelId(conversationId)?.slackChannelId ??
      null,
    conversationOfSlackThread: (slackChannelId, threadTs) => {
      const mapping = getSlackTeamChannelService()?.findBySlackChannelId(slackChannelId);
      if (mapping) {
        const root = chat()?.findSlackThreadRoot(mapping.chatChannelId, threadTs);
        return { conversationId: mapping.chatChannelId, ...(root ? { threadRootId: root.id } : {}) };
      }
      const link = getSlackAgentDmService()?.findBySlackChannelId(slackChannelId);
      return link ? { conversationId: link.chatChannelId } : null;
    },
    requestTicket: async (n) => {
      const all = await RequestService.getInstance().listAll().catch(() => []);
      const r = all.find((x) => x.ticketNumber === n);
      if (!r) return null;
      const place = slackPlaceOf(r);
      const { formatTicketNumber } = await import('../../types/v2/ticket.types.js');
      return {
        id: r.id,
        label: formatTicketNumber(n),
        ...(r.chatRef ? { conversationId: r.chatRef.channelId, threadRootId: r.chatRef.threadRootId } : {}),
        ...(place ? { slackChannelId: place.slackChannelId, threadTs: place.threadTs } : {}),
      };
    },
    projectTicket: async (session, ticketId) => {
      const items = await pool();
      const linked = items
        .filter((w) => {
          const link = (w.metadata ?? {}).projectTicket as { id?: unknown; projectPath?: unknown } | undefined;
          return link?.id === ticketId && typeof link.projectPath === 'string';
        })
        .sort((a, b) => Number(b.target === session) - Number(a.target === session));
      const link = linked[0]?.metadata?.projectTicket as { projectPath: string } | undefined;
      if (!link) return null;
      const t = await ProjectTicketService.getInstance().get(link.projectPath, ticketId).catch(() => null);
      return { projectPath: link.projectPath, ticketId, ...(t?.title ? { title: t.title } : {}) };
    },
    decision: async (id) => {
      const d = await DecisionService.getInstance()?.get(id).catch(() => null);
      if (!d) return null;
      return {
        id: d.id,
        asker: d.asker,
        requestedBy: d.requestedBy,
        ...(d.card ? { slackChannelId: d.card.slackChannelId, threadTs: d.card.threadTs ?? d.card.messageTs } : {}),
        ...(d.ticket ? { ticket: { projectPath: d.ticket.projectPath, id: d.ticket.id, title: d.ticket.title } } : {}),
        ...(d.teamId ? { teamId: d.teamId } : {}),
      };
    },
    workItem: async (id) => (await pool()).find((w) => w.id === id) ?? null,
    poolItems: pool,
    turnOrigin: (session) => OrcReplyRouteService.getInstance().getLastOrigin(session),
    promptReference: (session) => AgentPromptReferenceService.getInstance().get(session),
    owesOwner: (session) => (getOwnerMessageWatchdog()?.owedBy(session).length ?? 0) > 0,
    lastDelivered: (session) => OrcReplyRouteService.getInstance().getLastDelivered(session),
    ownerDm: async (session) => {
      const link = getSlackAgentDmService()?.findByAgentSession(session);
      if (link) return link.chatChannelId;
      const c = chat();
      if (!c) return null;
      // Only a real team member gets a DM — never one made up for an unknown name.
      const { StorageService } = await import('../core/storage.service.js');
      const teams = await StorageService.getInstance().getTeams().catch(() => []);
      if (!teams.some((t) => (t.members ?? []).some((m) => m.sessionName === session))) return null;
      const { channel } = c.ensureDmChannel({ agentSession: session, principal: { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' } });
      return channel.id;
    },
    // The one rule for "this thread is the agent's own work": live items and
    // items finished within the done grace (crewly#1496: a `--thread` hint
    // was refused 45 min after the item was verified, while `--work-item`
    // on the same item resolved to that thread).
    delegatedThread: async (session, slackChannelId, threadTs) => {
      const { isDelegatedInThread } = await import('./work-item-destination.js');
      return isDelegatedInThread(await pool(), session, slackChannelId, threadTs, Date.now());
    },
    surfacedOwnerConversations: (session) => SubAgentMessageQueue.getInstance().surfacedUnansweredConversations(session),
    // What the agent answers: the latest input that names it, not a reminder
    // or notice delivered since (message-routing audit 2026-10-18).
    // An agent message already answered with send-message is not (crewly#1381).
    latestInput: (session) => latestInputOf(getTurnTriggerTracker().openRoutedTrigger(session)),
    now: () => Date.now(),
  };
  const { deliverAgentReplyToConversation } = await import('../../controllers/chat/chat.controller.js');
  const chatLookup = await loadChatChannelLookup();
  return {
    resolver,
    deliverToConversation: deliverAgentReplyToConversation,
    workDestination: defaultWorkDestinationDeps,
    answerAgent: defaultAnswerAgent,
    refusedReplyNotice: {
      decision: async (id) => {
        const all = (await DecisionService.getInstance()?.list('all').catch(() => [])) ?? [];
        const x = all.find((y) => y.id === id);
        return x ? { status: x.status, ...(x.card ? { card: { slackChannelId: x.card.slackChannelId, threadTs: x.card.threadTs ?? x.card.messageTs } } : {}) } : null;
      },
      leadOf: async (session) => {
        const [{ StorageService }, { leadAbove }] = await Promise.all([import('../core/storage.service.js'), import('../task-pool/untargeted-router.js')]);
        return leadAbove(session, await StorageService.getInstance().getTeams().catch(() => []));
      },
      tell: async (toSession, text) => (await import('./work-item-destination.wiring.js')).getAgentMessenger()?.(toSession, text) ?? false,
      orchestrator: ORCHESTRATOR_SESSION_NAME,
      postToCard: async (card, text) => {
        const wd = await defaultWorkDestinationDeps();
        await wd.post({ agentSession: ORCHESTRATOR_SESSION_NAME, target: card.slackChannelId, threadTs: card.threadTs, text });
        return true;
      },
      now: () => Date.now(),
    },
    priorRoomAnswer: async (input) => {
      const { getSlackTeamChannelService } = await import('../slack/slack-team-channel.service.js');
      return (await getSlackTeamChannelService()?.heldReplyFor(input)) ?? null;
    },
    decisionOfCardThread: async (slackChannelId, threadTs) => {
      const all = (await DecisionService.getInstance()?.list('all').catch(() => [])) ?? [];
      const hit = all.find((x) => x.card && x.card.slackChannelId === slackChannelId && (x.card.threadTs ?? x.card.messageTs) === threadTs);
      return hit?.id ?? null;
    },
    turnTrigger: (session) => getTurnTriggerTracker().trigger(session),
    ownerAskedRecently: (session, conversationId) => getTurnTriggerTracker().ownerAskedRecently(session, conversationId),
    ownerAskedEarlier: (session, conversationId) => getTurnTriggerTracker().ownerAskedWithin(session, conversationId, TURN_TRIGGER_CONSTANTS.FRESH_MS),
    ownerWroteInThread: (conversationId, thread) => ownerWroteInThreadRecently(chatLookup, conversationId, thread),
    routedTrigger: (session) => getTurnTriggerTracker().openRoutedTrigger(session),
    currentTrace: (session) => getTraceContext().currentTrace(session),
    conversationPlace: (id) => chatConversationPlace(chatLookup, id),
  };
}

/** The chat-v2 lookups {@link chatConversationPlace} and {@link ownerWroteInThreadRecently} use. */
interface ChatChannelLookup {
  getChannelForBridge(id: string): { name: string; type?: string; agentSession?: string } | null;
  getMessageForBridge?(id: string): { id: string; channelId: string; threadId?: string } | null;
  findSlackThreadRoot?(channelId: string, slackThreadTs: string): { id: string } | null;
  listThreadForBridge?(channelId: string, rootId: string): Array<{ senderType: string; createdAt: number }>;
}

/**
 * Whether the owner wrote in a thread (a chat message id or a Slack thread
 * key) within {@link TURN_TRIGGER_CONSTANTS.OWNER_ANSWER_WINDOW_MS}. Never throws.
 *
 * @param chat - chat-v2 lookups, or null
 * @param conversationId - chat-v2 channel id
 * @param thread - Chat message id or `<slackChannel>:<threadTs>`
 * @param now - Clock (epoch ms)
 * @returns True when a user row in the thread is that recent
 */
export function ownerWroteInThreadRecently(chat: ChatChannelLookup | null, conversationId: string, thread: string, now: number = Date.now()): boolean {
  try {
    if (!chat?.listThreadForBridge) return false;
    const named = chat.getMessageForBridge?.(thread);
    let rootId = named && named.channelId === conversationId ? (named.threadId ?? named.id) : undefined;
    const key = rootId ? null : parseSlackThreadKey(thread);
    if (!rootId && key) rootId = chat.findSlackThreadRoot?.(conversationId, key.threadTs)?.id;
    if (!rootId) return false;
    const since = now - TURN_TRIGGER_CONSTANTS.OWNER_ANSWER_WINDOW_MS;
    return chat.listThreadForBridge(conversationId, rootId).some((m) => m.senderType === 'user' && m.createdAt >= since);
  } catch {
    return false;
  }
}

/**
 * The chat-v2 service, when it is up.
 *
 * @returns The service, or null
 */
async function loadChatChannelLookup(): Promise<ChatChannelLookup | null> {
  try {
    const { getChatV2Service } = await import('../chat-v2/chat-v2.singleton.js');
    return getChatV2Service();
  } catch {
    return null;
  }
}

/**
 * A chat conversation as the owner knows it: `#name` for a channel or room,
 * `the DM with <agent>` for a direct conversation.
 *
 * @param chat - chat-v2 lookups, or null
 * @param conversationId - chat-v2 channel id
 * @returns The place, or null when unknown
 */
export function chatConversationPlace(chat: ChatChannelLookup | null, conversationId: string): string | null {
  try {
    const ch = chat?.getChannelForBridge(conversationId);
    if (!ch) return null;
    if (ch.type === 'dm') return `the DM with ${memberNameFromSession(ch.agentSession || ch.name)}`;
    return ch.name ? `#${ch.name.replace(/^#/, '')}` : null;
  } catch {
    return null;
  }
}

/**
 * The route an agent's own messages carry onward: what it is answering now
 * (its latest routed input; message-route.ts). Never throws.
 *
 * @param session - Agent session
 * @returns The route, or null when its input names none
 */
export async function currentRouteOf(session: string): Promise<MessageRoute | null> {
  try {
    const { OrcReplyRouteService } = await import('./orc-reply-route.service.js');
    return routeOfTrigger(getTurnTriggerTracker().routedTrigger(session), OrcReplyRouteService.getInstance().getLastOrigin(session));
  } catch {
    return null;
  }
}
