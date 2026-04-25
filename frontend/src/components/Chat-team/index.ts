/**
 * Chat-team — Slack-like multi-team chat surfaces (Phase B FE shell).
 *
 * Default export is `TeamChatPage`; named exports cover the empty-state
 * components and the mock-data helpers (so other consumers — Storybook,
 * future Portal — can render the same surfaces with their own seed).
 *
 * Phase B (this commit) is mock-only. Phase A backend (Sam, target
 * 2026-04-27 EOD) supplies the real workspace + conversation streams.
 */

export { TeamChatPage as default, TeamChatPage } from './TeamChatPage';
export type { TeamChatPageProps } from './TeamChatPage';
export {
  AgentOfflineBanner,
  NoChannelsEmptyState,
  NoMessagesEmptyState,
  NoTeamsEmptyState,
} from './EmptyStates';
export {
  MOCK_CONVERSATIONS_BY_WORKSPACE,
  MOCK_MENTIONABLES,
  MOCK_WORKSPACES,
  findMockConversation,
  getMockGroupsForWorkspace,
} from './mock-team-chat-data';
