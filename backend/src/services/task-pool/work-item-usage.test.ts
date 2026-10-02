/**
 * Tests for computeWorkItemUsage (#812): a WorkItem's cost is the session's
 * usage while that item ran, not the session's cumulative total.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { TokenUsageService } from '../monitoring/token-usage.service.js';
import { computeWorkItemUsage } from './work-item-usage.js';

describe('computeWorkItemUsage (#812)', () => {
  let dir: string;
  let svc: TokenUsageService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-usage-'));
    svc = new TokenUsageService(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records only the usage between start and completion, not the cumulative session total', () => {
    const session = 'team-ella';
    // Earlier tasks in the same session: a large cumulative baseline.
    svc.recordUsage(session, 'ella', 900_000, 300_000, 'claude-sonnet-4-5', undefined, { timestamp: '2026-09-25T08:00:00.000Z' });
    // The task itself.
    svc.recordUsage(session, 'ella', 1_000, 500, 'claude-sonnet-4-5', undefined, { timestamp: '2026-09-25T12:03:00.000Z' });
    // After the task completed (the next task).
    svc.recordUsage(session, 'ella', 7_000, 2_000, 'claude-sonnet-4-5', undefined, { timestamp: '2026-09-25T13:02:00.000Z' });

    const usage = computeWorkItemUsage(
      { createdAt: '2026-09-25T11:59:00.000Z', startedAt: '2026-09-25T12:00:00.000Z', completedAt: '2026-09-25T12:07:00.000Z' },
      session,
      svc,
    );

    expect(usage).not.toBeNull();
    expect(usage!.inputTokens).toBe(1_000);
    expect(usage!.outputTokens).toBe(500);

    const cumulative = svc.getUsageBySessions().find((s) => s.sessionName === session)!;
    expect(usage!.cost).toBeGreaterThan(0);
    expect(usage!.cost).toBeLessThan(cumulative.cost);
  });

  it('falls back to createdAt when the item never recorded startedAt, and to now when not completed', () => {
    const calls: Array<[string, Date, Date | undefined]> = [];
    const source = {
      getSessionUsageSince: (s: string, since: Date, until?: Date) => {
        calls.push([s, since, until]);
        return { inputTokens: 1, outputTokens: 2, cost: 0.5 };
      },
    };
    const now = new Date('2026-09-25T12:30:00.000Z');
    const usage = computeWorkItemUsage({ createdAt: '2026-09-25T12:00:00.000Z' }, 'sess', source, now);
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2, cost: 0.5 });
    expect(calls[0][1].toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(calls[0][2]).toEqual(now);
  });

  it('returns null for an unusable window', () => {
    const source = { getSessionUsageSince: () => ({ inputTokens: 9, outputTokens: 9, cost: 9 }) };
    expect(computeWorkItemUsage({ createdAt: 'not a date' }, 's', source)).toBeNull();
    expect(computeWorkItemUsage(
      { createdAt: '2026-09-25T12:00:00.000Z', completedAt: '2026-09-25T11:00:00.000Z' }, 's', source,
    )).toBeNull();
  });
});
