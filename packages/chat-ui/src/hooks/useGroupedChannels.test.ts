/**
 * useGroupedChannels tests — exercise the pure `buildConversationGroups`
 * helper across the partition / scoping / sort cases the FE relies on.
 */

import { describe, it, expect } from 'vitest';
import type { Channel } from '../types/chat.types';
import { buildConversationGroups } from './useGroupedChannels';

const ISO_NOW = '2026-04-25T20:00:00.000Z';
const ISO_OLDER = '2026-04-25T18:00:00.000Z';

const channelGeneral: Channel = {
  id: 'ch-product-general',
  agentSession: '',
  name: 'general',
  createdAt: ISO_OLDER,
  type: 'channel',
  teamId: 'team-product',
  lastMessageAt: ISO_OLDER,
};

const channelOnboarding: Channel = {
  id: 'ch-product-onboarding',
  agentSession: '',
  name: 'proj-onboarding',
  createdAt: ISO_OLDER,
  type: 'channel',
  teamId: 'team-product',
  projectId: 'proj-onboarding',
  lastMessageAt: ISO_NOW,
};

const channelMarketing: Channel = {
  id: 'ch-marketing-general',
  agentSession: '',
  name: 'general',
  createdAt: ISO_OLDER,
  type: 'channel',
  teamId: 'team-marketing',
};

const dmSam: Channel = {
  id: 'ch-dm-sam',
  agentSession: 'crewly-product-sam',
  name: 'Sam',
  createdAt: ISO_OLDER,
  type: 'dm',
  targetMemberId: 'member-sam',
  lastMessageAt: ISO_NOW,
  presence: 'online',
};

const dmEla: Channel = {
  id: 'ch-dm-ella',
  agentSession: 'crewly-marketing-ella',
  name: 'Ella',
  createdAt: ISO_OLDER,
  type: 'dm',
  presence: 'busy',
};

describe('buildConversationGroups', () => {
  it('produces three stable groups with the right ids/labels', () => {
    const groups = buildConversationGroups([]);
    expect(groups).toHaveLength(3);
    expect(groups[0].id).toBe('channels');
    expect(groups[0].label).toBe('Channels');
    expect(groups[1].id).toBe('huddles');
    expect(groups[1].label).toBe('Huddles');
    expect(groups[2].id).toBe('dms');
    expect(groups[2].label).toBe('Direct Messages');
  });

  it('partitions channel-typed rows into Channels and dm rows into DMs', () => {
    const groups = buildConversationGroups([
      channelGeneral,
      dmSam,
      channelOnboarding,
      dmEla,
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual([
      // Sorted by recency desc — onboarding (now) before general (older).
      'ch-product-onboarding',
      'ch-product-general',
    ]);
    expect(groups[2].rows.map((r) => r.id)).toEqual([
      // dmSam has a lastMessageAt → it comes first; dmEla has none →
      // sorted by name fallback.
      'ch-dm-sam',
      'ch-dm-ella',
    ]);
  });

  it('routes huddle-typed rows into the workspace-agnostic Group Chats group', () => {
    const huddle: Channel = {
      id: 'ch-huddle-launch',
      agentSession: '',
      name: 'Launch crew',
      createdAt: ISO_OLDER,
      type: 'huddle',
    };
    // Even with a team workspace selected, the huddle surfaces (not team-scoped).
    const groups = buildConversationGroups([channelGeneral, huddle], {
      workspaceId: 'team-product',
    });
    const huddles = groups.find((g) => g.id === 'huddles')!;
    expect(huddles.rows.map((r) => r.id)).toEqual(['ch-huddle-launch']);
    expect(huddles.rows[0].kind).toBe('channel');
  });

  it('scopes Channels to the active workspaceId; DMs always flow', () => {
    const groups = buildConversationGroups(
      [channelGeneral, channelMarketing, dmSam, dmEla],
      { workspaceId: 'team-product' },
    );
    // Only product-team channels in the Channels group.
    expect(groups[0].rows.map((r) => r.id)).toEqual(['ch-product-general']);
    // DMs are workspace-agnostic — both surface regardless of teamId.
    expect(groups[2].rows.map((r) => r.id)).toEqual(['ch-dm-sam', 'ch-dm-ella']);
  });

  it('treats a legacy channel without `type` as a DM (backwards-compat)', () => {
    const legacy: Channel = {
      id: 'ch-legacy',
      agentSession: 'crewly-legacy',
      name: 'Legacy Agent',
      createdAt: ISO_OLDER,
      // no `type` field — pre-Phase B row
    };
    const groups = buildConversationGroups([legacy]);
    expect(groups[0].rows).toHaveLength(0);
    expect(groups[2].rows).toEqual([
      expect.objectContaining({ id: 'ch-legacy', kind: 'dm' }),
    ]);
  });

  it('drops Channels not matching the workspaceId without affecting input', () => {
    const input = [channelGeneral, channelMarketing];
    const groups = buildConversationGroups(input, { workspaceId: 'team-marketing' });
    expect(groups[0].rows.map((r) => r.id)).toEqual(['ch-marketing-general']);
    // Input array is not mutated.
    expect(input).toEqual([channelGeneral, channelMarketing]);
  });

  it('maps DM rows with the agent session + presence so the panel can render badges', () => {
    const groups = buildConversationGroups([dmSam]);
    const row = groups[2].rows[0];
    expect(row.kind).toBe('dm');
    expect(row.agentSession).toBe('crewly-product-sam');
    expect(row.presence).toBe('online');
  });

  it('omits agentSession and presence on channel rows', () => {
    const groups = buildConversationGroups([channelGeneral]);
    const row = groups[0].rows[0];
    expect(row.kind).toBe('channel');
    expect(row.agentSession).toBeUndefined();
    expect(row.presence).toBeUndefined();
  });

  it('falls back to alphabetical when no row has a lastMessageAt', () => {
    const a: Channel = { id: 'a', agentSession: 'a', name: 'Banana', createdAt: ISO_OLDER, type: 'dm' };
    const b: Channel = { id: 'b', agentSession: 'b', name: 'Apple', createdAt: ISO_OLDER, type: 'dm' };
    const groups = buildConversationGroups([a, b]);
    // Apple sorts before Banana alphabetically.
    expect(groups[2].rows.map((r) => r.title)).toEqual(['Apple', 'Banana']);
  });
});
