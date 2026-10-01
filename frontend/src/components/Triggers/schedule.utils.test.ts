/**
 * Tests for the Schedules page view-model.
 *
 * @module components/Triggers/schedule.utils.test
 */

import { describe, it, expect } from 'vitest';
import type { Trigger } from '../../types/trigger.types';
import type { CronTask } from '../../types/cron-task.types';
import type { Team } from '../../types';
import {
  describeCron,
  describeCronCore,
  timezoneLabel,
  formatRelative,
  formatAbsolute,
  formatShortDate,
  triggerDisplayName,
  isInternalTrigger,
  bucketSchedules,
  groupByTeam,
  buildDirectory,
  triggerToRow,
  cronTaskToRow,
} from './schedule.utils';

function trig(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: 't-1',
    type: 'time',
    config: { type: 'time', cronExpression: '30 22 * * *', timezone: 'America/New_York' },
    action: { createWorkItem: { title: 'Nightly ops report', target: 'ce-owen' } },
    status: 'active',
    createdBy: 'agent',
    internal: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    fireCount: 2,
    maxFires: 58,
    maxIdleFires: 3,
    consecutiveIdleFires: 0,
    teamId: 'team-ce',
    name: 'daily-ops-nightly-2230',
    ...overrides,
  };
}

const teams = [{
  id: 'team-ce',
  name: 'CareerEngine',
  members: [{ id: 'm', name: 'Owen', sessionName: 'ce-owen', role: 'developer' }],
}] as unknown as Team[];

