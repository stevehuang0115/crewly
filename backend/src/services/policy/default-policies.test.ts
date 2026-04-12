/**
 * Tests for Default Policies
 *
 * @module services/policy/default-policies.test
 */

import {
  POLICY_TEMPLATE_NAMES,
  POLICY_TEMPLATE_DESCRIPTIONS,
  isValidPolicyTemplateName,
  createPolicyFromTemplate,
  applyPolicyUpdate,
  summarizePolicy,
  CONSERVATIVE_POLICY,
  MODERATE_POLICY,
  AUTONOMOUS_POLICY,
} from './default-policies.js';
import { createMissionPolicy } from '../../types/v2/index.js';

describe('Default Policies', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('POLICY_TEMPLATE_NAMES', () => {
    it('should have 3 templates', () => {
      expect(POLICY_TEMPLATE_NAMES).toEqual(['conservative', 'moderate', 'autonomous']);
    });
  });

  describe('POLICY_TEMPLATE_DESCRIPTIONS', () => {
    it('should have a description for each template', () => {
      for (const name of POLICY_TEMPLATE_NAMES) {
        expect(typeof POLICY_TEMPLATE_DESCRIPTIONS[name]).toBe('string');
        expect(POLICY_TEMPLATE_DESCRIPTIONS[name].length).toBeGreaterThan(10);
      }
    });
  });

  // -----------------------------------------------------------------------
  // isValidPolicyTemplateName
  // -----------------------------------------------------------------------
  describe('isValidPolicyTemplateName', () => {
    it('should accept valid names', () => {
      expect(isValidPolicyTemplateName('conservative')).toBe(true);
      expect(isValidPolicyTemplateName('moderate')).toBe(true);
      expect(isValidPolicyTemplateName('autonomous')).toBe(true);
    });
    it('should reject invalid names', () => {
      expect(isValidPolicyTemplateName('permissive')).toBe(false);
      expect(isValidPolicyTemplateName('')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // createPolicyFromTemplate
  // -----------------------------------------------------------------------
  describe('createPolicyFromTemplate', () => {
    it('should create conservative policy', () => {
      const policy = createPolicyFromTemplate('m-1', 'conservative');
      expect(policy.missionId).toBe('m-1');
      expect(policy.canCreateTasks).toBe(false);
    });

    it('should create moderate policy', () => {
      const policy = createPolicyFromTemplate('m-1', 'moderate');
      expect(policy.canCreateTasks).toBe(true);
      expect(policy.canDeployToStaging).toBe(false);
    });

    it('should create autonomous policy', () => {
      const policy = createPolicyFromTemplate('m-1', 'autonomous');
      expect(policy.canDeployToStaging).toBe(true);
      expect(policy.canDeployToProd).toBe(false);
    });

    it('should apply overrides', () => {
      const policy = createPolicyFromTemplate('m-1', 'conservative', {
        canCreateTasks: true,
        maxParallelExecutions: 10,
      });
      expect(policy.canCreateTasks).toBe(true);
      expect(policy.maxParallelExecutions).toBe(10);
      expect(policy.canDeployToProd).toBe(false); // unchanged
    });

    it('should never override missionId', () => {
      const policy = createPolicyFromTemplate('m-1', 'conservative');
      expect(policy.missionId).toBe('m-1');
    });

    it('should accept custom escalation rules via overrides', () => {
      const customRules = [
        { condition: 'cost_exceeded' as const, threshold: 200, escalateTo: 'user' as const, action: 'block' as const },
      ];
      const policy = createPolicyFromTemplate('m-1', 'conservative', {
        escalationRules: customRules,
      });
      expect(policy.escalationRules).toHaveLength(1);
      expect(policy.escalationRules[0].threshold).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // applyPolicyUpdate
  // -----------------------------------------------------------------------
  describe('applyPolicyUpdate', () => {
    it('should update specified fields', () => {
      const existing = createMissionPolicy('m-1', 'conservative');
      const updated = applyPolicyUpdate(existing, { canCreateTasks: true });
      expect(updated.canCreateTasks).toBe(true);
      expect(updated.canDeployToProd).toBe(false); // unchanged
    });

    it('should preserve missionId', () => {
      const existing = createMissionPolicy('m-1', 'conservative');
      const updated = applyPolicyUpdate(existing, { canCreateTasks: true });
      expect(updated.missionId).toBe('m-1');
    });

    it('should not mutate original', () => {
      const existing = createMissionPolicy('m-1', 'conservative');
      applyPolicyUpdate(existing, { canCreateTasks: true });
      expect(existing.canCreateTasks).toBe(false);
    });

    it('should replace escalation rules when provided', () => {
      const existing = createMissionPolicy('m-1', 'autonomous');
      const origRuleCount = existing.escalationRules.length;
      const updated = applyPolicyUpdate(existing, { escalationRules: [] });
      expect(updated.escalationRules).toHaveLength(0);
      expect(existing.escalationRules).toHaveLength(origRuleCount); // unchanged
    });
  });

  // -----------------------------------------------------------------------
  // summarizePolicy
  // -----------------------------------------------------------------------
  describe('summarizePolicy', () => {
    it('should list all blocked for conservative', () => {
      const policy = createMissionPolicy('m-1', 'conservative');
      const summary = summarizePolicy(policy);
      expect(summary.allowed).toHaveLength(0);
      expect(summary.blocked).toHaveLength(7);
    });

    it('should list some allowed for moderate', () => {
      const policy = createMissionPolicy('m-1', 'moderate');
      const summary = summarizePolicy(policy);
      expect(summary.allowed).toContain('Create tasks');
      expect(summary.allowed).toContain('Close tasks');
      expect(summary.blocked).toContain('Deploy to production');
    });

    it('should show maxParallel', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      const summary = summarizePolicy(policy);
      expect(summary.maxParallel).toBe(5);
    });

    it('should show escalation count', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      const summary = summarizePolicy(policy);
      expect(summary.escalationCount).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Re-exported constants
  // -----------------------------------------------------------------------
  describe('re-exported constants', () => {
    it('should export CONSERVATIVE_POLICY', () => {
      expect(CONSERVATIVE_POLICY).toBeDefined();
      expect(CONSERVATIVE_POLICY.canCreateTasks).toBe(false);
    });
    it('should export MODERATE_POLICY', () => {
      expect(MODERATE_POLICY).toBeDefined();
    });
    it('should export AUTONOMOUS_POLICY', () => {
      expect(AUTONOMOUS_POLICY).toBeDefined();
    });
  });
});
