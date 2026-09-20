/**
 * Tests for GoogleWorkspaceTokenService — Cloud `/token` over a fake fetch,
 * the 60 s-margin cache, single in-flight refresh, error mapping, status,
 * disconnect and the connect URL.
 *
 * @module services/google/google-workspace-token.service.test
 */

import {
  GoogleWorkspaceTokenService,
  GoogleWorkspaceError,
  mapCloudFailure,
} from './google-workspace-token.service.js';
import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

const T0 = 1_800_000_000_000;
const CLOUD_URL = 'https://api.crewlyai.com/';
const PREFIX = 'https://api.crewlyai.com/api/cloud/google/workspace';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function tokenBody(accessToken: string, expiresInMs: number, now = T0) {
  return {
    success: true,
    data: { accessToken, expiresAt: new Date(now + expiresInMs).toISOString(), scopes: ['gmail.readonly'], email: 'owner@example.com' },
  };
}

let fetchMock: jest.Mock;
let now: number;
let cloud: { connected: boolean; token: string | null; url: string | null };
let service: GoogleWorkspaceTokenService;

beforeEach(() => {
  fetchMock = jest.fn();
  now = T0;
  cloud = { connected: true, token: 'cloud-jwt', url: CLOUD_URL };
  service = new GoogleWorkspaceTokenService({
    cloud: {
      isConnected: () => cloud.connected,
      getToken: () => cloud.token,
      getCloudUrl: () => cloud.url,
    },
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => now,
  });
});

afterEach(() => {
  GoogleWorkspaceTokenService.resetInstance();
});

