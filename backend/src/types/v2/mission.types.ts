/**
 * V2 Mission & MissionPolicy Type Definitions
 *
 * A Mission represents a team's long-term objective. Missions drive
 * autonomous work independent of user Requests. MissionPolicy governs
 * what a team can do autonomously under a Mission.
 *
 * @module types/v2/mission.types
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Mission Status
// ---------------------------------------------------------------------------

/**
 * Lifecycle statuses for a Mission.
 *
 * State machine:
 *   active → paused       (user/orchestrator pauses)
 *   active → completed    (all success criteria met)
 *   active → cancelled    (mission abandoned)
 *   paused → active       (resumed)
 *   paused → cancelled    (abandoned while paused)
 *   completed is terminal
 *   cancelled is terminal
 */
export type MissionStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/** All valid MissionStatus values. */
export const MISSION_STATUSES: readonly MissionStatus[] = [
  'active',
  'paused',
  'completed',
  'cancelled',
] as const;

/** Terminal mission statuses. */
export const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'completed',
  'cancelled',
]);

/** Valid mission status transitions. */
export const MISSION_TRANSITIONS: Record<MissionStatus, ReadonlySet<MissionStatus>> = {
  active: new Set(['paused', 'completed', 'cancelled']),
  paused: new Set(['active', 'cancelled']),
  completed: new Set<MissionStatus>(),
  cancelled: new Set<MissionStatus>(),
};

// ---------------------------------------------------------------------------
// Escalation Rules
// ---------------------------------------------------------------------------

/**
 * Conditions that trigger escalation to humans.
 */
export type EscalationCondition =
  | 'cost_exceeded'
  | 'time_exceeded'
  | 'failure_count'
  | 'scope_change'
  | 'security_concern';

/** All valid escalation conditions. */
export const ESCALATION_CONDITIONS: readonly EscalationCondition[] = [
  'cost_exceeded',
  'time_exceeded',
  'failure_count',
  'scope_change',
  'security_concern',
] as const;

/**
 * Action to take on escalation.
 */
export type EscalationAction = 'pause' | 'notify' | 'block';

/**
 * Who to escalate to.
 */
export type EscalationTarget = 'user' | 'orchestrator' | 'team_lead';

/**
 * A rule that triggers escalation when a condition is met.
 */
export interface EscalationRule {
  /** Condition that triggers escalation */
  condition: EscalationCondition;
  /** Threshold value (dollars, hours, count, etc.) */
  threshold: number;
  /** Who to escalate to */
  escalateTo: EscalationTarget;
  /** Action to take */
  action: EscalationAction;
}

// ---------------------------------------------------------------------------
// Execution Cadence
// ---------------------------------------------------------------------------

/**
 * Who must approve phase transitions before downstream work unlocks.
 * - 'none': phases advance automatically when all items verified/done
 * - 'team_lead': team lead must explicitly approve the phase gate
 * - 'human': a human operator must approve via dashboard/API
 */
export type PhaseGateApproval = 'none' | 'team_lead' | 'human';

/** All valid PhaseGateApproval values. */
export const PHASE_GATE_APPROVALS: readonly PhaseGateApproval[] = [
  'none',
  'team_lead',
  'human',
] as const;

/**
 * Defines when autonomous execution is permitted.
 * Uses 24h format. If startHour > endHour, it wraps past midnight.
 */
export interface WorkHoursWindow {
  /** Hour execution may start (0-23) */
  startHour: number;
  /** Hour execution must stop (0-23) */
  endHour: number;
  /** IANA timezone, e.g. "America/New_York", "UTC" */
  timezone: string;
  /** Days of week when work is allowed (0=Sun, 6=Sat). Empty array = every day. */
  activeDays: number[];
}

/**
 * Structured execution pacing for a Mission.
 *
 * Controls HOW FAST and WHEN autonomous work proceeds, separate from
 * WHAT the team is allowed to do (capability gates on MissionPolicy).
 */
export interface ExecutionCadence {
  /** Review schedule as cron expression (replaces top-level Mission.cadence) */
  reviewSchedule: string;
  /** Max WorkItems that may enter 'running' per calendar day (UTC). 0 = unlimited. */
  dailyItemLimit: number;
  /** When autonomous work is allowed. null = 24/7. */
  workHours: WorkHoursWindow | null;
  /** Approval required at phase boundaries */
  phaseGateApproval: PhaseGateApproval;
  /** If true, downstream phase WorkItems stay blocked until ALL upstream phase items reach 'verified'. */
  requireVerificationGate: boolean;
}

// ---------------------------------------------------------------------------
// Default ExecutionCadence values
// ---------------------------------------------------------------------------

