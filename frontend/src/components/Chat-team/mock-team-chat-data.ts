/**
 * Mock data for the Slack-like Team Chat FE shell (Phase B).
 *
 * Used by `TeamChatPage` until Sam's Phase A backend ships (target
 * 2026-04-27 EOD). Once the BE APIs land, this file is replaced (or
 * downgraded to fixture seed for tests + Storybook) by data the page
 * fetches via `services/api.service.ts` calls.
 *
 * Shapes match the contracts exported from `@crewly/chat-ui`:
 *   Workspace, ConversationGroup, MentionTarget.
 *
 * @module components/Chat-team/mock-team-chat-data
 */

import type {
  ConversationGroup,
  MentionTarget,
  Workspace,
} from '@crewly/chat-ui';

/**
 * Workspaces visible in the WorkspaceRail. Includes the cross-team
 * Activity entry per design §4.3 + an "org-crewly" parent grouping
 * the two product teams (per §6.1 nested grouping).
 */
export const MOCK_WORKSPACES: Workspace[] = [
  {
    id: 'activity',
    name: 'All DMs',
    kind: 'activity',
    unreadCount: 3,
  },
  {
    id: 'org-crewly',
    name: 'Crewly',
    initials: 'CR',
  },
  {
    id: 'team-product',
    name: 'Crewly Product',
    parentId: 'org-crewly',
    presence: 'online',
    unreadCount: 2,
  },
  {
    id: 'team-marketing',
    name: 'Crewly Marketing',
    parentId: 'org-crewly',
    unreadCount: 5,
    hasMentions: true,
  },
];

/**
 * Conversation groups keyed by workspace id. The center panel shows the
 * groups for whichever workspace is selected.
 */
export const MOCK_CONVERSATIONS_BY_WORKSPACE: Record<string, ConversationGroup[]> = {
  activity: [
    {
      id: 'activity',
      label: 'Activity',
      rows: [
        {
          id: 'activity-mention-sam',
          kind: 'activity',
          title: 'Sam mentioned you in #proj-onboarding',
          subtitle: 'Crewly Product',
          lastMessageAt: new Date(Date.now() - 8 * 60_000).toISOString(),
          mentionCount: 1,
        },
        {
          id: 'activity-dm-luna',
          kind: 'activity',
          title: 'Luna replied to your DM',
          subtitle: 'Crewly Marketing',
          lastMessageAt: new Date(Date.now() - 25 * 60_000).toISOString(),
          unreadCount: 2,
        },
      ],
    },
  ],
  'org-crewly': [
    {
      id: 'channels',
      label: 'Channels',
      rows: [
        {
          id: 'channel-org-announcements',
          kind: 'channel',
          title: 'announcements',
          lastMessagePreview: 'Q2 OKR review ships Monday.',
          lastMessageAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        },
      ],
    },
  ],
  'team-product': [
    {
      id: 'channels',
      label: 'Channels',
      rows: [
        {
          id: 'channel-product-general',
          kind: 'channel',
          title: 'general',
          lastMessagePreview: 'kicking off Phase A',
          lastMessageAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          unreadCount: 0,
        },
        {
          id: 'channel-product-onboarding',
          kind: 'channel',
          title: 'proj-onboarding',
          lastMessagePreview: 'Mia: design draft pinned',
          lastMessageAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          unreadCount: 2,
        },
      ],
    },
    {
      id: 'dms',
      label: 'Direct Messages',
      rows: [
        {
          id: 'dm-product-sam',
          kind: 'dm',
          title: 'Sam',
          presence: 'online',
          agentSession: 'crewly-product-sam-dd2b46f7',
          lastMessagePreview: 'PR #326 ready for your review',
          lastMessageAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          unreadCount: 1,
          mentionCount: 1,
        },
        {
          id: 'dm-product-max',
          kind: 'dm',
          title: 'Max',
          presence: 'inactive',
          agentSession: 'crewly-product-max-c69ce8e6',
          lastMessagePreview: 'Will resume after the THW PR merges',
          lastMessageAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
        },
      ],
    },
  ],
  'team-marketing': [
    {
      id: 'channels',
      label: 'Channels',
      rows: [
        {
          id: 'channel-marketing-general',
          kind: 'channel',
          title: 'general',
          lastMessagePreview: '@team blog post outline ready',
          lastMessageAt: new Date(Date.now() - 15 * 60_000).toISOString(),
          unreadCount: 4,
          mentionCount: 1,
        },
      ],
    },
    {
      id: 'dms',
      label: 'Direct Messages',
      rows: [
        {
          id: 'dm-marketing-luna',
          kind: 'dm',
          title: 'Luna',
          presence: 'idle',
          lastMessagePreview: 'Drafting the announcement copy',
          lastMessageAt: new Date(Date.now() - 22 * 60_000).toISOString(),
          unreadCount: 1,
        },
      ],
    },
  ],
};

/**
 * Flat list of @-mention targets — passed to MentionComposer. Includes
 * both team rollups and individual agents per design §7.2.
 */
export const MOCK_MENTIONABLES: MentionTarget[] = [
  {
    id: 'team-product',
    kind: 'team',
    label: 'Crewly Product',
    routingHint: 'Team lead responds',
  },
  {
    id: 'team-marketing',
    kind: 'team',
    label: 'Crewly Marketing',
    routingHint: 'Team lead responds',
  },
  {
    id: 'sam',
    kind: 'agent',
    label: 'Sam',
    presence: 'online',
    agentSession: 'crewly-product-sam-dd2b46f7',
    routingHint: 'Direct ping',
  },
  {
    id: 'max',
    kind: 'agent',
    label: 'Max',
    presence: 'inactive',
    agentSession: 'crewly-product-max-c69ce8e6',
    routingHint: 'Direct ping (queues)',
  },
  {
    id: 'leo',
    kind: 'agent',
    label: 'Leo',
    presence: 'online',
    agentSession: 'crewly-product-leo-62440736',
    routingHint: 'Direct ping',
  },
  {
    id: 'mia',
    kind: 'agent',
    label: 'Mia',
    presence: 'idle',
    routingHint: 'Direct ping',
  },
  {
    id: 'luna',
    kind: 'agent',
    label: 'Luna',
    presence: 'idle',
    routingHint: 'Direct ping',
  },
];

/**
 * Helper — get conversation groups for a given workspace, or empty
 * array. Wrapped so tests + the page share one source of truth.
 */
export function getMockGroupsForWorkspace(workspaceId: string | null): ConversationGroup[] {
  if (!workspaceId) return [];
  return MOCK_CONVERSATIONS_BY_WORKSPACE[workspaceId] ?? [];
}

/**
 * Look up a conversation row by id across the entire mock dataset.
 * Returns undefined when not found.
 */
export function findMockConversation(conversationId: string | null) {
  if (!conversationId) return undefined;
  for (const groups of Object.values(MOCK_CONVERSATIONS_BY_WORKSPACE)) {
    for (const group of groups) {
      const hit = group.rows.find((r) => r.id === conversationId);
      if (hit) return hit;
    }
  }
  return undefined;
}
