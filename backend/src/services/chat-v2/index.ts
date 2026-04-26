/**
 * Chat V2 service module barrel.
 *
 * @module services/chat-v2
 */

export { ChatV2Service, type ChatV2ServiceOptions } from './chat-v2.service.js';
export { loadChatV2Config, CHAT_V2_DEFAULTS, type ChatV2Config } from './config.js';
export { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
export {
  CHAT_ERROR_CODES,
  CHAT_CONTENT_TYPES,
  CHAT_SENDER_TYPES,
  ChatError,
  type ChatChannelDTO,
  type ChatMessageDTO,
  type ChatAttachmentDTO,
  type ChatPrincipal,
  type ChatContentType,
  type ChatSenderType,
  type ChatAgentPresenceStatus,
  type ChatErrorCode,
} from './types.js';
// Phase C BE.2 — mention dispatch routing scaffolding.
export {
  ChatV2MentionResolver,
  type MentionTarget,
  type MentionTargetKind,
  type MentionResolverContext,
  type MentionResolverDeps,
} from './chat-v2.mention-resolver.js';
