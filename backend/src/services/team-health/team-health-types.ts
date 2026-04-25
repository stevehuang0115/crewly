/**
 * Team-Health-Watchdog (THW) — Shared Types (Layer 4 Liveness Aggregator)
 *
 * Per the SEALED design at `.crewly/knowledge/team-health-watchdog-design-2026-04-25.md`,
 * these types are the contract surface between the pure detector, alert
 * router, watchdog service, and the orchestrator skill.
 *
 * Verdict tier names (§17 Q1, SEALED 2026-04-25T15:25Z):
 *   code:    'healthy' | 'stalling' | 'stuck' | 'cascade' | 'stale'
 *   display: 🟢       | 🟡         | 🔴      | 🚨        | 🟪
 *
 * Layer-4 invariant (§A.1, SEALED): THW READS, NEVER WRITES lower-layer
 * state.
 *
 * @module services/team-health/team-health-types
 */

import type {
  WorkItem,
  Request,
  Trigger,
} from '../../types/v2/index.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';

// ---------------------------------------------------------------------------
// Verdict — five tiers (§17 Q1 SEALED)
// ---------------------------------------------------------------------------

export type VerdictCode =
  | 'healthy'
  | 'stalling'
  | 'stuck'
  | 'cascade'
  | 'stale';

export const VERDICT_CODES: readonly VerdictCode[] = [
  'healthy',
  'stalling',
  'stuck',
  'cascade',
  'stale',
] as const;

/**
 * Single source of truth for code → emoji rendering.
 */
export const VERDICT_DISPLAY: Record<VerdictCode, string> = {
  healthy: '🟢',
  stalling: '🟡',
  stuck: '🔴',
  cascade: '🚨',
  stale: '🟪',
};

/**
 * Severity ordering for verdict tiers — used to merge multiple gates'
 * verdicts into one. Higher number = more severe.
 */
export const VERDICT_SEVERITY: Record<VerdictCode, number> = {
  healthy: 0,
  stalling: 1,
  stale: 2,
  stuck: 3,
  cascade: 4,
};

// ---------------------------------------------------------------------------
// Detection Output
// ---------------------------------------------------------------------------

export interface TeamHealthGates {
  team_idle: boolean;
  team_pending: boolean;
  team_silent: boolean;
  cascade_with_siblings: boolean;
}