describe('getAccessToken', () => {
  it('calls Cloud /token with the Cloud session JWT as Bearer and returns the access token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(tokenBody('ya29.first', 3600_000)));

    await expect(service.getAccessToken()).resolves.toBe('ya29.first');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PREFIX}/token`);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cloud-jwt');
  });

  it('serves the cached token until 60 s before expiry, then refreshes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.first', 3600_000)))
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.second', 3600_000, T0 + 3600_000)));

    await service.getAccessToken();
    now = T0 + 3600_000 - GOOGLE_WORKSPACE_CONSTANTS.TOKEN_REFRESH_MARGIN_MS - 1;
    await expect(service.getAccessToken()).resolves.toBe('ya29.first');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now = T0 + 3600_000 - GOOGLE_WORKSPACE_CONSTANTS.TOKEN_REFRESH_MARGIN_MS;
    await expect(service.getAccessToken()).resolves.toBe('ya29.second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares a single in-flight refresh between concurrent callers', async () => {
    let resolveFetch: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    const a = service.getAccessToken();
    const b = service.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(tokenBody('ya29.shared', 3600_000)));
    await expect(Promise.all([a, b])).resolves.toEqual(['ya29.shared', 'ya29.shared']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes again after clearCache()', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.first', 3600_000)))
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.second', 3600_000)));

    await service.getAccessToken();
    service.clearCache();
    await expect(service.getAccessToken()).resolves.toBe('ya29.second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an unparseable expiresAt as already stale', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { accessToken: 'ya29.x', expiresAt: 'soon' } }))
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.y', 3600_000)));

    await expect(service.getAccessToken()).resolves.toBe('ya29.x');
    await expect(service.getAccessToken()).resolves.toBe('ya29.y');
  });

  it('throws not_logged_in (401) without calling Cloud when there is no Cloud session', async () => {
    cloud.connected = false;
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 401, code: 'not_logged_in' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps Cloud 404 not_connected to a 409 not_connected error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_connected', code: 'not_connected' }, 404));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 409, code: 'not_connected' });
  });

  it('maps Cloud 409 grant_revoked to not_connected and drops the cache', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.first', 3600_000)))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: 'grant_revoked', code: 'grant_revoked' }, 409))
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.again', 3600_000)));

    await service.getAccessToken();
    service.clearCache();
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 409, code: 'not_connected' });
    // Cache was dropped by the failure: the next call goes back to Cloud.
    await expect(service.getAccessToken()).resolves.toBe('ya29.again');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps Cloud 503 not_configured to 503 and 502 google_error to 502', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_configured', code: 'not_configured' }, 503));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 503, code: 'not_configured' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'google_error', code: 'google_error' }, 502));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 502, code: 'google_error' });
  });

  it('maps a Cloud 401 to not_logged_in and a network failure to network', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'Unauthorized' }, 401));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 401, code: 'not_logged_in' });

    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await service.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleWorkspaceError);
    expect(err).toMatchObject({ status: 502, code: 'network' });
  });

  it('rejects a success envelope with no accessToken', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 502, code: 'google_error' });
  });
});

describe('multiple Google accounts and per-product grants', () => {
  /** A Cloud /token payload. */
  function tokenPayload(over: Record<string, unknown> = {}) {
    return jsonResponse({
      success: true,
      data: {
        accessToken: 'ya29.default',
        expiresAt: new Date(T0 + 3_600_000).toISOString(),
        email: 'first@gmail.com',
        products: ['gmail', 'calendar', 'drive'],
        ...over,
      },
    });
  }

  it('caches a token per Google account instead of letting the second evict the first', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenPayload({ accessToken: 'tok-first', email: 'first@gmail.com' }))
      .mockResolvedValueOnce(tokenPayload({ accessToken: 'tok-second', email: 'second@gmail.com' }));

    expect(await service.getAccessToken({ account: 'first@gmail.com' })).toBe('tok-first');
    expect(await service.getAccessToken({ account: 'second@gmail.com' })).toBe('tok-second');
    // Both are now cached: neither needs another round-trip.
    expect(await service.getAccessToken({ account: 'first@gmail.com' })).toBe('tok-first');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks Cloud for the named account and product', async () => {
    fetchMock.mockResolvedValueOnce(tokenPayload());
    await service.getAccessToken({ account: 'second@gmail.com', product: 'drive' });
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain(`${PREFIX}/token?`);
    expect(url).toContain('email=second%40gmail.com');
    expect(url).toContain('product=drive');
  });

  it('sends no query at all for the default account, so an older Cloud still answers', async () => {
    fetchMock.mockResolvedValueOnce(tokenPayload());
    await service.getAccessToken();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${PREFIX}/token`);
  });

  it('refuses a cached token for a product the grant does not cover', async () => {
    fetchMock.mockResolvedValueOnce(tokenPayload({ products: ['calendar'] }));
    expect(await service.getAccessToken({ product: 'calendar' })).toBe('ya29.default');
    // Served from cache — and still refused, rather than handed to Drive to
    // fail at Google with an opaque 403.
    await expect(service.getAccessToken({ product: 'drive' })).rejects.toMatchObject({ code: 'not_connected' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears one account without disturbing the other', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenPayload({ accessToken: 'tok-first', email: 'first@gmail.com' }))
      .mockResolvedValueOnce(tokenPayload({ accessToken: 'tok-second', email: 'second@gmail.com' }))
      .mockResolvedValueOnce(tokenPayload({ accessToken: 'tok-first-2', email: 'first@gmail.com' }));
    await service.getAccessToken({ account: 'first@gmail.com' });
    await service.getAccessToken({ account: 'second@gmail.com' });

    service.clearCache('first@gmail.com');
    expect(await service.getAccessToken({ account: 'first@gmail.com' })).toBe('tok-first-2');
    expect(await service.getAccessToken({ account: 'second@gmail.com' })).toBe('tok-second');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('builds a consent URL for just the products asked for, with a login hint', () => {
    const url = new URL(
      service.buildConnectUrl('https://dash.example/connections', {
        products: ['calendar'],
        loginHint: 'second@gmail.com',
      }),
    );
    expect(url.searchParams.get('products')).toBe('calendar');
    expect(url.searchParams.get('loginHint')).toBe('second@gmail.com');
    expect(url.searchParams.get('returnUrl')).toBe('https://dash.example/connections');
  });

  it('omits products and loginHint when none were given', () => {
    const url = new URL(service.buildConnectUrl('https://dash.example/connections'));
    expect(url.searchParams.has('products')).toBe(false);
    expect(url.searchParams.has('loginHint')).toBe(false);
  });

  it('disconnects one named account', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { removed: true } }));
    await service.disconnect({ account: 'second@gmail.com' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${PREFIX}?email=second%40gmail.com`);
  });
});

describe('status', () => {
  it('reports cloudConnected:false without a Cloud round-trip when not signed in', async () => {
    cloud.token = null;
    await expect(service.status()).resolves.toEqual({ connected: false, cloudConnected: false, connections: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unwraps Cloud /status', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { connected: true, email: 'owner@example.com', scopes: ['a'], grantedAt: '2026-09-18T00:00:00.000Z' },
    }));
    await expect(service.status()).resolves.toEqual({
      connected: true,
      cloudConnected: true,
      // An older Cloud sends no `connections`; the single grant it does
      // describe is surfaced as a one-entry list so callers need one shape.
      connections: [
        { email: 'owner@example.com', products: [], scopes: ['a'], grantedAt: '2026-09-18T00:00:00.000Z', isDefault: true },
      ],
      email: 'owner@example.com',
      scopes: ['a'],
      grantedAt: '2026-09-18T00:00:00.000Z',
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`${PREFIX}/status`);
  });

  it('turns a 404 not_connected into connected:false rather than throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_connected', code: 'not_connected' }, 404));
    await expect(service.status()).resolves.toEqual({ connected: false, cloudConnected: true, connections: [] });
  });

  it('still throws for a Cloud outage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_configured', code: 'not_configured' }, 503));
    await expect(service.status()).rejects.toMatchObject({ status: 503, code: 'not_configured' });
  });
});

describe('disconnect', () => {
  it('DELETEs the Cloud grant and drops the cached token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.first', 3600_000)))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { removed: true } }))
      .mockResolvedValueOnce(jsonResponse(tokenBody('ya29.after', 3600_000)));

    await service.getAccessToken();
    await expect(service.disconnect()).resolves.toEqual({ removed: true });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(PREFIX);
    expect(init.method).toBe('DELETE');

    await expect(service.getAccessToken()).resolves.toBe('ya29.after');
  });
});

describe('buildConnectUrl', () => {
  it('builds Cloud /start with the current Cloud JWT and the return URL', () => {
    const url = new URL(service.buildConnectUrl('http://localhost:8787/settings?tab=integrations'));
    expect(`${url.origin}${url.pathname}`).toBe(`${PREFIX}/start`);
    expect(url.searchParams.get('token')).toBe('cloud-jwt');
    expect(url.searchParams.get('returnUrl')).toBe('http://localhost:8787/settings?tab=integrations');
  });

  it('throws not_logged_in when there is no Cloud session', () => {
    cloud.connected = false;
    expect(() => service.buildConnectUrl('http://x/')).toThrow(GoogleWorkspaceError);
    try {
      service.buildConnectUrl('http://x/');
    } catch (err) {
      expect(err).toMatchObject({ status: 401, code: 'not_logged_in' });
    }
  });
});

describe('mapCloudFailure', () => {
  it('falls back to http_<status> for unknown failures', () => {
    const err = mapCloudFailure(418, undefined, undefined);
    expect(err).toMatchObject({ status: 502, code: 'http_418' });
  });
});

describe('singleton', () => {
  it('getInstance returns the same object until reset', () => {
    const a = GoogleWorkspaceTokenService.getInstance();
    expect(GoogleWorkspaceTokenService.getInstance()).toBe(a);
    GoogleWorkspaceTokenService.resetInstance();
    expect(GoogleWorkspaceTokenService.getInstance()).not.toBe(a);
  });
});
