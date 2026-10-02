/**
 * Tests for the Dashboard helpers (agent lookup, crew snapshot, inline answers).
 */
import { describe, it, expect } from 'vitest';
import type { Team, TeamMember } from '@/types';
import { buildAgentDirectory, buildCrewSnapshot, resolveAgent, splitDecisionOptions } from './dashboard.utils';

function member(over: Partial<TeamMember>): TeamMember {
  return {
    id: over.sessionName ?? 'm',
    name: 'Agent',
    sessionName: 's',
    role: 'developer',
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}

function team(name: string, members: TeamMember[]): Team {
  return { id: name, name, members, createdAt: '', updatedAt: '' } as unknown as Team;
}

const teams = [
  team('CE', [
    member({ name: 'Owen', sessionName: 'ce-owen' }),
    member({ name: 'Vera', sessionName: 'ce-vera', workingStatus: 'in_progress' }),
    member({ name: 'Sam', sessionName: 'ce-sam' }),
    member({ name: 'Off', sessionName: 'ce-off', agentStatus: 'inactive' }),
  ]),
  team('Think Tank', [member({ name: 'Atlas', sessionName: 'tt-atlas' })]),
];

describe('buildAgentDirectory / resolveAgent', () => {
  it('maps sessions to name and team; the orchestrator and unknown sessions fall back', () => {
    const dir = buildAgentDirectory(teams);
    expect(resolveAgent('tt-atlas', dir)).toEqual({ name: 'Atlas', team: 'Think Tank' });
    expect(resolveAgent('crewly-orc@mac', dir)).toEqual({ name: 'Orchestrator' });
    expect(resolveAgent('gone-1', dir)).toEqual({ name: 'gone-1' });
  });
});

describe('buildCrewSnapshot', () => {
  it('working = up and busy or holding a running run; idle = up and neither; stopped left out', () => {
    const snap = buildCrewSnapshot(teams, [
      { target: 'ce-owen', status: 'running', title: 'working on CE-81', startedAt: '2026-10-02T10:00:00Z' },
      { target: 'ce-owen', status: 'running', title: 'older run', startedAt: '2026-10-01T10:00:00Z' },
      { target: 'ce-off', status: 'running', title: 'ignored: session down' },
      { target: 'ce-sam', status: 'done', title: 'not running' },
    ]);
    expect(snap.working).toEqual([
      { session: 'ce-owen', name: 'Owen', team: 'CE', doing: 'working on CE-81' },
      { session: 'ce-vera', name: 'Vera', team: 'CE', doing: null },
    ]);
    expect(snap.idle).toEqual(['Sam', 'Atlas']);
  });
});

describe('splitDecisionOptions', () => {
  it('shows the first two answers and moves "Reply in thread" and the rest to ⋯', () => {
    const { inline, more } = splitDecisionOptions({
      defaultKey: 'wait',
      options: [{ key: 'a', label: 'Yes' }, { key: 'b', label: 'No' }, { key: 'c', label: 'Reply in thread' }],
    });
    expect(inline.map((o) => o.key)).toEqual(['a', 'b']);
    expect(more.map((o) => o.key)).toEqual(['c']);
  });

  it('lifts the default answer inline when it would otherwise be hidden', () => {
    const { inline, more } = splitDecisionOptions({
      defaultKey: 'c',
      options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }],
    });
    expect(inline.map((o) => o.key)).toEqual(['c', 'a']);
    expect(more.map((o) => o.key)).toEqual(['b']);
  });
});
