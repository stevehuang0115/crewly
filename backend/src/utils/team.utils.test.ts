/**
 * Tests for team.utils — the one team-lead rule (getTeamLeadIds /
 * isTeamLead), its stored form (normalizeTeamLeaderIds), setTeamLead, and
 * the pickTeamLead routing resolver built on it. The resolver is consumed by
 * chat-v2.mention-resolver, mission-reminder, the event bridge and more, so
 * regressions here block all of them.
 */

import { describe, it, expect } from '@jest/globals';
import {
  canMemberDelegate,
  getLeadSubordinates,
  getTeamLeadIds,
  isLeadRole,
  isTeamLead,
  normalizeTeamLeaderIds,
  pickTeamLead,
  setTeamLead,
} from './team.utils.js';
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

  it('a lead by the rule wins over a canDelegate-only member', () => {
    const dev = baseMember({ id: 'dev', canDelegate: true, hierarchyLevel: 2 });
    const role = baseMember({ id: 'role', role: 'team-leader' });
    const member = baseMember({ id: 'm1' });
    const team = mkTeam([member, role, dev]);

    expect(pickTeamLead(team)?.id).toBe('role');
  });

  it('rule 2: falls back to canDelegate=true when the team has no lead', () => {
    const dev = baseMember({ id: 'dev', canDelegate: true, hierarchyLevel: 2 });
    const member = baseMember({ id: 'm1' });
    expect(pickTeamLead(mkTeam([member, dev]))?.id).toBe('dev');
  });

  it('explicit leaderIds win over roles', () => {
    const owen = baseMember({ id: 'owen', role: 'tech-lead' });
    const vera = baseMember({ id: 'vera' });
    expect(pickTeamLead({ ...mkTeam([owen, vera]), leaderIds: ['vera'] } as Team)?.id).toBe('vera');
  });

  it('a tech-lead leads a team without leaderIds (CE / Owen)', () => {
    const owen = baseMember({ id: 'owen', role: 'tech-lead' });
    const nova = baseMember({ id: 'nova', role: 'content-strategist' as TeamMember['role'] });
    expect(pickTeamLead(mkTeam([nova, owen]))?.id).toBe('owen');
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

describe('getTeamLeadIds / isTeamLead — the one rule', () => {
  const owen = baseMember({ id: 'owen', role: 'tech-lead' });
  const vera = baseMember({ id: 'vera', role: 'developer' });
  const nova = baseMember({ id: 'nova', role: 'content-strategist' as TeamMember['role'] });

  it('uses explicit leaderIds', () => {
    const team = { ...mkTeam([owen, vera, nova]), leaderIds: ['vera', 'nova'] } as Team;
    expect(getTeamLeadIds(team)).toEqual(['vera', 'nova']);
    expect(isTeamLead(team, owen)).toBe(false);
    expect(isTeamLead(team, vera)).toBe(true);
  });

  it('falls back to the legacy leaderId', () => {
    const team = { ...mkTeam([owen, vera]), leaderId: 'vera' } as Team;
    expect(getTeamLeadIds(team)).toEqual(['vera']);
  });

  it('falls back to lead roles, tech-lead included', () => {
    expect(getTeamLeadIds(mkTeam([vera, owen, nova]))).toEqual(['owen']);
    const tl = baseMember({ id: 'tl', role: 'team-leader' });
    expect(getTeamLeadIds(mkTeam([vera, tl, owen]))).toEqual(['tl', 'owen']);
  });

  it('ignores explicit ids of members no longer on the team', () => {
    const team = { ...mkTeam([owen, vera]), leaderIds: ['gone'], leaderId: 'gone' } as Team;
    expect(getTeamLeadIds(team)).toEqual(['owen']);
  });

  it('returns nothing when the team has no lead', () => {
    expect(getTeamLeadIds(mkTeam([vera, nova]))).toEqual([]);
    expect(isTeamLead(mkTeam([vera, nova]), vera)).toBe(false);
  });

  it('canDelegate alone does not make a lead', () => {
    const d = baseMember({ id: 'd', canDelegate: true });
    expect(isTeamLead(mkTeam([d, vera]), d)).toBe(false);
    expect(canMemberDelegate(mkTeam([d, vera]), d)).toBe(true);
    expect(canMemberDelegate(mkTeam([owen, vera]), owen)).toBe(true);
    expect(canMemberDelegate(mkTeam([owen, vera]), vera)).toBe(false);
  });

  it('isLeadRole knows both lead roles', () => {
    expect(isLeadRole('team-leader')).toBe(true);
    expect(isLeadRole('tech-lead')).toBe(true);
    expect(isLeadRole('developer')).toBe(false);
    expect(isLeadRole(undefined)).toBe(false);
  });
});

describe('normalizeTeamLeaderIds — stored lead migration', () => {
  it('stores the lead-role member as leaderIds + leaderId, idempotently', () => {
    const team = mkTeam([baseMember({ id: 'vera' }), baseMember({ id: 'owen', role: 'tech-lead' })]);
    expect(normalizeTeamLeaderIds(team)).toBe(true);
    expect(team.leaderIds).toEqual(['owen']);
    expect(team.leaderId).toBe('owen');
    const snapshot = JSON.stringify(team);
    expect(normalizeTeamLeaderIds(team)).toBe(false);
    expect(JSON.stringify(team)).toBe(snapshot);
  });

  it('never changes the rule\'s answer', () => {
    const team = { ...mkTeam([baseMember({ id: 'owen', role: 'tech-lead' }), baseMember({ id: 'vera' })]), leaderIds: ['vera'] } as Team;
    const before = getTeamLeadIds(team);
    normalizeTeamLeaderIds(team);
    expect(getTeamLeadIds(team)).toEqual(before);
    expect(team.leaderIds).toEqual(['vera']);
    expect(team.leaderId).toBe('vera');
  });

  it('migrates a legacy leaderId to leaderIds', () => {
    const team = { ...mkTeam([baseMember({ id: 'vera' })]), leaderId: 'vera' } as Team;
    normalizeTeamLeaderIds(team);
    expect(team.leaderIds).toEqual(['vera']);
  });

  it('leaves a team with no lead alone', () => {
    const team = mkTeam([baseMember({ id: 'vera' })]);
    expect(normalizeTeamLeaderIds(team)).toBe(false);
    expect(team.leaderIds).toBeUndefined();
    expect(team.leaderId).toBeUndefined();
  });
});

describe('setTeamLead', () => {
  const mk = () =>
    mkTeam([
      baseMember({ id: 'owen', role: 'tech-lead' }),
      baseMember({ id: 'vera' }),
      baseMember({ id: 'nova', parentMemberId: 'owen' }),
    ]);

  it('set: the member becomes THE lead, reports move to it, the old lead loses the delegation flag', () => {
    const team = mk();
    const r = setTeamLead(team, 'vera');
    expect(r).toEqual({ before: ['owen'], after: ['vera'], changed: true });
    expect(team.leaderIds).toEqual(['vera']);
    expect(team.leaderId).toBe('vera');
    expect(isTeamLead(team, team.members[0])).toBe(false);
    const byId = (id: string) => team.members.find((m) => m.id === id)!;
    expect(byId('vera').canDelegate).toBe(true);
    expect(byId('owen').canDelegate).toBe(false);
    expect(byId('nova').parentMemberId).toBe('vera');
    expect(byId('vera').subordinateIds).toEqual(['nova']);
  });

  it('add: keeps the existing lead', () => {
    const team = mk();
    expect(setTeamLead(team, 'vera', 'add').after).toEqual(['owen', 'vera']);
    expect(getTeamLeadIds(team)).toEqual(['owen', 'vera']);
  });

  it('is a no-op change for the current lead', () => {
    const team = mk();
    expect(setTeamLead(team, 'owen').changed).toBe(false);
    expect(team.leaderIds).toEqual(['owen']);
  });

  it('refuses a non-member and the orchestrator', () => {
    expect(() => setTeamLead(mk(), 'nobody')).toThrow(/not on team/);
    const team = mkTeam([baseMember({ id: 'orc', role: 'orchestrator' })]);
    expect(() => setTeamLead(team, 'orc')).toThrow(/orchestrator/);
  });
});

describe('getLeadSubordinates', () => {
  it('explicit reports first; a rule lead without reports directs the rest of the team', () => {
    const owen = baseMember({ id: 'owen', role: 'tech-lead' });
    const vera = baseMember({ id: 'vera' });
    const nova = baseMember({ id: 'nova' });
    expect(getLeadSubordinates(mkTeam([owen, vera, nova]), owen).map((m) => m.id)).toEqual(['vera', 'nova']);
    const withReports = baseMember({ id: 'owen', role: 'tech-lead', subordinateIds: ['nova'] });
    expect(getLeadSubordinates(mkTeam([withReports, vera, nova]), withReports).map((m) => m.id)).toEqual(['nova']);
    expect(getLeadSubordinates(mkTeam([owen, vera, nova]), vera)).toEqual([]);
  });
});
