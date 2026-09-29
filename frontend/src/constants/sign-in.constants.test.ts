/**
 * Sign-in Needed Constants Tests
 *
 * @module constants/sign-in.constants.test
 */

import { describe, it, expect } from 'vitest';
import { SIGN_IN_CONSTANTS } from './sign-in.constants';

describe('sign-in.constants', () => {
  it('points the banner at the backend pending-logins endpoint', () => {
    expect(SIGN_IN_CONSTANTS.PENDING_ENDPOINT).toBe('/api/oauth/pending');
  });

  it('polls once a minute with a timeout shorter than the interval', () => {
    expect(SIGN_IN_CONSTANTS.PENDING_POLL_INTERVAL_MS).toBe(60_000);
    expect(SIGN_IN_CONSTANTS.PENDING_REQUEST_TIMEOUT_MS).toBeLessThan(SIGN_IN_CONSTANTS.PENDING_POLL_INTERVAL_MS);
  });

  it('exposes the chip label', () => {
    expect(SIGN_IN_CONSTANTS.CHIP_LABEL).toBe('Sign-in needed');
  });

  it('re-checks harness login state more often than the pending poll, with distinct storage keys', () => {
    expect(SIGN_IN_CONSTANTS.HARNESS_RECHECK_INTERVAL_MS).toBeLessThanOrEqual(SIGN_IN_CONSTANTS.PENDING_POLL_INTERVAL_MS);
    const keys = [
      SIGN_IN_CONSTANTS.DISMISSED_STORAGE_KEY,
      SIGN_IN_CONSTANTS.LOGIN_MARKS_STORAGE_KEY,
      SIGN_IN_CONSTANTS.LAST_STATES_STORAGE_KEY,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
