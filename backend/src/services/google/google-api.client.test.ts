/**
 * Tests for the Google API client — bearer/headers, URL building, and the
 * mapping of Google failures (401 drops the token cache).
 *
 * @module services/google/google-api.client.test
 */

import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';

function response(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

let fetchMock: jest.Mock;
let clearCache: jest.Mock;
let deps: GoogleApiDeps;

beforeEach(() => {
  fetchMock = jest.fn();
  clearCache = jest.fn();
  deps = {
    tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache },
    fetchImpl: fetchMock as unknown as typeof fetch,
  };
});

describe('buildGoogleUrl', () => {
  it('skips undefined/empty values and repeats array values', () => {
    const url = buildGoogleUrl('https://g/api', { q: 'is:unread', max: 5, skip: undefined, empty: '', h: ['A', 'B'] });
    expect(url).toBe('https://g/api?q=is%3Aunread&max=5&h=A&h=B');
  });
});

describe('googleRequest', () => {
  it('sends the access token as Bearer, JSON body on POST, and parses the response', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { id: '1' }));
    await expect(googleRequest(deps, 'https://g/x', { method: 'POST', body: { raw: 'abc' } })).resolves.toEqual({ id: '1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://g/x');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer ya29.tok', Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"raw":"abc"}');
  });

  it('defaults to GET without a Content-Type and returns {} on an empty body', async () => {
    fetchMock.mockResolvedValueOnce(response(200, ''));
    await expect(googleRequest(deps, 'https://g/x')).resolves.toEqual({});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer ya29.tok', Accept: 'application/json' });
    expect(init.body).toBeUndefined();
  });

  it('sends a raw body with its content type and can return the body as text (Drive export / upload)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'a,b\n1,2' });
    await expect(
      googleRequest(deps, 'https://g/export', { method: 'PUT', rawBody: Buffer.from('bytes'), contentType: 'multipart/related; boundary=x', responseType: 'text' }),
    ).resolves.toBe('a,b\n1,2');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ Authorization: 'Bearer ya29.tok', Accept: '*/*', 'Content-Type': 'multipart/related; boundary=x' });
    expect(init.body).toEqual(Buffer.from('bytes'));
  });

  it('drops the cached token on a Google 401 and reports it as 401 google_error', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { error: { code: 401, message: 'Invalid Credentials' } }));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({
      status: 401,
      code: 'google_error',
      message: 'Google rejected the access token: Invalid Credentials',
    });
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it('passes 403/404/429 through and folds other failures into 502', async () => {
    fetchMock.mockResolvedValueOnce(response(404, { error: { message: 'Requested entity was not found.' } }));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({ status: 404, message: 'Requested entity was not found.' });

    fetchMock.mockResolvedValueOnce(response(500, 'boom'));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({ status: 502, code: 'google_error', message: 'boom' });
    expect(clearCache).not.toHaveBeenCalled();
  });

  it('propagates token-service failures without calling Google', async () => {
    (deps.tokens.getAccessToken as jest.Mock).mockRejectedValueOnce(new GoogleWorkspaceError(409, 'not_connected', 'nope'));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({ status: 409, code: 'not_connected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an unreachable Google to 502 network and non-JSON to 502 google_error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({ status: 502, code: 'network' });

    fetchMock.mockResolvedValueOnce(response(200, '<html>'));
    await expect(googleRequest(deps, 'https://g/x')).rejects.toMatchObject({ status: 502, code: 'google_error' });
  });
});

describe('account and product plumbing', () => {
  // A service is bound to one Google account and one product; every request
  // it makes must carry both, or a Drive call could be served a token that
  // only covers Calendar and fail at Google with an opaque 403.
  it('passes the bound account and product to the token service', async () => {
    const getAccessToken = jest.fn().mockResolvedValue('ya29.tok');
    const bound = {
      tokens: { getAccessToken, clearCache: jest.fn() },
      fetchImpl: jest.fn().mockResolvedValue(response(200, '{}')) as unknown as typeof fetch,
      product: 'drive' as const,
      account: 'work@company.com',
    };
    await googleRequest(bound, 'https://g/x');
    expect(getAccessToken).toHaveBeenCalledWith({ account: 'work@company.com', product: 'drive' });
  });

  it('asks for the default account when none is bound', async () => {
    const getAccessToken = jest.fn().mockResolvedValue('ya29.tok');
    const unbound = {
      tokens: { getAccessToken, clearCache: jest.fn() },
      fetchImpl: jest.fn().mockResolvedValue(response(200, '{}')) as unknown as typeof fetch,
    };
    await googleRequest(unbound, 'https://g/x');
    expect(getAccessToken).toHaveBeenCalledWith({});
  });

  it('drops only the bound account\'s cached token on a 401', async () => {
    const clearOne = jest.fn();
    const bound = {
      tokens: { getAccessToken: jest.fn().mockResolvedValue('ya29.tok'), clearCache: clearOne },
      fetchImpl: jest.fn().mockResolvedValue(response(401, '{}')) as unknown as typeof fetch,
      account: 'work@company.com',
    };
    await expect(googleRequest(bound, 'https://g/x')).rejects.toMatchObject({ status: 401 });
    expect(clearOne).toHaveBeenCalledWith('work@company.com');
  });
});
