import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
  VerifiedSpotCheckService,
  isSpotCheckCandidate,
  runSpotCheck,
  sampleVerified,
  spotCheckLine,
  type SpotCheckResult,
} from './verified-spot-check.service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00.000Z');

/**
 * A verified WorkItem completed `agoMs` before NOW, with the given evidence.
 *
 * @param id - Id
 * @param agoMs - How long before NOW it completed
 * @param evidence - Its evidence (default: one artifact)
 * @param status - Status (default verified)
 * @returns The WorkItem
 */
function item(id: string, agoMs: number, evidence: unknown = [{ type: 'artifact', path: `/out/${id}.md` }], status = 'verified'): WorkItem {
  return {
    id,
    type: 'delegate',
    status,
    title: `Task ${id}`,
    completedAt: new Date(NOW.getTime() - agoMs).toISOString(),
    output: { summary: 'done', evidence },
  } as unknown as WorkItem;
}

describe('isSpotCheckCandidate', () => {
  it('needs verified, completed within the window, and an artifact', () => {
    expect(isSpotCheckCandidate(item('a', 2 * 3600e3), NOW.getTime(), DAY)).toBe(true);
    expect(isSpotCheckCandidate(item('b', 2 * DAY), NOW.getTime(), DAY)).toBe(false);
    expect(isSpotCheckCandidate(item('c', 3600e3, undefined, 'done'), NOW.getTime(), DAY)).toBe(false);
    expect(isSpotCheckCandidate(item('d', 3600e3, [{ type: 'command', command: 'npm test', exitCode: 0 }]), NOW.getTime(), DAY)).toBe(false);
    expect(isSpotCheckCandidate(item('e', 3600e3, 'nope'), NOW.getTime(), DAY)).toBe(false);
    expect(isSpotCheckCandidate({ ...item('f', 3600e3), completedAt: undefined } as WorkItem, NOW.getTime(), DAY)).toBe(false);
    // Completed "in the future" (clock skew) is not a candidate either.
    expect(isSpotCheckCandidate(item('g', -3600e3), NOW.getTime(), DAY)).toBe(false);
  });
});

describe('sampleVerified', () => {
  it('takes every candidate when there are few, newest first', () => {
    const items = [item('old', 5 * 3600e3), item('new', 3600e3), item('stale', 3 * DAY), item('cmd', 3600e3, [{ type: 'command', command: 'x', exitCode: 0 }])];
    const { candidates, sample } = sampleVerified(items, NOW.getTime(), { windowMs: DAY, sampleSize: 10 });
    expect(candidates.map((c) => c.id)).toEqual(['new', 'old']);
    expect(sample.map((c) => c.id)).toEqual(['new', 'old']);
  });

  it('spreads a larger sample evenly over the window, deterministically', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`w${String(i).padStart(2, '0')}`, (i + 1) * 3600e3));
    const first = sampleVerified(items, NOW.getTime(), { windowMs: DAY, sampleSize: 5 });
    expect(first.candidates).toHaveLength(20);
    expect(first.sample.map((c) => c.id)).toEqual(['w00', 'w04', 'w08', 'w12', 'w16']);
    const again = sampleVerified([...items].reverse(), NOW.getTime(), { windowMs: DAY, sampleSize: 5 });
    expect(again.sample.map((c) => c.id)).toEqual(first.sample.map((c) => c.id));
  });

  it('samples nothing with a sample size of zero', () => {
    expect(sampleVerified([item('a', 3600e3)], NOW.getTime(), { windowMs: DAY, sampleSize: 0 }).sample).toEqual([]);
  });
});

