/**
 * Tests for the THW alert router — dedup, cooldown, off-hours, channels.
 *
 * @module services/team-health/team-health-alert-router.test
 */

import {
  TeamHealthAlertRouter,
  formatRollupMessage,
  formatRecoveryMessage,
  isWithinWorkingHours,
} from './team-health-alert-router.js';
import type {
  AlertDecision,
  TeamHealthDetection,
  TeamSummary,
} from './team-health-types.js';
import { DEFAULT_ALERTING, DEFAULT_CONFIG } from './team-health-types.js';

const team: TeamSummary = {
  id: 'marketing', name: 'Marketing', slackThreadId: 'T_marketing',
  memberSessions: ['ella', 'grace'], tlSession: 'ella',
};

function detection(verdict: TeamHealthDetection['verdict']): TeamHealthDetection {
  return {
    teamId: 'marketing', verdict,
    gates: { team_idle: true, team_pending: true, team_silent: true, cascade_with_siblings: false },
    pendingWorkItemIds: ['wi-1', 'wi-2'],
    idleAgentSessions: ['ella', 'grace'],
    detectedAt: '2026-04-25T19:30:00.000Z',
    rationale: 'test',
  };
}

describe('TeamHealthAlertRouter — channel selection', () => {
  it('cascade → ops-channel', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const d = r.route(detection('cascade'), team, new Date('2026-04-25T15:00:00.000Z'), 0);
    expect(d.channel).toBe('ops-channel');
  });

  it('stuck → team-thread when configured', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const d = r.route(detection('stuck'), team, new Date('2026-04-25T15:00:00.000Z'), 0);
    expect(d.channel).toBe('team-thread');
  });

  it('stuck → tl-dm when no slack thread', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const teamNoThread: TeamSummary = { ...team, slackThreadId: undefined };
    const d = r.route(detection('stuck'), teamNoThread, new Date('2026-04-25T15:00:00.000Z'), 0);
    expect(d.channel).toBe('tl-dm');
  });
});

describe('TeamHealthAlertRouter — dedup / cooldown', () => {
  it('emits one; second within cooldown is suppressed', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const t1 = new Date('2026-04-25T15:00:00.000Z');
    const d1 = r.route(detection('stuck'), team, t1, 0);
    expect(d1.channel).toBe('team-thread');
    r.commitDecision(d1, t1);
    const t2 = new Date(t1.getTime() + 5 * 60 * 1000);
    const d2 = r.route(detection('stuck'), team, t2, 0);
    expect(d2.channel).toBe('suppressed');
    expect(d2.suppressionReason).toBe('cooldown');
  });

  it('shadow mode suppresses', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, true);
    const d = r.route(detection('cascade'), team, new Date('2026-04-25T15:00:00.000Z'), 0);
    expect(d.channel).toBe('suppressed');
    expect(d.suppressionReason).toBe('shadow_mode');
    expect(d.message.length).toBeGreaterThan(0);
  });

  it('alert-budget exceeded silences team', () => {
    const r = new TeamHealthAlertRouter(
      { ...DEFAULT_ALERTING, alertBudgetMaxAlertsPerTeam: 2, redCooldownMs: 1 },
      DEFAULT_CONFIG.offHoursSuppression, false,
    );
    const baseTime = new Date('2026-04-25T15:00:00.000Z').getTime();
    const d1 = r.route(detection('stuck'), team, new Date(baseTime), 0);
    r.commitDecision(d1, new Date(baseTime));
    const d2 = r.route(detection('stuck'), team, new Date(baseTime + 10), 0);
    r.commitDecision(d2, new Date(baseTime + 10));
    const d3 = r.route(detection('stuck'), team, new Date(baseTime + 20), 0);
    expect(d3.channel).toBe('suppressed');
    expect(d3.suppressionReason).toBe('alert_budget_exceeded');
  });

  it('🔇 silencing suppresses for the silence window', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const t = new Date('2026-04-25T15:00:00.000Z');
    r.silenceTeam('marketing', t, 60 * 60 * 1000);
    const d = r.route(detection('stuck'), team, t, 0);
    expect(d.channel).toBe('suppressed');
    expect(d.suppressionReason).toBe('silenced_by_react');
  });
});

describe('TeamHealthAlertRouter — recovery', () => {
  it('healthy with no prior alerts → suppressed (stable_healthy)', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const d = r.route(detection('healthy'), team, new Date('2026-04-25T15:00:00.000Z'), 0);
    expect(d.channel).toBe('suppressed');
    expect(d.suppressionReason).toBe('stable_healthy');
  });

  it('healthy after stuck → recovery announcement', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const t1 = new Date('2026-04-25T15:00:00.000Z');
    const stuckDecision = r.route(detection('stuck'), team, t1, 0);
    r.commitDecision(stuckDecision, t1);
    const t2 = new Date(t1.getTime() + 60 * 60 * 1000);
    const d = r.route(detection('healthy'), team, t2, 0);
    expect(d.channel).toBe('team-thread');
    expect(d.message).toContain('recovered');
  });
});

