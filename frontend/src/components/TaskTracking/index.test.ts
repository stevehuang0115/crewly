/**
 * Tests for TaskTracking index exports — V3
 *
 * @module components/TaskTracking/index.test
 */

import { describe, it, expect } from 'vitest';
import { TaskList, TaskRow, TaskSummaryBar, TaskFilters, MessageGroupCard } from './index';

describe('TaskTracking index', () => {
  it('exports TaskList', () => {
    expect(TaskList).toBeDefined();
    expect(typeof TaskList).toBe('function');
  });

  it('exports TaskRow', () => {
    expect(TaskRow).toBeDefined();
    expect(typeof TaskRow).toBe('function');
  });

  it('exports TaskSummaryBar', () => {
    expect(TaskSummaryBar).toBeDefined();
    expect(typeof TaskSummaryBar).toBe('function');
  });

  it('exports TaskFilters', () => {
    expect(TaskFilters).toBeDefined();
    expect(typeof TaskFilters).toBe('function');
  });

  it('exports MessageGroupCard', () => {
    expect(MessageGroupCard).toBeDefined();
    expect(typeof MessageGroupCard).toBe('function');
  });
});
