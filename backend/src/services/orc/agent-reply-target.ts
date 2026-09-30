/**
 * Where an agent's `reply` goes — decided by the harness from the delivery
 * the agent is answering, not by the agent picking the right tool and ids.
 *
 * Agents had to choose between reply-channel / reply-chat / reply-slack /
 * report-status and pass the right ids; Codex agents in particular got this
 * wrong and the owner's answer went to the orchestrator as "status" or into
 * the wrong conversation. `reply "<text>"` names nothing: the answer goes to
 * the turn origin recorded when the owner's message was delivered
 * (`OrcReplyRouteService`). Explicit ids that are the agent's own still win.
 *
 * @module services/orc/agent-reply-target
 * @see specs/2026-09-30-owner-message-guarantee.md §B
 */

import { ORC_STATUS_FORWARDING } from '../../constants.js';
import type { TurnOrigin } from './orc-reply-route.service.js';

/** The decision. */
export type AgentReplyPlan =
  /** A report-status line: to the orchestrator, exactly like report-status. */
  | { kind: 'status' }
  /** No answer needed: close what the agent was asked, post nothing. */
  | { kind: 'none'; origin?: TurnOrigin }
  /** Post as the agent into a chat-v2 conversation (DM / room / huddle), in `thread` when set. */
  | { kind: 'post'; conversationId: string; thread?: string; via: 'explicit' | 'origin'; reason: string }
  /** The orchestrator answering a Slack thread it was asked in through the master bot. */
  | { kind: 'orc-slack'; channelId: string; threadTs?: string; reason: string }
  /** The orchestrator answering in a chat conversation (its own reply routing applies). */
  | { kind: 'orc-chat'; conversationId?: string; reason: string }
  /** Nothing to answer into. */
  | { kind: 'no-target'; reason: string };

/** Inputs of {@link planAgentReply}. */
export interface AgentReplyRequest {
  /** Replying session (X-Agent-Session) */
  session: string;
  /** Whether it is the orchestrator */
  isOrchestrator: boolean;
  /** Reply text ('' with `none`) */
  content: string;
  /** `reply --none`: no answer needed */
  none?: boolean;
  /** Ids the agent passed, if any (may be missing, legacy or wrong) */
  requested?: { conversationId?: string; thread?: string };
  /** The recorded turn origin */
  origin?: TurnOrigin;
  /** Whether `conversationId` is one this agent may answer in (its DM, a room it is in) */
  ownsConversation: (conversationId: string) => boolean;
}

/**
 * Whether text is a report-status line for the orchestrator.
 *
 * @param content - Reply text
 * @returns True for `[DONE]`, `[WORKING]`, … at the start
 */
export function isStatusReport(content: string): boolean {
  return ORC_STATUS_FORWARDING.STATUS_MARKERS.test(content ?? '');
}

/**
 * The thread an origin's answer belongs in: the Slack thread key when the
 * message came from Slack, else the chat-v2 thread.
 *
 * @param origin - Turn origin
 * @returns Thread reference, or undefined
 */
export function originThread(origin: TurnOrigin | undefined): string | undefined {
  return origin?.slackThreadKey ?? origin?.chatThreadId;
}

/**
 * Decide where a reply goes.
 *
 * @param req - Who is replying, what, the ids it passed and its turn origin
 * @returns The plan
 */
export function planAgentReply(req: AgentReplyRequest): AgentReplyPlan {
  if (req.none) return { kind: 'none', ...(req.origin ? { origin: req.origin } : {}) };
  if (isStatusReport(req.content)) return { kind: 'status' };

  const requestedConv = req.requested?.conversationId?.trim() || undefined;
  const requestedThread = req.requested?.thread?.trim() || undefined;
  const origin = req.origin;

  if (req.isOrchestrator) {
    if (requestedConv) return { kind: 'orc-chat', conversationId: requestedConv, reason: 'conversation named' };
    if (origin?.slackChannelId) {
      return {
        kind: 'orc-slack',
        channelId: origin.slackChannelId,
        ...(origin.slackThreadTs ? { threadTs: origin.slackThreadTs } : {}),
        reason: 'turn came from a Slack thread',
      };
    }
    return { kind: 'orc-chat', ...(origin ? { conversationId: origin.conversationId } : {}), reason: origin ? 'turn origin' : 'no origin — orchestrator fallback' };
  }

  if (requestedConv && req.ownsConversation(requestedConv)) {
    const sameAsOrigin = origin?.conversationId === requestedConv;
    const thread = requestedThread ?? (sameAsOrigin ? originThread(origin) : undefined);
    return {
      kind: 'post',
      conversationId: requestedConv,
      ...(thread ? { thread } : {}),
      via: 'explicit',
      reason: 'named its own conversation',
    };
  }
  if (origin) {
    const thread = requestedThread ?? originThread(origin);
    return {
      kind: 'post',
      conversationId: origin.conversationId,
      ...(thread ? { thread } : {}),
      via: 'origin',
      reason: requestedConv ? `named a conversation that is not its own (${requestedConv}) — using its turn origin` : 'no conversation named — using its turn origin',
    };
  }
  return { kind: 'no-target', reason: 'no conversation named and no message delivered to this agent yet' };
}
