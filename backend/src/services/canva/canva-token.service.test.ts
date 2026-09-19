/**
 * Tests for CanvaTokenService — Cloud `/token` over a fake fetch, the cache
 * margin, single in-flight refresh, error mapping, status, disconnect and
 * the connect URL.
 *
 * @module services/canva/canva-token.service.test
 */

import { CanvaTokenService, CanvaError, mapCloudFailure } from './canva-token.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: { getInstance: () => ({ createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) }) },
}));

const T0 = 1_800_000_000_000;
const PREFIX = 'https://api.crewlyai.com/api/cloud/canva';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let fetchMock: jest.Mock;
let now: number;
let cloud: { connected: boolean; token: string | null; url: string | null };
let service: CanvaTokenService;

beforeEach(() => {
  fetchMock = jest.fn();
  now = T0;
  cloud = { connected: true, token: 'cloud-jwt', url: 'https://api.crewlyai.com/' };
  service = new CanvaTokenService({
    cloud: { isConnected: () => cloud.connected, getToken: () => cloud.token, getCloudUrl: () => cloud.url },
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => now,
  });
});

afterEach(() => CanvaTokenService.resetInstance());

describe('getAccessToken', () => {
  it('calls Cloud /token with the session JWT, caches until 60 s before expiry, shares in-flight refreshes', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { accessToken: 'cnv-1', expiresAt: new Date(T0 + 3_600_000).toISOString() } }));
    const [a, b] = await Promise.all([service.getAccessToken(), service.getAccessToken()]);
    expect(a).toBe('cnv-1');
    expect(b).toBe('cnv-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${PREFIX}/token`);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer cloud-jwt' });
    now = T0 + 3_600_000 - 61_000;
    await service.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now = T0 + 3_600_000 - 59_000;
    await service.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.clearCache();
    await service.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps Cloud failures: 401 → not_logged_in, 404/409 → not_connected, 503 → not_configured, 502 → canva_error, network', async () => {
    cloud.token = null;
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 401, code: 'not_logged_in' });
    cloud.token = 'cloud-jwt';
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_connected' }, 404));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 409, code: 'not_connected' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'grant_revoked' }, 409));
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: 'not_connected' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_configured' }, 503));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 503, code: 'not_configured' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'canva_error', message: 'x' }, 502));
    await expect(service.getAccessToken()).rejects.toMatchObject({ status: 502, code: 'canva_error' });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(service.getAccessToken()).rejects.toMatchObject({ code: 'network' });
    expect(mapCloudFailure(418, undefined, undefined)).toBeInstanceOf(CanvaError);
    expect(mapCloudFailure(418, undefined, undefined).code).toBe('http_418');
  });
});

describe('status / disconnect / connect URL', () => {
  it('reports the grant, and not-connected without throwing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { connected: true, canvaUserId: 'cu', displayName: 'Steve', scopes: ['asset:read'], grantedAt: 'g' } }));
    await expect(service.status()).resolves.toEqual({ connected: true, cloudConnected: true, canvaUserId: 'cu', displayName: 'Steve', scopes: ['asset:read'], grantedAt: 'g' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'not_connected' }, 404));
    await expect(service.status()).resolves.toEqual({ connected: false, cloudConnected: true });
    cloud.connected = false;
    await expect(service.status()).resolves.toEqual({ connected: false, cloudConnected: false });
  });

  it('disconnect DELETEs on Cloud; buildConnectUrl carries token + returnUrl', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { removed: true } }));
    await expect(service.disconnect()).resolves.toEqual({ removed: true });
    expect(fetchMock.mock.calls[0][0]).toBe(PREFIX);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
    const url = new URL(service.buildConnectUrl('http://localhost:8787/settings?tab=integrations'));
    expect(url.origin + url.pathname).toBe(`${PREFIX}/start`);
    expect(url.searchParams.get('token')).toBe('cloud-jwt');
    expect(url.searchParams.get('returnUrl')).toBe('http://localhost:8787/settings?tab=integrations');
    cloud.connected = false;
    expect(() => service.buildConnectUrl('http://x')).toThrow(CanvaError);
  });
});
