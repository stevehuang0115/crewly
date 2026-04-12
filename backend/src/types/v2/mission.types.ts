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
  /** Maximum concurrent executions allowed */
  maxParallelExecutions: number;
  /** Rules for when to escalate to humans */
  escalationRules: EscalationRule[];
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
  /** Review cadence (cron expression, e.g., "0 9 * * 1") */
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
  | 'change_user_visible_behavior';

/** All valid policy actions. */
export const POLICY_ACTIONS: readonly PolicyAction[] = [
  'create_task',
  'reprioritize_task',
  'close_task',
  'deploy_staging',
  'deploy_prod',
  'spend_money',
  'change_user_visible_behavior',
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
  maxParallelExecutions?: number;
  escalationRules?: EscalationRule[];
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
 * Validates a MissionPolicy object.
 */
export function isValidMissionPolicy(value: unknown): value is MissionPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
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

  return {
    id,
    objective: input.objective,
    ownerTeamId: input.ownerTeamId,
    successCriteria: input.successCriteria,
    currentStrategy: input.currentStrategy,
    activeProjectTaskIds: [],
    cadence: input.cadence ?? '0 9 * * 1', // Weekly Monday 9am
    policy: {
      ...createMissionPolicy(id, 'conservative'),
      ...input.policy,
      missionId: id,
    },
    status: 'active',
    createdAt: now,
    updatedAt: now,
    learnings: [],
  };
}
