/**
 * DTO translation helpers between chat-v2 and the legacy chat
 * `ChatMessage` / `ChatConversation` shapes.
 *
 * Lives under `chat-v2/` because chat-v2 is the destination; the
 * legacy `chat/` directory is being retired (Phase 6c of
 * `specs/2026-05-14-unified-chat-message-store.md`). Call sites that
 * still emit / receive legacy DTOs (HTTP responses, WebSocket events
 * the frontend already consumes) use these helpers to bridge without
 * duplicating the conversion logic everywhere.
 *
 * @module services/chat-v2/legacy-dto-utils
 */

import type {
  ChatChannelDTO,
  ChatMessageDTO,
  ChatPrincipal,
  ChatSenderType,
} from './types.js';
import type {
  ChatMessage,
  ChatConversation,
  ChatSender,
  ChatContentType,
} from '../../types/chat.types.js';
import { inferChannelTypeFromConversationId } from '../../types/chat.types.js';

/**
 * Server-internal principal used by callers that have no HTTP-request
 * principal to forward (Slack bridge, in-process runtime, migration
 * tooling, server bootstrap telemetry).
 */
export const SYSTEM_PRINCIPAL: ChatPrincipal = { userId: 'system', source: 'oss' };

/**
 * Map a legacy ChatSender (`{type, id?, name?}`) onto chat-v2's
 * closed `senderType` enum + senderId.
 *
 * Legacy types include 'user' | 'orchestrator' | 'agent' | 'system'
 * | 'auditor' | role-specific strings. chat-v2 only has three
 * (`user | agent | system`); everything that isn't user/system maps
 * to 'agent'.
 *
 * @param sender - Legacy sender descriptor
 * @returns chat-v2 senderType + senderId
 */
export function senderToV2(sender: ChatSender): { type: ChatSenderType; id: string } {
  const t = (sender?.type ?? '').toLowerCase();
  if (t === 'user') {
    return { type: 'user', id: sender.id ?? sender.name ?? 'user' };
  }
  if (t === 'system') {
    return { type: 'system', id: sender.id ?? 'system' };
  }
  return { type: 'agent', id: sender.id ?? sender.name ?? 'agent' };
}

/**
 * Convert a chat-v2 message DTO back into the legacy ChatMessage
 * shape that the frontend and WebSocket subscribers consume.
 *
 * @param dto - chat-v2 message DTO
 * @returns Legacy ChatMessage with ISO timestamp + `from` sender object
 */
export function v2MessageToLegacy(dto: ChatMessageDTO): ChatMessage {
  const fromType: ChatSender['type'] =
    dto.senderType === 'user'
      ? 'user'
      : dto.senderType === 'system'
        ? 'system'
        : 'orchestrator';
  return {
    id: dto.id,
    conversationId: dto.channelId,
    from: {
      type: fromType,
      id: dto.senderId,
      name: dto.senderId,
    },
    content: dto.content,
    contentType: (dto.contentType ?? 'markdown') as ChatContentType,
    metadata: (dto.metadata ?? {}) as Record<string, unknown>,
    status: 'sent',
    timestamp: new Date(dto.createdAt).toISOString(),
  };
}

/**
 * Convert a chat-v2 channel DTO back into the legacy
 * ChatConversation shape.
 *
 * @param channel - chat-v2 channel DTO
 * @param messageCount - Count of messages in the channel
 * @returns Legacy ChatConversation
 */
export function v2ChannelToLegacy(
  channel: ChatChannelDTO,
  messageCount: number,
): ChatConversation {
  return {
    id: channel.id,
    title: channel.name,
    participantIds: ['user', channel.agentSession || 'orchestrator'].filter(
      Boolean,
    ) as string[],
    createdAt: new Date(channel.createdAt).toISOString(),
    updatedAt: new Date(channel.lastMessageAt ?? channel.createdAt).toISOString(),
    isArchived: Boolean(channel.archivedAt),
    messageCount,
    channelType: inferChannelTypeFromConversationId(channel.id),
  };
}

/**
 * Infer the canonical `metadata.source` enum from legacy metadata.
 * Falls back to 'system' when the legacy caller didn't tag the message.
 *
 * @param metadata - Legacy metadata blob (possibly undefined)
 * @returns A chat-v2 `RecordTurnSource` value
 */
export function inferSourceFromLegacyMetadata(
  metadata: Record<string, unknown> | undefined,
): 'web' | 'slack' | 'pty-runtime' | 'in-process-runtime' | 'reply-tool' | 'system' {
  const src = metadata?.source;
  if (src === 'slack') return 'slack';
  if (src === 'web') return 'web';
  return 'system';
}
