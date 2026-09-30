import { TeamModel } from './Team.js';
import { Team, TeamMember } from '../types/index.js';

/**
 * Helper to create a minimal valid Team object for testing.
 */
function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    name: 'Test Team',
    members: [],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Helper to create a minimal valid TeamMember for testing.
 */
function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'member-1',
    name: 'Alice',
    sessionName: 'test-alice',
    role: 'developer',
    systemPrompt: 'You are Alice.',
    agentStatus: 'inactive',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TeamModel', () => {
  describe('constructor', () => {
    it('should create a team with default values', () => {
      const team = new TeamModel({});
      expect(team.id).toBe('');
      expect(team.name).toBe('');
      expect(team.members).toEqual([]);
      expect(team.projectIds).toEqual([]);
      expect(team.leaderIds).toBeUndefined();
      expect(team.leaderId).toBeUndefined();
    });

    it('should preserve leaderIds when provided', () => {
      const team = new TeamModel({
        id: 'team-1',
        name: 'Core',
        leaderIds: ['leader-a', 'leader-b'],
        leaderId: 'leader-a',
      });
      expect(team.leaderIds).toEqual(['leader-a', 'leader-b']);
      expect(team.leaderId).toBe('leader-a');
    });
  });

  describe('fromJSON — leaderIds migration', () => {
    it('should migrate legacy leaderId to leaderIds', () => {
      const data = makeTeam({
        hierarchical: true,
        leaderId: 'tl-001',
      });
      const team = TeamModel.fromJSON(data);
      expect(team.leaderIds).toEqual(['tl-001']);
      expect(team.leaderId).toBe('tl-001');
    });

    it('should use leaderIds as source of truth when both exist', () => {
      const data = makeTeam({
        hierarchical: true,
        leaderId: 'old-leader',
        leaderIds: ['new-leader-a', 'new-leader-b'],
      });
      const team = TeamModel.fromJSON(data);
      expect(team.leaderIds).toEqual(['new-leader-a', 'new-leader-b']);
      expect(team.leaderId).toBe('new-leader-a');
    });

    it('should leave both undefined when neither exists', () => {
      const data = makeTeam({});
      const team = TeamModel.fromJSON(data);
      expect(team.leaderIds).toBeUndefined();
      expect(team.leaderId).toBeUndefined();
    });

    it('should handle leaderIds with a single entry', () => {
      const data = makeTeam({
        hierarchical: true,
        leaderIds: ['solo-leader'],
      });
      const team = TeamModel.fromJSON(data);
      expect(team.leaderIds).toEqual(['solo-leader']);
      expect(team.leaderId).toBe('solo-leader');
    });

    it('stores a lead-role member (tech-lead) as the lead of a team with no leaderIds, idempotently', () => {
      const data = makeTeam({
        members: [makeMember({ id: 'vera' }), makeMember({ id: 'owen', name: 'Owen', role: 'tech-lead' })],
      });
      const team = TeamModel.fromJSON(data).toJSON();
      expect(team.leaderIds).toEqual(['owen']);
      expect(team.leaderId).toBe('owen');
      expect(TeamModel.fromJSON(team).toJSON()).toEqual(team);
    });

    it('keeps an explicit lead over a lead-role member', () => {
      const data = makeTeam({
        leaderIds: ['vera'],
        members: [makeMember({ id: 'vera' }), makeMember({ id: 'owen', role: 'team-leader' })],
      });
      const team = TeamModel.fromJSON(data);
      expect(team.leaderIds).toEqual(['vera']);
      expect(team.leaderId).toBe('vera');
    });

    it('should handle empty leaderIds array (no migration)', () => {
      const data = makeTeam({
        hierarchical: true,
        leaderIds: [],
        leaderId: 'fallback-leader',
      });
      const team = TeamModel.fromJSON(data);
      // Empty array is falsy in the length check, so leaderId stays
      expect(team.leaderIds).toEqual([]);
      expect(team.leaderId).toBe('fallback-leader');
    });
  });

  describe('toJSON', () => {
    it('should include leaderIds in serialized output', () => {
      const team = new TeamModel({
        id: 'team-1',
        name: 'Core',
        hierarchical: true,
        leaderId: 'tl-a',
        leaderIds: ['tl-a', 'tl-b'],
      });
      const json = team.toJSON();
      expect(json.leaderIds).toEqual(['tl-a', 'tl-b']);
      expect(json.leaderId).toBe('tl-a');
      expect(json.hierarchical).toBe(true);
    });

    it('should omit leaderIds when undefined', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Flat' });
      const json = team.toJSON();
      expect('leaderIds' in json).toBe(false);
    });

    it('should omit leaderId when undefined', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Flat' });
      const json = team.toJSON();
      expect('leaderId' in json).toBe(false);
    });
  });

  describe('fromJSON — legacy member migration', () => {
    it('should migrate legacy status field to agentStatus', () => {
      const legacyMember = { ...makeMember(), status: 'active' } as any;
      delete legacyMember.agentStatus; // simulate legacy data without agentStatus
      const data = makeTeam({ members: [legacyMember] });
      const team = TeamModel.fromJSON(data);
      expect(team.members[0].agentStatus).toBe('active');
    });

    it('should default runtimeType to claude-code', () => {
      const memberWithoutRuntime = { ...makeMember() };
      delete (memberWithoutRuntime as any).runtimeType;
      const data = makeTeam({ members: [memberWithoutRuntime] });
      const team = TeamModel.fromJSON(data);
      expect(team.members[0].runtimeType).toBe('claude-code');
    });
  });

  describe('fromJSON — legacy currentProject migration', () => {
    it('should migrate currentProject to projectIds', () => {
      const data = { ...makeTeam(), currentProject: 'proj-1' } as any;
      delete data.projectIds;
      const team = TeamModel.fromJSON(data);
      expect(team.projectIds).toEqual(['proj-1']);
    });
  });

  describe('member operations', () => {
    it('should add a member', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Test' });
      const member = makeMember({ id: 'new-member' });
      team.addMember(member);
      expect(team.members).toHaveLength(1);
      expect(team.members[0].id).toBe('new-member');
    });

    it('should remove a member', () => {
      const member = makeMember({ id: 'rm-me' });
      const team = new TeamModel({ id: 'team-1', name: 'Test', members: [member] });
      team.removeMember('rm-me');
      expect(team.members).toHaveLength(0);
    });

    it('should update a member', () => {
      const member = makeMember({ id: 'upd-me', name: 'Old' });
      const team = new TeamModel({ id: 'team-1', name: 'Test', members: [member] });
      team.updateMember('upd-me', { name: 'New' });
      expect(team.members[0].name).toBe('New');
    });
  });

  describe('parentTeamId', () => {
    it('should preserve parentTeamId in constructor', () => {
      const team = new TeamModel({
        id: 'child-1',
        name: 'Child Team',
        parentTeamId: 'parent-1',
      });
      expect(team.parentTeamId).toBe('parent-1');
    });

    it('should include parentTeamId in toJSON when set', () => {
      const team = new TeamModel({
        id: 'child-1',
        name: 'Child Team',
        parentTeamId: 'parent-1',
      });
      const json = team.toJSON();
      expect(json.parentTeamId).toBe('parent-1');
    });

    it('should omit parentTeamId from toJSON when undefined', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Top Level' });
      const json = team.toJSON();
      expect('parentTeamId' in json).toBe(false);
    });

    it('should preserve parentTeamId through fromJSON', () => {
      const data = makeTeam({ parentTeamId: 'org-1' });
      const team = TeamModel.fromJSON(data);
      expect(team.parentTeamId).toBe('org-1');
    });

    it('should handle undefined parentTeamId in fromJSON', () => {
      const data = makeTeam({});
      const team = TeamModel.fromJSON(data);
      expect(team.parentTeamId).toBeUndefined();
    });
  });

  describe('project operations', () => {
    it('should assign to project', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Test' });
      team.assignToProject('proj-1');
      expect(team.projectIds).toContain('proj-1');
    });

    it('should not duplicate project assignment', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Test', projectIds: ['proj-1'] });
      team.assignToProject('proj-1');
      expect(team.projectIds).toEqual(['proj-1']);
    });

    it('should unassign from project', () => {
      const team = new TeamModel({ id: 'team-1', name: 'Test', projectIds: ['proj-1', 'proj-2'] });
      team.unassignFromProject('proj-1');
      expect(team.projectIds).toEqual(['proj-2']);
    });
  });
});
