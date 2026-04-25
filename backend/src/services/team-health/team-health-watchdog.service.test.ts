/**
 * Tests for the THW service shell — sweep loop, alert delivery,
 * watchdog-watchdog (§E.8), reconfigure, silence, singleton accessor.
 *
 * @module services/team-health/team-health-watchdog.service.test
 */

import {
  TeamHealthWatchdogService,
  type AlertSink,
  type TeamHealthDataProvider,
  setTeamHealthWatchdogSingleton,
  getTeamHealthWatchdogSingleton,
} from './team-health-watchdog.service.js';
import type {
  AlertDecision,
  TeamHealthConfig,
  TeamHealthSnapshot,
  TeamSummary,
} from './team-health-types.js';
import { DEFAULT_CONFIG } from './team-health-types.js';
import type { WorkItem } from '../../types/v2/index.js';

class RecordingSink implements AlertSink {
  delivered: AlertDecision[] = [];
  shouldThrow = false;
  async deliver(decision: AlertDecision): Promise<void> {
    if (this.shouldThrow) throw new Error('synthetic delivery failure');
    this.delivered.push(decision);
  }
}

function buildSnapshot(now: Date, bootedAt: Date, scenario: 'healthy' | 'stuck'): TeamHealthSnapshot {
  const team: TeamSummary = {
    id: 't1', name: 't1', memberSessions: ['a1'], slackThreadId: 'T_t1', tlSession: 'a1',
  };
  if (scenario === 'healthy') {
    return {
      now, bootedAt, teams: [team],
      agentHealth: new Map([['a1', {
        sessionName: 'a1', status: 'active', workingStatus: 'in_progress',
        lastSeenAt: now.toISOString(),
      }]]),
      workItems: [], requests: [], triggers: [],
    };
  }
  const wi: WorkItem = {
    id: 'w1', type: 'delegate', owner: 'agent', target: 'a1',
    title: 'pending', status: 'queued',
    createdAt: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
    retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0,
  };
  return {
    now, bootedAt, teams: [team],
    agentHealth: new Map([['a1', {
      sessionName: 'a1', status: 'inactive', workingStatus: 'inactive',
      lastSeenAt: new Date(now.getTime() - 90 * 60 * 1000).toISOString(),
    }]]),
    workItems: [wi], requests: [], triggers: [],
  };
}

function dataProvider(snapshot: TeamHealthSnapshot): TeamHealthDataProvider {
  return { collectSnapshot: async () => snapshot };
}

const liveCfg: TeamHealthConfig = { ...DEFAULT_CONFIG, shadowMode: false };

describe('TeamHealthWatchdogService.runOnce', () => {
  it('produces a sweep result with one detection per team', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink,
      bootedAt: booted, clock: () => now,
    });
    const result = await svc.runOnce();
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].verdict).toBe('stuck');
    expect(sink.delivered).toHaveLength(1);
  });

  it('shadow mode does NOT deliver alerts', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: { ...DEFAULT_CONFIG, shadowMode: true },
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink, bootedAt: booted, clock: () => now,
    });
    const result = await svc.runOnce();
    expect(result.detections[0].verdict).toBe('stuck');
    expect(result.alerts[0].channel).toBe('suppressed');
    expect(sink.delivered).toHaveLength(0);
  });

  it('records bootGraceSuppressed when within grace', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const justBooted = new Date(now.getTime() - 60_000);
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(now, justBooted, 'stuck')),
      alertSink: sink, bootedAt: justBooted, clock: () => now,
    });
    const result = await svc.runOnce();
    expect(result.bootGraceSuppressed).toBe(true);
    expect(result.detections.every((d) => d.verdict === 'healthy')).toBe(true);
  });

  it('alert delivery failure does not crash the sweep', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    sink.shouldThrow = true;
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink, bootedAt: booted, clock: () => now,
    });
    const result = await svc.runOnce();
    expect(result.detections).toHaveLength(1);
    expect(sink.delivered).toHaveLength(0);
  });

  it('snapshot-collection failure degrades to empty result', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const sink = new RecordingSink();
    const failingProvider: TeamHealthDataProvider = {
      collectSnapshot: async () => { throw new Error('snapshot failure'); },
    };
    const svc = new TeamHealthWatchdogService({
      config: liveCfg, dataProvider: failingProvider, alertSink: sink,
      bootedAt: now, clock: () => now,
    });
    const result = await svc.runOnce();
    expect(result.detections).toEqual([]);
    expect(result.alerts).toEqual([]);
  });
});

