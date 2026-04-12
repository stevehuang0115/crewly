/**
 * Tests for request-tracking.types utility functions
 *
 * @module components/RequestTracking/request-tracking.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  getRequestStatusLabel,
  getStatusBadgeType,
  getPriorityBadgeVariant,
  getRequestPriorityLabel,
  getSourceLabel,
  formatRequestTime,
  computeRequestStats,
} from './request-tracking.types';
import type { RequestItem } from './request-tracking.types';

describe('getRequestStatusLabel', () => {
  it('returns correct labels for all statuses', () => {
    expect(getRequestStatusLabel('active')).toBe('Active');
    expect(getRequestStatusLabel('blocked')).toBe('Blocked');
    expect(getRequestStatusLabel('waiting_confirmation')).toBe('Waiting Confirmation');
    expect(getRequestStatusLabel('completed')).toBe('Completed');
  });
});

describe('getStatusBadgeType', () => {
  it('maps request statuses to StatusBadge types', () => {
    expect(getStatusBadgeType('active')).toBe('active');
    expect(getStatusBadgeType('blocked')).toBe('blocked');
    expect(getStatusBadgeType('waiting_confirmation')).toBe('paused');
    expect(getStatusBadgeType('completed')).toBe('completed');
  });
});

describe('getPriorityBadgeVariant', () => {
  it('maps priorities to Badge variants', () => {
    expect(getPriorityBadgeVariant('critical')).toBe('error');
    expect(getPriorityBadgeVariant('high')).toBe('warning');
    expect(getPriorityBadgeVariant('medium')).toBe('info');
    expect(getPriorityBadgeVariant('low')).toBe('default');
  });
});

describe('getRequestPriorityLabel', () => {
  it('returns correct labels', () => {
    expect(getRequestPriorityLabel('critical')).toBe('Critical');
    expect(getRequestPriorityLabel('high')).toBe('High');
    expect(getRequestPriorityLabel('medium')).toBe('Medium');
    expect(getRequestPriorityLabel('low')).toBe('Low');
  });
});

describe('getSourceLabel', () => {
  it('returns capitalized source labels', () => {
    expect(getSourceLabel('slack')).toBe('Slack');
    expect(getSourceLabel('email')).toBe('Email');
    expect(getSourceLabel('chat')).toBe('Chat');
    expect(getSourceLabel('api')).toBe('Api');
    expect(getSourceLabel('manual')).toBe('Manual');
  });
});

describe('formatRequestTime', () => {
  it('returns "just now" for very recent times', () => {
    expect(formatRequestTime(new Date().toISOString())).toBe('just now');
  });

  it('returns minutes ago for < 60 min', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRequestTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago for < 24 hours', () => {
    const threeHrsAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatRequestTime(threeHrsAgo)).toBe('3h ago');
  });

  it('returns days ago for >= 24 hours', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    expect(formatRequestTime(twoDaysAgo)).toBe('2d ago');
  });
});

describe('computeRequestStats', () => {
  it('computes correct statistics', () => {
    const requests: RequestItem[] = [
      { id: '1', title: 'A', status: 'active', priority: 'high', source: 'slack', requester: 'X', updatedAt: new Date().toISOString() },
      { id: '2', title: 'B', status: 'blocked', priority: 'low', source: 'email', requester: 'Y', updatedAt: new Date().toISOString() },
      { id: '3', title: 'C', status: 'waiting_confirmation', priority: 'medium', source: 'chat', requester: 'Z', updatedAt: new Date().toISOString() },
      { id: '4', title: 'D', status: 'active', priority: 'critical', source: 'api', requester: 'W', updatedAt: new Date().toISOString() },
    ];

    const stats = computeRequestStats(requests);
    expect(stats.total).toBe(4);
    expect(stats.active).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.waitingConfirmation).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('handles empty array', () => {
    const stats = computeRequestStats([]);
    expect(stats.total).toBe(0);
    expect(stats.active).toBe(0);
  });
});
