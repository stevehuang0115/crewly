/**
 * Team-Health-Watchdog (THW) — Config Loader
 *
 * Reads `~/.crewly/team-health/config.json`, validates against the SEALED
 * schema (§F.4), and on bad config logs `warn` and falls back to defaults.
 * MUST NEVER throw or crash the backend (§11.3).
 *
 * Env overrides:
 *   - TEAMHEALTH_ENABLED        ('true'/'false')
 *   - TEAMHEALTH_SHADOW_MODE    ('true'/'false')
 *   - TEAMHEALTH_T1_MS          (numeric ms)
 *   - TEAMHEALTH_T2_MS          (numeric ms)
 *
 * @module services/team-health/team-health-config
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TeamHealthConfig } from './team-health-types.js';
import { DEFAULT_CONFIG } from './team-health-types.js';

export function resolveConfigPath(): string {
  const home = process.env.CREWLY_HOME ?? path.join(os.homedir(), '.crewly');
  return path.join(home, 'team-health', 'config.json');
}

export function resolveSidecarDir(): string {
  const home = process.env.CREWLY_HOME ?? path.join(os.homedir(), '.crewly');
  return path.join(home, 'team-health');
}

export interface ConfigLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Load and validate the THW config from disk + env. Always returns a
 * valid TeamHealthConfig — bad fields fall back to defaults with a warn.
 *
 * @param logger - Optional logger for warnings
 * @returns A fully-populated, valid TeamHealthConfig
 */
export function loadTeamHealthConfig(logger?: ConfigLogger): TeamHealthConfig {
  let parsed: unknown = {};
  const configPath = resolveConfigPath();

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch (err) {
      logger?.warn('Failed to parse team-health config; using defaults.', {
        path: configPath,
        error: err instanceof Error ? err.message : String(err),
      });
      parsed = {};
    }
  }

  const merged = mergeWithDefaults(parsed, logger);
  applyEnvOverrides(merged, logger);
  return merged;
}

/**
 * Merge user-provided config object onto defaults. Validates types as
 * it goes; invalid fields fall back to default with a warn.
 */
