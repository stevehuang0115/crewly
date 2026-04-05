/**
 * Tests for PolicyEnforcementService
 *
 * @module services/policy/policy-enforcement.service.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEnforcementService } from './policy-enforcement.service.js';
import { createMission, createMissionPolicy } from '../../types/v2/index.js';
import type { Mission, EscalationContext, EscalationRule, PolicyAction } from '../../types/v2/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMission(policyTemplate: 'conservative' | 'moderate' | 'autonomous' = 'conservative'): Mission {
  const mission = createMission({
    objective: 'Test mission',
    ownerTeamId: 'team-1',
    successCriteria: ['Done'],
    currentStrategy: 'Test',
  });
  mission.policy = createMissionPolicy(mission.id, policyTemplate);
  return mission;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PolicyEnforcementService', () => {
  let service: PolicyEnforcementService;

  beforeEach(() => {
    service = new PolicyEnforcementService();
  });

  // -----------------------------------------------------------------------
  // checkPolicy — Boolean Gates
  // -----------------------------------------------------------------------
  describe('checkPolicy — boolean gates', () => {
    it('should block create_task under conservative policy', () => {
      const mission = makeMission('conservative');
      const decision = service.checkPolicy('create_task', mission);
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe('canCreateTasks');
    });

    it('should allow create_task under moderate policy', () => {
      const mission = makeMission('moderate');
      const decision = service.checkPolicy('create_task', mission);
      expect(decision.allowed).toBe(true);
    });

    it('should block deploy_prod under autonomous policy', () => {
      const mission = makeMission('autonomous');
      const decision = service.checkPolicy('deploy_prod', mission);
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe('canDeployToProd');
    });

    it('should allow deploy_staging under autonomous policy', () => {
      const mission = makeMission('autonomous');
      const decision = service.checkPolicy('deploy_staging', mission);
      expect(decision.allowed).toBe(true);
    });

    it('should block spend_money under moderate policy', () => {
      const mission = makeMission('moderate');
      const decision = service.checkPolicy('spend_money', mission);
      expect(decision.allowed).toBe(false);
    });

    it('should allow spend_money under autonomous policy', () => {
      const mission = makeMission('autonomous');
      const decision = service.checkPolicy('spend_money', mission);
      expect(decision.allowed).toBe(true);
    });

    it('should check all 7 policy actions', () => {
      const mission = makeMission('autonomous');
      const actions: PolicyAction[] = [
        'create_task',
        'reprioritize_task',
        'close_task',
        'deploy_staging',
        'deploy_prod',
        'spend_money',
        'change_user_visible_behavior',
      ];

      for (const action of actions) {
        const decision = service.checkPolicy(action, mission);
        expect(typeof decision.allowed).toBe('boolean');
      }
    });

    it('should reject unknown action', () => {
      const mission = makeMission('conservative');
      const decision = service.checkPolicy('unknown_action' as PolicyAction, mission);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain('Unknown policy action');
    });
  });

  // -----------------------------------------------------------------------
  // checkPolicy — Escalation Rules
  // -----------------------------------------------------------------------
  describe('checkPolicy — escalation rules', () => {
    it('should block when cost_exceeded rule with block action is triggered', () => {
      const mission = makeMission('autonomous');
      // Add a blocking escalation rule
      mission.policy.escalationRules = [
        { condition: 'cost_exceeded', threshold: 100, escalateTo: 'user', action: 'block' },
      ];

      const context: EscalationContext = { currentCost: 150 };
      const decision = service.checkPolicy('create_task', mission, context);
      expect(decision.allowed).toBe(false);
      expect(decision.escalation).toBeDefined();
      expect(decision.escalation!.condition).toBe('cost_exceeded');
    });

    it('should allow but attach escalation when notify rule triggered', () => {
      const mission = makeMission('autonomous');
      mission.policy.escalationRules = [
        { condition: 'failure_count', threshold: 3, escalateTo: 'team_lead', action: 'notify' },
      ];

      const context: EscalationContext = { failureCount: 5 };
      const decision = service.checkPolicy('create_task', mission, context);
      expect(decision.allowed).toBe(true);
      expect(decision.escalation).toBeDefined();
    });

    it('should not trigger escalation when below threshold', () => {
      const mission = makeMission('autonomous');
      mission.policy.escalationRules = [
        { condition: 'cost_exceeded', threshold: 100, escalateTo: 'user', action: 'block' },
      ];

      const context: EscalationContext = { currentCost: 50 };
      const decision = service.checkPolicy('create_task', mission, context);
      expect(decision.allowed).toBe(true);
      expect(decision.escalation).toBeUndefined();
    });

    it('should not evaluate escalation if gate blocks first', () => {
      const mission = makeMission('conservative');
      mission.policy.escalationRules = [
        { condition: 'cost_exceeded', threshold: 100, escalateTo: 'user', action: 'block' },
      ];

      const context: EscalationContext = { currentCost: 150 };
      const decision = service.checkPolicy('create_task', mission, context);
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe('canCreateTasks'); // blocked by gate, not escalation
      expect(decision.escalation).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // checkParallelCapacity
  // -----------------------------------------------------------------------
  describe('checkParallelCapacity', () => {
    it('should allow when below limit', () => {
      const mission = makeMission('moderate'); // maxParallelExecutions: 3
      const decision = service.checkParallelCapacity(mission, 2);
      expect(decision.allowed).toBe(true);
    });

    it('should block when at limit', () => {
      const mission = makeMission('moderate');
      const decision = service.checkParallelCapacity(mission, 3);
      expect(decision.allowed).toBe(false);
      expect(decision.blockedBy).toBe('maxParallelExecutions');
    });

    it('should block when above limit', () => {
      const mission = makeMission('conservative'); // maxParallelExecutions: 1
      const decision = service.checkParallelCapacity(mission, 5);
      expect(decision.allowed).toBe(false);
    });

    it('should allow when at 0 executions', () => {
      const mission = makeMission('conservative');
      const decision = service.checkParallelCapacity(mission, 0);
      expect(decision.allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // evaluateEscalationRules
  // -----------------------------------------------------------------------
  describe('evaluateEscalationRules', () => {
    const rules: EscalationRule[] = [
      { condition: 'cost_exceeded', threshold: 50, escalateTo: 'user', action: 'pause' },
      { condition: 'failure_count', threshold: 5, escalateTo: 'team_lead', action: 'notify' },
      { condition: 'security_concern', threshold: 1, escalateTo: 'user', action: 'block' },
    ];

    it('should return not triggered when no rules match', () => {
      const context: EscalationContext = { currentCost: 10, failureCount: 1 };
      const result = service.evaluateEscalationRules(rules, context);
      expect(result.triggered).toBe(false);
      expect(result.triggeredRules).toHaveLength(0);
    });

    it('should trigger cost_exceeded rule', () => {
      const context: EscalationContext = { currentCost: 75 };
      const result = service.evaluateEscalationRules(rules, context);
      expect(result.triggered).toBe(true);
      expect(result.triggeredRules).toHaveLength(1);
      expect(result.triggeredRules[0].condition).toBe('cost_exceeded');
    });

    it('should trigger multiple rules', () => {
      const context: EscalationContext = { currentCost: 75, failureCount: 10 };
      const result = service.evaluateEscalationRules(rules, context);
      expect(result.triggeredRules).toHaveLength(2);
    });

    it('should identify block as most severe action', () => {
      const context: EscalationContext = { currentCost: 75, securityConcern: true };
      const result = service.evaluateEscalationRules(rules, context);
      expect(result.requiredAction).toBe('block');
    });

    it('should identify pause over notify', () => {
      const context: EscalationContext = { currentCost: 75, failureCount: 10 };
      const result = service.evaluateEscalationRules(rules, context);
      expect(result.requiredAction).toBe('pause');
    });

    it('should handle time_exceeded', () => {
      const timeRules: EscalationRule[] = [
        { condition: 'time_exceeded', threshold: 48, escalateTo: 'user', action: 'notify' },
      ];
      const context: EscalationContext = { hoursElapsed: 72 };
      const result = service.evaluateEscalationRules(timeRules, context);
      expect(result.triggered).toBe(true);
    });

    it('should handle scope_change', () => {
      const scopeRules: EscalationRule[] = [
        { condition: 'scope_change', threshold: 1, escalateTo: 'orchestrator', action: 'pause' },
      ];
      const context: EscalationContext = { scopeChanged: true };
      const result = service.evaluateEscalationRules(scopeRules, context);
      expect(result.triggered).toBe(true);
    });

    it('should not trigger scope_change when not changed', () => {
      const scopeRules: EscalationRule[] = [
        { condition: 'scope_change', threshold: 1, escalateTo: 'orchestrator', action: 'pause' },
      ];
      const context: EscalationContext = { scopeChanged: false };
      const result = service.evaluateEscalationRules(scopeRules, context);
      expect(result.triggered).toBe(false);
    });

    it('should handle empty rules array', () => {
      const result = service.evaluateEscalationRules([], { currentCost: 1000 });
      expect(result.triggered).toBe(false);
    });

    it('should handle undefined context values', () => {
      const result = service.evaluateEscalationRules(rules, {});
      expect(result.triggered).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // dryRunCheck
  // -----------------------------------------------------------------------
  describe('dryRunCheck', () => {
    it('should check against a policy without needing a full mission', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      const decision = service.dryRunCheck('create_task', policy);
      expect(decision.allowed).toBe(true);
    });

    it('should block when policy denies', () => {
      const policy = createMissionPolicy('m-1', 'conservative');
      const decision = service.dryRunCheck('deploy_staging', policy);
      expect(decision.allowed).toBe(false);
    });

    it('should evaluate escalation rules in dry run', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      policy.escalationRules = [
        { condition: 'cost_exceeded', threshold: 10, escalateTo: 'user', action: 'block' },
      ];
      const context: EscalationContext = { currentCost: 50 };
      const decision = service.dryRunCheck('create_task', policy, context);
      expect(decision.allowed).toBe(false);
    });
  });
});
