/**
 * Tests for tier-quality — the send-back rate the quality guard compares (crewly#1173).
 */

import { describe, it, expect } from '@jest/globals';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { baselineBefore, describeStats, isSentBack, judgeGuard, settledItemsOf, statsAfter, statsOf } from './tier-quality.js';

const wi = (id: string, status: string, at: string, over: Partial<WorkItem> = {}): WorkItem =>
  ({ id, target: 'ella', status, createdAt: at, completedAt: at, retryCount: 0, title: id, type: 'delegate', ...over } as unknown as WorkItem);

describe('tier-quality', () => {
  it('counts rejected, failed and retried items as sent back', () => {
    expect(isSentBack(wi('a', 'rejected', '2026-10-01T00:00:00Z'))).toBe(true);
    expect(isSentBack(wi('b', 'failed', '2026-10-01T00:00:00Z'))).toBe(true);
    expect(isSentBack(wi('c', 'verified', '2026-10-01T00:00:00Z', { retryCount: 1 }))).toBe(true);
    expect(isSentBack(wi('d', 'done', '2026-10-01T00:00:00Z'))).toBe(false);
  });

  it('only counts settled items of the member, oldest first', () => {
    const items = [
      wi('late', 'done', '2026-10-03T00:00:00Z'),
      wi('early', 'verified', '2026-10-01T00:00:00Z'),
      wi('running', 'running', '2026-10-02T00:00:00Z'),
      wi('other', 'done', '2026-10-02T00:00:00Z', { target: 'sam' }),
    ];
    expect(settledItemsOf(items, ['ella']).map((x) => x.id)).toEqual(['early', 'late']);
  });

  it('splits before / after a change', () => {
    const at = Date.parse('2026-10-05T00:00:00Z');
    const items = [
      wi('b1', 'done', '2026-10-01T00:00:00Z'),
      wi('b2', 'rejected', '2026-10-02T00:00:00Z'),
      wi('a1', 'rejected', '2026-10-06T00:00:00Z'),
      wi('a2', 'done', '2026-10-07T00:00:00Z'),
    ];
    expect(baselineBefore(items, ['ella'], at)).toEqual({ settled: 2, sentBack: 1, rate: 0.5 });
    expect(statsAfter(items, ['ella'], at)).toEqual({ settled: 2, sentBack: 1, rate: 0.5 });
    expect(baselineBefore(items, ['ella'], at, 1)).toEqual({ settled: 1, sentBack: 1, rate: 1 });
  });

  it('waits for enough items, then judges worse only past the margin', () => {
    const base = { settled: 10, sentBack: 1, rate: 0.1 };
    expect(judgeGuard(base, { settled: 3, sentBack: 3, rate: 1 })).toBe('wait');
    expect(judgeGuard(base, { settled: 5, sentBack: 3, rate: 0.6 })).toBe('worse');
    expect(judgeGuard(base, { settled: 5, sentBack: 1, rate: 0.2 })).toBe('ok');
    // One bad item is not enough even at a high rate
    expect(judgeGuard({ settled: 0, sentBack: 0, rate: null }, { settled: 5, sentBack: 1, rate: 0.2 })).toBe('ok');
  });

  it('describes stats', () => {
    expect(describeStats(statsOf([]))).toBe('none settled');
    expect(describeStats({ settled: 5, sentBack: 3, rate: 0.6 })).toBe('3 of 5 sent back');
  });
});