export function mergeWithDefaults(
  input: unknown,
  logger?: ConfigLogger,
): TeamHealthConfig {
  const base: TeamHealthConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!input || typeof input !== 'object') return base;
  const obj = input as Record<string, unknown>;

  if (typeof obj.enabled === 'boolean') base.enabled = obj.enabled;
  if (typeof obj.shadowMode === 'boolean') base.shadowMode = obj.shadowMode;
  if (typeof obj.sweepIntervalMs === 'number' && obj.sweepIntervalMs > 0) {
    base.sweepIntervalMs = obj.sweepIntervalMs;
  } else if (obj.sweepIntervalMs !== undefined) {
    logger?.warn('Invalid sweepIntervalMs; using default.', { value: obj.sweepIntervalMs });
  }
  if (typeof obj.bootGraceMs === 'number' && obj.bootGraceMs >= 0) {
    base.bootGraceMs = obj.bootGraceMs;
  } else if (obj.bootGraceMs !== undefined) {
    logger?.warn('Invalid bootGraceMs; using default.', { value: obj.bootGraceMs });
  }

  if (obj.thresholds && typeof obj.thresholds === 'object') {
    const t = obj.thresholds as Record<string, unknown>;
    for (const key of Object.keys(base.thresholds) as (keyof typeof base.thresholds)[]) {
      const v = t[key];
      if (typeof v === 'number' && v > 0) {
        base.thresholds[key] = v;
      } else if (v !== undefined) {
        logger?.warn(`Invalid thresholds.${key}; using default.`, { value: v });
      }
    }
  }

  if (obj.byTeam && typeof obj.byTeam === 'object') {
    base.byTeam = {};
    for (const [teamId, override] of Object.entries(obj.byTeam as Record<string, unknown>)) {
      if (override && typeof override === 'object') {
        const o = override as Record<string, unknown>;
        const cleaned: Record<string, number> = {};
        for (const key of Object.keys(base.thresholds)) {
          const v = o[key];
          if (typeof v === 'number' && v > 0) cleaned[key] = v;
        }
        base.byTeam[teamId] = cleaned as Partial<typeof base.thresholds>;
      } else {
        logger?.warn(`Invalid byTeam[${teamId}]; ignoring override.`, { value: override });
      }
    }
  }

  if (obj.alerting && typeof obj.alerting === 'object') {
    const a = obj.alerting as Record<string, unknown>;
    for (const key of Object.keys(base.alerting) as (keyof typeof base.alerting)[]) {
      const v = a[key];
      if (typeof v === 'number' && v > 0) {
        base.alerting[key] = v;
      } else if (v !== undefined) {
        logger?.warn(`Invalid alerting.${key}; using default.`, { value: v });
      }
    }
  }

  if (obj.offHoursSuppression && typeof obj.offHoursSuppression === 'object') {
    const o = obj.offHoursSuppression as Record<string, unknown>;
    if (typeof o.enabled === 'boolean') base.offHoursSuppression.enabled = o.enabled;
    if (typeof o.ownerTimezone === 'string') {
      base.offHoursSuppression.ownerTimezone = o.ownerTimezone;
    }
    if (typeof o.workingHours === 'string' && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(o.workingHours)) {
      base.offHoursSuppression.workingHours = o.workingHours;
    } else if (o.workingHours !== undefined) {
      logger?.warn('Invalid offHoursSuppression.workingHours; using default.', {
        value: o.workingHours,
      });
    }
  }

  if (obj.staleTriggerDetection && typeof obj.staleTriggerDetection === 'object') {
    const s = obj.staleTriggerDetection as Record<string, unknown>;
    if (typeof s.enabled === 'boolean') base.staleTriggerDetection.enabled = s.enabled;
    if (typeof s.minPriorDoneCountForRedundancy === 'number' && s.minPriorDoneCountForRedundancy > 0) {
      base.staleTriggerDetection.minPriorDoneCountForRedundancy = s.minPriorDoneCountForRedundancy;
    } else if (s.minPriorDoneCountForRedundancy !== undefined) {
      logger?.warn('Invalid staleTriggerDetection.minPriorDoneCountForRedundancy; using default.', {
        value: s.minPriorDoneCountForRedundancy,
      });
    }
  }

  if (obj.lostDispatchDetection && typeof obj.lostDispatchDetection === 'object') {
    const l = obj.lostDispatchDetection as Record<string, unknown>;
    if (typeof l.enabled === 'boolean') base.lostDispatchDetection.enabled = l.enabled;
    if (typeof l.T1Ms === 'number' && l.T1Ms > 0) {
      base.lostDispatchDetection.T1Ms = l.T1Ms;
    } else if (l.T1Ms !== undefined) {
      logger?.warn('Invalid lostDispatchDetection.T1Ms; using default.', { value: l.T1Ms });
    }
    if (typeof l.postRestartGraceMs === 'number' && l.postRestartGraceMs >= 0) {
      base.lostDispatchDetection.postRestartGraceMs = l.postRestartGraceMs;
    } else if (l.postRestartGraceMs !== undefined) {
      logger?.warn('Invalid lostDispatchDetection.postRestartGraceMs; using default.', {
        value: l.postRestartGraceMs,
      });
    }
  }

  return base;
}

/**
 * Apply environment-variable overrides on top of the merged config.
 * Mutates `config` in place.
 */
export function applyEnvOverrides(config: TeamHealthConfig, logger?: ConfigLogger): void {
  const env = process.env;
  if (env.TEAMHEALTH_ENABLED !== undefined) {
    if (env.TEAMHEALTH_ENABLED === 'true') config.enabled = true;
    else if (env.TEAMHEALTH_ENABLED === 'false') config.enabled = false;
    else logger?.warn('Invalid TEAMHEALTH_ENABLED env var.', { value: env.TEAMHEALTH_ENABLED });
  }
  if (env.TEAMHEALTH_SHADOW_MODE !== undefined) {
    if (env.TEAMHEALTH_SHADOW_MODE === 'true') config.shadowMode = true;
    else if (env.TEAMHEALTH_SHADOW_MODE === 'false') config.shadowMode = false;
    else logger?.warn('Invalid TEAMHEALTH_SHADOW_MODE env var.', { value: env.TEAMHEALTH_SHADOW_MODE });
  }
  if (env.TEAMHEALTH_T1_MS !== undefined) {
    const n = Number.parseInt(env.TEAMHEALTH_T1_MS, 10);
    if (!Number.isNaN(n) && n > 0) {
      config.thresholds.TEAM_IDLE_T1_MS = n;
      config.thresholds.PENDING_T1_MS = n;
    } else logger?.warn('Invalid TEAMHEALTH_T1_MS env var.', { value: env.TEAMHEALTH_T1_MS });
  }
  if (env.TEAMHEALTH_T2_MS !== undefined) {
    const n = Number.parseInt(env.TEAMHEALTH_T2_MS, 10);
    if (!Number.isNaN(n) && n > 0) {
      config.thresholds.STUCK_T2_MS = n;
      config.thresholds.TRIGGER_SILENCE_T1_MS = n;
    } else logger?.warn('Invalid TEAMHEALTH_T2_MS env var.', { value: env.TEAMHEALTH_T2_MS });
  }
}
