/**
 * Wiring for {@link OwnerCompletionReportService}: where an owner origin is
 * on this machine, how the harness posts its own summary there, and which
 * posts count as "an agent answered there". The service stays transport-free.
 *
 * @module services/orc/owner-completion-report.wiring
 */

import { SLACK_THREAD_KEY_CONSTANTS, SLACK_TYPING_CONSTANTS } from '../../constants.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import { parseSlackThreadKey, slackThreadTag } from '../slack/slack-thread-key.js';
import type { OwnerCompletionReportService, OwnerOrigin, ReportPlace } from './owner-completion-report.service.js';

/** An app comment's Slack thread, when it is mirrored. */
export type CommentLinkLookup = (appId: string, commentId: string) => Promise<{ slackChannelId: string; threadTs: string } | null>;

/**
 * Resolve where an owner origin is.
 *
 * @param origin - Owner origin
 * @param commentLink - App comment → its Slack thread
 * @returns The place, or null when the origin names none
 */
export async function resolveReportPlace(origin: OwnerOrigin, commentLink: CommentLinkLookup): Promise<ReportPlace | null> {
  const ac = origin.appComment;
  if (ac?.appId && ac.commentId) {
    const link = origin.slackChannelId && origin.threadTs
      ? { slackChannelId: origin.slackChannelId, threadTs: origin.threadTs }
      : await commentLink(ac.appId, ac.commentId).catch(() => null);
    return {
      kind: 'app-comment',
      appId: ac.appId,
      commentId: ac.commentId,
      ...(link ? { slackChannelId: link.slackChannelId, threadTs: link.threadTs } : {}),
      label: link
        ? `the owner's app comment (app ${ac.appId}, comment ${ac.commentId}; its Slack thread ${slackThreadTag(link.slackChannelId, link.threadTs)})`
        : `the owner's app comment (app ${ac.appId}, comment ${ac.commentId})`,
    };
  }
  if (origin.slackChannelId) {
    return {
      kind: 'slack',
      slackChannelId: origin.slackChannelId,
      ...(origin.threadTs ? { threadTs: origin.threadTs } : {}),
      label: origin.threadTs ? `Slack thread ${slackThreadTag(origin.slackChannelId, origin.threadTs)}` : `Slack conversation ${origin.slackChannelId}`,
    };
  }
  if (origin.conversationId) {
    return {
      kind: 'chat',
      conversationId: origin.conversationId,
      ...(origin.chatThreadId ? { chatThreadId: origin.chatThreadId } : {}),
      label: `the owner's Crewly chat (conversation ${origin.conversationId})`,
    };
  }
  return null;
}

/** Transports the fallback post uses (all injectable). */
export interface FallbackTransports {
  /** Reply on an app comment as the agent (also mirrored into its Slack thread) */
  replyComment?: (appId: string, commentId: string, agentSession: string, text: string) => Promise<void>;
  /** Post in Slack as the agent's bot */
  slackAsAgent?: (agentSession: string, slackChannelId: string, text: string, threadTs?: string) => Promise<void>;
  /** Post in Slack as the workspace bot */
  slackAsCrewly?: (slackChannelId: string, text: string, threadTs?: string) => Promise<void>;
  /** Post in a chat conversation as the agent */
  chatAsAgent?: (conversationId: string, agentSession: string, text: string) => Promise<void>;
}

/**
 * Post the harness's summary in the owner's place: an app comment gets a
 * reply (mirrored to its Slack thread); Slack as the agent's bot, else as
 * Crewly; a chat as the agent. Never throws.
 *
 * @param place - Where
 * @param agentSession - The responsible agent
 * @param text - The summary
 * @param t - Transports
 * @returns True when posted somewhere in that place
 */
export async function postReportFallback(place: ReportPlace, agentSession: string, text: string, t: FallbackTransports): Promise<boolean> {
  const attempt = async (fn: (() => Promise<void>) | null): Promise<boolean> => {
    if (!fn) return false;
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };
  if (place.kind === 'app-comment') {
    if (await attempt(t.replyComment ? () => t.replyComment!(place.appId, place.commentId, agentSession, text) : null)) return true;
  }
  if (place.kind !== 'chat' && place.slackChannelId) {
    const ch = place.slackChannelId;
    if (await attempt(t.slackAsAgent ? () => t.slackAsAgent!(agentSession, ch, text, place.threadTs) : null)) return true;
    if (await attempt(t.slackAsCrewly ? () => t.slackAsCrewly!(ch, text, place.threadTs) : null)) return true;
  }
  if (place.kind === 'chat') {
    return attempt(t.chatAsAgent ? () => t.chatAsAgent!(place.conversationId, agentSession, text) : null);
  }
  return false;
}

/**
 * Feed a chat-v2 row: an agent's (non-interim) post answers its conversation
 * (and the Slack thread its reply was mirrored into).
 *
 * @param service - The report service
 * @param message - The row
 */
export function onChatRow(
  service: Pick<OwnerCompletionReportService, 'noteChatAnswer' | 'noteSlackAnswer'>,
  message: Pick<ChatMessageDTO, 'channelId' | 'senderType' | 'threadId' | 'metadata'>,
): void {
  if (message.senderType !== 'agent') return;
  const meta = message.metadata ?? {};
  if (meta[SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY] === true) return;
  service.noteChatAnswer(message.channelId, message.threadId);
  const key = parseSlackThreadKey(meta[SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]);
  if (key) service.noteSlackAnswer(key.slackChannelId, key.threadTs);
}

/**
 * Feed a Slack post made through this machine's SlackService.
 *
 * @param service - The report service
 * @param post - Where it went
 */
export function onSlackOutboundPost(
  service: Pick<OwnerCompletionReportService, 'noteSlackAnswer'>,
  post: { channelId: string; threadTs?: string; notAnAnswer?: boolean },
): void {
  if (post.notAnAnswer || !post.channelId) return;
  service.noteSlackAnswer(post.channelId, post.threadTs);
}

/**
 * Feed an inbound Slack message: an agent (any machine) posting there.
 *
 * @param service - The report service
 * @param message - Inbound fields
 */
export function onSlackInboundPost(
  service: Pick<OwnerCompletionReportService, 'noteSlackAnswer'>,
  message: { channelId: string; threadTs?: string; authorAgentSession?: string },
): void {
  if (!message.authorAgentSession || !message.channelId) return;
  service.noteSlackAnswer(message.channelId, message.threadTs);
}