/**
 * Conservative cadence — slow, human-gated, business hours only.
 */
export const CONSERVATIVE_CADENCE: Readonly<ExecutionCadence> = {
  reviewSchedule: '0 9 * * 1',
  dailyItemLimit: 3,
  workHours: {
    startHour: 9,
    endHour: 17,
    timezone: 'UTC',
    activeDays: [1, 2, 3, 4, 5],
  },
  phaseGateApproval: 'human',
  requireVerificationGate: true,
} as const;

/**
 * Moderate cadence — steady flow, TL-gated phases, extended hours.
 */
export const MODERATE_CADENCE: Readonly<ExecutionCadence> = {
  reviewSchedule: '0 9 * * 1,4',
  dailyItemLimit: 10,
  workHours: {
    startHour: 8,
    endHour: 20,
    timezone: 'UTC',
    activeDays: [1, 2, 3, 4, 5],
  },
  phaseGateApproval: 'team_lead',
  requireVerificationGate: true,
} as const;

/**
 * Autonomous cadence — fast, self-advancing, 24/7.
 */
export const AUTONOMOUS_CADENCE: Readonly<ExecutionCadence> = {
  reviewSchedule: '0 9 * * *',
  dailyItemLimit: 0,
  workHours: null,
  phaseGateApproval: 'none',
  requireVerificationGate: false,
} as const;

// ---------------------------------------------------------------------------
// MissionPolicy
// ---------------------------------------------------------------------------

/**
 * Governs what a team can do autonomously under a Mission.
 * Each boolean is a capability gate — false means human approval required.
 */
export interface MissionPolicy {
  /** Mission this policy applies to */
  missionId: string;
  /** Can team create new ProjectTasks without approval */
  canCreateTasks: boolean;
  /** Can team reprioritize existing tasks */
  canReprioritizeTasks: boolean;
  /** Can team close tasks without review */
  canCloseTasks: boolean;
  /** Can team deploy to staging environment */
  canDeployToStaging: boolean;
  /** Can team deploy to production */
  canDeployToProd: boolean;
  /** Can team incur costs (API calls, cloud resources) */
  canSpendMoney: boolean;
  /** Can team change user-visible behavior without human review */
  canChangeUserVisibleBehaviorWithoutReview: boolean;
  /** Can team trigger a mission replan autonomously */
  canReplanMission?: boolean;
  /** Can team advance to next phase without approval */
  canAdvancePhase?: boolean;
  /** Can team adjust KR targets without approval */
  canAdjustKRTargets?: boolean;
  /** Maximum concurrent executions allowed */
  maxParallelExecutions: number;
  /** Rules for when to escalate to humans */
  escalationRules: EscalationRule[];
  /** Execution pacing controls. If undefined, conservative defaults apply. */
  executionCadence?: ExecutionCadence;
}

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

/**
 * A team's long-term objective.
 * Missions exist independently of user Requests — they represent
 * what a team is responsible for over weeks/months.
 */
export interface Mission {
  /** UUID v4 */
  id: string;
  /** What this mission aims to achieve */
  objective: string;
  /** Team that owns this mission */
  ownerTeamId: string;
  /** Measurable criteria for success */
  successCriteria: string[];
  /** Current strategic approach */
  currentStrategy: string;
  /** Active ProjectTask IDs under this mission */
  activeProjectTaskIds: string[];
  /** @deprecated Use policy.executionCadence.reviewSchedule instead */
  cadence: string;
  /** Autonomy policy governing what the team can do without user approval */
  policy: MissionPolicy;
  /** Lifecycle status */
  status: MissionStatus;
  /** ISO8601 timestamps */
  createdAt: string;
  updatedAt: string;
  /** Last planning review */
  lastReviewAt?: string;
  /** Next scheduled planning review */
  nextReviewAt?: string;
  /** Accumulated learnings from execution */
  learnings: string[];
  /** Accumulated token usage across all Requests in this mission */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  /** Accumulated cost in USD across all Requests */
  totalCost?: number;
  /** Structured Key Result IDs (optional — missions without KRs use successCriteria strings) */
  keyResultIds?: string[];
  /** Current decomposition phase number */
  currentPhase?: number;
  /** Number of consecutive review cycles where KRs showed no progress */
  staleCycles?: number;
  /** Last OKR review result summary */
  lastReviewSummary?: string;
  /** OKR time period for period-based lifecycle management */
  period?: MissionPeriod;
}

// ---------------------------------------------------------------------------
// Policy Action Types (for enforcement)
// ---------------------------------------------------------------------------

/**
 * Actions that can be checked against a MissionPolicy.
 */
