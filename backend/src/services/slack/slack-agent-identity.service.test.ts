/**
 * Tests for SlackAgentIdentityService — Cloud calls over a fake fetch, the
 * 0600 local cache, pending-install polling and the installed hook.
 *
 * @module services/slack/slack-agent-identity.service.test
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  SlackAgentIdentityService,
  SlackIdentityCloudError,
  getSlackAgentIdentityService,
  setSlackAgentIdentityService,
} from './slack-agent-identity.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

let tmpDir: string;
let fetchMock: jest.Mock;
let cloud: { connected: boolean; token: string | null; url: string | null };
let service: SlackAgentIdentityService;
let intervals: Array<() => void>;

function makeService() {
  return new SlackAgentIdentityService({
    cloud: {
      isConnected: () => cloud.connected,
      getToken: () => cloud.token,
      getCloudUrl: () => cloud.url,
    },
    storePath: path.join(tmpDir, 'slack-agent-identities.json'),
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => 1_800_000_000_000,
    setInterval: ((fn: () => void) => {
      intervals.push(fn);
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      intervals = [];
    }) as unknown as typeof clearInterval,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slack-id-'));
  fetchMock = jest.fn();
  cloud = { connected: true, token: 'jwt-1', url: 'https://api.crewlyai.com/' };
  intervals = [];
  service = makeService();
});

afterEach(async () => {
  service.stop();
  setSlackAgentIdentityService(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('availability + Cloud transport', () => {
  it('is unavailable without a Cloud login', () => {
    cloud.connected = false;
    expect(service.isAvailable()).toBe(false);
    cloud.connected = true;
    cloud.token = null;
    expect(service.isAvailable()).toBe(false);
  });

  it('sends Bearer + JSON to the Cloud slack path (trailing slash trimmed)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { enabled: true, configToken: { configured: false }, agents: { total: 0, installed: 0, pending: 0 } } }));
    const status = await service.getCloudStatus();
    expect(status.enabled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/cloud/slack/status');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-1');
  });

  it('throws SlackIdentityCloudError with Cloud codes, and network for transport failures', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'no token', code: 'config_token_missing' }, 409));
    await expect(service.provision('s', 'Sam')).rejects.toMatchObject({ status: 409, code: 'config_token_missing' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(service.getCloudStatus()).rejects.toMatchObject({ code: 'network', status: 502 });
    cloud.token = null;
    await expect(service.getCloudStatus()).rejects.toMatchObject({ code: 'not_logged_in' });
  });

  it('setConfigToken / deleteConfigToken hit the right endpoints', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { configured: true, status: 'ok' } }));
    expect(await service.setConfigToken('cfg', 'ref')).toEqual({ configured: true, status: 'ok' });
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: 'cfg', refreshToken: 'ref' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { removed: true } }));
    expect(await service.deleteConfigToken()).toBe(true);
    expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
  });
});

describe('provision + cache', () => {
  it('caches a pending identity (0600) and starts polling', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install', installUrl: 'https://slack/x' } }),
    );
    const rec = await service.provision('s', 'Sam', 'desc');
    expect(rec).toMatchObject({ agentSession: 's', status: 'pending_install', installUrl: 'https://slack/x', announcedIn: [], invitedTo: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ agentSession: 's', displayName: 'Sam', description: 'desc' });
    const stat = await fs.stat(path.join(tmpDir, 'slack-agent-identities.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(intervals).toHaveLength(1);
    expect(service.get('s')?.status).toBe('pending_install');
    expect(service.getInstalled('s')).toBeNull();
  });

  it('refreshFromCloud merges tokens, fires onInstalled once, and stops polling when nothing is pending', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install', installUrl: 'https://slack/x' } }),
    );
    await service.provision('s', 'Sam');
    const installed = jest.fn();
    service.onInstalled(installed);

    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: [{ agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'installed', botUserId: 'USAM', botToken: 'xoxb-sam', teamId: 'T1' }] }),
    );
    const list = await service.refreshFromCloud();
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.crewlyai.com/api/cloud/slack/agents?includeTokens=1');
    expect(list[0]).toMatchObject({ status: 'installed', botUserId: 'USAM', botToken: 'xoxb-sam' });
    expect(list[0].installUrl).toBeUndefined();
    expect(installed).toHaveBeenCalledTimes(1);
    expect(service.getInstalled('s')).toEqual({ botUserId: 'USAM', botToken: 'xoxb-sam' });
    expect(service.findByBotUserId('USAM')).toBe('s');
    expect(intervals).toHaveLength(0);

    await service.refreshFromCloud();
    expect(installed).toHaveBeenCalledTimes(1);

    // Cloud pruned the agent → the local record goes too.
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: [] }));
    expect(await service.refreshFromCloud()).toEqual([]);
    expect(service.getInstalled('s')).toBeNull();
  });

  it('markChannel records announcements and invites without duplicates', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install' } }));
    await service.provision('s', 'Sam');
    await service.markChannel('s', { announcedIn: 'C1' });
    await service.markChannel('s', { announcedIn: 'C1', invitedTo: 'C1' });
    await service.markChannel('ghost', { invitedTo: 'C1' });
    expect(service.get('s')).toMatchObject({ announcedIn: ['C1'], invitedTo: ['C1'] });
  });

  it('reloads the cache in a new instance and resumes polling for pending installs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install' } }));
    await service.provision('s', 'Sam');
    intervals = [];
    const fresh = makeService();
    const list = await fresh.list();
    expect(list[0].agentSession).toBe('s');
    expect(intervals).toHaveLength(1);
    fresh.stop();
  });

  it('remove deletes on Cloud and locally, tolerating a 404 there', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install' } }));
    await service.provision('s', 'Sam');
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'nope', code: 'not_found' }, 404));
    expect(await service.remove('s')).toBe(false);
    expect(service.get('s')).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toContain('/api/cloud/slack/agents/s');
  });

  it('pollTick refreshes while available and gives up after the max age', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { agentSession: 's', displayName: 'Sam', appId: 'A1', status: 'pending_install' } }));
    await service.provision('s', 'Sam');
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
    await service.pollTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    cloud.connected = false;
    await service.pollTick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('survives a corrupt cache file', async () => {
    await fs.writeFile(path.join(tmpDir, 'slack-agent-identities.json'), '{nope');
    expect(await makeService().list()).toEqual([]);
  });
});

describe('singleton', () => {
  it('is null until set', () => {
    expect(getSlackAgentIdentityService()).toBeNull();
    setSlackAgentIdentityService(service);
    expect(getSlackAgentIdentityService()).toBe(service);
  });
  it('SlackIdentityCloudError carries status + code', () => {
    const e = new SlackIdentityCloudError(409, 'x', 'm');
    expect(e.name).toBe('SlackIdentityCloudError');
    expect(e.status).toBe(409);
  });
});

describe('applyCloudConfig (Slack v3 — identities delivered with the Cloud config)', () => {
  it('installs every agent from the config once, fires onInstalled for new ones and persists tokens', async () => {
    const installed = jest.fn();
    service.onInstalled(installed);
    const agents = [
      { agentSession: 'alpha-kai-1', teamId: 't1', botUserId: 'UKAI', botToken: 'xoxb-kai', appId: 'A1', displayName: 'Kai' },
      { agentSession: 'alpha-mia-2', teamId: 't1', botUserId: 'UMIA', botToken: 'xoxb-mia', appId: 'A2', displayName: 'Mia' },
    ];

    expect(await service.applyCloudConfig(agents)).toBe(2);
    expect(installed).toHaveBeenCalledTimes(2);
    expect(service.getInstalled('alpha-kai-1')).toEqual({ botUserId: 'UKAI', botToken: 'xoxb-kai' });
    expect(service.findByBotUserId('UMIA')).toBe('alpha-mia-2');
    expect(service.get('alpha-kai-1')?.teamId).toBe('t1');

    // Second application is a no-op (no new installs, no re-fire).
    expect(await service.applyCloudConfig(agents)).toBe(0);
    expect(installed).toHaveBeenCalledTimes(2);

    // Persisted for the next boot.
    const reloaded = makeService();
    expect((await reloaded.list()).map((r) => r.agentSession).sort()).toEqual(['alpha-kai-1', 'alpha-mia-2']);
    expect(reloaded.getInstalled('alpha-mia-2')?.botToken).toBe('xoxb-mia');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips entries without a token or bot user id', async () => {
    expect(
      await service.applyCloudConfig([
        { agentSession: 'x', botUserId: '', botToken: 'xoxb', appId: 'A', displayName: 'X' },
        { agentSession: 'y', botUserId: 'UY', botToken: '', appId: 'A', displayName: 'Y' },
      ]),
    ).toBe(0);
    expect(await service.list()).toEqual([]);
  });
});
