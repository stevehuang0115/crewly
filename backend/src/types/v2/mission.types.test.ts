/**
 * Tests for V2 Mission & MissionPolicy Type Definitions
 *
 * @module types/v2/mission.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  MISSION_STATUSES,
  TERMINAL_MISSION_STATUSES,
  MISSION_TRANSITIONS,
  POLICY_ACTIONS,
  ESCALATION_CONDITIONS,
  ACTION_TO_POLICY_FIELD,
  CONSERVATIVE_POLICY,
  MODERATE_POLICY,
  AUTONOMOUS_POLICY,
  isValidMissionStatus,
  isValidPolicyAction,
  isValidEscalationCondition,
  isValidMissionTransition,
  isValidEscalationRule,
  isValidMissionPolicy,
  isMission,
  createMissionPolicy,
  createMission,
} from './mission.types.js';
import type { MissionPolicy, EscalationRule, CreateMissionInput } from './mission.types.js';

describe('Mission Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('MISSION_STATUSES', () => {
    it('should contain 4 statuses', () => {
      expect(MISSION_STATUSES).toHaveLength(4);
      expect(MISSION_STATUSES).toContain('active');
      expect(MISSION_STATUSES).toContain('paused');
      expect(MISSION_STATUSES).toContain('completed');
      expect(MISSION_STATUSES).toContain('cancelled');
    });
  });

  describe('TERMINAL_MISSION_STATUSES', () => {
    it('should contain completed and cancelled', () => {
      expect(TERMINAL_MISSION_STATUSES.has('completed')).toBe(true);
      expect(TERMINAL_MISSION_STATUSES.has('cancelled')).toBe(true);
      expect(TERMINAL_MISSION_STATUSES.size).toBe(2);
    });
  });

  describe('POLICY_ACTIONS', () => {
    it('should contain 7 actions', () => {
      expect(POLICY_ACTIONS).toHaveLength(7);
    });
  });

  describe('ACTION_TO_POLICY_FIELD', () => {
    it('should map every action to a policy boolean field', () => {
      for (const action of POLICY_ACTIONS) {
        expect(ACTION_TO_POLICY_FIELD[action]).toBeDefined();
      }
    });
    it('should map create_task to canCreateTasks', () => {
      expect(ACTION_TO_POLICY_FIELD.create_task).toBe('canCreateTasks');
    });
    it('should map deploy_prod to canDeployToProd', () => {
      expect(ACTION_TO_POLICY_FIELD.deploy_prod).toBe('canDeployToProd');
    });
  });

  // -----------------------------------------------------------------------
  // Default Policies
  // -----------------------------------------------------------------------
  describe('CONSERVATIVE_POLICY', () => {
    it('should have all capabilities disabled', () => {
      expect(CONSERVATIVE_POLICY.canCreateTasks).toBe(false);
      expect(CONSERVATIVE_POLICY.canDeployToProd).toBe(false);
      expect(CONSERVATIVE_POLICY.canSpendMoney).toBe(false);
      expect(CONSERVATIVE_POLICY.maxParallelExecutions).toBe(1);
    });
  });

  describe('MODERATE_POLICY', () => {
    it('should allow task creation and closure', () => {
      expect(MODERATE_POLICY.canCreateTasks).toBe(true);
      expect(MODERATE_POLICY.canCloseTasks).toBe(true);
    });
    it('should not allow deploy or spend', () => {
      expect(MODERATE_POLICY.canDeployToStaging).toBe(false);
      expect(MODERATE_POLICY.canSpendMoney).toBe(false);
    });
  });

  describe('AUTONOMOUS_POLICY', () => {
    it('should allow most capabilities except prod deploy', () => {
      expect(AUTONOMOUS_POLICY.canCreateTasks).toBe(true);
      expect(AUTONOMOUS_POLICY.canDeployToStaging).toBe(true);
      expect(AUTONOMOUS_POLICY.canDeployToProd).toBe(false);
      expect(AUTONOMOUS_POLICY.canSpendMoney).toBe(true);
    });
    it('should have escalation rules', () => {
      expect(AUTONOMOUS_POLICY.escalationRules.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // State Machine
  // -----------------------------------------------------------------------
  describe('isValidMissionTransition', () => {
    it('should allow active → paused', () => {
      expect(isValidMissionTransition('active', 'paused')).toBe(true);
    });
    it('should allow active → completed', () => {
      expect(isValidMissionTransition('active', 'completed')).toBe(true);
    });
    it('should allow paused → active', () => {
      expect(isValidMissionTransition('paused', 'active')).toBe(true);
    });
    it('should disallow completed → any', () => {
      for (const s of MISSION_STATUSES) {
        expect(isValidMissionTransition('completed', s)).toBe(false);
      }
    });
    it('should disallow cancelled → any', () => {
      for (const s of MISSION_STATUSES) {
        expect(isValidMissionTransition('cancelled', s)).toBe(false);
      }
    });
    it('should have entries for all statuses', () => {
      for (const s of MISSION_STATUSES) {
        expect(MISSION_TRANSITIONS).toHaveProperty(s);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidMissionStatus', () => {
    it('should accept valid statuses', () => {
      for (const s of MISSION_STATUSES) {
        expect(isValidMissionStatus(s)).toBe(true);
      }
    });
    it('should reject invalid', () => {
      expect(isValidMissionStatus('running')).toBe(false);
    });
  });

  describe('isValidPolicyAction', () => {
    it('should accept valid actions', () => {
      for (const a of POLICY_ACTIONS) {
        expect(isValidPolicyAction(a)).toBe(true);
      }
    });
    it('should reject invalid', () => {
      expect(isValidPolicyAction('delete_mission')).toBe(false);
    });
  });

  describe('isValidEscalationCondition', () => {
    it('should accept valid conditions', () => {
      for (const c of ESCALATION_CONDITIONS) {
        expect(isValidEscalationCondition(c)).toBe(true);
      }
    });
    it('should reject invalid', () => {
      expect(isValidEscalationCondition('unknown')).toBe(false);
    });
  });

  describe('isValidEscalationRule', () => {
    const valid: EscalationRule = {
      condition: 'cost_exceeded',
      threshold: 50,
      escalateTo: 'user',
      action: 'pause',
    };
    it('should accept valid rule', () => {
      expect(isValidEscalationRule(valid)).toBe(true);
    });
    it('should reject null', () => {
      expect(isValidEscalationRule(null)).toBe(false);
    });
    it('should reject invalid condition', () => {
      expect(isValidEscalationRule({ ...valid, condition: 'bogus' })).toBe(false);
    });
    it('should reject negative threshold', () => {
      expect(isValidEscalationRule({ ...valid, threshold: -1 })).toBe(false);
    });
    it('should reject invalid escalateTo', () => {
      expect(isValidEscalationRule({ ...valid, escalateTo: 'admin' })).toBe(false);
    });
    it('should reject invalid action', () => {
      expect(isValidEscalationRule({ ...valid, action: 'delete' })).toBe(false);
    });
  });

  describe('isValidMissionPolicy', () => {
    it('should accept valid policy', () => {
      const policy = createMissionPolicy('mission-1');
      expect(isValidMissionPolicy(policy)).toBe(true);
    });
    it('should reject null', () => {
      expect(isValidMissionPolicy(null)).toBe(false);
    });
    it('should reject policy with zero maxParallelExecutions', () => {
      const policy = { ...createMissionPolicy('m-1'), maxParallelExecutions: 0 };
      expect(isValidMissionPolicy(policy)).toBe(false);
    });
  });

  describe('isMission', () => {
    it('should accept valid mission', () => {
      const mission = createMission({
        objective: 'Ship V3',
        ownerTeamId: 'team-1',
        successCriteria: ['All tests pass'],
        currentStrategy: 'Incremental delivery',
      });
      expect(isMission(mission)).toBe(true);
    });
    it('should reject null', () => {
      expect(isMission(null)).toBe(false);
    });
    it('should reject invalid status', () => {
      const mission = createMission({
        objective: 'X',
        ownerTeamId: 't',
        successCriteria: [],
        currentStrategy: 's',
      });
      expect(isMission({ ...mission, status: 'bogus' })).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createMissionPolicy', () => {
    it('should create conservative policy by default', () => {
      const policy = createMissionPolicy('m-1');
      expect(policy.missionId).toBe('m-1');
      expect(policy.canCreateTasks).toBe(false);
      expect(policy.canDeployToProd).toBe(false);
    });
    it('should create moderate policy', () => {
      const policy = createMissionPolicy('m-1', 'moderate');
      expect(policy.canCreateTasks).toBe(true);
      expect(policy.canCloseTasks).toBe(true);
      expect(policy.canDeployToStaging).toBe(false);
    });
    it('should create autonomous policy', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      expect(policy.canDeployToStaging).toBe(true);
      expect(policy.canDeployToProd).toBe(false);
    });
    it('should deep copy escalation rules', () => {
      const p1 = createMissionPolicy('m-1', 'autonomous');
      const p2 = createMissionPolicy('m-2', 'autonomous');
      p1.escalationRules[0].threshold = 9999;
      expect(p2.escalationRules[0].threshold).not.toBe(9999);
    });
  });

  describe('createMission', () => {
    const input: CreateMissionInput = {
      objective: 'Ship V3 architecture',
      ownerTeamId: 'team-product',
      successCriteria: ['Reconciler operational', 'TaskPool functional'],
      currentStrategy: 'Incremental delivery with guardrails',
    };

    it('should create mission with status active', () => {
      const mission = createMission(input);
      expect(mission.status).toBe('active');
    });
    it('should generate UUID id', () => {
      const mission = createMission(input);
      expect(mission.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should set default cadence to weekly Monday 9am', () => {
      const mission = createMission(input);
      expect(mission.cadence).toBe('0 9 * * 1');
    });
    it('should default to conservative policy', () => {
      const mission = createMission(input);
      expect(mission.policy.canCreateTasks).toBe(false);
    });
    it('should set policy.missionId to match mission.id', () => {
      const mission = createMission(input);
      expect(mission.policy.missionId).toBe(mission.id);
    });
    it('should initialize empty learnings', () => {
      const mission = createMission(input);
      expect(mission.learnings).toEqual([]);
    });
    it('should initialize empty activeProjectTaskIds', () => {
      const mission = createMission(input);
      expect(mission.activeProjectTaskIds).toEqual([]);
    });
    it('should respect custom cadence', () => {
      const mission = createMission({ ...input, cadence: '0 0 * * *' });
      expect(mission.cadence).toBe('0 0 * * *');
    });
    it('should merge partial policy overrides', () => {
      const mission = createMission({ ...input, policy: { canCreateTasks: true } });
      expect(mission.policy.canCreateTasks).toBe(true);
      expect(mission.policy.canDeployToProd).toBe(false); // still conservative default
    });
  });
});
