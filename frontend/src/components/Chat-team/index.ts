/**
 * Chat-team — Slack-like multi-team chat surfaces.
 *
 * Phase B (PR #327) shipped the mock-only `TeamChatPage`. Phase C
 * (this commit) adds `LiveTeamChatPage` — the production-path
 * companion that drives the same primitives off real BE data via
 * `useChannels` + `useGroupedChannels` + `useObservedWorkspaces` from
 * `@crewly/chat-ui`.
 *
 * Default export remains `TeamChatPage` (mock seed) so existing tests
 * + Storybook entries keep working unchanged. Production callsites
 * (App.tsx) mount `LiveTeamChatPage` explicitly — that's the path
 * that exercises the Phase A backend wire.
 */

export { TeamChatPage as default, TeamChatPage } from './TeamChatPage';
export type { TeamChatPageProps } from './TeamChatPage';
export { LiveTeamChatPage } from './LiveTeamChatPage';
export type { LiveTeamChatPageProps } from './LiveTeamChatPage';
export { ChatErrorToast } from './ChatErrorToast';
export type { ChatErrorToastProps } from './ChatErrorToast';
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
