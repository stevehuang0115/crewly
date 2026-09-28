/**
 * Tests for the agent roster reported to Crewly Cloud.
 */
import { describe, it, expect } from '@jest/globals';
import type { Team } from '../../types/index.js';
import { buildAgentRoster } from './agent-roster.utils.js';

function team(name: string, members: Array<Record<string, unknown>>): Team {
  return { id: `t-${name}`, name, members } as unknown as Team;
}

describe('buildAgentRoster', () => {
  it('lists the orchestrator first under its local session name', () => {
    expect(buildAgentRoster([])).toEqual([{ agentSession: 'crewly-orc', displayName: 'Crewly Orc', role: 'orchestrator' }]);
  });

  it('adds every team member with its session, display name, role and team', () => {
    const roster = buildAgentRoster([
      team('Web', [
        { id: 'm1', name: 'Ella', role: 'developer', sessionName: 'web-ella' },
        { id: 'm2', name: 'Sam', role: 'qa', agentId: 'agent-sam' },
      ]),
    ]);
    expect(roster.slice(1)).toEqual([
      { agentSession: 'web-ella', displayName: 'Ella', role: 'developer', teamName: 'Web' },
      { agentSession: 'agent-sam', displayName: 'Sam', role: 'qa', teamName: 'Web' },
    ]);
  });

  it('skips orchestrator-role members, members without an id and duplicates', () => {
    const roster = buildAgentRoster([
      team('A', [
        { id: 'o', name: 'Orc', role: 'orchestrator', sessionName: 'crewly-orc' },
        { name: 'ghost', role: 'developer', sessionName: 'ghost' },
        { id: 'm1', name: 'Ella', role: 'developer', sessionName: 'ella' },
      ]),
      team('B', [{ id: 'm9', name: 'Ella again', role: 'developer', sessionName: 'ella' }]),
    ]);
    expect(roster.map((r) => r.agentSession)).toEqual(['crewly-orc', 'ella']);
  });
});
