/**
 * Tests for AppsCloudClient — headers, refresh-and-retry on 401, error
 * mapping, and that the token never leaks into an error.
 */

import { AppsCloudClient, AppsCloudError, type AppsCloudSession } from './apps-cloud.client.js';

const TOKEN = 'cloud-access-jwt-SECRET';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeCloud(overrides: Partial<AppsCloudSession> = {}): AppsCloudSession & { tryRefreshToken: jest.Mock } {
  return {
    isConnected: () => true,
    getToken: () => TOKEN,
    getCloudUrl: () => 'https://api.crewlyai.com/',
    tryRefreshToken: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as AppsCloudSession & { tryRefreshToken: jest.Mock };
}

describe('AppsCloudClient asOwner', () => {
  it('sends the account token with NO instance and NO agent header (Cloud\'s owner actor), even without an instance id', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { collaborators: [] } }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => null, fetchImpl });
    await client.request('PUT', '/apps/abc/collaborators', { body: { kind: 'team' }, agent: 'dev-ella', asOwner: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['X-Crewly-Instance']).toBeUndefined();
    expect(init.headers['X-Crewly-Agent']).toBeUndefined();
  });

  it('a normal call still needs and sends the instance (agent calls are unchanged)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: {} }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });
    await client.request('GET', '/apps/abc/collaborators', { agent: 'dev-ella' });
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'X-Crewly-Instance': 'inst-1', 'X-Crewly-Agent': 'dev-ella' });
    const none = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => null, fetchImpl });
    await expect(none.request('GET', '/apps/abc/collaborators', { agent: 'dev-ella' })).rejects.toMatchObject({ code: 'instance_unknown' });
  });
});

describe('AppsCloudClient raw bodies', () => {
  it('sends bytes with their content type instead of JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { size: 3 } }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });
    await client.request('PUT', '/apps/abc/thumbnail', { raw: { data: Buffer.from([1, 2, 3]), contentType: 'image/png' }, agent: 'dev-ella' });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('image/png');
    expect(Array.from(init.body as Uint8Array)).toEqual([1, 2, 3]);
  });
});

describe('AppsCloudClient', () => {
  it('sends the bearer token, instance and agent headers to /api/apps/v1', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(201, { success: true, data: { appId: 'abcdefghjk' } }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });

    const data = await client.request<{ appId: string }>('POST', '/apps', { body: { name: 'Groceries' }, agent: 'dev-ella' });

    expect(data).toEqual({ appId: 'abcdefghjk' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/apps/v1/apps');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'X-Crewly-Instance': 'inst-1',
      'X-Crewly-Agent': 'dev-ella',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({ name: 'Groceries' });
  });

  it('omits X-Crewly-Agent for the owner and drops empty query values', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { changes: [], seq: 3 } }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });

    await client.request('GET', '/apps/x/changes', { query: { since: 2, wait: 0, after: undefined } });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/apps/v1/apps/x/changes?since=2&wait=0');
    expect(init.headers['X-Crewly-Agent']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('refreshes the token once on 401 and retries', async () => {
    const cloud = makeCloud();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { success: false, error: 'expired', code: 'unauthorized' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: [] }));
    const client = new AppsCloudClient({ cloud, instanceId: async () => 'inst-1', fetchImpl });

    await expect(client.request('GET', '/apps')).resolves.toEqual([]);
    expect(cloud.tryRefreshToken).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps a 401 that survives the refresh to not_logged_in (409)', async () => {
    const cloud = makeCloud({ tryRefreshToken: jest.fn().mockResolvedValue(false) });
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, {}));
    const client = new AppsCloudClient({ cloud, instanceId: async () => 'inst-1', fetchImpl });

    await expect(client.request('GET', '/apps')).rejects.toMatchObject({ status: 409, code: 'not_logged_in' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes Cloud's status, code and message through", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(404, { success: false, error: 'Document not found.', code: 'not_found' }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });

    const err = await client.request('GET', '/apps/x/data/c/d').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppsCloudError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'Document not found.' });
  });

  it('refuses without a Cloud login or instance id, without calling out', async () => {
    const fetchImpl = jest.fn();
    const offline = new AppsCloudClient({ cloud: makeCloud({ isConnected: () => false }), instanceId: async () => 'i', fetchImpl });
    await expect(offline.request('GET', '/apps')).rejects.toMatchObject({ code: 'not_logged_in' });
    expect(offline.isAvailable()).toBe(false);

    const noInstance = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => null, fetchImpl });
    await expect(noInstance.request('GET', '/apps')).rejects.toMatchObject({ code: 'instance_unknown' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a network failure into a 502 network error that does not contain the token', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`connect failed Authorization: Bearer ${TOKEN}`));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });

    const err = (await client.request('GET', '/apps').catch((e: unknown) => e)) as AppsCloudError;
    expect(err).toMatchObject({ status: 502, code: 'network' });
    expect(err.message).not.toContain(TOKEN);
  });

  it('handles a non-JSON error body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502 }));
    const client = new AppsCloudClient({ cloud: makeCloud(), instanceId: async () => 'inst-1', fetchImpl });

    await expect(client.request('GET', '/apps')).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });
});
