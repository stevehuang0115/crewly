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

/**
 * Canonical conversationId synthesizer for Slack inbound/outbound
 * messages. Returns the chat-v2 channel id that both
 * `persistSlackInbound` (in slack-orchestrator-bridge.ts) and the
 * `/slack/send` controller agree on, so user inbound and agent
 * reply on the same Slack thread always land on the SAME chat-v2
 * channel.
 *
 * Shape: `slack-${channelId}-${threadTsWithDotsReplaced}`. The dot
 * in Slack timestamps (e.g. `1777760999.956969`) is replaced with
 * a hyphen because some downstream consumers (and the SLA
 * subscriber's reverse parsing at `request-sla.subscriber.ts:343`)
 * use the dot as a separator; replacing it removes the ambiguity.
 *
 * Extracted from 5 duplicated call sites (slack.controller × 2,
 * slack-orchestrator-bridge, agent-runner, agent-registration) per
 * the 2026-05-15 code-review P0 #1. Single source of truth
 * prevents format drift if Slack ever changes its ts shape.
 *
 * @param channelId - Slack channel id (e.g. `D0AC7NF5N7L`)
 * @param threadTs - Slack thread timestamp (e.g. `1777760999.956969`)
 * @returns The canonical chat-v2 channel id for the conversation
 *
 * @example
 * ```typescript
 * synthesizeSlackConversationId('D0AC7NF5N7L', '1777760999.956969')
 * // → 'slack-D0AC7NF5N7L-1777760999-956969'
 * ```
 */
export function synthesizeSlackConversationId(
  channelId: string,
  threadTs: string,
): string {
  return `slack-${channelId}-${String(threadTs).replace('.', '-')}`;
}

/**
 * Deterministic idempotency key for an OUTBOUND Slack reply mirrored into
 * chat-v2.
 *
 * The same orc reply is persisted by TWO independent paths and must land as a
 * single row:
 *   - `SlackService.recordOutboundToChatV2` (fires inside `sendMessage`,
 *     `metadata.source = 'slack'`)
 *   - the `/api/slack/send` controller's `recordSlackReplyBookkeeping`
 *     (`metadata.source = 'reply-tool'`)
 * Giving both calls the SAME `clientMessageId` makes `recordTurn` dedupe on
 * `(channel_id, clientMessageId)`, so the reply is stored once instead of
 * doubled (visible as duplicate bubbles in the merged Orchestrator timeline).
 *
 * Keyed on the Slack thread + a stable hash of the content because the posted
 * Slack message `ts` is not known to both call sites. Two genuinely-identical
 * replies in the same thread would collide (rare; the same trade-off the
 * optimistic-send dedup already makes).
 *
 * @param slackChannelId - Slack channel id (e.g. `D0AC7NF5N7L`)
 * @param slackThreadTs - Slack thread root timestamp
 * @param content - The reply text being persisted
 * @returns A stable `clientMessageId`, identical across both persist paths
 */
export function slackOutboundClientMessageId(
  slackChannelId: string,
  slackThreadTs: string,
  content: string,
): string {
  // djb2 (xor variant) — fast, stable, collision-resistant enough for dedup.
  let hash = 5381;
  const s = content ?? '';
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return `slack-out-${slackChannelId}-${slackThreadTs}-${hash.toString(36)}`;
}
