/**
 * Tests for google-userinfo.utils — best-effort email fetch with all failure
 * modes suppressed.
 */

import {
  fetchGoogleAccountEmail,
  FetchLike,
} from './google-userinfo.utils.js';

describe('fetchGoogleAccountEmail', () => {
  /** Build a fetch mock whose responder decides what to return. */
  function buildMockFetch(
    responder: (url: string, init?: Parameters<FetchLike>[1]) => {
      ok?: boolean;
      status?: number;
      body?: unknown;
      throwOnFetch?: boolean;
    },
  ): FetchLike & { calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> } {
    const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
    const fn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      const r = responder(url, init);
      if (r.throwOnFetch) throw new Error('network down');
      const status = r.status ?? (r.ok ?? true ? 200 : 500);
      const ok = r.ok ?? (status >= 200 && status < 300);
      const bodyStr =
        typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      return {
        ok,
        status,
        text: async () => bodyStr,
        json: async () => JSON.parse(bodyStr),
      };
    };
    (fn as typeof fn & { calls: typeof calls }).calls = calls;
    return fn as FetchLike & { calls: typeof calls };
  }

  it('returns the email on a 200 response', async () => {
    const fetch = buildMockFetch(() => ({ body: { email: 'a@b.com' } }));
    const email = await fetchGoogleAccountEmail('at-valid', fetch);
    expect(email).toBe('a@b.com');
  });

  it('sends an Authorization Bearer header', async () => {
    const fetch = buildMockFetch(() => ({ body: { email: 'x@y.z' } }));
    await fetchGoogleAccountEmail('at-abc', fetch);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].init?.headers?.Authorization).toBe('Bearer at-abc');
  });

  it('hits the Google userinfo endpoint', async () => {
    const fetch = buildMockFetch(() => ({ body: { email: 'x@y.z' } }));
    await fetchGoogleAccountEmail('at', fetch);
    expect(fetch.calls[0].url).toMatch(/userinfo/);
    expect(new URL(fetch.calls[0].url).hostname).toBe('www.googleapis.com');
  });

  it('returns undefined on a non-200 response', async () => {
    const fetch = buildMockFetch(() => ({ ok: false, status: 401, body: '' }));
    const email = await fetchGoogleAccountEmail('at-bad', fetch);
    expect(email).toBeUndefined();
  });

  it('returns undefined when fetch throws', async () => {
    const fetch = buildMockFetch(() => ({ throwOnFetch: true }));
    const email = await fetchGoogleAccountEmail('at', fetch);
    expect(email).toBeUndefined();
  });

  it('returns undefined when body has no email field', async () => {
    const fetch = buildMockFetch(() => ({ body: { picture: 'url' } }));
    const email = await fetchGoogleAccountEmail('at', fetch);
    expect(email).toBeUndefined();
  });
});