describe('TeamHealthAlertRouter — off-hours downgrade', () => {
  it('🔴 stuck → 🟡 stalling outside working hours', () => {
    const r = new TeamHealthAlertRouter(
      DEFAULT_ALERTING,
      { enabled: true, ownerTimezone: 'America/New_York', workingHours: '09:00-21:00' },
      false,
    );
    const offHoursNow = new Date('2026-04-25T07:00:00.000Z'); // 03:00 ET
    const d = r.route(detection('stuck'), team, offHoursNow, 0);
    expect(d.effectiveVerdict).toBe('stalling');
  });

  it('🔴 stuck stays 🔴 inside working hours', () => {
    const r = new TeamHealthAlertRouter(
      DEFAULT_ALERTING,
      { enabled: true, ownerTimezone: 'America/New_York', workingHours: '09:00-21:00' },
      false,
    );
    const workingNow = new Date('2026-04-25T17:00:00.000Z');
    const d = r.route(detection('stuck'), team, workingNow, 0);
    expect(d.effectiveVerdict).toBe('stuck');
  });

  it('off-hours disabled keeps verdict unchanged', () => {
    const r = new TeamHealthAlertRouter(
      DEFAULT_ALERTING,
      { enabled: false, ownerTimezone: 'America/New_York', workingHours: '09:00-21:00' },
      false,
    );
    const offHoursNow = new Date('2026-04-25T07:00:00.000Z');
    const d = r.route(detection('stuck'), team, offHoursNow, 0);
    expect(d.effectiveVerdict).toBe('stuck');
  });
});

describe('isWithinWorkingHours', () => {
  it('midday in window → true', () => {
    expect(
      isWithinWorkingHours(new Date('2026-04-25T17:00:00.000Z'), {
        enabled: true, ownerTimezone: 'America/New_York', workingHours: '09:00-21:00',
      }),
    ).toBe(true);
  });
  it('03:00 ET → false', () => {
    expect(
      isWithinWorkingHours(new Date('2026-04-25T07:00:00.000Z'), {
        enabled: true, ownerTimezone: 'America/New_York', workingHours: '09:00-21:00',
      }),
    ).toBe(false);
  });
  it('malformed window → defaults to always-working', () => {
    expect(
      isWithinWorkingHours(new Date(), {
        enabled: true, ownerTimezone: 'America/New_York', workingHours: 'not-a-window',
      }),
    ).toBe(true);
  });
  it('invalid timezone → defaults to always-working', () => {
    expect(
      isWithinWorkingHours(new Date(), {
        enabled: true, ownerTimezone: 'Invalid/Zone', workingHours: '09:00-21:00',
      }),
    ).toBe(true);
  });
});

describe('formatRollupMessage', () => {
  it('cascade message names siblings', () => {
    const d: TeamHealthDetection = { ...detection('cascade'), cascadeWith: ['marketing-ops'] };
    const msg = formatRollupMessage(d, team, 'cascade', 0);
    expect(msg).toContain('cascade');
    expect(msg).toContain('marketing-ops');
  });

  it('stuck message lists pending and idle', () => {
    const msg = formatRollupMessage(detection('stuck'), team, 'stuck', 0);
    expect(msg).toContain('Pending work');
    expect(msg).toContain('Idle members');
    expect(msg).toContain('Suggested next step');
  });

  it('stale message asks to confirm cancel', () => {
    const det: TeamHealthDetection = { ...detection('stale'), staleWorkItemIds: ['wi-stale-relay'] };
    const msg = formatRollupMessage(det, team, 'stale', 0);
    expect(msg).toContain('Stale-fire suspects');
    expect(msg).toContain('Confirm cancel');
  });

  it('lost-dispatch message lists suspects', () => {
    const det: TeamHealthDetection = {
      ...detection('stalling'),
      lostDispatchWorkItemIds: ['wi-mia-lost'],
    };
    const msg = formatRollupMessage(det, team, 'stalling', 0);
    expect(msg).toContain('Lost-dispatch suspects');
    expect(msg).toContain('wi-mia-lost');
  });
});

describe('formatRecoveryMessage', () => {
  it('produces a short recovery line', () => {
    const msg = formatRecoveryMessage(team, detection('healthy'), new Date('2026-04-25T20:00:00.000Z'));
    expect(msg).toContain('recovered');
    expect(msg).toContain('Marketing');
  });
});

describe('TeamHealthAlertRouter — state snapshot/restore', () => {
  it('round-trips state through snapshot+restore', () => {
    const r = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    const t = new Date('2026-04-25T15:00:00.000Z');
    const d: AlertDecision = r.route(detection('stuck'), team, t, 0);
    r.commitDecision(d, t);
    r.silenceTeam('other-team', t, 60_000);
    const snap = r.snapshotState();
    const r2 = new TeamHealthAlertRouter(DEFAULT_ALERTING, DEFAULT_CONFIG.offHoursSuppression, false);
    r2.restoreState(snap);
    expect(r2.snapshotState()).toEqual(snap);
  });
});
