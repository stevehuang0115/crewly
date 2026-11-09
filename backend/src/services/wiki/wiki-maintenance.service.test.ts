/**
 * Tests for WikiMaintenanceService (#1345): the hourly drain + daily
 * rotation/compile scheduler, exercised with fake workers.
 *
 * @module services/wiki/wiki-maintenance.service.test
 */

import { WikiMaintenanceService } from './wiki-maintenance.service.js';
import type { WikiLogRotationService } from './wiki-log-rotation.service.js';
import type { WikiLogCompileService } from './wiki-log-compile.service.js';
import type { WikiQueueDrainService } from './wiki-queue-drain.service.js';
import type { WikiKnowledgeGapsService } from './wiki-knowledge-gaps.service.js';
import { WIKI_LOG_CONSTANTS } from '../../constants.js';

function fakes() {
  const calls = { drain: 0, rotate: [] as string[][], compile: [] as string[][], gaps: [] as string[][] };
  const drain = { drain: jest.fn(async () => { calls.drain++; return { pending: 0, tooYoung: 0, noVault: 0, filed: 0, skipped: 0, failed: 0, deferred: 0, dryRun: false }; }) } as unknown as WikiQueueDrainService;
  const rotation = { rotateAll: jest.fn(async (vaults: string[]) => { calls.rotate.push(vaults); return []; }) } as unknown as WikiLogRotationService;
  const compile = { compileAll: jest.fn(async (vaults: string[]) => { calls.compile.push(vaults); return []; }) } as unknown as WikiLogCompileService;
  const gaps = { compileAll: jest.fn(async (vaults: string[]) => { calls.gaps.push(vaults); return []; }) } as unknown as WikiKnowledgeGapsService;
  return { calls, drain, rotation, compile, gaps };
}

describe('WikiMaintenanceService', () => {
  const vaults = ['/v/a/.crewly/wiki', '/v/b/.crewly/wiki'];
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = Date.parse('2026-10-17T00:00:00.000Z');
    delete process.env[WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH];
  });

  afterEach(() => {
    WikiMaintenanceService.setInstance(null);
    delete process.env[WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH];
  });

  it('first tick drains and runs the daily pass; the next tick within a day only drains', async () => {
    const f = fakes();
    const svc = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, ...f });
    const first = await svc.tick();
    expect(f.calls.drain).toBe(1);
    expect(first.daily?.vaults).toEqual(vaults);
    expect(f.calls.rotate).toEqual([vaults]);
    expect(f.calls.compile).toEqual([vaults]);
    expect(f.calls.gaps).toEqual([vaults]);

    clock += 60 * 60 * 1000;
    const second = await svc.tick();
    expect(f.calls.drain).toBe(2);
    expect(second.skippedDaily).toBe('not_due');
    expect(f.calls.rotate).toHaveLength(1);

    clock += 24 * 60 * 60 * 1000;
    const third = await svc.tick();
    expect(third.daily).toBeDefined();
    expect(f.calls.rotate).toHaveLength(2);
  });

  it('force runs the daily pass even when not due', async () => {
    const f = fakes();
    const svc = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, ...f });
    await svc.tick();
    await svc.tick({ force: true });
    expect(f.calls.rotate).toHaveLength(2);
  });

  it('a failing drain does not stop the daily pass', async () => {
    const f = fakes();
    (f.drain.drain as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    const svc = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, ...f });
    const r = await svc.tick();
    expect(r.drain).toBeNull();
    expect(r.daily).toBeDefined();
  });

  it('passes dryRun through to every worker and does not record the daily pass', async () => {
    const f = fakes();
    const svc = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, dryRun: true, ...f });
    await svc.tick();
    expect(f.drain.drain).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(f.rotation.rotateAll).toHaveBeenCalledWith(vaults, expect.objectContaining({ dryRun: true }));
    expect(f.gaps.compileAll).toHaveBeenCalledWith(vaults, expect.objectContaining({ dryRun: true }));
    expect(f.compile.compileAll).toHaveBeenCalledWith(vaults, expect.objectContaining({ dryRun: true }));
    expect(svc.isDailyDue()).toBe(true);
  });

  it('start() honours the kill switch and is idempotent', () => {
    const f = fakes();
    process.env[WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH] = 'false';
    const off = new WikiMaintenanceService({ statePath: null, ...f });
    expect(off.start()).toBe(false);
    delete process.env[WIKI_LOG_CONSTANTS.MAINTENANCE_ENV_KILL_SWITCH];
    const on = new WikiMaintenanceService({ statePath: null, bootDelayMs: 60_000, ...f });
    try {
      expect(on.start()).toBe(true);
      expect(on.start()).toBe(true);
    } finally {
      on.stop();
    }
    expect(f.calls.drain).toBe(0); // boot delay not elapsed
  });

  it('setInstance stops the previous instance', () => {
    const f = fakes();
    const a = new WikiMaintenanceService({ statePath: null, bootDelayMs: 60_000, ...f });
    const stop = jest.spyOn(a, 'stop');
    a.start();
    WikiMaintenanceService.setInstance(a);
    WikiMaintenanceService.setInstance(null);
    expect(stop).toHaveBeenCalled();
    expect(WikiMaintenanceService.getInstance()).toBeNull();
  });

  it('the boot tick waits at the boot gate before ticking (crewly#1353)', async () => {
    const f = fakes();
    const order: string[] = [];
    const bootGate = jest.fn(async () => { order.push('gate'); return { reduced: true, waitedMs: 1_800_000, reason: 'restore queue still running' }; });
    f.drain.drain = jest.fn(async () => { order.push('drain'); return { pending: 0, tooYoung: 0, noVault: 0, filed: 0, skipped: 0, failed: 0, deferred: 0, dryRun: false }; }) as never;
    const svc = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, bootGate, ...f });
    const result = await svc.bootTick();
    expect(order).toEqual(['gate', 'drain']);
    expect(result.daily?.vaults).toEqual(vaults);
    // A failing gate never blocks the tick.
    const svc2 = new WikiMaintenanceService({ statePath: null, discoverRoots: async () => vaults, now, bootGate: async () => { throw new Error('gate broke'); }, ...fakes() });
    expect((await svc2.bootTick()).drain).not.toBeNull();
  });
});
