/**
 * V2 Reconciler Type Definitions
 *
 * The Reconciler is the "CPU" of Crewly V3 — it periodically recomputes
 * system truth from durable state, not trusting event delivery.
 * These types define its outputs and configuration.
 *
 * @module types/v2/reconcile.types
 */

// ---------------------------------------------------------------------------
// Reconcile Result
// ---------------------------------------------------------------------------

/**
 * The output of a single reconciliation pass.
 * Captures what the Reconciler found and corrected.
 */
export interface ReconcileResult {
  /** Requests whose status was corrected */
  requestsUpdated: number;
  /** WorkItems that were timed out */
  workItemsTimedOut: number;
  /** WorkItems that were re-queued (recovered from stuck state) */
  workItemsRequeued: number;
  /** Triggers that were rebuilt (missed fires detected and fixed) */
  triggersRebuilt: number;
  /** Claims revoked due to expired lease + grace period */
  claimsRevoked: number;
  /** Stale data cleaned up (orphan tasks, expired items) */
  staleItemsCleaned: number;
  /** ISO8601 timestamp of this reconciliation */
  reconciledAt: string;
  /** Duration of the reconcile pass in milliseconds */
  durationMs: number;
  /** Whether this was a full or targeted reconciliation */
  type: ReconcileType;
  /** Agents woken up via Hybrid Wake (suspended rehydrated or inactive started) */
  agentsWoken: number;
  /** Detailed log of individual corrections (for debugging/audit) */
  corrections: ReconcileCorrection[];
  /** Wake actions triggered during this pass */
  wakeActions: WakeAction[];
  /** Errors encountered during reconciliation (non-fatal) */
  errors: string[];
}

/**
 * Type of reconciliation pass.
 * - full: Scans all entities (periodic, on restart)
 * - targeted_request: Only reconciles a single Request + its WorkItems
 * - targeted_mission: Only reconciles a single Mission + its ProjectTasks
 * - fast: Quick pass — only checks lease expiry + agent health
 */
export type ReconcileType =
  | 'full'
  | 'targeted_request'
  | 'targeted_mission'
  | 'fast';

/** All valid ReconcileType values. */
export const RECONCILE_TYPES: readonly ReconcileType[] = [
  'full',
  'targeted_request',
  'targeted_mission',
  'fast',
] as const;

// ---------------------------------------------------------------------------
// Reconcile Correction (Audit Trail)
// ---------------------------------------------------------------------------

/**
 * A single correction made by the Reconciler.
 * Follows CEO principle: "All automation is explainable."
 */
export interface ReconcileCorrection {
  /** What entity was corrected (request, work_item, trigger, claim, etc.) */
  entityType: 'request' | 'work_item' | 'trigger' | 'project_task' | 'claim';
  /** ID of the corrected entity */
  entityId: string;
  /** What the status was before correction */
  previousState: string;
  /** What the status was changed to */
  newState: string;
  /** Why this correction was made */
  reason: string;
  /** What evidence triggered this correction */
  evidence: string;
  /** ISO8601 timestamp */
  correctedAt: string;
}

// ---------------------------------------------------------------------------
// Hybrid Wake Types
// ---------------------------------------------------------------------------

/**
 * Strategy for waking an agent based on its current status.
 * - rehydrate: Agent is suspended → call AgentSuspendService.rehydrateAgent()
 * - start: Agent is inactive → call start-agent API
 */
export type WakeStrategy = 'rehydrate' | 'start';

/**
 * A wake action to bring a dormant agent online for unclaimed work.
 * Produced by the detectUnclaimedTasks reconcile rule.
 */
export interface WakeAction {
  /** WorkItem ID that triggered the wake */
  workItemId: string;
  /** Agent session name to wake */
  agentSessionName: string;
  /** How to wake: rehydrate (suspended) or start (inactive) */
  strategy: WakeStrategy;
  /** Score from the agent selection algorithm */
  score: number;
  /** Breakdown of how the score was computed */
  scoreBreakdown: AgentScoreBreakdown;
  /** ISO8601 timestamp */
  triggeredAt: string;
  /** Optional team ID for start strategy */
  teamId?: string;
  /** Optional member ID for start strategy */
  memberId?: string;
}

/**
 * Breakdown of agent selection score components.
 * Final score = skillMatch + urgency + contextFamiliarity - loadPenalty
 */
export interface AgentScoreBreakdown {
  /** 0–40: How well the agent's role/type matches the WorkItem */
  skillMatch: number;
  /** 0–30: How urgent the WorkItem is (based on wait time) */
  urgency: number;
  /** 0–20: How familiar the agent is with the WorkItem's context */
  contextFamiliarity: number;
  /** 0–20: Penalty for agent's current load */
  loadPenalty: number;
}

// ---------------------------------------------------------------------------
// Reconciler Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the ReconcilerService.
 * Controls timing, thresholds, and behavior.
 */
