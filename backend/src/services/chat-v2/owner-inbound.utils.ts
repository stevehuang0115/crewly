/**
 * Record an owner's message that arrived on a messenger bridge (Telegram,
 * Google Chat) as a chat-v2 `user` turn.
 *
 * Why (#730): the commitment-approval gate reads the owner's words from
 * chat-v2 `user` rows. Chat UI, Slack and WhatsApp already record theirs;
 * Telegram and Google Chat delivered straight to the orchestrator's queue and
 * left no row, so an owner who approved a launch there was held forever — the
 * "single channel = deadlock" failure. Recording them here widens which owner
 * channels count without loosening what counts: the row is written by the
 * bridge from a platform event, never from text an agent supplies.
 *
 * Persistence is best-effort: a failure is returned as null so the caller can
 * log it, and delivery to the orchestrator proceeds regardless.
 *
 * @module services/chat-v2/owner-inbound.utils
 */

import type { ChatChannelDTO } from './types.js';
import type { RecordTurnInput, RecordTurnResult } from './chat-v2.service.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

/** Messenger surfaces recorded through this helper. */
export type MessengerOwnerSource = 'telegram' | 'google-chat';

/** The slice of ChatV2Service this helper needs (keeps it unit-testable). */
export interface OwnerInboundChat {
  ensureChannelForLegacyConversation(args: {
    conversationId: string;
    agentSession: string;
    name?: string;
  }): ChatChannelDTO;
  recordTurn(input: RecordTurnInput): RecordTurnResult;
}

/** Characters allowed in a synthesized chat-v2 channel id. */
const UNSAFE_ID_CHARS = /[^A-Za-z0-9_-]+/g;

/**
 * Build a stable chat-v2 channel id for a messenger conversation.
 *
 * Platform ids can contain `/` (Google Chat `spaces/AAA`) which does not
 * belong in a channel id used in URLs; unsafe runs collapse to `-`.
 *
 * @param prefix - Surface prefix, e.g. `telegram` or `gchat`
 * @param rawId - Platform conversation id
 * @returns `<prefix>-<sanitized id>`
 *
 * @example
 * messengerConversationId('gchat', 'spaces/AAQA1') // 'gchat-spaces-AAQA1'
 */
export function messengerConversationId(prefix: string, rawId: string): string {
  // Leading/trailing dashes are kept: a Telegram group id is negative
  // (`-100123`) and must not collide with a user id `100123`.
  const safe = rawId.replace(UNSAFE_ID_CHARS, '-');
  return `${prefix}-${safe || 'unknown'}`;
}

/**
 * Record one owner message from a messenger bridge.
 *
 * @param chat - chat-v2 service (or a test double)
 * @param args.conversationId - chat-v2 channel id (see {@link messengerConversationId})
 * @param args.content - Message text as the owner wrote it
 * @param args.senderId - Platform user id / display name
 * @param args.source - Which messenger it came from
 * @param args.metadata - Extra platform correlation fields
 * @returns The chat-v2 channel id, or null when recording failed
 */
export function recordMessengerOwnerTurn(
  chat: OwnerInboundChat,
  args: {
    conversationId: string;
    content: string;
    senderId: string;
    source: MessengerOwnerSource;
    metadata?: Record<string, unknown>;
  },
): string | null {
  if (!args.content || args.content.trim().length === 0) return null;
  try {
    const channel = chat.ensureChannelForLegacyConversation({
      conversationId: args.conversationId,
      agentSession: ORCHESTRATOR_SESSION_NAME,
    });
    chat.recordTurn({
      channelId: channel.id,
      senderType: 'user',
      senderId: args.senderId || args.source,
      content: args.content,
      metadata: { ...(args.metadata ?? {}), source: args.source },
    });
    return channel.id;
  } catch {
    return null;
  }
}
