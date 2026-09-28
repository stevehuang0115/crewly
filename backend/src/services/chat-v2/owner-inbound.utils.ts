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

/** Messenger surfaces whose agent replies are recorded through {@link recordMessengerAgentReply}. */
export type MessengerReplySource = 'telegram' | 'google-chat' | 'whatsapp';

/**
 * Record the orchestrator's reply that a messenger bridge just sent, as an
 * agent turn on the same chat-v2 channel the owner's message went to.
 *
 * Why (specs/unified-conversations-cloud-store.md §A.3 G1): outbound
 * Telegram / Google Chat / WhatsApp replies reached only the platform and a
 * thread file, so the machine's conversation log — and Crewly Cloud's copy
 * of it — held the question without the answer.
 *
 * Idempotent when the platform returns a message id:
 * `clientMessageId = <source>-out-<platformMessageId>`. Best-effort: a
 * failure returns null and the reply stays delivered.
 *
 * @param chat - chat-v2 service (or a test double)
 * @param args.conversationId - chat-v2 channel id of the conversation
 * @param args.content - The text that was sent
 * @param args.source - Which messenger carried it
 * @param args.agentSession - Agent that answered (defaults to the orchestrator)
 * @param args.platformMessageId - Platform id of the sent message, when known
 * @param args.metadata - Extra platform correlation fields
 * @returns The chat-v2 message id, or null when recording failed
 */
export function recordMessengerAgentReply(
  chat: OwnerInboundChat,
  args: {
    conversationId: string;
    content: string;
    source: MessengerReplySource;
    agentSession?: string;
    platformMessageId?: string | number | null;
    metadata?: Record<string, unknown>;
  },
): string | null {
  if (!args.content || args.content.trim().length === 0) return null;
  const agentSession = args.agentSession || ORCHESTRATOR_SESSION_NAME;
  try {
    const channel = chat.ensureChannelForLegacyConversation({
      conversationId: args.conversationId,
      agentSession: ORCHESTRATOR_SESSION_NAME,
    });
    const hasPlatformId =
      args.platformMessageId !== undefined && args.platformMessageId !== null && String(args.platformMessageId).length > 0;
    const { message } = chat.recordTurn({
      channelId: channel.id,
      senderType: 'agent',
      senderId: agentSession,
      content: args.content,
      ...(hasPlatformId ? { clientMessageId: `${args.source}-out-${String(args.platformMessageId)}` } : {}),
      metadata: { ...(args.metadata ?? {}), source: args.source },
    });
    return message.id;
  } catch {
    return null;
  }
}

/** The slice of ChatV2Service a Cloud Talk turn needs. */
export interface CloudTalkChat {
  ensureDmChannel(args: {
    agentSession: string;
    principal: { userId: string; source: 'oss' };
  }): { channel: ChatChannelDTO };
  recordTurn(input: RecordTurnInput): RecordTurnResult;
}

/**
 * Record a message the owner sent from Crewly Cloud's Talk page into the
 * agent's DM — the same channel the dashboard and the agent's Slack DM use —
 * tagged `source: 'cloud-talk'` (spec §A.3 G3, §D.3 step 4).
 *
 * The Phase 3 `talk_message` relay handler calls this; it is idempotent on
 * the Talk `clientMessageId`, so a relay retry records one row. Replies to a
 * Talk turn stay off Slack through the reply-affinity rule (G6).
 *
 * @param chat - chat-v2 service (or a test double)
 * @param args.agentSession - Agent the owner is talking to
 * @param args.text - What the owner said
 * @param args.clientMessageId - Talk message id (`talk-<uuid>`)
 * @param args.ownerUserId - Owner principal of the DM channel
 * @returns The persisted turn and the DM channel id
 * @throws {ChatError} when the channel cannot be created or the text is invalid
 */
export function recordCloudTalkTurn(
  chat: CloudTalkChat,
  args: { agentSession: string; text: string; clientMessageId: string; ownerUserId: string },
): RecordTurnResult & { channelId: string } {
  const { channel } = chat.ensureDmChannel({
    agentSession: args.agentSession,
    principal: { userId: args.ownerUserId, source: 'oss' },
  });
  const result = chat.recordTurn({
    channelId: channel.id,
    senderType: 'user',
    senderId: args.ownerUserId,
    content: args.text,
    clientMessageId: args.clientMessageId,
    metadata: { source: 'cloud-talk' },
  });
  return { ...result, channelId: channel.id };
}