export interface TeamHealthDetection {
  teamId: string;
  verdict: VerdictCode;
  gates: TeamHealthGates;
  cascadeWith?: string[];
  staleWorkItemIds?: string[];
  /** WorkItem IDs flagged by the lost-dispatch detector (post-SEALED amendment) */
  lostDispatchWorkItemIds?: string[];
  orphanRequestIds?: string[];
  pendingWorkItemIds: string[];
  idleAgentSessions: string[];
  detectedAt: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Detector Inputs
// ---------------------------------------------------------------------------

export interface TeamSummary {
  id: string;
  name?: string;
  slackThreadId?: string;
  memberSessions: string[];
  tlSession?: string;
  parentTeamId?: string;
}

export interface TeamHealthSnapshot {
  now: Date;
  teams: TeamSummary[];
  agentHealth: Map<string, AgentHealth & { workingStatus?: AgentWorkingStatus }>;
  workItems: WorkItem[];
  requests: Request[];
  triggers: Trigger[];
  priorDoneCounts?: Map<string, number>;
  /** WorkItem ID → list of artifact probes parsed from description */
  artifactProbes?: Map<string, ArtifactProbeResult[]>;
  thinkingOverrides?: Map<string, Date>;
  bootedAt: Date;
}

export type AgentWorkingStatus =
  | 'idle'
  | 'in_progress'
  | 'working'
  | 'inactive'
  | 'suspended'
  | 'thinking';

export interface ArtifactProbeResult {
  kind: 'package_version' | 'prior_done_count' | 'route' | 'migration' | 'file_state';
  isStale: boolean;
  evidence: string;
}

// ---------------------------------------------------------------------------
// Configuration (§F.4 SEALED defaults + post-SEALED LostDispatch amendment)
// ---------------------------------------------------------------------------

export interface TeamHealthThresholds {
  TEAM_IDLE_T1_MS: number;
  PENDING_T1_MS: number;
  TRIGGER_SILENCE_T1_MS: number;
  STUCK_T2_MS: number;
  ORPHAN_REQUEST_T1_MS: number;
}

/** SEALED default thresholds (§17 Q2). */
export const DEFAULT_THRESHOLDS: TeamHealthThresholds = {
  TEAM_IDLE_T1_MS: 30 * 60 * 1000,
  PENDING_T1_MS: 30 * 60 * 1000,
  TRIGGER_SILENCE_T1_MS: 60 * 60 * 1000,
  STUCK_T2_MS: 60 * 60 * 1000,
  ORPHAN_REQUEST_T1_MS: 15 * 60 * 1000,
};

export interface OffHoursConfig {
  enabled: boolean;
  ownerTimezone: string;
  workingHours: string;
}

export interface TeamHealthAlertingConfig {
  yellowCooldownMs: number;
  redCooldownMs: number;
  cascadeCooldownMs: number;
  alertBudgetWindowMs: number;
  alertBudgetMaxAlertsPerTeam: number;
}

export const DEFAULT_ALERTING: TeamHealthAlertingConfig = {
  yellowCooldownMs: 60 * 60 * 1000,
  redCooldownMs: 30 * 60 * 1000,
  cascadeCooldownMs: 15 * 60 * 1000,
  alertBudgetWindowMs: 6 * 60 * 60 * 1000,
  alertBudgetMaxAlertsPerTeam: 3,
};

/**
 * Stale-trigger detector config (§B.4).
 */
export interface StaleTriggerConfig {
  enabled: boolean;
  minPriorDoneCountForRedundancy: number;
}

export const DEFAULT_STALE_TRIGGER: StaleTriggerConfig = {
  enabled: true,
  minPriorDoneCountForRedundancy: 3,
};

/**
 * Lost-dispatch detector config — POST-SEALED amendment 2026-04-25
 * approved by Sam (TL) for Cases #5/#6/#7 (PM/UX/TL restart drops).
 */
export interface LostDispatchConfig {
  enabled: boolean;
  T1Ms: number;
  postRestartGraceMs: number;
}

export const DEFAULT_LOST_DISPATCH: LostDispatchConfig = {
  enabled: true,
  T1Ms: 10 * 60 * 1000,
  postRestartGraceMs: 60_000,
};

export type PerTeamThresholdOverride = Partial<TeamHealthThresholds>;

export interface TeamHealthConfig {
  enabled: boolean;
  shadowMode: boolean;
  sweepIntervalMs: number;
  bootGraceMs: number;
  thresholds: TeamHealthThresholds;
  byTeam: Record<string, PerTeamThresholdOverride>;
  alerting: TeamHealthAlertingConfig;
  offHoursSuppression: OffHoursConfig;
  staleTriggerDetection: StaleTriggerConfig;
  /** Post-SEALED amendment — lost-dispatch detection, default ON */
  lostDispatchDetection: LostDispatchConfig;
}

export const DEFAULT_CONFIG: TeamHealthConfig = {
  enabled: true,
  shadowMode: true,
  sweepIntervalMs: 60_000,
  bootGraceMs: 5 * 60 * 1000,
  thresholds: { ...DEFAULT_THRESHOLDS },
  byTeam: {},
  alerting: { ...DEFAULT_ALERTING },
  offHoursSuppression: {
    enabled: true,
    ownerTimezone: 'America/New_York',
    workingHours: '09:00-21:00',
  },
  staleTriggerDetection: { ...DEFAULT_STALE_TRIGGER },
  lostDispatchDetection: { ...DEFAULT_LOST_DISPATCH },
};

// ---------------------------------------------------------------------------
// Alert Router types
// ---------------------------------------------------------------------------

export type AlertChannel = 'team-thread' | 'tl-dm' | 'ops-channel' | 'suppressed';

export type SuppressionReason =
  | 'shadow_mode'
  | 'cooldown'
  | 'alert_budget_exceeded'
  | 'boot_grace'
  | 'off_hours_downgrade'
  | 'stable_healthy'
  | 'silenced_by_react';

export interface AlertDecision {
  detection: TeamHealthDetection;
  channel: AlertChannel;
  effectiveVerdict: VerdictCode;
  message: string;
  suppressionReason?: SuppressionReason;
  dedupKey: string;
}

// ---------------------------------------------------------------------------
// Sweep Result
// ---------------------------------------------------------------------------

export interface TeamHealthSweepResult {
  sweptAt: string;
  durationMs: number;
  detections: TeamHealthDetection[];
  alerts: AlertDecision[];
  bootGraceSuppressed: boolean;
  shadowMode: boolean;
}

// ---------------------------------------------------------------------------
// Type Guards / Helpers
// ---------------------------------------------------------------------------

export function isValidVerdictCode(value: string): value is VerdictCode {
  return (VERDICT_CODES as readonly string[]).includes(value);
}

export function maxVerdict(a: VerdictCode, b: VerdictCode): VerdictCode {
  return VERDICT_SEVERITY[b] > VERDICT_SEVERITY[a] ? b : a;
}
