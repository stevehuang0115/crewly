/**
 * Browser Extension Status Constants Tests
 *
 * Verifies threshold values and ordering invariant
 * (ONLINE_THRESHOLD_MS < STALE_THRESHOLD_MS).
 *
 * @module constants/browser-ext-status.constants.test
 */

import { describe, it, expect } from 'vitest';
import { BROWSER_EXT_STATUS } from './browser-ext-status.constants';

describe('browser-ext-status.constants', () => {
  it('should expose ONLINE_THRESHOLD_MS as 30 seconds', () => {
    expect(BROWSER_EXT_STATUS.ONLINE_THRESHOLD_MS).toBe(30_000);
  });

  it('should expose STALE_THRESHOLD_MS as 60 seconds', () => {
    expect(BROWSER_EXT_STATUS.STALE_THRESHOLD_MS).toBe(60_000);
  });

  it('should keep ONLINE threshold strictly below STALE threshold', () => {
    expect(BROWSER_EXT_STATUS.ONLINE_THRESHOLD_MS).toBeLessThan(
      BROWSER_EXT_STATUS.STALE_THRESHOLD_MS,
    );
  });
});