export interface ReconcilerConfig {
  /** Fast loop interval in ms (default: 10000 = 10s) — lease + agent health only */
  fastLoopIntervalMs: number;
  /** Full loop interval in ms (default: 60000 = 60s) — complete scan */
  fullLoopIntervalMs: number;
  /** Max duration allowed for a single reconcile pass in ms (budget: 3s) */
  maxReconcileDurationMs: number;
  /** WorkItem timeout threshold in ms — running longer than this = stuck */
  workItemTimeoutMs: number;
  /** How many recent ReconcileResults to retain in history */
  maxHistorySize: number;
  /** Whether event-triggered targeted reconciliation is enabled */
  eventTriggeredEnabled: boolean;
}

/**
 * Default Reconciler configuration values.
 * Performance budget: single reconcile < 3s (CEO requirement).
 */
export const DEFAULT_RECONCILER_CONFIG: Readonly<ReconcilerConfig> = {
  fastLoopIntervalMs: 10_000,       // 10 seconds
  fullLoopIntervalMs: 60_000,       // 60 seconds
  maxReconcileDurationMs: 3_000,    // 3 seconds performance budget
  workItemTimeoutMs: 600_000,       // 10 minutes
  maxHistorySize: 100,
  eventTriggeredEnabled: true,
} as const;

// ---------------------------------------------------------------------------
// Reconciler Status (for API)
// ---------------------------------------------------------------------------

/**
 * Current status of the ReconcilerService.
 * Exposed via GET /api/reconciler/status.
 */
export interface ReconcilerStatus {
  /** Whether the Reconciler is currently running a pass */
  isRunning: boolean;
  /** Last completed reconciliation result */
  lastResult?: ReconcileResult;
  /** Next scheduled full reconciliation time (ISO8601) */
  nextFullReconcileAt?: string;
  /** Next scheduled fast reconciliation time (ISO8601) */
  nextFastReconcileAt?: string;
  /** Total number of reconcile passes since startup */
  totalPasses: number;
  /** Total corrections made since startup */
  totalCorrections: number;
  /** Current configuration */
  config: ReconcilerConfig;
}

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Checks whether a string is a valid ReconcileType.
 *
 * @param value - The string to check
 * @returns True if value is a valid ReconcileType
 */
export function isValidReconcileType(value: string): value is ReconcileType {
  return (RECONCILE_TYPES as readonly string[]).includes(value);
}

/**
 * Validates that an unknown value is structurally a valid ReconcileResult.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to the ReconcileResult interface
 */
export function isReconcileResult(value: unknown): value is ReconcileResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.requestsUpdated === 'number' &&
    typeof obj.workItemsTimedOut === 'number' &&
    typeof obj.workItemsRequeued === 'number' &&
    typeof obj.claimsRevoked === 'number' &&
    typeof obj.triggersRebuilt === 'number' &&
    typeof obj.staleItemsCleaned === 'number' &&
    typeof obj.reconciledAt === 'string' &&
    typeof obj.durationMs === 'number' &&
    typeof obj.type === 'string' &&
    isValidReconcileType(obj.type) &&
    typeof obj.agentsWoken === 'number' &&
    Array.isArray(obj.corrections) &&
    Array.isArray(obj.wakeActions) &&
    Array.isArray(obj.errors)
  );
}

/**
 * Validates that an unknown value is a valid ReconcilerConfig.
 *
 * @param value - Unknown value to validate
 * @returns True if value conforms to ReconcilerConfig
 */
export function isValidReconcilerConfig(value: unknown): value is ReconcilerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.fastLoopIntervalMs === 'number' && obj.fastLoopIntervalMs > 0 &&
    typeof obj.fullLoopIntervalMs === 'number' && obj.fullLoopIntervalMs > 0 &&
    typeof obj.maxReconcileDurationMs === 'number' && obj.maxReconcileDurationMs > 0 &&
    typeof obj.workItemTimeoutMs === 'number' && obj.workItemTimeoutMs > 0 &&
    typeof obj.maxHistorySize === 'number' && obj.maxHistorySize > 0 &&
    typeof obj.eventTriggeredEnabled === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an empty ReconcileResult for a new reconciliation pass.
 *
 * @param type - The type of reconciliation being performed
 * @returns A ReconcileResult with all counters at zero
 */
export function createEmptyReconcileResult(type: ReconcileType): ReconcileResult {
  return {
    requestsUpdated: 0,
    workItemsTimedOut: 0,
    workItemsRequeued: 0,
    claimsRevoked: 0,
    triggersRebuilt: 0,
    staleItemsCleaned: 0,
    agentsWoken: 0,
    reconciledAt: new Date().toISOString(),
    durationMs: 0,
    type,
    corrections: [],
    wakeActions: [],
    errors: [],
  };
}

/**
 * Creates a ReconcileCorrection entry.
 *
 * @param params - Correction details
 * @returns A fully populated ReconcileCorrection
 */
export function createCorrection(params: {
  entityType: ReconcileCorrection['entityType'];
  entityId: string;
  previousState: string;
  newState: string;
  reason: string;
  evidence: string;
}): ReconcileCorrection {
  return {
    ...params,
    correctedAt: new Date().toISOString(),
  };
}
