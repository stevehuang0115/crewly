/**
 * Tests for THW shared types — verdict tier helpers + severity ordering.
 *
 * @module services/team-health/team-health-types.test
 */

import {
  VERDICT_CODES,
  VERDICT_DISPLAY,
  VERDICT_SEVERITY,
  isValidVerdictCode,
  maxVerdict,
  DEFAULT_CONFIG,
  DEFAULT_THRESHOLDS,
  DEFAULT_ALERTING,
  DEFAULT_STALE_TRIGGER,
  DEFAULT_LOST_DISPATCH,
} from './team-health-types.js';

describe('VerdictCode helpers', () => {
  it('all five codes are exposed', () => {
    expect(VERDICT_CODES).toEqual(['healthy', 'stalling', 'stuck', 'cascade', 'stale']);
  });

  it('display map covers all codes', () => {
    for (const code of VERDICT_CODES) {
      expect(VERDICT_DISPLAY[code]).toBeDefined();
    }
  });

  it('severity is monotonic — cascade is highest', () => {
    expect(VERDICT_SEVERITY.cascade).toBeGreaterThan(VERDICT_SEVERITY.stuck);
    expect(VERDICT_SEVERITY.stuck).toBeGreaterThan(VERDICT_SEVERITY.stale);
    expect(VERDICT_SEVERITY.stale).toBeGreaterThan(VERDICT_SEVERITY.stalling);
    expect(VERDICT_SEVERITY.stalling).toBeGreaterThan(VERDICT_SEVERITY.healthy);
  });

  describe('isValidVerdictCode', () => {
    it('accepts every defined code', () => {
      for (const code of VERDICT_CODES) {
        expect(isValidVerdictCode(code)).toBe(true);
      }
    });
    it('rejects unknown strings', () => {
      expect(isValidVerdictCode('green')).toBe(false);
      expect(isValidVerdictCode('')).toBe(false);
      expect(isValidVerdictCode('CASCADE')).toBe(false);
    });
  });

  describe('maxVerdict', () => {
    it('picks the higher-severity verdict', () => {
      expect(maxVerdict('healthy', 'stuck')).toBe('stuck');
      expect(maxVerdict('stuck', 'cascade')).toBe('cascade');
      expect(maxVerdict('stalling', 'stale')).toBe('stale');
    });
    it('returns the first arg on ties', () => {
      expect(maxVerdict('stuck', 'stuck')).toBe('stuck');
    });
  });
});

describe('Default config', () => {
  it('SEALED thresholds match §17 Q2', () => {
    expect(DEFAULT_THRESHOLDS.TEAM_IDLE_T1_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_THRESHOLDS.PENDING_T1_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_THRESHOLDS.TRIGGER_SILENCE_T1_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_THRESHOLDS.STUCK_T2_MS).toBe(60 * 60 * 1000);
    expect(DEFAULT_THRESHOLDS.ORPHAN_REQUEST_T1_MS).toBe(15 * 60 * 1000);
  });

  it('SEALED alerting cooldowns match §F.4', () => {
    expect(DEFAULT_ALERTING.yellowCooldownMs).toBe(60 * 60 * 1000);
    expect(DEFAULT_ALERTING.redCooldownMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_ALERTING.cascadeCooldownMs).toBe(15 * 60 * 1000);
    expect(DEFAULT_ALERTING.alertBudgetWindowMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_ALERTING.alertBudgetMaxAlertsPerTeam).toBe(3);
  });

  it('default config ships shadowMode=true (Phase 0 default)', () => {
    expect(DEFAULT_CONFIG.shadowMode).toBe(true);
    expect(DEFAULT_CONFIG.enabled).toBe(true);
  });

  it('default stale-trigger threshold matches §B.4', () => {
    expect(DEFAULT_STALE_TRIGGER.minPriorDoneCountForRedundancy).toBe(3);
    expect(DEFAULT_STALE_TRIGGER.enabled).toBe(true);
  });

  it('lost-dispatch detection is ON by default per Sam approval (post-SEALED)', () => {
    expect(DEFAULT_LOST_DISPATCH.enabled).toBe(true);
    expect(DEFAULT_LOST_DISPATCH.T1Ms).toBe(10 * 60 * 1000);
    expect(DEFAULT_LOST_DISPATCH.postRestartGraceMs).toBe(60_000);
  });
});
