/**
 * Tests for OKROwnerGuidanceService — approval nudges and the weekly digest.
 *
 * @module services/v3/okr-owner-guidance.service.test
 */

import { OKROwnerGuidanceService, formatKrLine } from './okr-owner-guidance.service.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm-team',
    objective: 'Portal Team: steady ticket flow',
    ownerTeamId: 't1',
    level: 'team',
    parentMissionId: 'm-company',
    status: 'active',
    approval: { state: 'pending_approval' },
    successCriteria: [],
    policy: {} as never,
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  } as unknown as Mission;
}

function kr(over: Partial<KeyResult> = {}): KeyResult {
  return { id: 'k1', missionId: 'm-team', title: 'KR1 review backlog', current: 3, target: 2, baseline: 6, unit: 'tickets', status: 'on_track', metricType: 'number', measurementSource: 'manual', linkedWorkItemIds: [], measurements: [], createdAt: 'x', updatedAt: 'x', ...over } as KeyResult;
}

const MON_0930 = new Date('2026-09-21T09:30:00.000Z'); // Monday, after the 09:00 boundary

function build(opts: { missions: Mission[]; now?: Date; krs?: KeyResult[] }) {
  const owner = jest.fn().mockResolvedValue(undefined);
  const orc = jest.fn();
  const saved: Mission[] = [];
  const clock = { now: opts.now ?? new Date('2026-09-18T15:00:00.000Z') }; // Friday
  const svc = new OKROwnerGuidanceService({
    notifyOwner: owner,
    notifyOrchestrator: orc,
    listKeyResults: jest.fn().mockResolvedValue(opts.krs ?? [kr()]),
    loadMissions: async () => opts.missions,
    saveMission: async (m) => {
      saved.push(m);
    },
    statePath: null,
    now: () => clock.now,
  });
  return { svc, owner, orc, saved, clock };
}

describe('formatKrLine', () => {
  it('renders current → target with unit and status', () => {
    expect(formatKrLine(kr())).toBe('• KR1 review backlog: 3 → 2 tickets (on track)');
  });
});

describe('approval nudge', () => {
  it('nudges the owner and the orchestrator once for a pending proposal and stamps the mission', async () => {
    const company = mission({ id: 'm-company', level: 'company', parentMissionId: undefined, approval: { state: 'approved' } });
    const { svc, owner, orc, saved } = build({ missions: [company, mission()] });

    const out = await svc.run();

    expect(out).toMatchObject({ pendingProposals: 1, nudged: 1, digestSent: false });
    expect(owner).toHaveBeenCalledTimes(1);
    const msg = owner.mock.calls[0][0].message as string;
    expect(msg).toContain('Portal Team: steady ticket flow');
    expect(msg).toContain('Under: ' + company.objective);
    expect(msg).toContain('KR1 review backlog: 3 → 2 tickets');
    expect(orc).toHaveBeenCalledWith(expect.stringContaining('[OKR-APPROVAL] Mission m-team'));
    expect(saved[0].lastApprovalNudgeAt).toBe('2026-09-18T15:00:00.000Z');
  });

  it('does not re-nudge inside the 24 h cooldown, does after it', async () => {
    const recent = mission({ lastApprovalNudgeAt: '2026-09-18T10:00:00.000Z' });
    const stale = mission({ id: 'm-old', lastApprovalNudgeAt: '2026-09-17T10:00:00.000Z' });
    const { svc, owner } = build({ missions: [recent, stale] });

    const out = await svc.run();

    expect(out.nudged).toBe(1);
    expect(owner.mock.calls[0][0].metadata).toMatchObject({ missionId: 'm-old' });
  });

  it('ignores approved, rejected and paused missions', async () => {
    const { svc, owner } = build({
      missions: [
        mission({ approval: { state: 'approved' } }),
        mission({ id: 'r', approval: { state: 'rejected' } }),
        mission({ id: 'p', status: 'paused' }),
      ],
    });
    expect((await svc.run()).pendingProposals).toBe(0);
    expect(owner).not.toHaveBeenCalled();
  });
});

describe('weekly digest', () => {
  it('sends one digest after the cron boundary, listing live KRs and pending proposals, then not again', async () => {
    const live = mission({ id: 'm-company', level: 'company', parentMissionId: undefined, approval: { state: 'approved' } });
    const { svc, owner, clock } = build({ missions: [live, mission({ lastApprovalNudgeAt: '2026-09-21T09:00:00.000Z' })] });

    // First ever run only starts the schedule (Friday) — no digest at boot.
    expect((await svc.run()).digestSent).toBe(false);
    clock.now = MON_0930;
    const first = await svc.run();
    expect(first.digestSent).toBe(true);
    const digest = owner.mock.calls.find((c) => c[0].title === 'Weekly OKR digest')![0].message as string;
    expect(digest).toContain('Weekly OKR digest');
    expect(digest).toContain(live.objective);
    expect(digest).toContain('Waiting for your approval');
    expect(digest).toContain('Portal Team: steady ticket flow');

    owner.mockClear();
    const second = await svc.run();
    expect(second.digestSent).toBe(false);
    expect(owner.mock.calls.some((c) => c[0].title === 'Weekly OKR digest')).toBe(false);
  });

  it('does nothing before the boundary and stamps quietly when there is nothing to report', async () => {
    const { svc, owner, clock } = build({ missions: [] });
    await svc.run(); // start the schedule
    clock.now = new Date('2026-09-21T08:00:00.000Z'); // Monday, before 09:00
    expect((await svc.run()).digestSent).toBe(false);
    clock.now = MON_0930;
    expect((await svc.run()).digestSent).toBe(false); // nothing to report → no message
    expect(owner).not.toHaveBeenCalled();
  });

  it('survives a broken KR lookup and a failing notifier', async () => {
    const live = mission({ id: 'm-company', level: 'company', parentMissionId: undefined, approval: { state: 'approved' } });
    const svc = new OKROwnerGuidanceService({
      notifyOwner: jest.fn().mockRejectedValue(new Error('slack down')),
      notifyOrchestrator: null,
      listKeyResults: jest.fn().mockRejectedValue(new Error('disk')),
      loadMissions: async () => [live, mission()],
      saveMission: async () => undefined,
      statePath: null,
      now: () => MON_0930,
    });
    await svc.run(); // starts the digest schedule
    await expect(svc.run()).resolves.toMatchObject({ pendingProposals: 1, nudged: 0, digestSent: false });
  });
});
