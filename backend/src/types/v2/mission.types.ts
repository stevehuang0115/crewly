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
// Mission Level (OKR cascade tier)
// ---------------------------------------------------------------------------

/**
 * Organizational tier of a Mission within the OKR cascade.
 *
 * The cascade is the Mission tree expressed via `Mission.parentMissionId`:
 *   company → team → project (3 levels).
 *
 * - `company`: root of the cascade; has no parent Mission.
 * - `team`: decomposes a company Mission; parent must be `company`.
 * - `project`: decomposes a team Mission; parent must be `team`; `projectId` set.
 */
export type MissionLevel = 'company' | 'team' | 'project';

/** All valid MissionLevel values, ordered top → bottom of the cascade. */
export const MISSION_LEVELS: readonly MissionLevel[] = ['company', 'team', 'project'] as const;

/**
 * Numeric depth of each cascade tier (company = 0, team = 1, project = 2).
 * Used to enforce the "child is exactly one tier below parent" rule.
 */
export const MISSION_LEVEL_DEPTH: Record<MissionLevel, number> = {
  company: 0,
  team: 1,
  project: 2,
};

/** Depth threshold at or beyond which a mission is treated as `project` level. */
export const PROJECT_LEVEL_DEPTH = 2;

/**
 * Checks whether a string is a valid MissionLevel.
 *
 * @param value - Candidate string
 * @returns `true` if `value` is one of `company` | `team` | `project`
 */
export function isValidMissionLevel(value: string): value is MissionLevel {
  return (MISSION_LEVELS as readonly string[]).includes(value);
}

/**
 * Validates a single downward cascade step: a child level may only sit exactly
 * one tier below its parent, and `company` must be a root (no parent).
 *
 * Adjacency matrix:
 * | child   | required parent | parentMissionId   |
 * |---------|-----------------|-------------------|
 * | company | —               | must be undefined |
 * | team    | company         | required          |
 * | project | team            | required          |
 *
 * @param childLevel - The level of the child mission
 * @param parentLevel - The level of the parent mission, or `undefined` if no parent
 * @returns `null` if the pairing is legal, otherwise a human-readable reason
 *
 * @example
 * ```ts
 * validateLevelLink('team', 'company'); // null
 * validateLevelLink('company', 'team'); // "A company mission cannot have a parent"
 * ```
 */
export function validateLevelLink(
  childLevel: MissionLevel,
  parentLevel: MissionLevel | undefined,
): string | null {
  if (childLevel === 'company') {
    return parentLevel === undefined
      ? null
      : 'A company mission cannot have a parent';
  }
  if (parentLevel === undefined) {
    return `A ${childLevel} mission requires a parent mission`;
  }
  const expectedDepth = MISSION_LEVEL_DEPTH[childLevel] - 1;
  if (MISSION_LEVEL_DEPTH[parentLevel] !== expectedDepth) {
    return `A ${childLevel} mission must have a ${
      MISSION_LEVELS[expectedDepth]
    } parent, not a ${parentLevel} parent`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proposal / Approval Governance
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a decomposition proposal.
 *
 * A team-leader/PM agent drafts a child OKR decomposition as a proposal; it is
 * NOT cascade-active until the human owner approves. Reject carries a reason.
 *
 * - `draft`: agent is still composing the proposal.
 * - `pending_approval`: submitted, awaiting the human owner's decision.
 * - `approved`: owner accepted; mission is now cascade-active (terminal).
 * - `rejected`: owner declined with a reason; owner may request a redraft.
 */
export type ProposalState = 'draft' | 'pending_approval' | 'approved' | 'rejected';

/** All valid ProposalState values. */
export const PROPOSAL_STATES: readonly ProposalState[] = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
] as const;

/**
 * Legal proposal-state transitions.
 *
 * - draft → pending_approval
 * - pending_approval → approved | rejected
 * - approved → (terminal)
 * - rejected → draft (owner can ask for a redraft)
 */
export const PROPOSAL_TRANSITIONS: Record<ProposalState, ReadonlySet<ProposalState>> = {
  draft: new Set(['pending_approval']),
  pending_approval: new Set(['approved', 'rejected']),
  approved: new Set<ProposalState>(),
  rejected: new Set(['draft']),
};

/**
 * Checks whether a string is a valid ProposalState.
 *
 * @param value - Candidate string
 * @returns `true` if `value` is one of the four proposal states
 */
export function isValidProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value);
}

