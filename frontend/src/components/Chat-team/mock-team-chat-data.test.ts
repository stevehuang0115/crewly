import { describe, it, expect } from 'vitest';
import {
  MOCK_WORKSPACES,
  MOCK_MENTIONABLES,
  MOCK_CONVERSATIONS_BY_WORKSPACE,
  findMockConversation,
  getMockGroupsForWorkspace,
} from './mock-team-chat-data';

describe('mock-team-chat-data', () => {
  it('declares at least one workspace per kind in scope', () => {
    expect(MOCK_WORKSPACES.find((w) => w.kind === 'activity')).toBeDefined();
    expect(MOCK_WORKSPACES.find((w) => !w.parentId && !w.kind)).toBeDefined();
    expect(MOCK_WORKSPACES.find((w) => w.parentId === 'org-crewly')).toBeDefined();
  });

  it('every nested workspace has an existing parent in the same dataset', () => {
    const ids = new Set(MOCK_WORKSPACES.map((w) => w.id));
    for (const w of MOCK_WORKSPACES) {
      if (!w.parentId) continue;
      expect(ids.has(w.parentId)).toBe(true);
    }
  });

  it('every workspace key in MOCK_CONVERSATIONS_BY_WORKSPACE matches a workspace id', () => {
    const ids = new Set(MOCK_WORKSPACES.map((w) => w.id));
    for (const key of Object.keys(MOCK_CONVERSATIONS_BY_WORKSPACE)) {
      expect(ids.has(key)).toBe(true);
    }
  });

  it('mentionables include both kinds and stable routing hints', () => {
    const teams = MOCK_MENTIONABLES.filter((m) => m.kind === 'team');
    const agents = MOCK_MENTIONABLES.filter((m) => m.kind === 'agent');
    expect(teams.length).toBeGreaterThan(0);
    expect(agents.length).toBeGreaterThan(0);
    for (const m of MOCK_MENTIONABLES) {
      expect(typeof m.routingHint).toBe('string');
    }
  });

  it('getMockGroupsForWorkspace returns the configured groups', () => {
    const groups = getMockGroupsForWorkspace('team-product');
    const labels = groups.map((g) => g.label);
    expect(labels).toContain('Channels');
    expect(labels).toContain('Direct Messages');
  });

  it('getMockGroupsForWorkspace returns empty array for unknown workspace', () => {
    expect(getMockGroupsForWorkspace('does-not-exist')).toEqual([]);
    expect(getMockGroupsForWorkspace(null)).toEqual([]);
  });

  it('findMockConversation locates a known channel by id', () => {
    const row = findMockConversation('channel-product-general');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('channel');
  });

  it('findMockConversation returns undefined for a missing id', () => {
    expect(findMockConversation('nope')).toBeUndefined();
    expect(findMockConversation(null)).toBeUndefined();
  });
});
