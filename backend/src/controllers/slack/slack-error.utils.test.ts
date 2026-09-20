/**
 * Tests for Slack platform-error reporting.
 *
 * The bug these lock down: Slack answers a scope failure with `needed` and
 * `provided`, and the controller threw both away — the owner of a second
 * install saw "Slack API error: missing_scope" with no way to learn that the
 * answer was `groups:read` (2026-09-19).
 */

import { describeSlackError, isSlackPlatformError } from './slack-error.utils';

/** A Slack SDK platform error with the given body. */
function slackError(data: Record<string, unknown>): Error {
  return Object.assign(new Error('platform error'), { code: 'slack_webapi_platform_error', data });
}

describe('isSlackPlatformError', () => {
  it('recognises the SDK marker and nothing else', () => {
    expect(isSlackPlatformError(slackError({ error: 'missing_scope' }))).toBe(true);
    expect(isSlackPlatformError(new Error('boom'))).toBe(false);
    expect(isSlackPlatformError({ code: 'slack_webapi_platform_error' })).toBe(false);
    expect(isSlackPlatformError(undefined)).toBe(false);
  });
});

describe('describeSlackError', () => {
  it('names the missing scope and says where to add it', () => {
    const out = describeSlackError(
      slackError({ error: 'missing_scope', needed: 'groups:read', provided: 'chat:write,channels:read' }),
    );
    expect(out.error).toBe('Slack API error: missing_scope (needs groups:read)');
    expect(out.needed).toBe('groups:read');
    expect(out.provided).toBe('chat:write,channels:read');
    expect(out.hint).toContain('groups:read');
    expect(out.hint).toMatch(/OAuth & Permissions/);
    expect(out.hint).toMatch(/reinstall/i);
  });

  it('keeps the plain shape for an error Slack did not qualify', () => {
    expect(describeSlackError(slackError({ error: 'channel_not_found' }))).toEqual({
      success: false,
      error: 'Slack API error: channel_not_found',
      slackError: 'channel_not_found',
    });
  });

  it('offers no scope hint for a non-scope error that happens to carry needed', () => {
    const out = describeSlackError(slackError({ error: 'ratelimited', needed: 'x' }));
    expect(out.hint).toBeUndefined();
    expect(out.needed).toBe('x');
  });

  it('falls back to a named unknown rather than undefined', () => {
    expect(describeSlackError(slackError({})).slackError).toBe('unknown_slack_error');
    expect(describeSlackError(new Error('no data')).slackError).toBe('unknown_slack_error');
    expect(describeSlackError(undefined).slackError).toBe('unknown_slack_error');
  });

  it('ignores non-string needed/provided rather than rendering [object Object]', () => {
    const out = describeSlackError(slackError({ error: 'missing_scope', needed: { a: 1 }, provided: 5 }));
    expect(out.error).toBe('Slack API error: missing_scope');
    expect(out.needed).toBeUndefined();
    expect(out.provided).toBeUndefined();
  });
});
