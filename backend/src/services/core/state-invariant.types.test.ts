/**
 * Tests for state-invariant types.
 *
 * @module services/core/state-invariant.types.test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  StateInvariantViolation,
  FORCE_EMPTY_BOOT_ENV,
  isForceEmptyBootActive,
} from './state-invariant.types.js';

describe('StateInvariantViolation', () => {
  it('exposes currentTeamCount, backupTeamCount, backupTimestamp directly on the instance', () => {
    const err = new StateInvariantViolation('refusing to boot', {
      currentTeamCount: 0,
      backupTeamCount: 7,
      backupTimestamp: '2026-05-03T14:46:00.000Z',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StateInvariantViolation);
    expect(err.name).toBe('StateInvariantViolation');
    expect(err.message).toBe('refusing to boot');
    expect(err.currentTeamCount).toBe(0);
    expect(err.backupTeamCount).toBe(7);
    expect(err.backupTimestamp).toBe('2026-05-03T14:46:00.000Z');
  });

  it('preserves a null backupTimestamp', () => {
    const err = new StateInvariantViolation('x', {
      currentTeamCount: 0,
      backupTeamCount: 3,
      backupTimestamp: null,
    });
    expect(err.backupTimestamp).toBeNull();
  });
});

describe('isForceEmptyBootActive', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env[FORCE_EMPTY_BOOT_ENV];
    delete process.env[FORCE_EMPTY_BOOT_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[FORCE_EMPTY_BOOT_ENV];
    } else {
      process.env[FORCE_EMPTY_BOOT_ENV] = originalEnv;
    }
  });

  it('returns false when env var is unset', () => {
    expect(isForceEmptyBootActive()).toBe(false);
  });

  it('returns false for empty string', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = '';
    expect(isForceEmptyBootActive()).toBe(false);
  });

  it('returns true for "1"', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = '1';
    expect(isForceEmptyBootActive()).toBe(true);
  });

  it('returns true for "true" (case-insensitive)', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = 'TRUE';
    expect(isForceEmptyBootActive()).toBe(true);
  });

  it('returns true for "yes"', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = 'yes';
    expect(isForceEmptyBootActive()).toBe(true);
  });

  it('returns false for "0" / "false" / arbitrary string', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = '0';
    expect(isForceEmptyBootActive()).toBe(false);
    process.env[FORCE_EMPTY_BOOT_ENV] = 'false';
    expect(isForceEmptyBootActive()).toBe(false);
    process.env[FORCE_EMPTY_BOOT_ENV] = 'maybe';
    expect(isForceEmptyBootActive()).toBe(false);
  });

  it('trims whitespace before evaluating', () => {
    process.env[FORCE_EMPTY_BOOT_ENV] = '  1  ';
    expect(isForceEmptyBootActive()).toBe(true);
  });
});