export type PolicyAction =
  | 'create_task'
  | 'reprioritize_task'
  | 'close_task'
  | 'deploy_staging'
  | 'deploy_prod'
  | 'spend_money'
  | 'change_user_visible_behavior'
  | 'replan_mission'
  | 'advance_phase'
  | 'adjust_kr_target';

/** All valid policy actions. */
export const POLICY_ACTIONS: readonly PolicyAction[] = [
  'create_task',
  'reprioritize_task',
  'close_task',
  'deploy_staging',
  'deploy_prod',
  'spend_money',
  'change_user_visible_behavior',
  'replan_mission',
  'advance_phase',
  'adjust_kr_target',
] as const;

/**
 * Maps PolicyAction to the corresponding MissionPolicy boolean field.
 */
export const ACTION_TO_POLICY_FIELD: Record<PolicyAction, keyof MissionPolicy> = {
  create_task: 'canCreateTasks',
  reprioritize_task: 'canReprioritizeTasks',
  close_task: 'canCloseTasks',
  deploy_staging: 'canDeployToStaging',
  deploy_prod: 'canDeployToProd',
  spend_money: 'canSpendMoney',
  change_user_visible_behavior: 'canChangeUserVisibleBehaviorWithoutReview',
  replan_mission: 'canReplanMission',
  advance_phase: 'canAdvancePhase',
  adjust_kr_target: 'canAdjustKRTargets',
};

/**
 * Result of a policy check.
 */
export interface PolicyDecision {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Reason for denial (if not allowed) */
  reason?: string;
  /** Which policy field blocked the action */
  blockedBy?: keyof MissionPolicy;
  /** Escalation triggered (if any) */
  escalation?: EscalationRule;
}

/**
 * Context for evaluating escalation rules.
 */
export interface EscalationContext {
  /** Current cost incurred by this mission */
  currentCost?: number;
  /** Hours elapsed since mission started */
  hoursElapsed?: number;
  /** Number of failures in this mission */
  failureCount?: number;
  /** Whether scope has changed from original */
  scopeChanged?: boolean;
  /** Whether there's a security concern */
  securityConcern?: boolean;
}

// ---------------------------------------------------------------------------
// Input Types
// ---------------------------------------------------------------------------

/**
 * Input for creating a new Mission.
 */
export interface CreateMissionInput {
  objective: string;
  ownerTeamId: string;
  successCriteria: string[];
  currentStrategy: string;
  cadence?: string;
  policy?: Partial<MissionPolicy>;
  /** OKR time period for period-based lifecycle management */
  period?: MissionPeriod;
}

/**
 * Input for updating a MissionPolicy.
 */
export interface UpdatePolicyInput {
  canCreateTasks?: boolean;
  canReprioritizeTasks?: boolean;
  canCloseTasks?: boolean;
  canDeployToStaging?: boolean;
  canDeployToProd?: boolean;
  canSpendMoney?: boolean;
  canChangeUserVisibleBehaviorWithoutReview?: boolean;
  canReplanMission?: boolean;
  canAdvancePhase?: boolean;
  canAdjustKRTargets?: boolean;
  maxParallelExecutions?: number;
  escalationRules?: EscalationRule[];
  executionCadence?: Partial<ExecutionCadence>;
}

// ---------------------------------------------------------------------------
// Default Policies (Templates)
// ---------------------------------------------------------------------------

/**
 * Conservative policy — all capabilities disabled, human approval for everything.
 */
export const CONSERVATIVE_POLICY: Readonly<Omit<MissionPolicy, 'missionId'>> = {
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
} as const;

/**
 * Moderate policy — can create and close tasks, but no deploy or spend.
 */
export const MODERATE_POLICY: Readonly<Omit<MissionPolicy, 'missionId'>> = {
  canCreateTasks: true,
  canReprioritizeTasks: true,
  canCloseTasks: true,
  canDeployToStaging: false,
  canDeployToProd: false,
  canSpendMoney: false,
  canChangeUserVisibleBehaviorWithoutReview: false,
  maxParallelExecutions: 3,
  escalationRules: [
    { condition: 'failure_count', threshold: 3, escalateTo: 'team_lead', action: 'notify' },
  ],
  executionCadence: MODERATE_CADENCE,
} as const;

/**
 * Autonomous policy — most capabilities enabled, but no prod deploy.
 */
