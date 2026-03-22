/**
 * Tests for Unified Scheduler type validators and constants.
 */

import { describe, it, expect } from 'vitest';
import {
  UNIFIED_SCHEDULER_CONSTANTS,
  VALID_SCHEDULE_TYPES,
  isValidCronExpression,
  validateCreateRequest,
} from './unified-scheduler.types.js';

describe('UNIFIED_SCHEDULER_CONSTANTS', () => {
  it('eval interval is 60 seconds', () => {
    expect(UNIFIED_SCHEDULER_CONSTANTS.EVAL_INTERVAL_MS).toBe(60_000);
  });

  it('default max consecutive is 10', () => {
    expect(UNIFIED_SCHEDULER_CONSTANTS.DEFAULT_MAX_CONSECUTIVE).toBe(10);
  });
});

describe('VALID_SCHEDULE_TYPES', () => {
  it('contains cron, interval, idle', () => {
    expect(VALID_SCHEDULE_TYPES.has('cron')).toBe(true);
    expect(VALID_SCHEDULE_TYPES.has('interval')).toBe(true);
    expect(VALID_SCHEDULE_TYPES.has('idle')).toBe(true);
  });

  it('does not contain invalid types', () => {
    expect(VALID_SCHEDULE_TYPES.has('once')).toBe(false);
    expect(VALID_SCHEDULE_TYPES.has('daily')).toBe(false);
  });
});

describe('isValidCronExpression', () => {
  it('accepts valid 5-field cron', () => {
    expect(isValidCronExpression('0 8 * * *')).toBe(true);
    expect(isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(isValidCronExpression('0 8,14,20 * * *')).toBe(true);
    expect(isValidCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isValidCronExpression('30 */2 * * *')).toBe(true);
  });

  it('rejects invalid expressions', () => {
    expect(isValidCronExpression('not-a-cron')).toBe(false);
    expect(isValidCronExpression('0 8 * *')).toBe(false); // 4 fields
    expect(isValidCronExpression('0 8 * * * *')).toBe(false); // 6 fields
    expect(isValidCronExpression('')).toBe(false);
  });
});

describe('validateCreateRequest', () => {
  const validCron = { target: 'session', type: 'cron' as const, cron: '0 8 * * *', message: 'hi' };
  const validInterval = { target: 'session', type: 'interval' as const, intervalMinutes: 30, message: 'hi' };
  const validIdle = { target: 'session', type: 'idle' as const, idleTimeoutMinutes: 15, message: 'hi' };

  it('returns null for valid cron request', () => {
    expect(validateCreateRequest(validCron)).toBeNull();
  });

  it('returns null for valid interval request', () => {
    expect(validateCreateRequest(validInterval)).toBeNull();
  });

  it('returns null for valid idle request', () => {
    expect(validateCreateRequest(validIdle)).toBeNull();
  });

  it('returns error for missing target', () => {
    expect(validateCreateRequest({ ...validCron, target: '' })).toContain('target');
  });

  it('returns error for missing message', () => {
    expect(validateCreateRequest({ ...validCron, message: '' })).toContain('message');
  });

  it('returns error for invalid type', () => {
    expect(validateCreateRequest({ ...validCron, type: 'invalid' as any })).toContain('type');
  });

  it('returns error for missing cron field', () => {
    expect(validateCreateRequest({ target: 'x', type: 'cron', message: 'hi' })).toContain('cron');
  });

  it('returns error for invalid cron expression', () => {
    expect(validateCreateRequest({ ...validCron, cron: 'bad' })).toContain('Invalid cron');
  });

  it('returns error for missing intervalMinutes', () => {
    expect(validateCreateRequest({ target: 'x', type: 'interval', message: 'hi' })).toContain('intervalMinutes');
  });

  it('returns error for negative intervalMinutes', () => {
    expect(validateCreateRequest({ ...validInterval, intervalMinutes: -1 })).toContain('intervalMinutes');
  });

  it('returns error for missing idleTimeoutMinutes', () => {
    expect(validateCreateRequest({ target: 'x', type: 'idle', message: 'hi' })).toContain('idleTimeoutMinutes');
  });
});
