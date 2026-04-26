/**
 * Public API surface smoke test.
 *
 * Confirms `@crewly/chat-ui` exports its named entry points so
 * downstream consumers (OSS frontend, Portal, future team-chat
 * surfaces) can import them by name. Catches accidental rename or
 * deletion of public symbols — those are semver-breaking changes that
 * Portal's file-dep would silently inherit.
 *
 * Phase B (2026-04-25) added the Slack-like surfaces (WorkspaceRail,
 * ConversationListPanel, MentionComposer) and broadened the
 * AgentStatusBadge vocabulary; they're explicitly checked below so
 * future refactors keep the surface stable.
 */

import { describe, it, expect } from 'vitest';
import * as PublicApi from './index';

describe('@crewly/chat-ui public API', () => {
  it('exports the existing chat primitives unchanged', () => {
    // Provider + components shipped before Phase B.
    expect(typeof PublicApi.ChatAPIProvider).toBe('function');
    expect(typeof PublicApi.useChatProviderMode).toBe('function');
    expect(typeof PublicApi.AgentStatusBadge).toBe('function');
    expect(typeof PublicApi.ChannelList).toBe('function');
    expect(typeof PublicApi.MessageThread).toBe('function');
    expect(typeof PublicApi.MessageInput).toBe('function');
  });

  it('exports the existing hooks unchanged', () => {
    expect(typeof PublicApi.useChannels).toBe('function');
    expect(typeof PublicApi.useMessages).toBe('function');
    expect(typeof PublicApi.useSendMessage).toBe('function');
    expect(typeof PublicApi.useAgentPresence).toBe('function');
  });

  it('exports the existing API primitives unchanged', () => {
    expect(typeof PublicApi.HttpChatApiClient).toBe('function');
    expect(typeof PublicApi.MockChatApiClient).toBe('function');
    expect(typeof PublicApi.ChatApiError).toBe('function');
    expect(typeof PublicApi.CHAT_API_ERROR_CODES).toBe('object');
  });

  it('exports the new Phase B Slack-like surfaces', () => {
    expect(typeof PublicApi.WorkspaceRail).toBe('function');
    expect(typeof PublicApi.ConversationListPanel).toBe('function');
    expect(typeof PublicApi.MentionComposer).toBe('function');
  });

  it('exports the Phase C derivation hooks + their pure helpers', () => {
    expect(typeof PublicApi.useGroupedChannels).toBe('function');
    expect(typeof PublicApi.buildConversationGroups).toBe('function');
    expect(typeof PublicApi.useObservedWorkspaces).toBe('function');
    expect(typeof PublicApi.buildObservedWorkspaces).toBe('function');
  });
});