export const AUTONOMOUS_POLICY: Readonly<Omit<MissionPolicy, 'missionId'>> = {
  canCreateTasks: true,
  canReprioritizeTasks: true,
  canCloseTasks: true,
  canDeployToStaging: true,
  canDeployToProd: false,
  canSpendMoney: true,
  canChangeUserVisibleBehaviorWithoutReview: false,
  maxParallelExecutions: 5,
  escalationRules: [
    { condition: 'cost_exceeded', threshold: 50, escalateTo: 'user', action: 'pause' },
    { condition: 'failure_count', threshold: 5, escalateTo: 'team_lead', action: 'notify' },
    { condition: 'security_concern', threshold: 1, escalateTo: 'user', action: 'block' },
  ],
  executionCadence: AUTONOMOUS_CADENCE,
} as const;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid MissionStatus.
 */
export function isValidMissionStatus(value: string): value is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid PolicyAction.
 */
export function isValidPolicyAction(value: string): value is PolicyAction {
  return (POLICY_ACTIONS as readonly string[]).includes(value);
}

/**
 * Checks whether a string is a valid EscalationCondition.
 */
export function isValidEscalationCondition(value: string): value is EscalationCondition {
  return (ESCALATION_CONDITIONS as readonly string[]).includes(value);
}

/**
 * Checks whether a mission status transition is valid.
 */
export function isValidMissionTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].has(to);
}

/**
 * Validates an EscalationRule.
 */
export function isValidEscalationRule(rule: unknown): rule is EscalationRule {
  if (typeof rule !== 'object' || rule === null) return false;
  const obj = rule as Record<string, unknown>;
  return (
    typeof obj.condition === 'string' &&
    isValidEscalationCondition(obj.condition) &&
    typeof obj.threshold === 'number' &&
    obj.threshold >= 0 &&
    typeof obj.escalateTo === 'string' &&
    ['user', 'orchestrator', 'team_lead'].includes(obj.escalateTo) &&
    typeof obj.action === 'string' &&
    ['pause', 'notify', 'block'].includes(obj.action)
  );
}

/**
 * Checks whether a string is a valid PhaseGateApproval.
 */
export function isValidPhaseGateApproval(value: string): value is PhaseGateApproval {
  return (PHASE_GATE_APPROVALS as readonly string[]).includes(value);
}

/**
 * Validates a WorkHoursWindow object.
 */
export function isValidWorkHoursWindow(value: unknown): value is WorkHoursWindow {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.startHour === 'number' &&
    Number.isInteger(obj.startHour) &&
    obj.startHour >= 0 && obj.startHour <= 23 &&
    typeof obj.endHour === 'number' &&
    Number.isInteger(obj.endHour) &&
    obj.endHour >= 0 && obj.endHour <= 23 &&
    typeof obj.timezone === 'string' &&
    obj.timezone.length > 0 &&
    Array.isArray(obj.activeDays) &&
    (obj.activeDays as unknown[]).every(
      (d: unknown) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
    )
  );
}

/**
 * Validates an ExecutionCadence object.
 */
export function isValidExecutionCadence(value: unknown): value is ExecutionCadence {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.reviewSchedule === 'string' &&
    obj.reviewSchedule.length > 0 &&
    typeof obj.dailyItemLimit === 'number' &&
    Number.isInteger(obj.dailyItemLimit) &&
    obj.dailyItemLimit >= 0 &&
    (obj.workHours === null || isValidWorkHoursWindow(obj.workHours)) &&
    typeof obj.phaseGateApproval === 'string' &&
    isValidPhaseGateApproval(obj.phaseGateApproval) &&
    typeof obj.requireVerificationGate === 'boolean'
  );
}

/**
 * Validates a MissionPolicy object.
 */
export function isValidMissionPolicy(value: unknown): value is MissionPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  const baseValid = (
    typeof obj.missionId === 'string' &&
    typeof obj.canCreateTasks === 'boolean' &&
    typeof obj.canReprioritizeTasks === 'boolean' &&
    typeof obj.canCloseTasks === 'boolean' &&
    typeof obj.canDeployToStaging === 'boolean' &&
    typeof obj.canDeployToProd === 'boolean' &&
    typeof obj.canSpendMoney === 'boolean' &&
    typeof obj.canChangeUserVisibleBehaviorWithoutReview === 'boolean' &&
    typeof obj.maxParallelExecutions === 'number' &&
    obj.maxParallelExecutions > 0 &&
    Array.isArray(obj.escalationRules)
  );
  if (!baseValid) return false;
  // executionCadence is optional; validate only if present
  if (obj.executionCadence !== undefined && !isValidExecutionCadence(obj.executionCadence)) {
    return false;
  }
  return true;
}

/**
 * Validates that an unknown value is structurally a valid Mission.
 */
