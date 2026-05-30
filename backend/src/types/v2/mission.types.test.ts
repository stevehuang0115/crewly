/**
 * Tests for V2 Mission & MissionPolicy Type Definitions
 *
 * @module types/v2/mission.types.test
 */

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
  PHASE_GATE_APPROVALS,
  CONSERVATIVE_CADENCE,
  MODERATE_CADENCE,
  AUTONOMOUS_CADENCE,
  MISSION_PRIORITIES,
  MISSION_PRIORITY_RANK,
  isValidMissionStatus,
  isValidPolicyAction,
  isValidEscalationCondition,
  isValidMissionTransition,
  isValidEscalationRule,
  isValidPhaseGateApproval,
  isValidWorkHoursWindow,
  isValidExecutionCadence,
  isValidMissionPolicy,
  isMission,
  createMissionPolicy,
  createMission,
  getEffectiveCadence,
  mergeExecutionCadence,
  validateParentLink,
  MISSION_LEVELS,
  MISSION_LEVEL_DEPTH,
  PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS,
  isValidMissionLevel,
  validateLevelLink,
  deriveLevel,
  isValidProposalState,
  isValidProposalTransition,
  validateCascadeLink,
  createMonthlyPeriod,
  isPeriodActive,
} from './mission.types.js';
import type {
  Mission,
  MissionPolicy,
  EscalationRule,
  CreateMissionInput,
  ExecutionCadence,
  MissionLevel,
  ProposalState,
  ApprovalState,
  UpdateMissionInput,
} from './mission.types.js';

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
    it('should contain 10 actions', () => {
      expect(POLICY_ACTIONS).toHaveLength(10);
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
    it('should sync cadence into executionCadence.reviewSchedule', () => {
      const mission = createMission({ ...input, cadence: '0 0 * * *' });
      expect(mission.policy.executionCadence?.reviewSchedule).toBe('0 0 * * *');
    });
    it('should default executionCadence to conservative', () => {
      const mission = createMission(input);
      expect(mission.policy.executionCadence).toBeDefined();
      expect(mission.policy.executionCadence?.dailyItemLimit).toBe(CONSERVATIVE_CADENCE.dailyItemLimit);
      expect(mission.policy.executionCadence?.phaseGateApproval).toBe('human');
    });
  });

  // -----------------------------------------------------------------------
  // ExecutionCadence Validators
  // -----------------------------------------------------------------------
  describe('isValidPhaseGateApproval', () => {
    it('should accept all valid values', () => {
      for (const v of PHASE_GATE_APPROVALS) {
        expect(isValidPhaseGateApproval(v)).toBe(true);
      }
    });
    it('should reject invalid values', () => {
      expect(isValidPhaseGateApproval('admin')).toBe(false);
      expect(isValidPhaseGateApproval('')).toBe(false);
    });
  });

  describe('isValidWorkHoursWindow', () => {
    it('should accept valid work hours', () => {
      expect(isValidWorkHoursWindow({
        startHour: 9, endHour: 17, timezone: 'UTC', activeDays: [1, 2, 3, 4, 5],
      })).toBe(true);
    });
    it('should accept empty activeDays (every day)', () => {
      expect(isValidWorkHoursWindow({
        startHour: 0, endHour: 23, timezone: 'America/New_York', activeDays: [],
      })).toBe(true);
    });
    it('should reject hour out of range', () => {
      expect(isValidWorkHoursWindow({
        startHour: 25, endHour: 17, timezone: 'UTC', activeDays: [],
      })).toBe(false);
    });
    it('should reject non-integer hour', () => {
      expect(isValidWorkHoursWindow({
        startHour: 9.5, endHour: 17, timezone: 'UTC', activeDays: [],
      })).toBe(false);
    });
    it('should reject empty timezone', () => {
      expect(isValidWorkHoursWindow({
        startHour: 9, endHour: 17, timezone: '', activeDays: [],
      })).toBe(false);
    });
    it('should reject invalid day number', () => {
      expect(isValidWorkHoursWindow({
        startHour: 9, endHour: 17, timezone: 'UTC', activeDays: [7],
      })).toBe(false);
    });
    it('should reject null', () => {
      expect(isValidWorkHoursWindow(null)).toBe(false);
    });
  });

  describe('isValidExecutionCadence', () => {
    it('should accept valid cadence', () => {
      expect(isValidExecutionCadence(CONSERVATIVE_CADENCE)).toBe(true);
      expect(isValidExecutionCadence(MODERATE_CADENCE)).toBe(true);
      expect(isValidExecutionCadence(AUTONOMOUS_CADENCE)).toBe(true);
    });
    it('should accept cadence with null workHours', () => {
      expect(isValidExecutionCadence({
        ...CONSERVATIVE_CADENCE, workHours: null,
      })).toBe(true);
    });
    it('should reject empty reviewSchedule', () => {
      expect(isValidExecutionCadence({
        ...CONSERVATIVE_CADENCE, reviewSchedule: '',
      })).toBe(false);
    });
    it('should reject negative dailyItemLimit', () => {
      expect(isValidExecutionCadence({
        ...CONSERVATIVE_CADENCE, dailyItemLimit: -1,
      })).toBe(false);
    });
    it('should reject non-integer dailyItemLimit', () => {
      expect(isValidExecutionCadence({
        ...CONSERVATIVE_CADENCE, dailyItemLimit: 2.5,
      })).toBe(false);
    });
    it('should reject invalid phaseGateApproval', () => {
      expect(isValidExecutionCadence({
        ...CONSERVATIVE_CADENCE, phaseGateApproval: 'admin',
      })).toBe(false);
    });
    it('should reject null', () => {
      expect(isValidExecutionCadence(null)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Cadence Constants
  // -----------------------------------------------------------------------
  describe('Cadence Constants', () => {
    it('CONSERVATIVE_CADENCE should have human phase gate and verification', () => {
      expect(CONSERVATIVE_CADENCE.phaseGateApproval).toBe('human');
      expect(CONSERVATIVE_CADENCE.requireVerificationGate).toBe(true);
      expect(CONSERVATIVE_CADENCE.dailyItemLimit).toBe(3);
    });
    it('MODERATE_CADENCE should have team_lead phase gate', () => {
      expect(MODERATE_CADENCE.phaseGateApproval).toBe('team_lead');
      expect(MODERATE_CADENCE.requireVerificationGate).toBe(true);
      expect(MODERATE_CADENCE.dailyItemLimit).toBe(10);
    });
    it('AUTONOMOUS_CADENCE should have no phase gate and no verification', () => {
      expect(AUTONOMOUS_CADENCE.phaseGateApproval).toBe('none');
      expect(AUTONOMOUS_CADENCE.requireVerificationGate).toBe(false);
      expect(AUTONOMOUS_CADENCE.dailyItemLimit).toBe(0);
      expect(AUTONOMOUS_CADENCE.workHours).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Policy Templates include executionCadence
  // -----------------------------------------------------------------------
  describe('Policy Templates with ExecutionCadence', () => {
    it('CONSERVATIVE_POLICY should include CONSERVATIVE_CADENCE', () => {
      expect(CONSERVATIVE_POLICY.executionCadence).toEqual(CONSERVATIVE_CADENCE);
    });
    it('MODERATE_POLICY should include MODERATE_CADENCE', () => {
      expect(MODERATE_POLICY.executionCadence).toEqual(MODERATE_CADENCE);
    });
    it('AUTONOMOUS_POLICY should include AUTONOMOUS_CADENCE', () => {
      expect(AUTONOMOUS_POLICY.executionCadence).toEqual(AUTONOMOUS_CADENCE);
    });
  });

  // -----------------------------------------------------------------------
  // isValidMissionPolicy with executionCadence
  // -----------------------------------------------------------------------
  describe('isValidMissionPolicy with executionCadence', () => {
    it('should accept policy without executionCadence (backward compat)', () => {
      const policy: MissionPolicy = {
        missionId: 'test-mission',
        canCreateTasks: false,
        canReprioritizeTasks: false,
        canCloseTasks: false,
        canDeployToStaging: false,
        canDeployToProd: false,
        canSpendMoney: false,
        canChangeUserVisibleBehaviorWithoutReview: false,
        maxParallelExecutions: 1,
        escalationRules: [],
      };
      expect(isValidMissionPolicy(policy)).toBe(true);
    });
    it('should accept policy with valid executionCadence', () => {
      const policy: MissionPolicy = {
        missionId: 'test-mission',
        canCreateTasks: false,
        canReprioritizeTasks: false,
        canCloseTasks: false,
        canDeployToStaging: false,
        canDeployToProd: false,
        canSpendMoney: false,
        canChangeUserVisibleBehaviorWithoutReview: false,
        maxParallelExecutions: 1,
        escalationRules: [],
        executionCadence: CONSERVATIVE_CADENCE,
      };
      expect(isValidMissionPolicy(policy)).toBe(true);
    });
    it('should reject policy with invalid executionCadence', () => {
      const policy = {
        missionId: 'test-mission',
        canCreateTasks: false,
        canReprioritizeTasks: false,
        canCloseTasks: false,
        canDeployToStaging: false,
        canDeployToProd: false,
        canSpendMoney: false,
        canChangeUserVisibleBehaviorWithoutReview: false,
        maxParallelExecutions: 1,
        escalationRules: [],
        executionCadence: { reviewSchedule: '' }, // invalid
      };
      expect(isValidMissionPolicy(policy)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getEffectiveCadence
  // -----------------------------------------------------------------------
  describe('getEffectiveCadence', () => {
    it('should return policy cadence when defined', () => {
      const policy = createMissionPolicy('m-1', 'autonomous');
      const cadence = getEffectiveCadence(policy);
      expect(cadence.dailyItemLimit).toBe(AUTONOMOUS_CADENCE.dailyItemLimit);
      expect(cadence.phaseGateApproval).toBe('none');
    });
    it('should fall back to conservative when undefined', () => {
      const policy: MissionPolicy = {
        missionId: 'm-1',
        canCreateTasks: false,
        canReprioritizeTasks: false,
        canCloseTasks: false,
        canDeployToStaging: false,
        canDeployToProd: false,
        canSpendMoney: false,
        canChangeUserVisibleBehaviorWithoutReview: false,
        maxParallelExecutions: 1,
        escalationRules: [],
        // no executionCadence
      };
      const cadence = getEffectiveCadence(policy);
      expect(cadence.dailyItemLimit).toBe(CONSERVATIVE_CADENCE.dailyItemLimit);
      expect(cadence.phaseGateApproval).toBe('human');
    });
  });

  // -----------------------------------------------------------------------
  // mergeExecutionCadence
  // -----------------------------------------------------------------------
  describe('mergeExecutionCadence', () => {
    it('should merge partial updates', () => {
      const result = mergeExecutionCadence(CONSERVATIVE_CADENCE, { dailyItemLimit: 20 });
      expect(result.dailyItemLimit).toBe(20);
      expect(result.reviewSchedule).toBe(CONSERVATIVE_CADENCE.reviewSchedule);
      expect(result.phaseGateApproval).toBe(CONSERVATIVE_CADENCE.phaseGateApproval);
    });
    it('should clear workHours when set to null', () => {
      const result = mergeExecutionCadence(CONSERVATIVE_CADENCE, { workHours: null });
      expect(result.workHours).toBeNull();
    });
    it('should deep merge workHours', () => {
      const result = mergeExecutionCadence(CONSERVATIVE_CADENCE, {
        workHours: { startHour: 7, endHour: 22, timezone: 'UTC', activeDays: [1, 2, 3, 4, 5] },
      });
      expect(result.workHours?.startHour).toBe(7);
      expect(result.workHours?.endHour).toBe(22);
    });
    it('should not mutate original', () => {
      const original: ExecutionCadence = { ...CONSERVATIVE_CADENCE };
      mergeExecutionCadence(original, { dailyItemLimit: 99 });
      expect(original.dailyItemLimit).toBe(CONSERVATIVE_CADENCE.dailyItemLimit);
    });
  });

  // -----------------------------------------------------------------------
  // Priority
  // -----------------------------------------------------------------------
  describe('MISSION_PRIORITIES', () => {
    it('lists the four levels ordered from most to least important', () => {
      expect(MISSION_PRIORITIES).toEqual(['critical', 'high', 'medium', 'low']);
    });

    it('rank order matches list order', () => {
      expect(MISSION_PRIORITY_RANK.critical).toBeLessThan(MISSION_PRIORITY_RANK.high);
      expect(MISSION_PRIORITY_RANK.high).toBeLessThan(MISSION_PRIORITY_RANK.medium);
      expect(MISSION_PRIORITY_RANK.medium).toBeLessThan(MISSION_PRIORITY_RANK.low);
    });
  });

  // -----------------------------------------------------------------------
  // validateParentLink
  // -----------------------------------------------------------------------
  describe('validateParentLink', () => {
    type Pair = Pick<Mission, 'id' | 'parentMissionId'>;
    const m = (id: string, parentMissionId?: string): Pair => ({ id, parentMissionId });

    it('rejects self-reference', () => {
      const reason = validateParentLink('a', 'a', new Map());
      expect(reason).toMatch(/own parent/i);
    });

    it('rejects unknown parent', () => {
      const reason = validateParentLink('a', 'does-not-exist', new Map());
      expect(reason).toMatch(/does not exist/i);
    });

    it('accepts a valid link to an existing parent', () => {
      const byId = new Map<string, Pair>([['p', m('p')]]);
      expect(validateParentLink('c', 'p', byId)).toBeNull();
    });

    it('rejects a cycle through intermediate ancestors', () => {
      //    child (a)           proposed parent: b
      //    existing: b → c → a (cycle if we add a → b)
      const byId = new Map<string, Pair>([
        ['a', m('a')],
        ['b', m('b', 'c')],
        ['c', m('c', 'a')],
      ]);
      const reason = validateParentLink('a', 'b', byId);
      expect(reason).toMatch(/cycle/i);
    });

    it('detects an already-cyclic parent chain defensively', () => {
      const byId = new Map<string, Pair>([
        ['x', m('x', 'y')],
        ['y', m('y', 'x')],
      ]);
      const reason = validateParentLink('new', 'x', byId);
      expect(reason).toMatch(/cycle/i);
    });
  });

  // -----------------------------------------------------------------------
  // OKR-reminder additions: Mission.ownerId / lastReminderAt
  // -----------------------------------------------------------------------
  describe('Mission OKR-reminder fields', () => {
    it('createMission persists optional ownerId from input', () => {
      const mission = createMission({
        objective: 'Test',
        ownerTeamId: 't1',
        ownerId: 'u1',
        successCriteria: [],
        currentStrategy: '',
      });

      expect(mission.ownerId).toBe('u1');
    });

    it('createMission leaves ownerId undefined when not provided', () => {
      const mission = createMission({
        objective: 'Test',
        ownerTeamId: 't1',
        successCriteria: [],
        currentStrategy: '',
      });

      expect(mission.ownerId).toBeUndefined();
    });

    it('Mission accepts lastReminderAt as an optional ISO timestamp', () => {
      const m: Mission = createMission({
        objective: 'Test',
        ownerTeamId: 't1',
        successCriteria: [],
        currentStrategy: '',
      });
      m.lastReminderAt = new Date().toISOString();

      expect(typeof m.lastReminderAt).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // OKR Cascade: MissionLevel
  // -----------------------------------------------------------------------
  describe('MissionLevel', () => {
    it('MISSION_LEVELS contains exactly company, team, project in order', () => {
      expect(MISSION_LEVELS).toEqual(['company', 'team', 'project']);
    });

    it('MISSION_LEVEL_DEPTH assigns ascending depths', () => {
      expect(MISSION_LEVEL_DEPTH).toEqual({ company: 0, team: 1, project: 2 });
    });

    it('isValidMissionLevel accepts valid levels', () => {
      for (const lvl of MISSION_LEVELS) {
        expect(isValidMissionLevel(lvl)).toBe(true);
      }
    });

    it('isValidMissionLevel rejects unknown strings', () => {
      expect(isValidMissionLevel('individual')).toBe(false);
      expect(isValidMissionLevel('')).toBe(false);
    });
  });

  describe('validateLevelLink (adjacency matrix)', () => {
    it('company with no parent is valid', () => {
      expect(validateLevelLink('company', undefined)).toBeNull();
    });

    it('company with a parent is invalid', () => {
      expect(validateLevelLink('company', 'team')).not.toBeNull();
      expect(validateLevelLink('company', 'company')).not.toBeNull();
    });

    it('team requires a company parent', () => {
      expect(validateLevelLink('team', 'company')).toBeNull();
      expect(validateLevelLink('team', undefined)).not.toBeNull();
      expect(validateLevelLink('team', 'team')).not.toBeNull();
      expect(validateLevelLink('team', 'project')).not.toBeNull();
    });

    it('project requires a team parent', () => {
      expect(validateLevelLink('project', 'team')).toBeNull();
      expect(validateLevelLink('project', undefined)).not.toBeNull();
      expect(validateLevelLink('project', 'company')).not.toBeNull();
      expect(validateLevelLink('project', 'project')).not.toBeNull();
    });

    it('covers the full child x parent matrix exactly once-legal-per-child', () => {
      const parents: Array<MissionLevel | undefined> = [undefined, 'company', 'team', 'project'];
      const legal: Record<MissionLevel, MissionLevel | undefined> = {
        company: undefined,
        team: 'company',
        project: 'team',
      };
      for (const child of MISSION_LEVELS) {
        for (const parent of parents) {
          const result = validateLevelLink(child, parent);
          if (parent === legal[child]) {
            expect(result).toBeNull();
          } else {
            expect(result).not.toBeNull();
          }
        }
      }
    });
  });

  describe('deriveLevel', () => {
    const byId = new Map<string, Pick<Mission, 'id' | 'parentMissionId'>>([
      ['co', { id: 'co' }],
      ['team', { id: 'team', parentMissionId: 'co' }],
      ['proj', { id: 'proj', parentMissionId: 'team' }],
      ['deep', { id: 'deep', parentMissionId: 'proj' }],
    ]);

    it('depth 0 (no parent) ⇒ company', () => {
      expect(deriveLevel('co', byId)).toBe('company');
    });

    it('depth 1 ⇒ team', () => {
      expect(deriveLevel('team', byId)).toBe('team');
    });

    it('depth 2 ⇒ project', () => {
      expect(deriveLevel('proj', byId)).toBe('project');
    });

    it('depth >= 2 stays project', () => {
      expect(deriveLevel('deep', byId)).toBe('project');
    });

    it('handles a cycle without infinite looping', () => {
      const cyclic = new Map<string, Pick<Mission, 'id' | 'parentMissionId'>>([
        ['a', { id: 'a', parentMissionId: 'b' }],
        ['b', { id: 'b', parentMissionId: 'a' }],
      ]);
      const level = deriveLevel('a', cyclic);
      expect(MISSION_LEVELS).toContain(level);
    });
  });

  // -----------------------------------------------------------------------
  // OKR Cascade: Proposal / Approval governance
  // -----------------------------------------------------------------------
  describe('ProposalState', () => {
    it('PROPOSAL_STATES lists the four states', () => {
      expect(PROPOSAL_STATES).toEqual(['draft', 'pending_approval', 'approved', 'rejected']);
    });

    it('isValidProposalState validates membership', () => {
      for (const s of PROPOSAL_STATES) {
        expect(isValidProposalState(s)).toBe(true);
      }
      expect(isValidProposalState('active')).toBe(false);
    });
  });

  describe('isValidProposalTransition', () => {
    it('draft only advances to pending_approval', () => {
      expect(isValidProposalTransition('draft', 'pending_approval')).toBe(true);
      expect(isValidProposalTransition('draft', 'approved')).toBe(false);
      expect(isValidProposalTransition('draft', 'rejected')).toBe(false);
    });

    it('pending_approval advances to approved or rejected', () => {
      expect(isValidProposalTransition('pending_approval', 'approved')).toBe(true);
      expect(isValidProposalTransition('pending_approval', 'rejected')).toBe(true);
      expect(isValidProposalTransition('pending_approval', 'draft')).toBe(false);
    });

    it('approved is terminal', () => {
      for (const to of PROPOSAL_STATES) {
        expect(isValidProposalTransition('approved', to)).toBe(false);
      }
    });

    it('rejected can return to draft for a redraft', () => {
      expect(isValidProposalTransition('rejected', 'draft')).toBe(true);
      expect(isValidProposalTransition('rejected', 'approved')).toBe(false);
    });

    it('PROPOSAL_TRANSITIONS matches the guard', () => {
      for (const from of PROPOSAL_STATES) {
        for (const to of PROPOSAL_STATES) {
          expect(isValidProposalTransition(from, to)).toBe(PROPOSAL_TRANSITIONS[from].has(to));
        }
      }
    });

    it('ApprovalState shape is assignable', () => {
      const a: ApprovalState = {
        state: 'rejected',
        proposedBy: 'agent-1',
        proposedAt: new Date().toISOString(),
        decidedBy: 'steve',
        decidedAt: new Date().toISOString(),
        rejectionReason: 'scope too broad',
      };
      expect(a.state).toBe('rejected');
    });
  });

  // -----------------------------------------------------------------------
  // OKR Cascade: validateCascadeLink
  // -----------------------------------------------------------------------
  describe('validateCascadeLink', () => {
    const byId = new Map<string, Pick<Mission, 'id' | 'parentMissionId' | 'level'>>([
      ['co', { id: 'co', level: 'company' }],
      ['team', { id: 'team', parentMissionId: 'co', level: 'team' }],
    ]);

    it('company root with no parent is valid', () => {
      expect(validateCascadeLink('co2', 'company', undefined, byId)).toBeNull();
    });

    it('rejects company with a parent', () => {
      expect(validateCascadeLink('co2', 'company', 'co', byId)).not.toBeNull();
    });

    it('valid team under company', () => {
      expect(validateCascadeLink('team2', 'team', 'co', byId)).toBeNull();
    });

    it('valid project under team', () => {
      expect(validateCascadeLink('proj1', 'project', 'team', byId)).toBeNull();
    });

    it('rejects project under company (level mismatch)', () => {
      expect(validateCascadeLink('proj1', 'project', 'co', byId)).not.toBeNull();
    });

    it('rejects a self-referential link (cycle check still runs)', () => {
      expect(validateCascadeLink('team', 'team', 'team', byId)).not.toBeNull();
    });

    it('rejects link to a missing parent', () => {
      expect(validateCascadeLink('team2', 'team', 'ghost', byId)).not.toBeNull();
    });

    it('derives parent level when parent.level is absent', () => {
      const derivedById = new Map<string, Pick<Mission, 'id' | 'parentMissionId' | 'level'>>([
        ['co', { id: 'co' }],
        ['team', { id: 'team', parentMissionId: 'co' }],
      ]);
      // team's parent 'co' has no explicit level; deriveLevel ⇒ company, so a
      // project child of 'team' is valid.
      expect(validateCascadeLink('proj', 'project', 'team', derivedById)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // OKR Cascade: Mission / Input field additions (backward compatible)
  // -----------------------------------------------------------------------
  describe('Cascade field additions', () => {
    it('isMission still passes for a legacy mission without new fields', () => {
      const legacy = {
        id: 'm1',
        objective: 'legacy',
        ownerTeamId: 't1',
        status: 'active',
        createdAt: new Date().toISOString(),
        successCriteria: [],
        activeProjectTaskIds: [],
      };
      expect(isMission(legacy)).toBe(true);
    });

    it('createMission defaults a parentless mission to company level', () => {
      const m = createMission({
        objective: 'O',
        ownerTeamId: 't1',
        successCriteria: [],
        currentStrategy: '',
      });
      expect(m.level).toBe('company');
      expect(m.approval).toBeUndefined();
    });

    it('createMission honours explicit level/projectId/approval input', () => {
      const input: CreateMissionInput = {
        objective: 'O',
        ownerTeamId: 't1',
        successCriteria: [],
        currentStrategy: '',
        parentMissionId: 'team-1',
        level: 'project',
        projectId: 'proj-1',
        approval: { state: 'pending_approval', proposedBy: 'agent-1' },
      };
      const m = createMission(input);
      expect(m.level).toBe('project');
      expect(m.projectId).toBe('proj-1');
      expect(m.approval?.state).toBe('pending_approval');
      expect(m.parentMissionId).toBe('team-1');
    });

    it('UpdateMissionInput accepts cascade fields and excludes id/createdAt', () => {
      const patch: UpdateMissionInput = {
        objective: 'next',
        level: 'team',
        projectId: 'p2',
        parentMissionId: 'co-1',
        approval: { state: 'approved' },
        status: 'paused',
      };
      expect(patch.level).toBe('team');
      // @ts-expect-error id is immutable and not part of UpdateMissionInput
      patch.id = 'x';
    });
  });

  describe('createMonthlyPeriod', () => {
    it('builds a half-open monthly period with UTC bounds and a YYYY-MM label', () => {
      const p = createMonthlyPeriod(2026, 3); // March (1-based)
      expect(p.type).toBe('monthly');
      expect(p.startDate).toBe('2026-03-01T00:00:00.000Z');
      expect(p.endDate).toBe('2026-04-01T00:00:00.000Z'); // first day of next month, exclusive
      expect(p.label).toBe('2026-03');
      expect(isPeriodActive(p, new Date('2026-03-15T12:00:00.000Z'))).toBe(true);
      // end is exclusive
      expect(isPeriodActive(p, new Date('2026-04-01T00:00:00.000Z'))).toBe(false);
    });

    it('rolls December over into the next January', () => {
      const p = createMonthlyPeriod(2026, 12);
      expect(p.startDate).toBe('2026-12-01T00:00:00.000Z');
      expect(p.endDate).toBe('2027-01-01T00:00:00.000Z');
      expect(p.label).toBe('2026-12');
    });
  });

  describe('createMission priority', () => {
    it('copies the priority from input onto the mission', () => {
      const m = createMission({
        objective: 'O',
        ownerTeamId: 't',
        successCriteria: [],
        currentStrategy: '',
        priority: 'high',
      });
      expect(m.priority).toBe('high');
    });
  });
});
