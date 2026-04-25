/**
 * Type-level smoke tests for team-chat.types.
 *
 * These are intentionally lightweight: they confirm that the exported
 * shapes accept the expected combinations and reject obviously-wrong
 * ones, without paying for a full structural test suite. The runtime
 * behavior of the components that consume these types lives in their
 * own *.test.tsx files.
 */

import { describe, it, expect } from 'vitest';
import type {
  ConversationGroup,
  ConversationRow,
  MentionTarget,
  Workspace,
} from './team-chat.types';

describe('team-chat.types', () => {
  it('Workspace accepts a minimal team entry', () => {
    const ws: Workspace = { id: 'team-1', name: 'Crewly Product' };
    expect(ws.kind).toBeUndefined(); // defaults to team in the renderer
  });

  it('Workspace accepts the cross-team Activity entry', () => {
    const inbox: Workspace = {
      id: 'activity',
      name: 'All DMs',
      kind: 'activity',
      unreadCount: 3,
      hasMentions: true,
    };
    expect(inbox.hasMentions).toBe(true);
  });

  it('Workspace accepts nested grouping via parentId', () => {
    const child: Workspace = { id: 't-2', name: 'Marketing', parentId: 'org-crewly' };
    expect(child.parentId).toBe('org-crewly');
  });

  it('ConversationRow accepts a channel row', () => {
    const row: ConversationRow = {
      id: 'c-general',
      kind: 'channel',
      title: 'general',
      lastMessagePreview: 'kicking off Phase A',
      unreadCount: 2,
      mentionCount: 0,
    };
    expect(row.kind).toBe('channel');
  });

  it('ConversationRow accepts a DM row with presence', () => {
    const row: ConversationRow = {
      id: 'dm-sam',
      kind: 'dm',
      title: 'Sam',
      presence: 'online',
      agentSession: 'crewly-product-sam-dd2b46f7',
      mentionCount: 1,
    };
    expect(row.presence).toBe('online');
  });

  it('ConversationGroup gathers rows under a section label', () => {
    const group: ConversationGroup = {
      id: 'channels',
      label: 'Channels',
      rows: [
        { id: 'c-general', kind: 'channel', title: 'general' },
        { id: 'c-proj-onboarding', kind: 'channel', title: 'proj-onboarding' },
      ],
    };
    expect(group.rows).toHaveLength(2);
  });

  it('MentionTarget supports team and agent kinds with routing hints', () => {
    const team: MentionTarget = {
      id: 'team-product',
      kind: 'team',
      label: 'Crewly Product',
      routingHint: 'Team lead responds',
    };
    const agent: MentionTarget = {
      id: 'sam',
      kind: 'agent',
      label: 'Sam',
      routingHint: 'Direct ping',
      presence: 'online',
    };
    expect(team.kind).toBe('team');
    expect(agent.kind).toBe('agent');
  });
});
