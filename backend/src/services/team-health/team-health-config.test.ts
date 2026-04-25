/**
 * Tests for THW config loader — schema validation + env overrides.
 *
 * @module services/team-health/team-health-config.test
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyEnvOverrides,
  loadTeamHealthConfig,
  mergeWithDefaults,
} from './team-health-config.js';
import { DEFAULT_CONFIG } from './team-health-types.js';

const captureLogger = () => {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn: (msg: string) => { warnings.push(msg); },
      info: () => {},
    },
  };
};

describe('mergeWithDefaults', () => {
  it('returns defaults on null/undefined input', () => {
    expect(mergeWithDefaults(null)).toEqual(DEFAULT_CONFIG);
    expect(mergeWithDefaults(undefined)).toEqual(DEFAULT_CONFIG);
    expect(mergeWithDefaults('not an object')).toEqual(DEFAULT_CONFIG);
  });

  it('overlays valid fields onto defaults', () => {
    const cfg = mergeWithDefaults({
      enabled: false, shadowMode: false, sweepIntervalMs: 30_000,
      thresholds: { TEAM_IDLE_T1_MS: 60_000 },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.shadowMode).toBe(false);
    expect(cfg.sweepIntervalMs).toBe(30_000);
    expect(cfg.thresholds.TEAM_IDLE_T1_MS).toBe(60_000);
    expect(cfg.thresholds.PENDING_T1_MS).toBe(DEFAULT_CONFIG.thresholds.PENDING_T1_MS);
  });

  it('rejects invalid types and warns', () => {
    const { warnings, logger } = captureLogger();
    const cfg = mergeWithDefaults(
      {
        sweepIntervalMs: 'oops',
        thresholds: { TEAM_IDLE_T1_MS: -1 },
        alerting: { redCooldownMs: null },
      },
      logger,
    );
    expect(cfg.sweepIntervalMs).toBe(DEFAULT_CONFIG.sweepIntervalMs);
    expect(cfg.thresholds.TEAM_IDLE_T1_MS).toBe(DEFAULT_CONFIG.thresholds.TEAM_IDLE_T1_MS);
    expect(cfg.alerting.redCooldownMs).toBe(DEFAULT_CONFIG.alerting.redCooldownMs);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('applies per-team overrides', () => {
    const cfg = mergeWithDefaults({
      byTeam: { marketing: { TEAM_IDLE_T1_MS: 120_000 } },
    });
    expect(cfg.byTeam.marketing?.TEAM_IDLE_T1_MS).toBe(120_000);
  });

  it('rejects malformed working hours', () => {
    const { warnings, logger } = captureLogger();
    const cfg = mergeWithDefaults(
      { offHoursSuppression: { workingHours: 'noon-midnight' } }, logger,
    );
    expect(cfg.offHoursSuppression.workingHours).toBe(DEFAULT_CONFIG.offHoursSuppression.workingHours);
    expect(warnings.some((w) => /workingHours/.test(w))).toBe(true);
  });

  it('reads lostDispatchDetection overrides', () => {
    const cfg = mergeWithDefaults({
      lostDispatchDetection: { enabled: false, T1Ms: 5 * 60 * 1000, postRestartGraceMs: 30_000 },
    });
    expect(cfg.lostDispatchDetection.enabled).toBe(false);
    expect(cfg.lostDispatchDetection.T1Ms).toBe(5 * 60 * 1000);
    expect(cfg.lostDispatchDetection.postRestartGraceMs).toBe(30_000);
  });
});

describe('applyEnvOverrides', () => {
  beforeEach(() => {
    delete process.env.TEAMHEALTH_ENABLED;
    delete process.env.TEAMHEALTH_SHADOW_MODE;
    delete process.env.TEAMHEALTH_T1_MS;
    delete process.env.TEAMHEALTH_T2_MS;
  });

  it('TEAMHEALTH_ENABLED overrides config', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    process.env.TEAMHEALTH_ENABLED = 'false';
    applyEnvOverrides(cfg);
    expect(cfg.enabled).toBe(false);
  });

  it('TEAMHEALTH_SHADOW_MODE=false flips off shadow mode', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    process.env.TEAMHEALTH_SHADOW_MODE = 'false';
    applyEnvOverrides(cfg);
    expect(cfg.shadowMode).toBe(false);
  });

  it('TEAMHEALTH_T1_MS sets both team_idle and pending thresholds', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    process.env.TEAMHEALTH_T1_MS = '60000';
    applyEnvOverrides(cfg);
    expect(cfg.thresholds.TEAM_IDLE_T1_MS).toBe(60_000);
    expect(cfg.thresholds.PENDING_T1_MS).toBe(60_000);
  });

  it('invalid TEAMHEALTH_T1_MS falls back with warn', () => {
    const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const { warnings, logger } = captureLogger();
    process.env.TEAMHEALTH_T1_MS = 'not-a-number';
    applyEnvOverrides(cfg, logger);
    expect(cfg.thresholds.TEAM_IDLE_T1_MS).toBe(DEFAULT_CONFIG.thresholds.TEAM_IDLE_T1_MS);
    expect(warnings.some((w) => /T1_MS/.test(w))).toBe(true);
  });
});

describe('loadTeamHealthConfig — file integration', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thw-config-test-'));
    fs.mkdirSync(path.join(tmpHome, 'team-health'), { recursive: true });
    process.env.CREWLY_HOME = tmpHome;
  });
  afterEach(() => {
    delete process.env.CREWLY_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns defaults when file does not exist', () => {
    const cfg = loadTeamHealthConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.shadowMode).toBe(true);
  });

  it('reads valid JSON and applies overlay', () => {
    const file = path.join(tmpHome, 'team-health', 'config.json');
    fs.writeFileSync(file, JSON.stringify({ shadowMode: false, sweepIntervalMs: 15_000 }));
    const cfg = loadTeamHealthConfig();
    expect(cfg.shadowMode).toBe(false);
    expect(cfg.sweepIntervalMs).toBe(15_000);
  });

  it('falls back to defaults on parse error and warns (does NOT throw)', () => {
    const file = path.join(tmpHome, 'team-health', 'config.json');
    fs.writeFileSync(file, '{ this is not json');
    const { warnings, logger } = captureLogger();
    const cfg = loadTeamHealthConfig(logger);
    expect(cfg.enabled).toBe(true);
    expect(warnings.some((w) => /parse/.test(w))).toBe(true);
  });
});
