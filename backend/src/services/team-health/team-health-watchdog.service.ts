/**
 * Team-Health-Watchdog (THW) — Service Shell (Layer 4)
 *
 * Wires the pure detector + alert router to live data sources, runs the
 * 60s sweep loop, exposes API for the orchestrator skill / health endpoint.
 *
 * Architecture (§A.5): keep sweep+dedup+rate-limit+heartbeat strictly
 * separable from the detector. v0.5 will extract these protected members
 * into a `WatchdogBase`.
 *
 * Layer-4 invariant (§A.1): READS lower-layer state, EMITS alerts.
 * NEVER mutates `agent.status`, claims, or work items.
 *
 * @module services/team-health/team-health-watchdog.service
 */

import type {
  AlertDecision,
  TeamHealthConfig,
  TeamHealthDetection,
  TeamHealthSnapshot,
  TeamHealthSweepResult,
} from './team-health-types.js';
import { detectTeamHealth, detectOrphanRequests } from './team-health-detector.js';
import { TeamHealthAlertRouter } from './team-health-alert-router.js';

/**
 * THW data provider — connects the detector to live state. Tests pass
 * a fixture-driven provider; production wiring lives outside this module.
 */
export interface TeamHealthDataProvider {
  collectSnapshot(now: Date): Promise<TeamHealthSnapshot>;
}

/**
 * Delivers an alert decision out to humans. Resolves successfully even
 * on transport error; the watchdog logs but does not retry — next sweep
 * re-emits if the verdict still holds (idempotent dedup).
 */
export interface AlertSink {
  deliver(decision: AlertDecision): Promise<void>;
}

export interface WatchdogLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: WatchdogLogger = {
  info: () => {}, warn: () => {}, error: () => {},
};

export interface TeamHealthWatchdogOptions {
  config: TeamHealthConfig;
  dataProvider: TeamHealthDataProvider;
  alertSink: AlertSink;
  bootedAt?: Date;
  logger?: WatchdogLogger;
  clock?: () => Date;
}

/**
 * The watchdog service. Owns the sweep loop and exposes the public API.
 */
export class TeamHealthWatchdogService {
  // Hoist candidates for `WatchdogBase` extraction in v0.5 (§A.5).
  protected sweepIntervalMs: number;
  protected bootedAt: Date;
  protected router: TeamHealthAlertRouter;

  // v0-specific state.
  private config: TeamHealthConfig;
  private dataProvider: TeamHealthDataProvider;
  private alertSink: AlertSink;
  private logger: WatchdogLogger;
  private clock: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSweep: TeamHealthSweepResult | null = null;
  private isRunning = false;

  constructor(opts: TeamHealthWatchdogOptions) {
    this.config = opts.config;
    this.dataProvider = opts.dataProvider;
    this.alertSink = opts.alertSink;
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? (() => new Date());
    this.bootedAt = opts.bootedAt ?? this.clock();
    this.sweepIntervalMs = opts.config.sweepIntervalMs;
    this.router = new TeamHealthAlertRouter(
      opts.config.alerting,
      opts.config.offHoursSuppression,
      opts.config.shadowMode,
    );
  }