describe('describeCron', () => {
  it.each([
    ['30 22 * * *', 'America/New_York', 'Every day 22:30 ET'],
    ['0 22 * * 5', 'America/New_York', 'Every Friday 22:00 ET'],
    ['*/15 * * * *', 'UTC', 'Every 15 min'],
    ['* * * * *', 'UTC', 'Every minute'],
    ['0 9 * * 1-5', 'Asia/Shanghai', 'Weekdays 09:00 Beijing'],
    ['0 10 * * 0,6', undefined, 'Weekends 10:00'],
    ['0 9 * * 1,3', 'UTC', 'Every Mon, Wed 09:00 UTC'],
    ['0 9 1 * *', 'UTC', 'Every month on the 1st 09:00 UTC'],
    ['0 9 22 * *', 'UTC', 'Every month on the 22nd 09:00 UTC'],
    ['0 9,18 * * *', 'UTC', 'Every day 09:00, 18:00 UTC'],
    ['5 */2 * * *', 'UTC', 'Every 2 h at :05 UTC'],
    ['5 * * * *', 'UTC', 'Every hour at :05 UTC'],
  ])('%s (%s) → %s', (cron, tz, expected) => {
    expect(describeCron(cron, tz)).toBe(expected);
  });

  it('falls back to the raw expression for unusual shapes', () => {
    expect(describeCronCore('0 9 * 1 *')).toBeNull();
    expect(describeCron('0 9 * 1 *', 'America/New_York')).toBe('0 9 * 1 * (ET)');
  });

  it('labels unknown zones by city', () => {
    expect(timezoneLabel('Europe/Berlin')).toBe('Berlin');
    expect(timezoneLabel(undefined)).toBe('');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  it('says how far away a time is', () => {
    expect(formatRelative('2026-09-30T15:00:00Z', now)).toBe('in 3 h');
    expect(formatRelative('2026-09-30T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelative('2026-10-02T12:00:00Z', now)).toBe('in 2 days');
    expect(formatRelative(undefined, now)).toBe('');
    expect(formatRelative('2026-09-30T12:00:20Z', now)).toBe('now');
    expect(formatRelative('2026-10-01T12:00:00Z', now)).toBe('in 1 day');
  });

  it('formats dates with English month names (local time)', () => {
    const local = new Date(2026, 8, 30, 22, 30).toISOString();
    expect(formatAbsolute(local)).toBe('Sep 30, 22:30');
    expect(formatShortDate(new Date(2026, 10, 24, 9, 0).toISOString())).toBe('Nov 24');
    expect(formatAbsolute(undefined)).toBe('—');
  });
});

describe('names and classification', () => {
  it('uses the name, then the work item title, then the schedule', () => {
    expect(triggerDisplayName(trig())).toBe('daily-ops-nightly-2230');
    expect(triggerDisplayName(trig({ name: 'followup:abcd1234' }))).toBe('Nightly ops report');
    expect(triggerDisplayName(trig({ name: undefined, action: { runReconciler: true } }))).toBe('Every day 22:30 ET');
  });

  it('trusts the internal flag, else falls back to the creator', () => {
    expect(isInternalTrigger(trig({ internal: true }))).toBe(true);
    expect(isInternalTrigger(trig({ internal: undefined, createdBy: 'system' }))).toBe(true);
    expect(isInternalTrigger(trig({ internal: undefined, createdBy: 'agent' }))).toBe(false);
  });

  it('builds a row with runner, team, remaining and the expiry warning', () => {
    const dir = buildDirectory(teams);
    const row = triggerToRow(trig({ fireCount: 51 }), dir);
    expect(row).toMatchObject({ runnerName: 'Owen', teamName: 'CareerEngine', remaining: 7, expiringSoon: true });
    expect(triggerToRow(trig(), dir).expiringSoon).toBe(false);
  });

  it('turns a cron task into a schedule row named by its 【title】', () => {
    const task = {
      id: 'c1', cronExpression: '0 22 * * 5', timezone: 'America/New_York', targetAgent: 'ce-owen',
      targetTeamId: 'team-ce', taskDescription: '【Weekly recap】\nmore', createdBy: 'user',
      createdAt: '', enabled: false, lastRunAt: null, nextRunAt: null,
    } as CronTask;
    expect(cronTaskToRow(task, buildDirectory(teams))).toMatchObject({ name: 'Weekly recap', status: 'paused', scheduleText: 'Every Friday 22:00 ET' });
  });
});

describe('bucketSchedules', () => {
  const triggers = [
    trig(),
    trig({ id: 'p', status: 'paused' }),
    trig({ id: 'one', config: { type: 'time', delayMs: 60_000 }, name: undefined }),
    trig({ id: 'sig', type: 'signal', config: { type: 'signal', eventType: 'agent:idle' } }),
    trig({ id: 'old', status: 'exhausted' }),
    trig({ id: 'sys', internal: true, createdBy: 'system', config: { type: 'time', cronExpression: '*/5 * * * *' } }),
  ];

  it('splits rows into scheduled / reminders / events / history and hides internal', () => {
    const b = bucketSchedules({ triggers, cronTasks: [], eventSubs: [], teams, showSystem: false });
    expect(b.scheduled.map((r) => r.id).sort()).toEqual(['p', 't-1']);
    expect(b.reminders.map((r) => r.id)).toEqual(['one']);
    expect(b.events.map((r) => r.id)).toEqual(['sig']);
    expect(b.history.map((r) => r.id)).toEqual(['old']);
    expect(b.hiddenInternal).toBe(1);
    expect(b.activeRecurring).toBe(1);
  });

  it('shows internal rows when asked', () => {
    const b = bucketSchedules({ triggers, cronTasks: [], eventSubs: [], teams, showSystem: true });
    expect(b.scheduled.some((r) => r.id === 'sys')).toBe(true);
    expect(b.hiddenInternal).toBe(0);
  });

  it('hides the reconciler event subscription by default', () => {
    const subs = [{ id: 's', eventType: 'x', filter: {}, oneShot: false, subscriberSession: '__reconciler__', createdAt: '' }];
    expect(bucketSchedules({ triggers: [], cronTasks: [], eventSubs: subs, teams, showSystem: false }).events).toEqual([]);
  });

  it('groups by team with unknown teams last', () => {
    const dir = buildDirectory(teams);
    const rows = [triggerToRow(trig({ teamId: undefined, action: { sendMessage: { target: 'x', message: 'y' } } }), dir), triggerToRow(trig(), dir)];
    expect(groupByTeam(rows).map((g) => g.teamName)).toEqual(['CareerEngine', 'Other']);
  });
});
