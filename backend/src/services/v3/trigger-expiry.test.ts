/**
 * Tests for the trigger expiry heads-up helpers.
 *
 * @module services/v3/trigger-expiry.test
 */

import type { Trigger } from '../../types/v2/trigger.types.js';
import type { Team } from '../../types/index.js';
import {
  remainingFires,
  needsExpiryNotice,
  projectLastFireAt,
  buildExpiryNotice,
  resolveExpiryNoticeTarget,
  triggerLabel,
} from './trigger-expiry.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    }),
  },
}));

function nightly(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: '8c61ac27-aaaa-4000-8000-000000000000',
    type: 'time',
    config: { type: 'time', cronExpression: '30 22 * * *', timezone: 'America/New_York' },
    action: { createWorkItem: { target: 'ce-owen-ad0320ab', title: 'Nightly ops report' } },
    status: 'active',
    createdBy: 'agent',
    internal: false,
    createdAt: '2026-09-28T00:00:00.000Z',
    nextFireAt: '2026-10-01T02:30:00.000Z',
    fireCount: 55,
    maxFires: 58,
    maxIdleFires: 3,
    consecutiveIdleFires: 0,
    teamId: 'team-ce',
    name: 'daily-ops-nightly-2230',
    ...overrides,
  };
}

describe('remainingFires', () => {
  it('is maxFires - fireCount, floored at 0, undefined when unlimited', () => {
    expect(remainingFires({ maxFires: 58, fireCount: 2 })).toBe(56);
    expect(remainingFires({ maxFires: 2, fireCount: 5 })).toBe(0);
    expect(remainingFires({ maxFires: undefined, fireCount: 5 })).toBeUndefined();
  });
});

describe('needsExpiryNotice', () => {
  it('fires at 3 remaining and not before', () => {
    expect(needsExpiryNotice(nightly({ fireCount: 54 }))).toBe(false); // 4 left
    expect(needsExpiryNotice(nightly({ fireCount: 55 }))).toBe(true); // 3 left
  });

  it('is not due twice, for paused/internal/one-shot, or when exhausted', () => {
    expect(needsExpiryNotice(nightly({ expiryNoticeSentAt: '2026-11-20T00:00:00Z' }))).toBe(false);
    expect(needsExpiryNotice(nightly({ status: 'paused' }))).toBe(false);
    expect(needsExpiryNotice(nightly({ internal: true }))).toBe(false);
    expect(needsExpiryNotice(nightly({ config: { type: 'time', delayMs: 1000 } }))).toBe(false);
    expect(needsExpiryNotice(nightly({ fireCount: 58 }))).toBe(false);
  });
});

describe('projectLastFireAt', () => {
  it('walks the cron forward to the final allowed fire', () => {
    // 3 left: next fire + 2 more daily slots.
    const last = projectLastFireAt(nightly());
    expect(last).toBeDefined();
    const days = (new Date(last!).getTime() - new Date('2026-10-01T02:30:00.000Z').getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(2);
  });

  it('is undefined for unlimited and one-shot triggers', () => {
    expect(projectLastFireAt(nightly({ maxFires: undefined }))).toBeUndefined();
    expect(projectLastFireAt(nightly({ config: { type: 'time', delayMs: 1000 } }))).toBeUndefined();
  });
});

describe('buildExpiryNotice', () => {
  it('names the schedule, counts, and forbids auto-renewal', () => {
    const n = buildExpiryNotice(nightly(), '2026-10-03T02:30:00.000Z');
    expect(n.title).toContain('daily-ops-nightly-2230');
    expect(n.title).toContain('3');
    expect(n.description).toContain('3 run(s) left of 58');
    expect(n.description).toContain('Do NOT renew it automatically');
    expect(n.description).toContain('2026-10-03T02:30:00.000Z');
  });

  it('labels by work item title when there is no name', () => {
    expect(triggerLabel(nightly({ name: undefined }))).toBe('Nightly ops report');
  });
});

describe('resolveExpiryNoticeTarget', () => {
  const team = {
    id: 'team-ce',
    name: 'CE',
    leaderIds: ['m-lead'],
    members: [
      { id: 'm-lead', name: 'Lena', role: 'team-leader', sessionName: 'ce-lena-1', hierarchyLevel: 1, canDelegate: true },
      { id: 'm-owen', name: 'Owen', role: 'developer', sessionName: 'ce-owen-ad0320ab' },
    ],
  } as unknown as Team;

  it('picks the lead of the trigger team', () => {
    expect(resolveExpiryNoticeTarget(nightly(), [team])).toBe('ce-lena-1');
  });

  it('falls back to the runner team, then the orchestrator', () => {
    expect(resolveExpiryNoticeTarget(nightly({ teamId: undefined }), [team])).toBe('ce-lena-1');
    expect(resolveExpiryNoticeTarget(nightly({ teamId: 'gone', action: { sendMessage: { target: 'nobody', message: 'x' } } }), [team])).toBe('crewly-orc');
  });
});