describe('TeamHealthWatchdogService — watchdog-watchdog (§E.8)', () => {
  it('reports degraded when last sweep is older than 3× sweep interval', async () => {
    const t0 = new Date('2026-04-25T19:30:00.000Z');
    const sink = new RecordingSink();
    const clockBox = { now: t0 };
    const svc = new TeamHealthWatchdogService({
      config: { ...liveCfg, sweepIntervalMs: 60_000 },
      dataProvider: dataProvider(buildSnapshot(t0, t0, 'healthy')),
      alertSink: sink, bootedAt: t0,
      clock: () => clockBox.now,
    });
    await svc.runOnce();
    expect(svc.isDegraded()).toBe(false);
    clockBox.now = new Date(t0.getTime() + 200 * 1000);
    expect(svc.isDegraded()).toBe(true);
    expect(svc.getLastSweepAgeMs()).toBeGreaterThan(180_000);
  });

  it('returns -1 ageMs before any sweep has run', () => {
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(new Date(), new Date(), 'healthy')),
      alertSink: sink,
    });
    expect(svc.getLastSweepAgeMs()).toBe(-1);
  });
});

describe('TeamHealthWatchdogService — getCurrentVerdicts', () => {
  it('filters by teamId when provided', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink, bootedAt: booted, clock: () => now,
    });
    await svc.runOnce();
    expect(svc.getCurrentVerdicts('t1')).toHaveLength(1);
    expect(svc.getCurrentVerdicts('does-not-exist')).toHaveLength(0);
  });

  it('returns empty array before any sweep', () => {
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(new Date(), new Date(), 'healthy')),
      alertSink: sink,
    });
    expect(svc.getCurrentVerdicts()).toEqual([]);
  });
});

describe('TeamHealthWatchdogService — start/stop', () => {
  it('disabled config does not start', () => {
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: { ...liveCfg, enabled: false },
      dataProvider: dataProvider(buildSnapshot(new Date(), new Date(), 'healthy')),
      alertSink: sink,
    });
    svc.start();
    expect(svc.isActive()).toBe(false);
  });

  it('start + stop are idempotent', () => {
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(new Date(), new Date(), 'healthy')),
      alertSink: sink,
    });
    svc.start();
    svc.start();
    expect(svc.isActive()).toBe(true);
    svc.stop();
    svc.stop();
    expect(svc.isActive()).toBe(false);
  });
});

describe('TeamHealthWatchdogService — silenceTeam', () => {
  it('silenceTeam suppresses subsequent alerts', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: liveCfg,
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink, bootedAt: booted, clock: () => now,
    });
    svc.silenceTeam('t1', 60 * 60 * 1000);
    await svc.runOnce();
    expect(sink.delivered).toHaveLength(0);
  });
});

describe('TeamHealthWatchdogService — reconfigure', () => {
  it('reconfigure swaps shadowMode flag at runtime', async () => {
    const now = new Date('2026-04-25T19:30:00.000Z');
    const booted = new Date('2026-04-25T08:00:00.000Z');
    const sink = new RecordingSink();
    const svc = new TeamHealthWatchdogService({
      config: { ...liveCfg, shadowMode: true },
      dataProvider: dataProvider(buildSnapshot(now, booted, 'stuck')),
      alertSink: sink, bootedAt: booted, clock: () => now,
    });
    await svc.runOnce();
    expect(sink.delivered).toHaveLength(0);
    svc.reconfigure({ ...liveCfg, shadowMode: false });
    await svc.runOnce();
    expect(sink.delivered).toHaveLength(1);
  });
});

describe('singleton accessor', () => {
  it('round-trips via setTeamHealthWatchdogSingleton', () => {
    const fake = {} as TeamHealthWatchdogService;
    setTeamHealthWatchdogSingleton(fake);
    expect(getTeamHealthWatchdogSingleton()).toBe(fake);
  });
});
