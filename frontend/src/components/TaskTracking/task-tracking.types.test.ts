/**
 * Tests for task tracking types and utility functions.
 *
 * @module components/TaskTracking/task-tracking.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  getStatusLabel,
  getStatusClass,
  getLevelInfo,
  deriveGroupState,
  getFilterStatuses,
  formatRelativeTime,
  formatTokens,
  formatCost,
} from './task-tracking.types';
import type { IntentTaskSummary } from './task-tracking.types';

/** Helper to create a task with the given status */
function makeTask(status: string): IntentTaskSummary {
  return {
    id: `task-${status}`,
    messageId: 'msg-1',
    intent: `Task with status ${status}`,
    level: 'L1',
    category: 'test',
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 0,
    totalTokens: 0,
    totalCost: 0,
    assignedSessions: [],
    order: 0,
  };
}

describe('getStatusLabel', () => {
  it('maps classified to Ready', () => {
    expect(getStatusLabel('classified')).toBe('Ready');
  });

  it('maps in_progress to Running', () => {
    expect(getStatusLabel('in_progress')).toBe('Running');
  });

  it('maps completed to Done', () => {
    expect(getStatusLabel('completed')).toBe('Done');
  });

  it('maps failed to Needs attention', () => {
    expect(getStatusLabel('failed')).toBe('Needs attention');
  });

  it('maps cancelled to Stopped', () => {
    expect(getStatusLabel('cancelled')).toBe('Stopped');
  });

  it('maps paused to Paused', () => {
    expect(getStatusLabel('paused')).toBe('Paused');
  });

  it('defaults unknown status to Ready', () => {
    expect(getStatusLabel('unknown')).toBe('Ready');
  });
});

describe('getStatusClass', () => {
  it('maps classified to ready', () => {
    expect(getStatusClass('classified')).toBe('ready');
  });

  it('maps in_progress to running', () => {
    expect(getStatusClass('in_progress')).toBe('running');
  });

  it('maps failed to attention', () => {
    expect(getStatusClass('failed')).toBe('attention');
  });

  it('defaults unknown to ready', () => {
    expect(getStatusClass('unknown')).toBe('ready');
  });
});

describe('getLevelInfo', () => {
  it('returns Quick for L0', () => {
    const info = getLevelInfo('L0');
    expect(info.short).toBe('L0');
    expect(info.full).toBe('L0 Quick');
  });

  it('returns Standard for L1', () => {
    const info = getLevelInfo('L1');
    expect(info.full).toBe('L1 Standard');
  });

  it('returns Complex for L2', () => {
    const info = getLevelInfo('L2');
    expect(info.full).toBe('L2 Complex');
  });

  it('returns raw level for unknown', () => {
    const info = getLevelInfo('L9');
    expect(info.short).toBe('L9');
    expect(info.full).toBe('L9');
  });
});

describe('deriveGroupState', () => {
  it('returns Ready for empty tasks', () => {
    expect(deriveGroupState([])).toBe('Ready');
  });

  it('returns Needs attention if any task is failed', () => {
    expect(deriveGroupState([makeTask('completed'), makeTask('failed')])).toBe('Needs attention');
  });

  it('returns Running if any task is in_progress (no failures)', () => {
    expect(deriveGroupState([makeTask('classified'), makeTask('in_progress')])).toBe('Running');
  });

  it('returns Paused if any task is paused (no failures or in_progress)', () => {
    expect(deriveGroupState([makeTask('classified'), makeTask('paused')])).toBe('Paused');
  });

  it('returns Done if all tasks are completed', () => {
    expect(deriveGroupState([makeTask('completed'), makeTask('completed')])).toBe('Done');
  });

  it('returns Stopped if all tasks are cancelled', () => {
    expect(deriveGroupState([makeTask('cancelled'), makeTask('cancelled')])).toBe('Stopped');
  });

  it('returns Ready if mix of classified and completed', () => {
    expect(deriveGroupState([makeTask('classified'), makeTask('completed')])).toBe('Ready');
  });

  it('prioritizes failed over in_progress', () => {
    expect(deriveGroupState([makeTask('in_progress'), makeTask('failed')])).toBe('Needs attention');
  });
});

describe('getFilterStatuses', () => {
  it('returns empty for all', () => {
    expect(getFilterStatuses('all')).toEqual([]);
  });

  it('returns active statuses', () => {
    expect(getFilterStatuses('active')).toEqual(['classified', 'in_progress', 'paused']);
  });

  it('returns failed for needs_attention', () => {
    expect(getFilterStatuses('needs_attention')).toEqual(['failed']);
  });

  it('returns completed for completed', () => {
    expect(getFilterStatuses('completed')).toEqual(['completed']);
  });
});

describe('formatRelativeTime', () => {
  it('returns "just now" for recent timestamps', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('just now');
  });

  it('returns minutes for timestamps under an hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours for timestamps under a day', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days for timestamps over a day', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });
});

describe('formatTokens', () => {
  it('returns raw number for small counts', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('returns K for thousands', () => {
    expect(formatTokens(15_000)).toBe('15.0K');
  });

  it('returns M for millions', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatCost', () => {
  it('returns dash for zero', () => {
    expect(formatCost(0)).toBe('-');
  });

  it('returns <$0.01 for tiny amounts', () => {
    expect(formatCost(0.005)).toBe('<$0.01');
  });

  it('formats normal amounts as USD', () => {
    expect(formatCost(0.45)).toBe('$0.45');
  });

  it('formats larger amounts', () => {
    expect(formatCost(12.5)).toBe('$12.50');
  });
});
