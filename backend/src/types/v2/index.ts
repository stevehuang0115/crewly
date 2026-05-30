/**
 * V2 Core Types — Barrel Export
 *
 * Central export point for all V2 architecture types.
 * Import from this module for convenience:
 *
 * @example
 * ```typescript
 * import { Request, WorkItem, Trigger, ReconcileResult, TaskClaim } from '../types/v2/index.js';
 * ```
 *
 * @module types/v2
 */

// Request types
export type {
  Request,
  RequestStatus,
  IntentCategory,
  IntentLevel,
  CreateRequestInput,
  UpdateRequestInput,
} from './request.types.js';

export {
  REQUEST_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  INTENT_CATEGORIES,
  REQUEST_TRANSITIONS,
  isValidRequestStatus,
  isValidIntentCategory,
  isValidRequestTransition,
  isRequest,
  validateCreateRequestInput,
  createRequest,
} from './request.types.js';

// WorkItem types
export type {
  WorkItem,
  WorkItemType,
  WorkItemOwner,
  WorkItemStatus,
  CreateWorkItemInput,
  UpdateWorkItemInput,
} from './work-item.types.js';

export {
  WORK_ITEM_TYPES,
  WORK_ITEM_OWNERS,
  WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  DEFAULT_MAX_RETRIES,
  isValidWorkItemType,
  isValidWorkItemStatus,
  isValidWorkItemOwner,
  isValidWorkItemTransition,
  isWorkItem,
  validateCreateWorkItemInput,
  createWorkItem,
} from './work-item.types.js';

// Trigger types
export type {
  Trigger,
  TriggerType,
  TriggerStatus,
  TriggerConfig,
  TimeTriggerConfig,
  SignalTriggerConfig,
  CompoundTriggerConfig,
  TriggerAction,
  CreateTriggerInput,
} from './trigger.types.js';

export {
  TRIGGER_TYPES,
  TRIGGER_STATUSES,
  DEFAULT_MAX_IDLE_FIRES,
  isValidTriggerType,
  isValidTriggerStatus,
  isValidTriggerConfig,
  isTrigger,
  isValidTriggerAction,
  validateCreateTriggerInput,
  createTrigger,
} from './trigger.types.js';

// Reconcile types
export type {
  ReconcileResult,
  ReconcileType,
  ReconcileCorrection,
  ReconcilerConfig,
  ReconcilerStatus,
  WakeAction,
  WakeStrategy,
  AgentScoreBreakdown,
} from './reconcile.types.js';

export {
  RECONCILE_TYPES,
  DEFAULT_RECONCILER_CONFIG,
  isValidReconcileType,
  isReconcileResult,
  isValidReconcilerConfig,
  createEmptyReconcileResult,
  createCorrection,
} from './reconcile.types.js';

// Claim types
export type {
  TaskClaim,
  ClaimStatus,
  CreateClaimInput,
} from './claim.types.js';

export {
  CLAIM_STATUSES,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_GRACE_PERIOD_MS,
  DEFAULT_MAX_EXTENSIONS,
  isValidClaimStatus,
  isTaskClaim,
  isLeaseExpired,
  isGracePeriodExceeded,
  canExtendLease,
  validateCreateClaimInput,
  createTaskClaim,
  extendClaim,
} from './claim.types.js';

// Mission & MissionPolicy types
export type {
  Mission,
  MissionStatus,
  MissionPolicy,
  EscalationRule,
  EscalationCondition,
  EscalationAction,
  EscalationTarget,
  PolicyAction,
  PolicyDecision,
  EscalationContext,
  CreateMissionInput,
  UpdateMissionInput,
  UpdatePolicyInput,
  PhaseGateApproval,
  WorkHoursWindow,
  ExecutionCadence,
  MissionLevel,
  ProposalState,
  ApprovalState,
} from './mission.types.js';

export {
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
  MISSION_LEVELS,
  MISSION_LEVEL_DEPTH,
  PROJECT_LEVEL_DEPTH,
  PROPOSAL_STATES,
  PROPOSAL_TRANSITIONS,
  isValidMissionLevel,
  validateLevelLink,
  deriveLevel,
  isValidProposalState,
  isValidProposalTransition,
  validateCascadeLink,
} from './mission.types.js';

// Key Result types (OKR)
export type {
  KeyResult,
  KRMetricType,
  KRStatus,
  KRMeasurementSource,
  KRContribution,
  KRMeasurement,
  CreateKeyResultInput,
  UpdateKeyResultInput,
  MissionOKRSummary,
  CascadeOKRSummary,
  OKRRecommendation,
  OKRReviewResult,
  ReviewDecision,
} from './key-result.types.js';

export {
  KR_METRIC_TYPES,
  KR_STATUSES,
  KR_MEASUREMENT_SOURCES,
  MAX_MEASUREMENT_HISTORY,
  isValidKRMetricType,
  isValidKRStatus,
  isValidKRMeasurementSource,
  isKeyResult,
  validateCreateKeyResultInput,
  createKeyResult,
  computeKRProgress,
  deriveKRStatus,
  deriveOKRRecommendation,
  computeRolledUpProgress,
} from './key-result.types.js';

// Workspace types
export type {
  Workspace,
  WorkspaceAccessMode,
  WorkspaceOwnerType,
  CreateWorkspaceInput,
  WriteWorkspaceInput,
  StructuredWriteInput,
} from './workspace.types.js';

export {
  WORKSPACE_ACCESS_MODES,
  WORKSPACE_OWNER_TYPES,
  isValidWorkspaceAccessMode,
  isValidWorkspaceOwnerType,
  isWorkspace,
  validateCreateWorkspaceInput,
  validateWriteWorkspaceInput,
  createWorkspace,
  WorkspaceConflictError,
  WorkspaceAccessError,
} from './workspace.types.js';
