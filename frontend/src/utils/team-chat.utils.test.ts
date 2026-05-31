/**
 * Tests for the team-chat derivation helpers.
 *
 * @module utils/team-chat.utils.test
 */

import { describe, it, expect } from 'vitest';
import { buildTeamLabels, buildMentionables } from './team-chat.utils';
import type { Team, TeamMember } from '../types';

/** Build a minimal TeamMember fixture, overriding only what a test cares about. */
function member(overrides: Partial<TeamMember>): TeamMember {
  return {
    id: 'm1',
    name: 'Member One',
    sessionName: 'sess-m1',
    role: 'developer',
    systemPrompt: '',
    agentStatus: 'inactive',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Build a minimal Team fixture. */
function team(overrides: Partial<Team>): Team {
  return {
    id: 't1',
    name: 'Team One',
    members: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildTeamLabels', () => {
  it('maps team id to name', () => {
    const labels = buildTeamLabels([team({ id: 'a', name: 'Alpha' }), team({ id: 'b', name: 'Beta' })]);
    expect(labels).toEqual({ a: 'Alpha', b: 'Beta' });
  });

  it('skips teams with an empty name so the rail can fall back to the id', () => {
    const labels = buildTeamLabels([team({ id: 'a', name: '' })]);
    expect(labels).toEqual({});
  });

  it('returns an empty record for no teams', () => {
    expect(buildTeamLabels([])).toEqual({});
  });
});

describe('buildMentionables', () => {
  it('emits a team target then one agent target per member', () => {
    const targets = buildMentionables([
      team({
        id: 't1',
        name: 'Alpha',
        members: [member({ id: 'm1', name: 'Ann', sessionName: 'sess-ann', role: 'pm' })],
      }),
    ]);
    expect(targets).toEqual([
      { id: 't1', kind: 'team', label: 'Alpha', routingHint: 'Routes to the team leader' },
      {
        id: 'm1',
        kind: 'agent',
        label: 'Ann',
        routingHint: 'pm',
        presence: 'offline',
        agentSession: 'sess-ann',
      },
    ]);
  });

  it('maps agent status to presence', () => {
    const targets = buildMentionables([
      team({
        id: 't1',
        members: [
          member({ id: 'a', sessionName: 'sa', agentStatus: 'active' }),
          member({ id: 'b', sessionName: 'sb', agentStatus: 'starting' }),
          member({ id: 'c', sessionName: 'sc', agentStatus: 'suspended' }),
        ],
      }),
    ]);
    const byId = Object.fromEntries(targets.filter((t) => t.kind === 'agent').map((t) => [t.id, t.presence]));
    expect(byId).toEqual({ a: 'online', b: 'idle', c: 'offline' });
  });

  it('de-duplicates a member shared across teams (by session name)', () => {
    const shared = member({ id: 'm1', sessionName: 'shared-sess' });
    const targets = buildMentionables([
      team({ id: 't1', name: 'One', members: [shared] }),
      team({ id: 't2', name: 'Two', members: [shared] }),
    ]);
    const agents = targets.filter((t) => t.kind === 'agent');
    expect(agents).toHaveLength(1);
    // both team rows still present
    expect(targets.filter((t) => t.kind === 'team')).toHaveLength(2);
  });

  it('tolerates a team with no members array', () => {
    const targets = buildMentionables([team({ id: 't1', name: 'Alpha', members: undefined as unknown as TeamMember[] })]);
    expect(targets).toEqual([
      { id: 't1', kind: 'team', label: 'Alpha', routingHint: 'Routes to the team leader' },
    ]);
  });
});
