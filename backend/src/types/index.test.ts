// ExpertProfileModule integration
import type { TeamMember, TeamMemberRole, Team } from './index';

describe('Core Types - Hierarchy Extensions', () => {
  describe('TeamMemberRole', () => {
    it('should include team-leader as a valid role', () => {
      const role: TeamMemberRole = 'team-leader';
      expect(role).toBe('team-leader');
    });

    it('should include all expected roles', () => {
      const roles: TeamMemberRole[] = [
        'orchestrator', 'team-leader', 'tpm', 'architect', 'pgm',
        'developer', 'frontend-developer', 'backend-developer', 'fullstack-dev',
        'qa', 'qa-engineer', 'tester', 'designer', 'product-manager',
        'sales', 'support',
      ];

      roles.forEach(role => {
        const member: Pick<TeamMember, 'role'> = { role };
        expect(member.role).toBe(role);
      });
    });
  });

  describe('TeamMember hierarchy fields', () => {
    const baseMember: TeamMember = {
      id: 'member-1',
      name: 'Test Member',
      sessionName: 'session-1',
      role: 'developer',
      systemPrompt: 'You are a developer',
      agentStatus: 'inactive',
      workingStatus: 'idle',
      runtimeType: 'claude-code',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('should work without any hierarchy fields (backwards compatible)', () => {
      expect(baseMember.parentMemberId).toBeUndefined();
      expect(baseMember.hierarchyLevel).toBeUndefined();
      expect(baseMember.subordinateIds).toBeUndefined();
      expect(baseMember.canDelegate).toBeUndefined();
      expect(baseMember.maxConcurrentTasks).toBeUndefined();
    });

    it('should accept parentMemberId for child members', () => {
      const worker: TeamMember = {
        ...baseMember,
        parentMemberId: 'leader-id',
        hierarchyLevel: 2,
      };

      expect(worker.parentMemberId).toBe('leader-id');
      expect(worker.hierarchyLevel).toBe(2);
    });

    it('should accept subordinateIds for leader members', () => {
      const leader: TeamMember = {
        ...baseMember,
        role: 'team-leader',
        hierarchyLevel: 1,
        canDelegate: true,
        subordinateIds: ['worker-1', 'worker-2', 'worker-3'],
      };

      expect(leader.subordinateIds).toEqual(['worker-1', 'worker-2', 'worker-3']);
      expect(leader.canDelegate).toBe(true);
      expect(leader.hierarchyLevel).toBe(1);
    });

    it('should accept maxConcurrentTasks', () => {
      const member: TeamMember = {
        ...baseMember,
        maxConcurrentTasks: 3,
      };

      expect(member.maxConcurrentTasks).toBe(3);
    });

    it('should support N-level hierarchy depths', () => {
      const levels = [0, 1, 2, 3, 4, 5];
      levels.forEach(level => {
        const member: TeamMember = {
          ...baseMember,
          hierarchyLevel: level,
        };
        expect(member.hierarchyLevel).toBe(level);
      });
    });
  });

  describe('Team hierarchy fields', () => {
    const baseTeam: Team = {
      id: 'team-1',
      name: 'Test Team',
      members: [],
      projectIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    it('should work without hierarchy fields (flat team)', () => {
      expect(baseTeam.hierarchical).toBeUndefined();
      expect(baseTeam.leaderId).toBeUndefined();
      expect(baseTeam.templateId).toBeUndefined();
    });

    it('should accept hierarchical flag and leaderId', () => {
      const team: Team = {
        ...baseTeam,
        hierarchical: true,
        leaderId: 'leader-member-id',
      };

      expect(team.hierarchical).toBe(true);
      expect(team.leaderId).toBe('leader-member-id');
    });

    it('should accept templateId', () => {
      const team: Team = {
        ...baseTeam,
        templateId: 'core-engineering-v1',
      };

      expect(team.templateId).toBe('core-engineering-v1');
    });

    it('should accept all hierarchy fields together', () => {
      const team: Team = {
        ...baseTeam,
        hierarchical: true,
        leaderId: 'tl-001',
        templateId: 'qa-team-template',
      };

      expect(team.hierarchical).toBe(true);
      expect(team.leaderId).toBe('tl-001');
      expect(team.templateId).toBe('qa-team-template');
    });

    it('should accept leaderIds for multi-TL teams', () => {
      const team: Team = {
        ...baseTeam,
        hierarchical: true,
        leaderIds: ['pm-tl', 'dev-tl'],
        leaderId: 'pm-tl',
      };

      expect(team.leaderIds).toEqual(['pm-tl', 'dev-tl']);
      expect(team.leaderId).toBe('pm-tl');
    });

    it('should allow leaderIds without leaderId', () => {
      const team: Team = {
        ...baseTeam,
        hierarchical: true,
        leaderIds: ['solo-tl'],
      };

      expect(team.leaderIds).toEqual(['solo-tl']);
      expect(team.leaderId).toBeUndefined();
    });
  });
});