describe('runSpotCheck + spotCheckLine', () => {
  it('collects discrepancies per sampled item and states zero explicitly', async () => {
    const items = [item('ok', 3600e3), item('gone', 2 * 3600e3)];
    const recheck = async (wi: WorkItem) => (wi.id === 'gone' ? [{ artifact: '/out/gone.md', problem: '"/out/gone.md" does not exist' }] : []);
    const result = await runSpotCheck(items, NOW, recheck, { windowMs: DAY, sampleSize: 10 });
    expect(result).toMatchObject({ at: NOW.toISOString(), candidates: 2, sampled: 2 });
    expect(result.discrepancies).toEqual([{ workItemId: 'gone', title: 'Task gone', artifact: '/out/gone.md', problem: '"/out/gone.md" does not exist' }]);
    expect(spotCheckLine(result)).toBe('Spot check: 2 verified item(s) from the last day re-checked, 1 discrepancy\n- gone "Task gone": "/out/gone.md" does not exist');

    const clean = await runSpotCheck([items[0]], NOW, recheck, { windowMs: DAY, sampleSize: 10 });
    expect(spotCheckLine(clean)).toBe('Spot check: 1 verified item(s) from the last day re-checked, 0 discrepancies');
    expect(spotCheckLine({ at: '', candidates: 0, sampled: 0, discrepancies: [] })).toBe('Spot check: 0 verified item(s) from the last day re-checked, 0 discrepancies');
  });

  it('turns a throwing re-check into a discrepancy instead of failing the run', async () => {
    const result = await runSpotCheck([item('boom', 3600e3)], NOW, async () => { throw new Error('disk'); }, { windowMs: DAY, sampleSize: 10 });
    expect(result.discrepancies).toEqual([{ workItemId: 'boom', title: 'Task boom', artifact: '(all)', problem: 're-check failed: disk' }]);
  });

  it('caps the listed discrepancies and counts the rest', () => {
    const result: SpotCheckResult = {
      at: '',
      candidates: 9,
      sampled: 9,
      discrepancies: Array.from({ length: 7 }, (_, i) => ({ workItemId: `w${i}`, title: 'T', artifact: `/a${i}`, problem: 'gone' })),
    };
    const line = spotCheckLine(result);
    expect(line).toContain('7 discrepancies');
    expect(line.split('\n')).toHaveLength(1 + 5 + 1);
    expect(line).toContain('… and 2 more');
  });
});

describe('VerifiedSpotCheckService', () => {
  let root: string;
  let clock: Date;
  let notices: Array<{ title: string; message: string }>;

  /**
   * @param items - The pool
   * @param recheck - Re-check hook
   * @returns A service over a temp state file
   */
  function build(items: WorkItem[], recheck: (wi: WorkItem) => Promise<Array<{ artifact: string; problem: string }>> = async () => []): VerifiedSpotCheckService {
    return new VerifiedSpotCheckService({
      getItems: async () => items,
      recheck,
      notifyOwner: async (n) => {
        notices.push(n);
        return true;
      },
      stateFile: path.join(root, 'spot.json'),
      now: () => clock,
    });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-spot-'));
    clock = NOW;
    notices = [];
  });

  afterEach(async () => {
    VerifiedSpotCheckService.setInstance(null);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('runs once per local day, persists the result, and the digest line reads it back', async () => {
    const svc = build([item('a', 3600e3)]);
    const first = await svc.runIfDue();
    expect(first?.sampled).toBe(1);
    expect(await svc.runIfDue()).toBeNull();
    expect(await svc.digestLine(clock)).toBe('Spot check: 1 verified item(s) from the last day re-checked, 0 discrepancies');
    expect(notices).toEqual([]);

    // A fresh instance over the same state file (a restart) does not re-run today.
    const restarted = build([item('a', 3600e3)]);
    expect(await restarted.runIfDue()).toBeNull();
    expect(await restarted.latest()).toMatchObject({ sampled: 1 });

    // The next day it is due again; yesterday's line is not today's.
    clock = new Date(NOW.getTime() + DAY);
    expect(await restarted.digestLine(clock)).toBeNull();
    expect((await restarted.runIfDue())?.at).toBe(clock.toISOString());
  });

  it('tells the owner at once when a sampled artifact is gone', async () => {
    const svc = build([item('gone', 3600e3)], async () => [{ artifact: '/out/gone.md', problem: '"/out/gone.md" does not exist' }]);
    await svc.runIfDue();
    expect(notices).toEqual([
      {
        title: 'Verified work spot check',
        message: 'Spot check: 1 verified item(s) from the last day re-checked, 1 discrepancy\n- gone "Task gone": "/out/gone.md" does not exist',
        urgent: false,
      },
    ]);
  });

  it('a failing pool read is logged, not thrown, and leaves the day open', async () => {
    const svc = new VerifiedSpotCheckService({
      getItems: async () => { throw new Error('pool locked'); },
      notifyOwner: async () => true,
      stateFile: path.join(root, 'spot.json'),
      now: () => clock,
    });
    expect(await svc.runIfDue()).toBeNull();
    expect(await svc.latest()).toBeNull();
  });

  it('start() schedules and stop() clears without running immediately', () => {
    jest.useFakeTimers();
    try {
      const svc = build([]);
      svc.start();
      svc.start(); // idempotent
      svc.stop();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('holds a process-wide instance', () => {
    const svc = build([]);
    VerifiedSpotCheckService.setInstance(svc);
    expect(VerifiedSpotCheckService.getInstance()).toBe(svc);
  });
});
