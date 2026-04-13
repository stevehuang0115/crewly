/**
 * Tests for SkillPermissionService — autonomyLevel hard enforcement.
 *
 * @module services/skill/skill-permission.service.test
 */

import { SkillPermissionService } from './skill-permission.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('SkillPermissionService', () => {
  beforeEach(() => {
    SkillPermissionService.resetInstance();
  });

  describe('directed autonomy', () => {
    const ctx = { autonomyLevel: 'directed' as const, role: 'developer' };

    it('should block delegation skills', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('delegate-task', ctx).allowed).toBe(false);
      expect(svc.canExecuteSkill('decompose-goal', ctx).allowed).toBe(false);
      expect(svc.canExecuteSkill('decompose-mission', ctx).allowed).toBe(false);
    });

    it('should block management skills', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('start-agent', ctx).allowed).toBe(false);
      expect(svc.canExecuteSkill('stop-agent', ctx).allowed).toBe(false);
      expect(svc.canExecuteSkill('design-team', ctx).allowed).toBe(false);
    });

    it('should allow execution skills', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('code-review', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('testing', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('report-status', ctx).allowed).toBe(true);
    });
  });

  describe('bounded autonomy', () => {
    const ctx = { autonomyLevel: 'bounded' as const, role: 'team-leader', canDelegate: true };

    it('should allow delegation skills', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('delegate-task', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('decompose-goal', ctx).allowed).toBe(true);
    });

    it('should block prod deployment', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('deploy-to-prod', ctx).allowed).toBe(false);
    });

    it('should block team design', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('design-team', ctx).allowed).toBe(false);
    });
  });

  describe('domain_autonomous', () => {
    const ctx = { autonomyLevel: 'domain_autonomous' as const, role: 'team-leader', canDelegate: true };

    it('should allow most skills', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('delegate-task', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('decompose-goal', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('design-team', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('start-agent', ctx).allowed).toBe(true);
    });

    it('should still block prod deployment', () => {
      const svc = SkillPermissionService.getInstance();
      expect(svc.canExecuteSkill('deploy-to-prod', ctx).allowed).toBe(false);
    });
  });

  describe('canDelegate enforcement', () => {
    it('should block delegation skills without canDelegate flag', () => {
      const svc = SkillPermissionService.getInstance();
      const ctx = { autonomyLevel: 'bounded' as const, role: 'developer', canDelegate: false };
      const result = svc.canExecuteSkill('delegate-task', ctx);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('delegation authority');
    });
  });

  describe('orchestrator bypass', () => {
    it('should allow all skills for orchestrator role', () => {
      const svc = SkillPermissionService.getInstance();
      const ctx = { autonomyLevel: 'directed' as const, role: 'orchestrator' };
      expect(svc.canExecuteSkill('delegate-task', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('design-team', ctx).allowed).toBe(true);
      expect(svc.canExecuteSkill('stop-agent', ctx).allowed).toBe(true);
    });
  });

  describe('filterPermittedSkills', () => {
    it('should filter out blocked skills', () => {
      const svc = SkillPermissionService.getInstance();
      const ctx = { autonomyLevel: 'directed' as const, role: 'developer' };
      const skills = ['code-review', 'delegate-task', 'testing', 'start-agent'];
      const permitted = svc.filterPermittedSkills(skills, ctx);
      expect(permitted).toEqual(['code-review', 'testing']);
    });
  });

  describe('default autonomy', () => {
    it('should default to directed when autonomyLevel is undefined', () => {
      const svc = SkillPermissionService.getInstance();
      const ctx = { role: 'developer' };
      expect(svc.canExecuteSkill('delegate-task', ctx).allowed).toBe(false);
    });
  });
});
