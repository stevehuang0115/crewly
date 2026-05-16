/**
 * Tests for team.utils — canonical pickTeamLead resolver.
 *
 * Covers all 4 cascade rules + the empty-members null path. The same
 * resolver is consumed by chat-v2.mention-resolver and mission-reminder,
 * so regressions here block both consumers.
 */

import { describe, it, expect } from '@jest/globals';
import { pickTeamLead } from './team.utils.js';
import type { Team, TeamMember } from '../types/index.js';

const baseMember = (overrides: Partial<TeamMember>): TeamMember =>
  ({
    id: 'm-' + (overrides.id ?? Math.random().toString(36).slice(2, 8)),
    name: 'Member',
    sessionName: 'session',
    role: 'developer',
    hierarchyLevel: 2,
    canDelegate: false,
    ...overrides,
  } as TeamMember);

const mkTeam = (members: TeamMember[]): Team =>
  ({
    id: 't-1',
    name: 'Test Team',
    members,
  } as Team);

describe('pickTeamLead', () => {
  it('rule 1: prefers hierarchyLevel=1 + canDelegate=true', () => {
    const tl = baseMember({ id: 'tl', hierarchyLevel: 1, canDelegate: true, role: 'team-leader' });
    const dev = baseMember({ id: 'dev', canDelegate: true });
    const role = baseMember({ id: 'role', role: 'team-leader' });
    const team = mkTeam([dev, role, tl]);

    expect(pickTeamLead(team)?.id).toBe('tl');
  });

  it('rule 2: falls back to canDelegate=true at any level', () => {
    const dev = baseMember({ id: 'dev', canDelegate: true, hierarchyLevel: 2 });
    const role = baseMember({ id: 'role', role: 'team-leader' });
    const member = baseMember({ id: 'm1' });
    const team = mkTeam([member, role, dev]);

    expect(pickTeamLead(team)?.id).toBe('dev');
  });

  it('rule 3: falls back to role=team-leader when no canDelegate', () => {
    const role = baseMember({ id: 'role', role: 'team-leader' });
    const member = baseMember({ id: 'm1' });
    const team = mkTeam([member, role]);

    expect(pickTeamLead(team)?.id).toBe('role');
  });

  it('rule 4: falls back to first member when no other rule matches', () => {
    const m1 = baseMember({ id: 'm1' });
    const m2 = baseMember({ id: 'm2' });
    const team = mkTeam([m1, m2]);

    expect(pickTeamLead(team)?.id).toBe('m1');
  });

  // Issue #332: rule-4 fallback must emit a warn so missing hierarchy
  // data surfaces in observability. Rules 1-3 must stay silent.
  describe('observability (#332)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    function countTeamUtilsWarns(): number {
      return warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('pickTeamLead falling back to first member'),
      ).length;
    }

    it('rule-1 (hierarchy TL) does NOT warn', () => {
      const tl = baseMember({ id: 'tl', hierarchyLevel: 1, canDelegate: true });
      const other = baseMember({ id: 'dev' });
      const team = mkTeam([other, tl]);
      pickTeamLead(team);
      expect(countTeamUtilsWarns()).toBe(0);
    });

    it('rule-2 (canDelegate) does NOT warn', () => {
      const tl = baseMember({ id: 'tl', canDelegate: true });
      const team = mkTeam([tl]);
      pickTeamLead(team);
      expect(countTeamUtilsWarns()).toBe(0);
    });

    it('rule-3 (role=team-leader) does NOT warn', () => {
      const tl = baseMember({ id: 'tl', role: 'team-leader' });
      const team = mkTeam([tl]);
      pickTeamLead(team);
      expect(countTeamUtilsWarns()).toBe(0);
    });

    it('rule-4 (first member fallback) DOES warn', () => {
      const m1 = baseMember({ id: 'm1' });
      const m2 = baseMember({ id: 'm2' });
      const team = mkTeam([m1, m2]);
      pickTeamLead(team);
      expect(countTeamUtilsWarns()).toBe(1);
    });
  });

  it('returns null when team has no members', () => {
    const team = mkTeam([]);
    expect(pickTeamLead(team)).toBeNull();
  });

  it('returns null when team.members is undefined', () => {
    const team = { id: 't-1', name: 'Empty', members: undefined } as unknown as Team;
    expect(pickTeamLead(team)).toBeNull();
  });
});
