/**
 * Team-Health-Watchdog (THW) — Public Module Surface
 *
 * Barrel export. Internals (private helpers) are NOT re-exported.
 *
 * @module services/team-health
 */

export {
  type VerdictCode,
  VERDICT_CODES,
  VERDICT_DISPLAY,
  VERDICT_SEVERITY,
  isValidVerdictCode,
  maxVerdict,
  type TeamHealthDetection,
  type TeamHealthGates,
  type TeamSummary,
  type TeamHealthSnapshot,
  type AgentWorkingStatus,
  type ArtifactProbeResult,
  type TeamHealthConfig,
  type TeamHealthThresholds,
  type TeamHealthAlertingConfig,
  type OffHoursConfig,
  type StaleTriggerConfig,
  type LostDispatchConfig,
  type PerTeamThresholdOverride,
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  DEFAULT_ALERTING,
  DEFAULT_STALE_TRIGGER,
  DEFAULT_LOST_DISPATCH,
  type AlertChannel,
  type AlertDecision,
  type SuppressionReason,
  type TeamHealthSweepResult,
} from './team-health-types.js';

export { detectTeamHealth, detectOrphanRequests } from './team-health-detector.js';
export {
  detectStaleWorkItems,
  isStale,
  describeStaleEvidence,
  type StaleTriggerInput,
} from './stale-trigger-detector.js';
export {
  detectLostDispatches,
  describeLostDispatchEvidence,
} from './lost-dispatch-detector.js';
export {
  TeamHealthAlertRouter,
  formatRollupMessage,
  formatRecoveryMessage,
  isWithinWorkingHours,
} from './team-health-alert-router.js';
export {
  TeamHealthWatchdogService,
  type TeamHealthWatchdogOptions,
  type TeamHealthDataProvider,
  type AlertSink,
  type WatchdogLogger,
  setTeamHealthWatchdogSingleton,
  getTeamHealthWatchdogSingleton,
} from './team-health-watchdog.service.js';
export {
  loadTeamHealthConfig,
  mergeWithDefaults,
  applyEnvOverrides,
  resolveConfigPath,
  resolveSidecarDir,
  type ConfigLogger,
} from './team-health-config.js';
export {
  LiveTeamHealthDataProvider,
  type LiveDataAccessors,
} from './live-team-health-data-provider.js';
