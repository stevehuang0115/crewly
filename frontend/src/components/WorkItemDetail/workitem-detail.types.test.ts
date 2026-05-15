/**
 * WorkItem Detail Types — Unit Tests
 *
 * Tests for type utilities, formatters, and timeline builder.
 *
 * @module components/WorkItemDetail/workitem-detail.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  getWorkItemStatusType,
  getWorkItemStatusLabel,
  getWorkItemTypeBadgeVariant,
  getWorkItemTypeLabel,
  getWorkItemOwnerLabel,
  formatRelativeTime,
  formatTimestamp,
  formatCost,
  formatTokens,
  buildTimeline,
} from './workitem-detail.types';
import type { WorkItem } from './workitem-detail.types';

// =============================================================================
// Fixtures
// =============================================================================

function createTestWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'test-uuid-1234-5678',
    type: 'delegate',
    owner: 'agent',
    target: 'crewly-product-leo',
    title: 'Test WorkItem',
    description: 'Test description',
    status: 'queued',
    createdAt: '2026-04-05T10:00:00.000Z',
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    ...overrides,
  };
}

// =============================================================================
// Tests: Status Mapping
// =============================================================================

describe('getWorkItemStatusType', () => {
  it('maps queued to pending', () => {
    expect(getWorkItemStatusType('queued')).toBe('pending');
  });

  it('maps running to running', () => {
    expect(getWorkItemStatusType('running')).toBe('running');
  });

  it('maps done to completed', () => {
    expect(getWorkItemStatusType('done')).toBe('completed');
  });

  it('maps failed to error', () => {
    expect(getWorkItemStatusType('failed')).toBe('error');
  });

  it('maps blocked to blocked', () => {
    expect(getWorkItemStatusType('blocked')).toBe('blocked');
  });

  it('maps cancelled to inactive', () => {
    expect(getWorkItemStatusType('cancelled')).toBe('inactive');
  });

  it('maps scheduled to paused', () => {
    expect(getWorkItemStatusType('scheduled')).toBe('paused');
  });
});

describe('getWorkItemStatusLabel', () => {
  it('returns human-readable labels', () => {
    expect(getWorkItemStatusLabel('queued')).toBe('Queued');
    expect(getWorkItemStatusLabel('running')).toBe('Running');
    expect(getWorkItemStatusLabel('done')).toBe('Completed');
    expect(getWorkItemStatusLabel('failed')).toBe('Failed');
    expect(getWorkItemStatusLabel('blocked')).toBe('Blocked');
    expect(getWorkItemStatusLabel('cancelled')).toBe('Cancelled');
    expect(getWorkItemStatusLabel('scheduled')).toBe('Scheduled');
  });
});

// =============================================================================
// Tests: Type Mapping
// =============================================================================

describe('getWorkItemTypeBadgeVariant', () => {
  it('maps delegate to primary', () => {
    expect(getWorkItemTypeBadgeVariant('delegate')).toBe('primary');
  });

  it('maps project_task to info', () => {
    expect(getWorkItemTypeBadgeVariant('project_task')).toBe('info');
  });

  it('maps cron_run to warning', () => {
    expect(getWorkItemTypeBadgeVariant('cron_run')).toBe('warning');
  });
});

describe('getWorkItemTypeLabel', () => {
  it('returns human-readable type labels', () => {
    expect(getWorkItemTypeLabel('delegate')).toBe('Delegate');
    expect(getWorkItemTypeLabel('project_task')).toBe('Project Task');
    expect(getWorkItemTypeLabel('cron_run')).toBe('Cron Run');
    expect(getWorkItemTypeLabel('reconcile')).toBe('Reconcile');
  });
});

// =============================================================================
// Tests: Owner Label
// =============================================================================

describe('getWorkItemOwnerLabel', () => {
  it('returns formatted owner labels', () => {
    expect(getWorkItemOwnerLabel('orchestrator')).toBe('Orchestrator');
    expect(getWorkItemOwnerLabel('team_lead')).toBe('Team Lead');
    expect(getWorkItemOwnerLabel('agent')).toBe('Agent');
    expect(getWorkItemOwnerLabel('system')).toBe('System');
  });
});

// =============================================================================
// Tests: Formatters
// =============================================================================

describe('formatRelativeTime', () => {
  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe('just now');
  });

  it('returns minutes ago for short durations', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago for medium durations', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });

  it('returns days ago for long durations', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago');
  });
});

describe('formatTimestamp', () => {
  it('formats a valid ISO date', () => {
    const result = formatTimestamp('2026-04-05T10:30:01.000Z');
    expect(result).toContain('2026');
    expect(result).toContain('04');
    expect(result).toContain('05');
  });

  it('returns input for invalid date', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('formatCost', () => {
  it('returns $0.00 for zero', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('shows 4 decimals for small values', () => {
    expect(formatCost(0.0045)).toBe('$0.0045');
  });

  it('shows 2 decimals for larger values', () => {
    expect(formatCost(1.5)).toBe('$1.50');
  });
});

describe('formatTokens', () => {
  it('returns 0 for zero', () => {
    expect(formatTokens(0)).toBe('0');
  });

  it('returns raw number for small counts', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('formats thousands with K suffix', () => {
    expect(formatTokens(1500)).toBe('1.5K');
  });

  it('formats millions with M suffix', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

// =============================================================================
// Tests: Timeline Builder
// =============================================================================

describe('buildTimeline', () => {
  it('creates a queued event for every item', () => {
    const item = createTestWorkItem();
    const events = buildTimeline(item);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.label === 'QUEUED')).toBe(true);
  });

  it('adds RUNNING event when startedAt is present', () => {
    const item = createTestWorkItem({
      status: 'running',
      startedAt: '2026-04-05T10:01:00.000Z',
    });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'RUNNING')).toBe(true);
  });

  it('adds COMPLETED event for done items', () => {
    const item = createTestWorkItem({
      status: 'done',
      startedAt: '2026-04-05T10:01:00.000Z',
      completedAt: '2026-04-05T10:05:00.000Z',
    });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'COMPLETED')).toBe(true);
  });

  it('adds ERROR event when error is present', () => {
    const item = createTestWorkItem({
      status: 'failed',
      startedAt: '2026-04-05T10:01:00.000Z',
      completedAt: '2026-04-05T10:05:00.000Z',
      error: 'Timeout exceeded',
    });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'ERROR')).toBe(true);
    const errorEvent = events.find((e) => e.label === 'ERROR');
    expect(errorEvent?.detail).toBe('Timeout exceeded');
  });

  it('adds FAILED event for failed items', () => {
    const item = createTestWorkItem({
      status: 'failed',
      startedAt: '2026-04-05T10:01:00.000Z',
      completedAt: '2026-04-05T10:05:00.000Z',
      retryCount: 3,
      maxRetries: 3,
    });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'FAILED')).toBe(true);
  });

  it('adds CANCELLED event for cancelled items', () => {
    const item = createTestWorkItem({ status: 'cancelled' });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'CANCELLED')).toBe(true);
  });

  it('shows the persisted cancelReason in the CANCELLED event detail', () => {
    const item = createTestWorkItem({
      status: 'cancelled',
      cancelReason: 'parent_cascade(WI-123)',
    });
    const events = buildTimeline(item);
    const cancelled = events.find((e) => e.label === 'CANCELLED');
    expect(cancelled?.detail).toBe('Cancelled: parent_cascade(WI-123)');
  });

  it('falls back to a terse "Cancelled (no reason recorded)" detail when cancelReason is missing', () => {
    // Phase 6α follow-up #8: previous fallback included a transitional
    // dev-note about pre-persistence rows. That note has aged out — the
    // current fallback should be a clean, user-facing message.
    const item = createTestWorkItem({ status: 'cancelled' });
    const events = buildTimeline(item);
    const cancelled = events.find((e) => e.label === 'CANCELLED');
    expect(cancelled?.detail).toBe('Cancelled (no reason recorded).');
  });

  it('adds RESULT DATA event when result is present', () => {
    const item = createTestWorkItem({
      status: 'done',
      completedAt: '2026-04-05T10:05:00.000Z',
      result: { output: 'success' },
    });
    const events = buildTimeline(item);
    expect(events.some((e) => e.label === 'RESULT DATA')).toBe(true);
  });

  it('sorts events newest first', () => {
    const item = createTestWorkItem({
      status: 'done',
      startedAt: '2026-04-05T10:01:00.000Z',
      completedAt: '2026-04-05T10:05:00.000Z',
    });
    const events = buildTimeline(item);
    for (let i = 0; i < events.length - 1; i++) {
      const t1 = new Date(events[i].timestamp).getTime();
      const t2 = new Date(events[i + 1].timestamp).getTime();
      expect(t1).toBeGreaterThanOrEqual(t2);
    }
  });
});
