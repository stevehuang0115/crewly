/**
 * Tests for the unhandled-rejection classifier used by the backend's
 * process-level `unhandledRejection` handler (backend/src/index.ts,
 * registerSignalHandlers).
 *
 * @module utils/unhandled-rejection.test
 */

import { isNonFatalUnhandledRejection, unhandledRejectionMessage } from './unhandled-rejection.utils.js';
import { NON_FATAL_UNHANDLED_REJECTION_PATTERNS, SLACK_PLATFORM_ERROR_PREFIX } from '../constants.js';

describe('unhandledRejectionMessage', () => {
  it('returns the message of an Error', () => {
    expect(unhandledRejectionMessage(new Error('boom'))).toBe('boom');
  });

  it('coerces a non-Error reason to a string', () => {
    expect(unhandledRejectionMessage('plain string')).toBe('plain string');
    expect(unhandledRejectionMessage(42)).toBe('42');
    expect(unhandledRejectionMessage(undefined)).toBe('undefined');
  });
});

describe('isNonFatalUnhandledRejection', () => {
  it('the pattern list contains the Slack platform-error prefix', () => {
    expect(NON_FATAL_UNHANDLED_REJECTION_PATTERNS).toContain(SLACK_PLATFORM_ERROR_PREFIX);
  });

  it.each([
    ['invalid_auth', 'An API error occurred: invalid_auth'],
    ['token_revoked', 'An API error occurred: token_revoked'],
    ['account_inactive', 'An API error occurred: account_inactive'],
  ])('a Slack platform error (%s) is non-fatal — Slack degrades, the backend stays up', (_code, message) => {
    const err = Object.assign(new Error(message), {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: _code },
    });
    expect(isNonFatalUnhandledRejection(err)).toBe(true);
  });

  it.each([
    "Unhandled event 'server explicit disconnect' in state 'connecting'",
    'socket hang up',
    'read ECONNRESET',
  ])('keeps the pre-existing non-fatal patterns: %s', (message) => {
    expect(isNonFatalUnhandledRejection(new Error(message))).toBe(true);
  });

  it('a genuinely unknown rejection stays fatal (the shutdown path is not widened)', () => {
    expect(isNonFatalUnhandledRejection(new Error("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isNonFatalUnhandledRejection(new Error('ENOENT: no such file or directory'))).toBe(false);
    expect(isNonFatalUnhandledRejection('some string reason')).toBe(false);
  });

  it('does not match the Slack error code alone without the SDK prefix', () => {
    // A bare "invalid_auth" thrown by app code is not a Slack SDK rejection;
    // only the SDK's "An API error occurred:" prefix is recognised.
    expect(isNonFatalUnhandledRejection(new Error('invalid_auth'))).toBe(false);
  });
});
