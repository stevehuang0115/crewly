/**
 * Prompt Generator Service Tests
 *
 * @module services/prompt/prompt-generator.service.test
 */

import { PromptGeneratorService } from './prompt-generator.service.js';
import { StorageService } from '../core/storage.service.js';
import type { TeamMember, Team } from '../../types/index.js';

// Mock dependencies
jest.mock('../core/storage.service.js', () => ({
  StorageService: {
    getInstance: jest.fn(() => ({
      getMemberPromptPath: jest.fn((teamId, memberId) => `/home/user/.crewly/teams/${teamId}/prompts/${memberId}.md`),
      getOrchestratorPromptPath: jest.fn(() => '/home/user/.crewly/teams/orchestrator/prompt.md'),
      saveMemberPrompt: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: jest.fn(() => ({
      createComponentLogger: jest.fn(() => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
    })),
  },
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

// Mock MissionContextService — default to empty so legacy tests stay clean.
// Individual tests that need a populated mission card override this mock.
const mockGetContextForAgent = jest.fn().mockResolvedValue('');
jest.mock('../memory/mission-context.service.js', () => ({
  MissionContextService: {
    getInstance: jest.fn(() => ({
      getContextForAgent: mockGetContextForAgent,
    })),
  },
}));

describe('PromptGeneratorService', () => {
  let service: PromptGeneratorService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContextForAgent.mockResolvedValue('');
    PromptGeneratorService.resetInstance();
    service = PromptGeneratorService.getInstance();
  });

  describe('singleton', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = PromptGeneratorService.getInstance();
      const instance2 = PromptGeneratorService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = PromptGeneratorService.getInstance();
      PromptGeneratorService.resetInstance();
      const instance2 = PromptGeneratorService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('generateMemberPrompt', () => {
    const mockMember: TeamMember = {
      id: 'member-1',
      name: 'Test Developer',
      sessionName: 'test-session',
      role: 'developer',
      systemPrompt: 'Test prompt',
      agentStatus: 'inactive',
      workingStatus: 'idle',
      runtimeType: 'claude-code',
      skillOverrides: ['chrome-browser'],
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    };

    it('should generate prompt with member info header', async () => {
      const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

      expect(prompt).toContain('# Test Developer');
      expect(prompt).toContain('Role: developer');
    });

    it('should include context reminder footer', async () => {
      const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

      expect(prompt).toContain('## Context Reminder');
      expect(prompt).toContain('If you lose context about who you are, read this file');
      expect(prompt).toContain('/home/user/.crewly/teams/team-1/prompts/member-1.md');
    });

    // M1: Mission/OKR Auto-Injection
    describe('mission context injection (M1)', () => {
      it('should inject mission card when service returns non-empty content', async () => {
        const missionCard = '## Mission Context\n\n### Active Goals\n- Ship Sprint 3 Cloud MVP';
        mockGetContextForAgent.mockResolvedValueOnce(missionCard);

        const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

        expect(prompt).toContain('## Mission Context');
        expect(prompt).toContain('Ship Sprint 3 Cloud MVP');
      });

      it('should call MissionContextService with member.id, projectPath, and teamId', async () => {
        await service.generateMemberPrompt(mockMember, 'team-1');

        expect(mockGetContextForAgent).toHaveBeenCalledWith({
          agentId: 'member-1',
          projectPath: process.cwd(),
          teamId: 'team-1',
        });
      });

      it('should place mission card between Skills block and Context Reminder footer', async () => {
        const missionCard = '## Mission Context\n\n### Active Goals\n- Goal A';
        mockGetContextForAgent.mockResolvedValueOnce(missionCard);

        // Member with at least one skill so the Skills block renders
        const memberWithSkills: TeamMember = {
          ...mockMember,
          skillOverrides: ['chrome-browser'],
        };

        // Spy to make a skill produce visible content
        jest.spyOn(service, 'getRoleAssignedSkills').mockResolvedValue([]);
        jest.spyOn(service, 'getSkillInstructions').mockResolvedValue('Use Chrome via remote-browser.');

        const prompt = await service.generateMemberPrompt(memberWithSkills, 'team-1');

        const skillsIdx = prompt.indexOf('## Assigned Skills');
        const missionIdx = prompt.indexOf('## Mission Context');
        const reminderIdx = prompt.indexOf('## Context Reminder');

        expect(skillsIdx).toBeGreaterThan(-1);
        expect(missionIdx).toBeGreaterThan(-1);
        expect(reminderIdx).toBeGreaterThan(-1);
        expect(missionIdx).toBeGreaterThan(skillsIdx);
        expect(reminderIdx).toBeGreaterThan(missionIdx);
      });

      it('should skip injection when service returns empty string', async () => {
        mockGetContextForAgent.mockResolvedValueOnce('');

        const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

        expect(prompt).not.toContain('## Mission Context');
        // Other sections still render normally
        expect(prompt).toContain('# Test Developer');
        expect(prompt).toContain('## Context Reminder');
      });

      it('should skip injection when service returns whitespace-only content', async () => {
        mockGetContextForAgent.mockResolvedValueOnce('   \n  \n');

        const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

        expect(prompt).not.toContain('## Mission Context');
      });

      it('should fail-soft when MissionContextService throws', async () => {
        mockGetContextForAgent.mockRejectedValueOnce(new Error('boom'));

        // Must not throw — prompt assembly should never break on mission read failure
        const prompt = await service.generateMemberPrompt(mockMember, 'team-1');

        expect(prompt).toContain('# Test Developer');
        expect(prompt).toContain('## Context Reminder');
        expect(prompt).not.toContain('## Mission Context');
      });
    });
  });

  describe('buildContextPrefix', () => {
    const mockMember: TeamMember = {
      id: 'ceo-1',
      name: 'CEO',
      sessionName: 'ceo-session',
      role: 'product-manager',
      systemPrompt: 'CEO prompt',
      agentStatus: 'active',
      workingStatus: 'idle',
      runtimeType: 'claude-code',
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    };

    it('should build context prefix with member info', () => {
      const prefix = service.buildContextPrefix(mockMember, 'business-os', 'Business OS');

      expect(prefix).toContain('## Session Context');
      expect(prefix).toContain('**Agent:** CEO (product-manager)');
      expect(prefix).toContain('**Team:** Business OS');
      expect(prefix).toContain('**Prompt file:**');
      expect(prefix).toContain('/home/user/.crewly/teams/business-os/prompts/ceo-1.md');
    });
  });

  describe('buildOrchestratorContextPrefix', () => {
    it('should build context prefix for orchestrator', () => {
      const prefix = service.buildOrchestratorContextPrefix();

      expect(prefix).toContain('## Session Context');
      expect(prefix).toContain('**Agent:** Crewly Orchestrator');
      expect(prefix).toContain('**Prompt file:**');
      expect(prefix).toContain('/home/user/.crewly/teams/orchestrator/prompt.md');
    });
  });

  describe('getMemberSkills', () => {
    it('should combine role skills with skill overrides', async () => {
      const mockMember: TeamMember = {
        id: 'member-1',
        name: 'Test',
        sessionName: 'test',
        role: 'developer',
        systemPrompt: '',
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        skillOverrides: ['extra-skill'],
        createdAt: '',
        updatedAt: '',
      };

      // Mock getRoleAssignedSkills to return some skills
      jest.spyOn(service, 'getRoleAssignedSkills').mockResolvedValue(['code-review', 'testing']);

      const skills = await service.getMemberSkills(mockMember);

      expect(skills).toContain('code-review');
      expect(skills).toContain('testing');
      expect(skills).toContain('extra-skill');
    });

    it('should exclude skills in excludedRoleSkills', async () => {
      const mockMember: TeamMember = {
        id: 'member-1',
        name: 'Test',
        sessionName: 'test',
        role: 'developer',
        systemPrompt: '',
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        excludedRoleSkills: ['testing'],
        createdAt: '',
        updatedAt: '',
      };

      jest.spyOn(service, 'getRoleAssignedSkills').mockResolvedValue(['code-review', 'testing']);

      const skills = await service.getMemberSkills(mockMember);

      expect(skills).toContain('code-review');
      expect(skills).not.toContain('testing');
    });
  });
});