export function isMission(value: unknown): value is Mission {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.objective === 'string' &&
    typeof obj.ownerTeamId === 'string' &&
    typeof obj.status === 'string' &&
    isValidMissionStatus(obj.status) &&
    typeof obj.createdAt === 'string' &&
    Array.isArray(obj.successCriteria) &&
    Array.isArray(obj.activeProjectTaskIds)
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a default MissionPolicy for a given mission.
 * Defaults to conservative (all disabled).
 *
 * @param missionId - The mission this policy applies to
 * @param template - Optional template: 'conservative', 'moderate', 'autonomous'
 * @returns A fully populated MissionPolicy
 */
export function createMissionPolicy(
  missionId: string,
  template: 'conservative' | 'moderate' | 'autonomous' = 'conservative',
): MissionPolicy {
  const templates = {
    conservative: CONSERVATIVE_POLICY,
    moderate: MODERATE_POLICY,
    autonomous: AUTONOMOUS_POLICY,
  };

  return {
    missionId,
    ...templates[template],
    // Deep copy escalation rules to avoid shared references
    escalationRules: [...templates[template].escalationRules.map(r => ({ ...r }))],
  };
}

/**
 * Creates a new Mission with sensible defaults.
 *
 * @param input - Required and optional creation fields
 * @returns A fully populated Mission object
 */
export function createMission(input: CreateMissionInput): Mission {
  const now = new Date().toISOString();
  const id = uuidv4();
  const reviewSchedule = input.cadence ?? '0 9 * * 1';

  const basePolicy = createMissionPolicy(id, 'conservative');
  const mergedPolicy: MissionPolicy = {
    ...basePolicy,
    ...input.policy,
    missionId: id,
    // Deep copy escalation rules from the merged result
    escalationRules: [...(input.policy?.escalationRules ?? basePolicy.escalationRules).map(r => ({ ...r }))],
  };

  // Sync reviewSchedule into executionCadence if caller provided cadence but no executionCadence
  if (!mergedPolicy.executionCadence) {
    mergedPolicy.executionCadence = { ...CONSERVATIVE_CADENCE, reviewSchedule };
  } else if (input.cadence && !input.policy?.executionCadence?.reviewSchedule) {
    mergedPolicy.executionCadence = {
      ...mergedPolicy.executionCadence,
      reviewSchedule,
    };
  }

  return {
    id,
    objective: input.objective,
    ownerTeamId: input.ownerTeamId,
    successCriteria: input.successCriteria,
    currentStrategy: input.currentStrategy,
    activeProjectTaskIds: [],
    cadence: reviewSchedule,
    policy: mergedPolicy,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    learnings: [],
    period: input.period,
  };
}

// ---------------------------------------------------------------------------
// ExecutionCadence Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective ExecutionCadence for a mission policy.
 * Falls back to CONSERVATIVE_CADENCE when no cadence is defined.
 *
 * @param policy - The MissionPolicy to read from
 * @returns Resolved ExecutionCadence (never undefined)
 */
export function getEffectiveCadence(policy: MissionPolicy): ExecutionCadence {
  return policy.executionCadence ?? { ...CONSERVATIVE_CADENCE };
}

/**
 * Merges a partial cadence update into an existing ExecutionCadence.
 * Deep-merges workHours if both exist. Pass workHours: null to clear.
 *
 * @param existing - Current cadence
 * @param updates - Partial fields to merge
 * @returns New merged ExecutionCadence (does not mutate inputs)
 */
export function mergeExecutionCadence(
  existing: ExecutionCadence,
  updates: Partial<ExecutionCadence>,
): ExecutionCadence {
  return {
    ...existing,
    ...updates,
    workHours: updates.workHours === null
      ? null
      : updates.workHours !== undefined
        ? {
            ...(existing.workHours ?? { startHour: 9, endHour: 17, timezone: 'UTC', activeDays: [1, 2, 3, 4, 5] }),
            ...updates.workHours,
          }
        : existing.workHours,
  };
}

// ---------------------------------------------------------------------------
// Mission Period Types & Helpers
// ---------------------------------------------------------------------------

export type MissionPeriodType = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'custom';

export interface MissionPeriod {
  type: MissionPeriodType;
  startDate: string;
  endDate: string;
  label?: string;
}

export function isPeriodActive(period: MissionPeriod, now: Date = new Date()): boolean {
  return now >= new Date(period.startDate) && now < new Date(period.endDate);
}

export function isPeriodPast(period: MissionPeriod, now: Date = new Date()): boolean {
  return now >= new Date(period.endDate);
}

export function isPeriodFuture(period: MissionPeriod, now: Date = new Date()): boolean {
  return now < new Date(period.startDate);
}

export function sortMissionsByPriority(missions: Mission[]): Mission[] {
  return [...missions].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
