/**
 * Tests for Trigger page helper utilities.
 *
 * @module components/Triggers/helpers.test
 */

import { formatDate, statusBadgeClass, triggerConfigSummary, triggerActionSummary } from './helpers';
import type { Trigger } from '../../types/trigger.types';

describe('formatDate', () => {
  it('should return em-dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('should return em-dash for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('should format a valid ISO string', () => {
    const result = formatDate('2025-06-15T14:30:00Z');
    expect(result).toBeTruthy();
    expect(result).not.toBe('—');
  });
});

describe('statusBadgeClass', () => {
  it('should return green classes for active', () => {
    expect(statusBadgeClass('active')).toContain('green');
  });

  it('should return yellow classes for paused', () => {
    expect(statusBadgeClass('paused')).toContain('yellow');
  });

  it('should return blue classes for exhausted', () => {
    expect(statusBadgeClass('exhausted')).toContain('blue');
  });

  it('should return red classes for cancelled', () => {
    expect(statusBadgeClass('cancelled')).toContain('red');
  });

  it('should return default classes for unknown status', () => {
    expect(statusBadgeClass('unknown')).toContain('surface-dark');
  });
});

describe('triggerConfigSummary', () => {
  it('should show cron expression for time triggers', () => {
    const trigger = { config: { type: 'time', cronExpression: '0 9 * * 1-5' } } as Trigger;
    expect(triggerConfigSummary(trigger)).toBe('0 9 * * 1-5');
  });

  it('should show event type for signal triggers', () => {
    const trigger = { config: { type: 'signal', eventType: 'agent:idle' } } as Trigger;
    expect(triggerConfigSummary(trigger)).toBe('agent:idle');
  });

  it('should show em-dash for empty time config', () => {
    const trigger = { config: { type: 'time' } } as Trigger;
    expect(triggerConfigSummary(trigger)).toBe('—');
  });
});

describe('triggerActionSummary', () => {
  it('should show message target for sendMessage action', () => {
    const trigger = { action: { sendMessage: { target: '#general', message: 'hi' } } } as Trigger;
    expect(triggerActionSummary(trigger)).toBe('→ #general');
  });

  it('should show Create WorkItem for createWorkItem action', () => {
    const trigger = { action: { createWorkItem: {} } } as unknown as Trigger;
    expect(triggerActionSummary(trigger)).toBe('Create WorkItem');
  });

  it('should return em-dash for empty action', () => {
    const trigger = { action: {} } as Trigger;
    expect(triggerActionSummary(trigger)).toBe('—');
  });
});
