/**
 * Types Index Tests
 *
 * Verifies that all type modules are properly exported from the barrel file.
 *
 * @module types/index.test
 */

import { describe, it, expect } from 'vitest';
import * as TypesModule from './index';

describe('Types Index Exports', () => {
  describe('Core Types', () => {
    it('should export TeamMember interface (type check)', () => {
      // Type check - if this compiles, the interface is exported
      const member: TypesModule.TeamMember = {
        id: 'test',
        name: 'Test',
        sessionName: 'test-session',
        role: 'developer',
        systemPrompt: 'Test prompt',
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(member.id).toBe('test');
    });

    it('should export Team interface (type check)', () => {
      const team: TypesModule.Team = {
        id: 'team-1',
        name: 'Test Team',
        members: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(team.id).toBe('team-1');
    });

    it('should export Project interface (type check)', () => {
      const project: TypesModule.Project = {
        id: 'proj-1',
        name: 'Test Project',
        path: '/test/path',
        teams: {},
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(project.id).toBe('proj-1');
    });

    it('should export Ticket interface (type check)', () => {
      const ticket: TypesModule.Ticket = {
        id: 'ticket-1',
        title: 'Test Ticket',
        description: 'Test description',
        status: 'open',
        priority: 'medium',
        projectId: 'proj-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(ticket.id).toBe('ticket-1');
    });

    it('should export ApiResponse interface (type check)', () => {
      const response: TypesModule.ApiResponse<string> = {
        success: true,
        data: 'test',
      };
      expect(response.success).toBe(true);
    });
  });

  describe('Factory Types Re-exports', () => {
    it('should export factory type interfaces', () => {
      // Factory types are re-exported
      const config: TypesModule.FactoryQueueConfig = {
        id: 'q1',
        name: 'Test Queue',
        maxConcurrent: 5,
        priority: 'normal',
        estimatedProcessingTime: 60,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(config.id).toBe('q1');
    });
  });

  describe('Role Types Re-exports', () => {
    it('should export Role interface', () => {
      const role: TypesModule.Role = {
        id: 'role-1',
        key: 'developer',
        name: 'Developer',
        description: 'A developer role',
        systemPrompt: 'You are a developer',
        color: '#0000FF',
        icon: '💻',
        skills: [],
        permissions: [],
        isBuiltin: false,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(role.key).toBe('developer');
    });

    it('should export role utility functions', () => {
      expect(typeof TypesModule.isValidRoleCategory).toBe('function');
      expect(typeof TypesModule.getRoleCategoryDisplayName).toBe('function');
      expect(typeof TypesModule.getRoleCategoryIcon).toBe('function');
    });

    it('should export ROLE_CATEGORIES constant', () => {
      expect(Array.isArray(TypesModule.ROLE_CATEGORIES)).toBe(true);
      expect(TypesModule.ROLE_CATEGORIES.length).toBeGreaterThan(0);
    });

    it('should export ROLE_CATEGORY_DISPLAY_NAMES constant', () => {
      expect(typeof TypesModule.ROLE_CATEGORY_DISPLAY_NAMES).toBe('object');
    });

    it('should export ROLE_CATEGORY_ICONS constant', () => {
      expect(typeof TypesModule.ROLE_CATEGORY_ICONS).toBe('object');
    });
  });

  describe('Settings Types Re-exports', () => {
    it('should export Settings interface', () => {
      const settings: TypesModule.Settings = {
        general: {
          theme: 'dark',
          language: 'en',
          timezone: 'UTC',
          autoSave: true,
          autoSaveInterval: 30,
        },
        agent: {
          defaultRuntimeType: 'claude-code',
          defaultSystemPrompt: 'Test',
          registrationTimeout: 30000,
          activityCheckInterval: 5000,
          maxConcurrentAgents: 10,
        },
        orchestrator: {
          checkInIntervalMinutes: 15,
          enableAutoScheduling: true,
          defaultProjectPath: '/projects',
        },
        notifications: {
          enableDesktop: true,
          enableSound: false,
          enableEmail: false,
          emailAddress: undefined,
        },
        api: {
          baseUrl: 'http://localhost:3000',
          wsUrl: 'ws://localhost:3000',
          timeout: 30000,
          retryAttempts: 3,
        },
      };
      expect(settings.general.theme).toBe('dark');
    });

    it('should export settings utility functions', () => {
      expect(typeof TypesModule.getAIRuntimeDisplayName).toBe('function');
      expect(typeof TypesModule.isValidAIRuntime).toBe('function');
    });

    it('should export AI_RUNTIMES constant', () => {
      expect(Array.isArray(TypesModule.AI_RUNTIMES)).toBe(true);
      expect(TypesModule.AI_RUNTIMES).toContain('claude-code');
    });

    it('should export AI_RUNTIME_DISPLAY_NAMES constant', () => {
      expect(typeof TypesModule.AI_RUNTIME_DISPLAY_NAMES).toBe('object');
    });
  });

  describe('Chat Types Re-exports', () => {
    it('should export ChatMessage interface', () => {
      const message: TypesModule.ChatMessage = {
        id: 'msg-1',
        conversationId: 'conv-1',
        from: { type: 'user' },
        content: 'Hello',
        contentType: 'text',
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
      expect(message.from.type).toBe('user');
    });

    it('should export ChatConversation interface', () => {
      const conversation: TypesModule.ChatConversation = {
        id: 'conv-1',
        title: 'Test Conversation',
        participantIds: ['user-1'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isArchived: false,
        messageCount: 0,
      };
      expect(conversation.isArchived).toBe(false);
    });

    it('should export chat sender types', () => {
      const senderType: TypesModule.ChatSenderType = 'user';
      expect(['user', 'orchestrator', 'agent', 'system']).toContain(senderType);
    });

    it('should export chat content types', () => {
      const contentType: TypesModule.ChatContentType = 'text';
      expect([
        'text',
        'status',
        'task',
        'error',
        'system',
        'code',
        'markdown',
      ]).toContain(contentType);
    });
  });

  describe('Skill Types Re-exports', () => {
    it('should export Skill interface', () => {
      const skill: TypesModule.Skill = {
        id: 'skill-1',
        name: 'Test Skill',
        description: 'A test skill',
        category: 'development',
        promptFile: 'prompts/test.md',
        assignableRoles: [],
        triggers: [],
        tags: [],
        version: '1.0.0',
        isBuiltin: false,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(skill.category).toBe('development');
    });

    it('should export skill utility functions', () => {
      expect(typeof TypesModule.isValidSkillCategory).toBe('function');
      expect(typeof TypesModule.isValidExecutionType).toBe('function');
      expect(typeof TypesModule.getSkillCategoryLabel).toBe('function');
      expect(typeof TypesModule.getSkillCategoryIcon).toBe('function');
      expect(typeof TypesModule.getExecutionTypeLabel).toBe('function');
    });

    it('should export SKILL_CATEGORIES constant', () => {
      expect(Array.isArray(TypesModule.SKILL_CATEGORIES)).toBe(true);
      expect(TypesModule.SKILL_CATEGORIES).toContain('development');
    });

    it('should export EXECUTION_TYPES constant', () => {
      expect(Array.isArray(TypesModule.EXECUTION_TYPES)).toBe(true);
      expect(TypesModule.EXECUTION_TYPES).toContain('script');
    });
  });

  describe('WebSocket Event Types', () => {
    it('should export TeamMemberStatusChangeEvent interface (type check)', () => {
      const event: TypesModule.TeamMemberStatusChangeEvent = {
        teamId: 'team-1',
        memberId: 'member-1',
        sessionName: 'test-session',
        agentStatus: 'active',
      };
      expect(event.teamId).toBe('team-1');
      expect(event.agentStatus).toBe('active');
    });

    it('should accept all valid agentStatus values', () => {
      const statuses: Array<TypesModule.TeamMember['agentStatus']> = ['active', 'inactive', 'activating'];

      statuses.forEach((status) => {
        const event: TypesModule.TeamMemberStatusChangeEvent = {
          teamId: 'team-1',
          memberId: 'member-1',
          sessionName: 'test-session',
          agentStatus: status,
        };
        expect(['active', 'inactive', 'activating']).toContain(event.agentStatus);
      });
    });
  });

  describe('per-agent model presets', () => {
    it('lists presets, effort levels and a hint for every PTY runtime', () => {
      for (const runtime of ['claude-code', 'codex-cli', 'gemini-cli', 'opencode-cli']) {
        expect(TypesModule.RUNTIME_MODEL_PRESETS[runtime].length).toBeGreaterThan(0);
        expect(TypesModule.RUNTIME_MODEL_HINTS[runtime]).toBeTruthy();
        expect(Array.isArray(TypesModule.RUNTIME_EFFORT_LEVELS[runtime])).toBe(true);
      }
      expect(TypesModule.RUNTIME_EFFORT_LEVELS['claude-code']).toContain('max');
      expect(TypesModule.RUNTIME_EFFORT_LEVELS['codex-cli']).toContain('high');
      expect(TypesModule.RUNTIME_EFFORT_LEVELS['gemini-cli']).toEqual([]);
      expect(TypesModule.RUNTIME_EFFORT_LEVELS['crewly-agent']).toEqual([]);
    });
  });
});