/**
 * Checks whether a proposal-state transition is legal.
 *
 * @param from - Current proposal state
 * @param to - Proposed next proposal state
 * @returns `true` if `from → to` is an allowed transition
 *
 * @example
 * ```ts
 * isValidProposalTransition('pending_approval', 'approved'); // true
 * isValidProposalTransition('approved', 'draft');            // false
 * ```
 */
export function isValidProposalTransition(from: ProposalState, to: ProposalState): boolean {
  return PROPOSAL_TRANSITIONS[from].has(to);
}

/**
 * Governance metadata attached to a Mission that arose from a decomposition
 * proposal. Kept small and self-contained so the approval *workflow* layer can
 * be relocated to `crewly-pro` later without touching `Mission` core (see
 * spec §2.5 FLAG).
 */
export interface ApprovalState {
  /** Current proposal lifecycle state. */
  state: ProposalState;
  /** Agent session that drafted the decomposition. */
  proposedBy?: string;
  /** ISO8601 timestamp the proposal was submitted. */
  proposedAt?: string;
  /** Human owner who decided (e.g. "steve"). */
  decidedBy?: string;
  /** ISO8601 timestamp of the decision. */
  decidedAt?: string;
  /** Required when `state === 'rejected'`. */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Mission Priority
// ---------------------------------------------------------------------------

/**
 * Priority levels for a Mission.
 *
 * Ordered from most to least important: critical > high > medium > low.
 * Used for sorting and filtering; does not affect policy enforcement.
 */
export type MissionPriority = 'critical' | 'high' | 'medium' | 'low';

/** All valid MissionPriority values (ordered most → least important). */
export const MISSION_PRIORITIES: readonly MissionPriority[] = [
  'critical',
  'high',
  'medium',
  'low',
] as const;

/**
 * Numeric rank for sorting missions by priority (lower rank = higher priority).
 * Missing priority is treated as `low`.
 */
export const MISSION_PRIORITY_RANK: Record<MissionPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
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
  /** Last Slack reminder sent for off-track KRs */
  lastReminderAt?: string;
  /**
   * WorkItem id of the currently-pending review WorkItem for this Mission
   * (REVIEW-1 reentrancy lock — Arch Veto V8). Populated by
   * `MissionReminderService.runSweep()` when a review WorkItem is
   * created and cleared when that WorkItem reaches a terminal status
   * (`verified` / `rejected` / `failed` / `cancelled`). When this field
   * is set on a sweep tick, the sweep short-circuits and skips creation —
   * preventing double-creation of review WorkItems within the same
   * cadence boundary even if the sweep is replayed by an external
   * scheduler glitch or manual TL action.
   */
  pendingReviewWorkItemId?: string;
  /** Individual owner ID (optional, defaults to team lead of ownerTeamId) */
  ownerId?: string;
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
  /** Priority for sorting/filtering. Does not affect policy enforcement. */
  priority?: MissionPriority;
  /**
   * Optional parent Mission ID, forming a hierarchy
   * (e.g. company-level OKR → team-level OKR → individual OKR).
   * Must not be self, and the resulting chain must not form a cycle.
   */
  parentMissionId?: string;
  /**
   * Cascade tier of this mission. When absent (legacy missions), it is resolved
   * via {@link resolveMissionLevel}, which falls back to {@link deriveLevel}:
   * a parentless legacy mission resolves to `company`, a one-parent chain to
   * `team`, and a two-or-more-parent chain to `project`.
   */
  level?: MissionLevel;
  /** Project this mission belongs to. REQUIRED when `level === 'project'`. */
  projectId?: string;
  /**
   * Decomposition governance. Absent ⇒ treat as already-active (legacy
   * missions). A mission is cascade-active iff `approval` is absent OR
   * `approval.state === 'approved'`.
   */
  approval?: ApprovalState;
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
  /** Priority for sorting/filtering. Does not affect policy enforcement. */
  priority?: MissionPriority;
  /** Optional individual owner ID. Defaults to the team leader if not provided. */
  ownerId?: string;
  /** Optional parent Mission ID (validated to avoid self-ref and cycles). */
  parentMissionId?: string;
  /** Cascade tier. Inferred from the parent chain when omitted. */
  level?: MissionLevel;
  /** Project this mission belongs to. Required when `level === 'project'`. */
  projectId?: string;
  /** Decomposition governance state (set when created via a proposal). */
  approval?: ApprovalState;
}

