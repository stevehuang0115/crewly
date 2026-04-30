/**
 * Browser Instance Status Helper Tests
 *
 * Covers all four branches of `getInstanceStatus`:
 *   1. missing `lastSeenAt` → 'offline'
 *   2. just-now → 'online'
 *   3. ~45s ago → 'stale'
 *   4. >> 60s ago → 'offline'
 *   plus malformed string → 'offline'
 *   plus boundary semantics at 30s and 60s
 *
 * @module utils/browser-instance-status.test
 */

import { describe, it, expect } from 'vitest';
import { getInstanceStatus } from './browser-instance-status';
import { BROWSER_EXT_STATUS } from '../constants/browser-ext-status.constants';

describe('getInstanceStatus', () => {
  // Pin a deterministic clock so the tests don't depend on wall time.
  const NOW = new Date('2026-04-30T12:00:00Z');

  /**
   * Build an ISO timestamp `ageMs` milliseconds before NOW.
   */
  const isoAgeMs = (ageMs: number): string =>
    new Date(NOW.getTime() - ageMs).toISOString();

  it('returns "offline" when lastSeenAt is undefined', () => {
    expect(getInstanceStatus(undefined, NOW)).toBe('offline');
  });

  it('returns "offline" when lastSeenAt is malformed', () => {
    expect(getInstanceStatus('not-a-date', NOW)).toBe('offline');
  });

  it('returns "online" for a just-now timestamp', () => {
    expect(getInstanceStatus(NOW.toISOString(), NOW)).toBe('online');
  });

  it('returns "online" at the ONLINE_THRESHOLD_MS boundary (≤30s)', () => {
    const atBoundary = isoAgeMs(BROWSER_EXT_STATUS.ONLINE_THRESHOLD_MS);
    expect(getInstanceStatus(atBoundary, NOW)).toBe('online');
  });

  it('returns "stale" for ~45s ago (between 30s and 60s)', () => {
    expect(getInstanceStatus(isoAgeMs(45_000), NOW)).toBe('stale');
  });

  it('returns "stale" at the STALE_THRESHOLD_MS boundary (≤60s)', () => {
    const atBoundary = isoAgeMs(BROWSER_EXT_STATUS.STALE_THRESHOLD_MS);
    expect(getInstanceStatus(atBoundary, NOW)).toBe('stale');
  });

  it('returns "offline" for ~5min ago', () => {
    expect(getInstanceStatus(isoAgeMs(5 * 60 * 1000), NOW)).toBe('offline');
  });

  it('returns "offline" just past the 60s boundary', () => {
    const justPast = isoAgeMs(BROWSER_EXT_STATUS.STALE_THRESHOLD_MS + 1);
    expect(getInstanceStatus(justPast, NOW)).toBe('offline');
  });

  it('treats future timestamps (clock skew) as "online"', () => {
    const future = new Date(NOW.getTime() + 5_000).toISOString();
    expect(getInstanceStatus(future, NOW)).toBe('online');
  });

  it('uses new Date() as the default reference time', () => {
    // Without injecting `now`, a just-built timestamp must still be online.
    expect(getInstanceStatus(new Date().toISOString())).toBe('online');
  });
});
