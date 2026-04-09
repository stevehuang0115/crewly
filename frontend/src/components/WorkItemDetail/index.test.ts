/**
 * WorkItem Detail Barrel Export — Unit Tests
 *
 * Verifies that all expected exports are available from the barrel.
 *
 * @module components/WorkItemDetail/index.test
 */

import { describe, it, expect } from 'vitest';
import {
  WorkItemTimeline,
  WorkItemMetrics,
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
} from './index';

describe('WorkItemDetail barrel exports', () => {
  it('exports WorkItemTimeline component', () => {
    expect(WorkItemTimeline).toBeDefined();
    expect(typeof WorkItemTimeline).toBe('function');
  });

  it('exports WorkItemMetrics component', () => {
    expect(WorkItemMetrics).toBeDefined();
    expect(typeof WorkItemMetrics).toBe('function');
  });

  it('exports all type utility functions', () => {
    expect(typeof getWorkItemStatusType).toBe('function');
    expect(typeof getWorkItemStatusLabel).toBe('function');
    expect(typeof getWorkItemTypeBadgeVariant).toBe('function');
    expect(typeof getWorkItemTypeLabel).toBe('function');
    expect(typeof getWorkItemOwnerLabel).toBe('function');
  });

  it('exports all formatter functions', () => {
    expect(typeof formatRelativeTime).toBe('function');
    expect(typeof formatTimestamp).toBe('function');
    expect(typeof formatCost).toBe('function');
    expect(typeof formatTokens).toBe('function');
  });

  it('exports buildTimeline function', () => {
    expect(typeof buildTimeline).toBe('function');
  });
});