/**
 * Input for updating an existing Mission (general updater).
 *
 * Excludes the immutable `id` and `createdAt`. Every field is optional so a
 * caller may PATCH any subset. `approval.state` transitions are NOT enforced
 * here — they must flow through the dedicated approve/reject workflow so there
 * is a single source of transition enforcement (spec §3.3).
 */
export interface UpdateMissionInput {
  objective?: string;
  currentStrategy?: string;
  successCriteria?: string[];
  status?: MissionStatus;
  priority?: MissionPriority;
  period?: MissionPeriod;
  keyResultIds?: string[];
  parentMissionId?: string;
  level?: MissionLevel;
  projectId?: string;
  approval?: ApprovalState;
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
    ownerId: input.ownerId,
    createdAt: now,
    updatedAt: now,
    learnings: [],
    period: input.period,
    parentMissionId: input.parentMissionId,
    level: input.level ?? (input.parentMissionId ? undefined : 'company'),
    projectId: input.projectId,
    approval: input.approval,
    priority: input.priority,
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

/**
 * Build a `monthly` MissionPeriod for a given calendar month.
 *
 * The period is half-open `[first day of month, first day of next month)`,
 * matching the `now >= start && now < end` convention used by
 * {@link isPeriodActive}. Dates are UTC so the boundaries are deterministic
 * regardless of server timezone. Handles December → January year rollover.
 *
 * @param year - Full year, e.g. `2026`.
 * @param month - 1-based month (`1` = January … `12` = December).
 * @returns A `monthly` MissionPeriod with ISO8601 start/end and a `YYYY-MM` label.
 *
 * @example
 * ```typescript
 * createMonthlyPeriod(2026, 3); // March 2026: 2026-03-01 → 2026-04-01, label "2026-03"
 * ```
 */
export function createMonthlyPeriod(year: number, month: number): MissionPeriod {
  const start = new Date(Date.UTC(year, month - 1, 1));
  // month is 1-based, so passing it as the 0-based Date month index yields the
  // first day of the *next* month (Date normalizes 12 → January of year+1).
  const end = new Date(Date.UTC(year, month, 1));
  return {
    type: 'monthly',
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    label: `${year}-${String(month).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------------
// Mission Hierarchy Helpers
// ---------------------------------------------------------------------------

/**
 * Validates a proposed parent link between a child mission and a parent.
 *
 * Rejects self-reference and any cycle that would be introduced by walking
 * up the existing parent chain from `parentId`. The child mission itself
 * does not need to exist in `byId` (useful for create-time validation).
 *
 * @param childId - The mission that would acquire the parent
 * @param parentId - The proposed parent mission ID
 * @param byId - All existing missions indexed by ID
 * @returns `null` if the link is valid, otherwise a human-readable reason
 *
 * @example
 * ```ts
 * const reason = validateParentLink('m1', 'm2', new Map([['m2', m2]]));
 * if (reason) throw new Error(reason);
 * ```
 */
export function validateParentLink(
  childId: string,
  parentId: string,
  byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
): string | null {
  if (childId === parentId) return 'A mission cannot be its own parent';
  if (!byId.has(parentId)) return `Parent mission ${parentId} does not exist`;

  // Walk up from the proposed parent; if we reach `childId`, we have a cycle.
  const seen = new Set<string>();
  let cursor: string | undefined = parentId;
  while (cursor) {
    if (seen.has(cursor)) return `Parent chain contains a cycle at ${cursor}`;
    if (cursor === childId) return 'Proposed parent link would create a cycle';
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentMissionId;
  }
  return null;
}

/**
 * Derives a Mission's cascade level by walking its `parentMissionId` chain.
 *
 * Depth 0 (no parent) ⇒ `company`, depth 1 ⇒ `team`, depth ≥ 2 ⇒ `project`.
 * Used to backfill `level` for legacy missions persisted before the cascade
 * fields existed. Guards against cycles defensively (returns the level computed
 * at the point a repeat is detected rather than looping forever).
 *
 * @param missionId - The mission whose level to derive
 * @param byId - All missions indexed by ID (need only `id` + `parentMissionId`)
 * @returns The derived MissionLevel
 *
 * @example
 * ```ts
 * deriveLevel('teamM', new Map([['teamM', { id: 'teamM', parentMissionId: 'co' }], ['co', { id: 'co' }]])); // 'team'
 * ```
 */
export function deriveLevel(
  missionId: string,
  byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
): MissionLevel {
  let depth = 0;
  const seen = new Set<string>();
  let cursor: string | undefined = byId.get(missionId)?.parentMissionId;
  while (cursor && depth < PROJECT_LEVEL_DEPTH) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parentMissionId;
  }
  if (depth === 0) return 'company';
  if (depth === 1) return 'team';
  return 'project';
}

/**
 * Resolve a mission's effective cascade level through a SINGLE canonical rule,
 * shared by every read path (cascade service, mission routes' read-migration).
 *
 * Prefers the mission's explicit `level`; when absent (legacy missions persisted
 * before the cascade fields existed) it falls back to {@link deriveLevel}, which
 * walks the `parentMissionId` chain (no parent ⇒ `company`, one parent ⇒ `team`,
 * two-or-more ⇒ `project`). Centralising the fallback here guarantees the same
 * document resolves to the same level no matter which code path reads it.
 *
 * @param mission - The mission whose level to resolve (needs `id`, optional
 *   `level` + `parentMissionId`)
 * @param byId - All missions indexed by ID for the parent-chain walk
 * @returns The resolved {@link MissionLevel}
 *
 * @example
 * ```ts
 * resolveMissionLevel({ id: 'co', }, byId);                 // 'company' (no parent)
 * resolveMissionLevel({ id: 't', parentMissionId: 'co' }, byId); // 'team'
 * ```
 */
export function resolveMissionLevel(
  mission: Pick<Mission, 'id' | 'level' | 'parentMissionId'>,
  byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId'>>,
): MissionLevel {
  if (mission.level) return mission.level;
  return deriveLevel(mission.id, byId);
}

/**
 * Combined cascade-link guard: runs the raw cycle/self-ref check
 * ({@link validateParentLink}) AND the level-adjacency check
 * ({@link validateLevelLink}). The parent's level is read from `byId` (its own
 * `level` field, falling back to {@link deriveLevel} when absent).
 *
 * `validateParentLink` keeps its original signature for callers that only need
 * the cycle check.
 *
 * @param childId - The mission that would acquire the parent
 * @param childLevel - The proposed level of the child mission
 * @param parentId - The proposed parent mission ID, or `undefined` for a root
 * @param byId - All existing missions indexed by ID
 * @returns `null` if the link is valid, otherwise a human-readable reason
 *
 * @example
 * ```ts
 * const reason = validateCascadeLink('p1', 'project', 't1', byId);
 * if (reason) throw new Error(reason);
 * ```
 */
export function validateCascadeLink(
  childId: string,
  childLevel: MissionLevel,
  parentId: string | undefined,
  byId: ReadonlyMap<string, Pick<Mission, 'id' | 'parentMissionId' | 'level'>>,
): string | null {
  if (parentId === undefined) {
    return validateLevelLink(childLevel, undefined);
  }
  const cycleReason = validateParentLink(childId, parentId, byId);
  if (cycleReason) return cycleReason;
  const parent = byId.get(parentId);
  const parentLevel = parent?.level ?? deriveLevel(parentId, byId);
  return validateLevelLink(childLevel, parentLevel);
}

/**
 * Sort missions by status (active first), then by priority rank, then by recency.
 *
 * @param missions - Missions to sort (not mutated)
 * @returns New array sorted by status → priority → createdAt desc
 */
export function sortMissionsByPriority(missions: Mission[]): Mission[] {
  return [...missions].sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (a.status !== 'active' && b.status === 'active') return 1;
    const rankA = MISSION_PRIORITY_RANK[a.priority ?? 'low'];
    const rankB = MISSION_PRIORITY_RANK[b.priority ?? 'low'];
    if (rankA !== rankB) return rankA - rankB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}
