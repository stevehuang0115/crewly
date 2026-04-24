/**
 * ChatApiError unit tests.
 *
 * Focus: envelope parsing + code normalization. The class has no async
 * behavior beyond `Response.json()`, so these tests stay tight.
 *
 * @module api/errors.test
 */

import { describe, it, expect } from 'vitest';
import { ChatApiError, CHAT_API_ERROR_CODES } from './errors';

function mockResponse(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ChatApiError', () => {
  it('parses the canonical { success:false, error:{code,message,details} } envelope', async () => {
    const res = mockResponse(
      {
        success: false,
        error: {
          code: 'agent_already_bound',
          message: 'Agent is already bound to channel ch-abc',
          details: { existingChannelId: 'ch-abc' },
        },
      },
      409,
    );
    const err = await ChatApiError.fromResponse(res);

    expect(err).toBeInstanceOf(ChatApiError);
    expect(err.code).toBe('agent_already_bound');
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe('Agent is already bound to channel ch-abc');
    expect(err.details).toEqual({ existingChannelId: 'ch-abc' });
  });

  it('collapses unknown codes to "unknown_error"', async () => {
    const res = mockResponse(
      { success: false, error: { code: 'something_new', message: 'oops' } },
      418,
    );
    const err = await ChatApiError.fromResponse(res);
    expect(err.code).toBe('unknown_error');
    expect(err.httpStatus).toBe(418);
    expect(err.message).toBe('oops');
  });

  it('falls back when the body is not JSON', async () => {
    const res = new Response('<html>Gateway</html>', { status: 502 });
    const err = await ChatApiError.fromResponse(res);
    expect(err.code).toBe('unknown_error');
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain('502');
  });

  it('falls back when the body has no `error` object', async () => {
    const res = mockResponse({ ok: false }, 500);
    const err = await ChatApiError.fromResponse(res);
    expect(err.code).toBe('unknown_error');
    expect(err.httpStatus).toBe(500);
  });

  it('exposes all canonical error codes for consumer switch-statements', () => {
    // Guard against accidental typos in the constant list.
    expect(CHAT_API_ERROR_CODES).toContain('rate_limited');
    expect(CHAT_API_ERROR_CODES).toContain('validation_error');
    expect(CHAT_API_ERROR_CODES).toContain('channel_archived');
  });
});
