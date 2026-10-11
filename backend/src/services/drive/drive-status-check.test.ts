/**
 * Tests for the Drive kickoff status check ("let me check with the teams"):
 * the agents holding the owner's open items are asked to bring them up to
 * date, stopped ones are left alone, then the snapshot is rebuilt.
 */

import { DriveStatusCheck, statusCheckText, type StatusCheckTarget } from './drive-status-check.js';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;

function setup(targets: StatusCheckTarget[], running: string[], over: { nudge?: (s: string, t: string) => Promise<boolean>; rebuild?: () => Promise<void> } = {}) {
  const order: string[] = [];
  const nudged: Array<{ session: string; text: string }> = [];
  const check = new DriveStatusCheck({
    targets: async () => targets,
    isRunning: (s) => running.includes(s),
    nudge: over.nudge ?? (async (session, text) => {
      order.push(`nudge:${session}`);
      nudged.push({ session, text });
      return true;
    }),
    rebuild: over.rebuild ?? (async () => void order.push('rebuild')),
    sleep: async (ms) => void order.push(`wait:${ms}`),
    waitMs: 5,
    maxAgents: 2,
    logger,
  });
  return { check, order, nudged };
}

const target = (agentSession: string, n: number): StatusCheckTarget => ({ agentSession, agentName: agentSession, items: Array.from({ length: n }, (_, i) => `ticket TKT-${i}: thing ${i}`) });

describe('DriveStatusCheck', () => {
  it('asks running agents, waits, then rebuilds - in that order', async () => {
    const { check, order, nudged } = setup([target('ella', 1), target('max', 2)], ['ella', 'max']);
    expect(await check.run()).toEqual({ asked: 2, skippedStopped: 0 });
    expect(order.slice(-2)).toEqual(['wait:5', 'rebuild']);
    expect(nudged).toHaveLength(2);
  });

  it('does not wake stopped agents, and asks only the busiest few', async () => {
    const { check, nudged } = setup([target('a', 1), target('b', 3), target('c', 2), target('d', 5)], ['a', 'b', 'c']);
    const out = await check.run();
    expect(out).toEqual({ asked: 2, skippedStopped: 1 });
    expect(nudged.map((n) => n.session).sort()).toEqual(['b', 'c']);
  });

  it('with nobody to ask it just rebuilds, without waiting', async () => {
    const { check, order } = setup([target('a', 1)], []);
    await check.run();
    expect(order).toEqual(['rebuild']);
  });

  it('a failing nudge or target read never stops the rebuild', async () => {
    const failing = setup([target('a', 1)], ['a'], { nudge: async () => Promise.reject(new Error('down')) });
    expect((await failing.check.run()).asked).toBe(0);
    expect(failing.order).toEqual(['rebuild']);
    const rebuilt = jest.fn(async () => undefined);
    const broken = new DriveStatusCheck({ targets: async () => Promise.reject(new Error('x')), isRunning: () => true, nudge: async () => true, rebuild: rebuilt, sleep: async () => undefined, logger });
    await broken.run();
    expect(rebuilt).toHaveBeenCalledTimes(1);
  });

  it('calls made while a check runs share it', async () => {
    const rebuild = jest.fn(async () => undefined);
    const { check } = setup([target('a', 1)], ['a'], { rebuild });
    await Promise.all([check.run(), check.run()]);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });
});

describe('statusCheckText', () => {
  it('tells the agent to update state, not to message the owner', () => {
    const text = statusCheckText(['ticket TKT-4: redo the intro']);
    expect(text).toContain('- ticket TKT-4: redo the intro');
    expect(text).toMatch(/already done or shipped, close it/);
    expect(text).toMatch(/Do not message the owner/);
  });
});