  /**
   * Start the periodic sweep loop. Idempotent. Per §11.3 self-instrumentation,
   * we run `runOnce` immediately on start so /api/health has data from boot.
   */
  start(): void {
    if (!this.config.enabled) {
      this.logger.info('TeamHealthWatchdog disabled by config; not starting.');
      return;
    }
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.info('TeamHealthWatchdog starting', {
      sweepIntervalMs: this.sweepIntervalMs,
      shadowMode: this.config.shadowMode,
      bootedAt: this.bootedAt.toISOString(),
    });
    this.runOnce().catch((err) => {
      this.logger.error('Initial THW sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('THW sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.sweepIntervalMs);
  }

  /**
   * Stop the periodic sweep loop. After stop(), `last_sweep_age_ms` grows;
   * /api/health surfaces this so a stuck watchdog itself shows as 'degraded'
   * (§E.8 watchdog-watchdog).
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this.logger.info('TeamHealthWatchdog stopped');
  }

  /**
   * Run one sweep on demand. Catches own errors and returns a degraded
   * sweep result rather than throwing.
   */
  async runOnce(): Promise<TeamHealthSweepResult> {
    const now = this.clock();
    const startedMs = Date.now();
    let detections: TeamHealthDetection[] = [];
    const alerts: AlertDecision[] = [];
    let bootGraceSuppressed = false;

    try {
      const snapshot = await this.dataProvider.collectSnapshot(now);
      const bootGraceUntil = snapshot.bootedAt.getTime() + this.config.bootGraceMs;
      bootGraceSuppressed = now.getTime() < bootGraceUntil;

      detections = detectTeamHealth(snapshot, this.config);
      const orphans = detectOrphanRequests(
        snapshot.requests, snapshot.workItems, now,
        this.config.thresholds.ORPHAN_REQUEST_T1_MS,
      );
      const teamSummaryById = new Map(snapshot.teams.map((t) => [t.id, t]));

      for (const detection of detections) {
        const team = teamSummaryById.get(detection.teamId);
        if (!team) continue;
        const decision = this.router.route(detection, team, now, orphans.systemTotal);
        alerts.push(decision);
      }

      for (const decision of alerts) {
        if (decision.channel === 'suppressed') continue;
        try {
          await this.alertSink.deliver(decision);
          this.router.commitDecision(decision, now);
        } catch (err) {
          this.logger.warn('Alert delivery failed; will retry on next sweep', {
            teamId: decision.detection.teamId,
            verdict: decision.effectiveVerdict,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      this.logger.error('THW snapshot collection or detection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const result: TeamHealthSweepResult = {
      sweptAt: now.toISOString(),
      durationMs: Date.now() - startedMs,
      detections, alerts, bootGraceSuppressed,
      shadowMode: this.config.shadowMode,
    };
    this.lastSweep = result;
    return result;
  }

  /**
   * Get the most recent sweep result; null until `start()`/`runOnce()` runs.
   */
  getLastSweep(): TeamHealthSweepResult | null {
    return this.lastSweep;
  }

  /**
   * Milliseconds since the last sweep. -1 if no sweep has ever completed.
   */
  getLastSweepAgeMs(): number {
    if (!this.lastSweep) return -1;
    return Math.max(0, this.clock().getTime() - new Date(this.lastSweep.sweptAt).getTime());
  }

  /**
   * Self-health probe — the watchdog-watchdog (§E.8). True when the
   * sweep loop appears stuck (age > 3× sweep interval).
   */
  isDegraded(): boolean {
    const age = this.getLastSweepAgeMs();
    if (age < 0) return false;
    return age > 3 * this.sweepIntervalMs;
  }

  /**
   * Per-team verdicts from the most recent sweep. Backs the
   * orchestrator `team-health-scan` skill (§6.5).
   */
  getCurrentVerdicts(teamId?: string): TeamHealthDetection[] {
    if (!this.lastSweep) return [];
    if (!teamId) return this.lastSweep.detections;
    return this.lastSweep.detections.filter((d) => d.teamId === teamId);
  }

  /**
   * Apply an updated config at runtime (e.g., post-edit reload).
   */
  reconfigure(config: TeamHealthConfig): void {
    this.config = config;
    this.sweepIntervalMs = config.sweepIntervalMs;
    this.router.setShadowMode(config.shadowMode);
    this.router.reconfigure(config.alerting, config.offHoursSuppression);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        void this.runOnce().catch((err) => {
          this.logger.error('THW sweep failed (post-reconfigure)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.sweepIntervalMs);
    }
  }

  /**
   * Apply a manual silence to a team (Slack 🔇 react handler).
   */
  silenceTeam(teamId: string, durationMs: number): void {
    this.router.silenceTeam(teamId, this.clock(), durationMs);
  }

  /**
   * Read the running flag — used by /api/health.
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

/**
 * Module-level singleton for lazy init (per Sam's etiquette nudge:
 * `getInstance()` + first-call init, not module-load side effect).
 *
 * Production wiring calls `setTeamHealthWatchdogSingleton(svc)` once during
 * boot; the controller and /api/health helpers consume `getTeamHealthWatchdogSingleton()`.
 */
let singletonInstance: TeamHealthWatchdogService | null = null;

export function setTeamHealthWatchdogSingleton(svc: TeamHealthWatchdogService): void {
  singletonInstance = svc;
}

export function getTeamHealthWatchdogSingleton(): TeamHealthWatchdogService | null {
  return singletonInstance;
}
