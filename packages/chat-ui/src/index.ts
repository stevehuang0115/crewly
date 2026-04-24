/**
 * @crewly/chat-ui — public API surface.
 *
 * This is the ONLY entry point consumers should import from. Anything
 * reachable through a deeper path is considered internal and may change
 * without a semver bump.
 */

// Provider
export { ChatAPIProvider, useChatProviderMode } from './context/ChatAPIProvider';
export type { ChatAPIProviderProps } from './context/ChatAPIProvider';

// Components
export { AgentStatusBadge } from './components/AgentStatusBadge';
export type { AgentStatusBadgeProps } from './components/AgentStatusBadge';
export { ChannelList } from './components/ChannelList';
export type { ChannelListProps } from './components/ChannelList';
export { MessageThread } from './components/MessageThread';
export type { MessageThreadProps } from './components/MessageThread';
export { MessageInput } from './components/MessageInput';
export type { MessageInputProps } from './components/MessageInput';

// Hooks
export { useChannels } from './hooks/useChannels';
export type { UseChannelsResult } from './hooks/useChannels';
export { useMessages } from './hooks/useMessages';
export type { UseMessagesResult } from './hooks/useMessages';
export { useSendMessage } from './hooks/useSendMessage';
export type { UseSendMessageResult } from './hooks/useSendMessage';
export { useAgentPresence } from './hooks/useAgentPresence';
export type { UseAgentPresenceResult } from './hooks/useAgentPresence';

// API primitives (advanced: e.g. tests that want to inject a custom client)
export { HttpChatApiClient } from './api/client';
export type { ChatApiClient, ChannelSubscription, HttpClientOptions } from './api/client';
export { MockChatApiClient } from './api/mock-client';
export type { MockClientOptions } from './api/mock-client';
export { ChatApiError, CHAT_API_ERROR_CODES } from './api/errors';
export type { ChatApiErrorCode } from './api/errors';

// Types — stable public contract with Sam's backend
export type {
  AgentPresence,
  AgentPresenceStatus,
  Channel,
  CreateChannelInput,
  Message,
  MessageAttachment,
  MessageAuthorRole,
  MessagePage,
  SendMessageInput,
  ChatWebsocketEvent,
} from './types/chat.types';
