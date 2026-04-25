/**
 * Smoke test for the Chat-team module's public re-exports. Confirms
 * the named symbols stay stable as Phase B → Phase C → Phase D
 * extends the surface.
 */

import { describe, it, expect } from 'vitest';
import * as ChatTeam from './index';

describe('Chat-team module exports', () => {
  it('exports TeamChatPage as both named + default', () => {
    expect(typeof ChatTeam.TeamChatPage).toBe('function');
    expect(typeof ChatTeam.default).toBe('function');
    expect(ChatTeam.default).toBe(ChatTeam.TeamChatPage);
  });

  it('exports the 4 empty-state components', () => {
    expect(typeof ChatTeam.NoTeamsEmptyState).toBe('function');
    expect(typeof ChatTeam.NoChannelsEmptyState).toBe('function');
    expect(typeof ChatTeam.NoMessagesEmptyState).toBe('function');
    expect(typeof ChatTeam.AgentOfflineBanner).toBe('function');
  });

  it('exports the mock-data helpers', () => {
    expect(Array.isArray(ChatTeam.MOCK_WORKSPACES)).toBe(true);
    expect(Array.isArray(ChatTeam.MOCK_MENTIONABLES)).toBe(true);
    expect(typeof ChatTeam.MOCK_CONVERSATIONS_BY_WORKSPACE).toBe('object');
    expect(typeof ChatTeam.getMockGroupsForWorkspace).toBe('function');
    expect(typeof ChatTeam.findMockConversation).toBe('function');
  });
});
