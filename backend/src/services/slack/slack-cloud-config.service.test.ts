/**
 * Tests for SlackCloudConfigService — Cloud fetch over a fake fetch, the
 * 0600 cache, source precedence (`CREWLY_SLACK_SOURCE`), the 10-minute
 * refresh and change notifications.
 *
 * @module services/slack/slack-cloud-config.service.test
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import {
  SlackCloudConfigService,
  resolveSlackSourceMode,
  isCloudConfig,
  getSlackCloudConfigService,
  setSlackCloudConfigService,
} from './slack-cloud-config.service.js';
import type { SlackCloudConfig } from '../../types/slack.types.js';
import { SLACK_CLOUD_CONSTANTS } from '../../constants.js';

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

const CONFIG: SlackCloudConfig = {
  workspace: { slackTeamId: 'T1', slackTeamName: 'Acme', botUserId: 'UBOT', botToken: 'xoxb-master', appId: 'A0' },
  agents: [
    { agentSession: 'alpha-kai-1', teamId: 't1', botUserId: 'UKAI', botToken: 'xoxb-kai', appId: 'A1', displayName: 'Kai' },
  ],
  transport: 'cloud',
};

let tmpDir: string;
let fetchMock: jest.Mock;
let cloud: { connected: boolean; token: string | null; url: string | null };
let env: NodeJS.ProcessEnv;
let intervals: Array<{ fn: () => void; ms: number }>;
let storePath: string;

function makeService() {
  return new SlackCloudConfigService({
    cloud: {
      isConnected: () => cloud.connected,
      getToken: () => cloud.token,
      getCloudUrl: () => cloud.url,
    },
    storePath,
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => 1_800_000_000_000,
    env,
    setInterval: ((fn: () => void, ms: number) => {
      intervals.push({ fn, ms });
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {
      intervals = [];
    }) as unknown as typeof clearInterval,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slack-cloud-'));
  storePath = path.join(tmpDir, 'slack-cloud-config.json');
  fetchMock = jest.fn();
  cloud = { connected: true, token: 'jwt-1', url: 'https://api.crewlyai.com/' };
  env = {};
  intervals = [];
});

afterEach(async () => {
  setSlackCloudConfigService(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('resolveSlackSourceMode', () => {
  it('defaults to auto and accepts env / cloud case-insensitively', () => {
    expect(resolveSlackSourceMode({})).toBe('auto');
    expect(resolveSlackSourceMode({ CREWLY_SLACK_SOURCE: 'env' })).toBe('env');
    expect(resolveSlackSourceMode({ CREWLY_SLACK_SOURCE: ' Cloud ' })).toBe('cloud');
    expect(resolveSlackSourceMode({ CREWLY_SLACK_SOURCE: 'nonsense' })).toBe('auto');
  });
});

describe('isCloudConfig', () => {
  it('accepts the contract payload and rejects a workspace without a token', () => {
    expect(isCloudConfig(CONFIG)).toBe(true);
    expect(isCloudConfig({ ...CONFIG, workspace: { ...CONFIG.workspace, botToken: '' } })).toBe(false);
    expect(isCloudConfig({ ...CONFIG, agents: [{ agentSession: 'x' }] })).toBe(false);
    expect(isCloudConfig(null)).toBe(false);
  });
});

describe('availability', () => {
  it('is unavailable without a Cloud login or when CREWLY_SLACK_SOURCE=env', () => {
    const service = makeService();
    expect(service.isAvailable()).toBe(true);
    cloud.connected = false;
    expect(service.isAvailable()).toBe(false);
    cloud.connected = true;
    env.CREWLY_SLACK_SOURCE = 'env';
    expect(makeService().isAvailable()).toBe(false);
  });
});

describe('refresh + cache', () => {
  it('GETs /api/cloud/slack/config with the Cloud bearer and caches the result at 0600', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    const config = await service.refresh();

    expect(config).toEqual(CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/cloud/slack/config');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer jwt-1');

    const stat = await fs.stat(storePath);
    expect(stat.mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(await fs.readFile(storePath, 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.config).toEqual(CONFIG);
    expect(service.getFetchedAt()).toBe(new Date(1_800_000_000_000).toISOString());
    expect(service.getLastError()).toBeNull();
  });

  it('serves the cached copy on a restart when Cloud is unreachable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    await makeService().refresh();

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const restarted = makeService();
    const config = await restarted.loadOrRefresh();
    expect(config).toEqual(CONFIG);
    expect(restarted.getLastError()).toMatch(/Cloud unreachable/);
  });

  it('a 404 (no workspace on Cloud) clears the cache and notifies listeners with null', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    const listener = jest.fn();
    service.onChange(listener);
    await service.refresh();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'cloud' }));

    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'not connected' }, 404));
    expect(await service.refresh()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
    await expect(fs.access(storePath)).rejects.toBeDefined();
  });

  it('keeps the cache and records the error on a Cloud failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    await service.refresh();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'boom', code: 'server' }, 500));
    expect(await service.refresh()).toEqual(CONFIG);
    expect(service.getLastError()).toBe('boom');
    expect(await fs.readFile(storePath, 'utf8')).toContain('xoxb-master');
  });

  it('rejects a malformed config instead of caching it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { workspace: {}, agents: [] } }));
    const service = makeService();
    expect(await service.refresh()).toBeNull();
    expect(service.getLastError()).toMatch(/malformed/);
  });

  it('does not hit Cloud at all when CREWLY_SLACK_SOURCE=env', async () => {
    env.CREWLY_SLACK_SOURCE = 'env';
    const service = makeService();
    expect(await service.loadOrRefresh()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only notifies when the config actually changed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    const listener = jest.fn();
    service.onChange(listener);
    await service.refresh();
    await service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);

    const rotated = { ...CONFIG, workspace: { ...CONFIG.workspace, botToken: 'xoxb-rotated' } };
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: rotated }));
    await service.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(service.getConfig()?.workspace.botToken).toBe('xoxb-rotated');
  });

  it('clear() forgets the cached config', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    await service.refresh();
    await service.clear();
    expect(service.getConfig()).toBeNull();
    await expect(fs.access(storePath)).rejects.toBeDefined();
  });
});

describe('removeWorkspace', () => {
  it('DELETEs /api/cloud/slack/workspace, clears the cache and notifies', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    const listener = jest.fn();
    service.onChange(listener);
    await service.refresh();

    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { removed: true } }));
    expect(await service.removeWorkspace()).toBe(true);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.crewlyai.com/api/cloud/slack/workspace');
    expect(init.method).toBe('DELETE');
    expect(service.getConfig()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);
    await expect(fs.access(storePath)).rejects.toBeDefined();
  });

  it('treats a 404 as already removed and surfaces other Cloud errors', async () => {
    const service = makeService();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'none' }, 404));
    expect(await service.removeWorkspace()).toBe(false);
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'boom', code: 'server' }, 500));
    await expect(service.removeWorkspace()).rejects.toMatchObject({ status: 500, code: 'server' });
  });
});

describe('read model', () => {
  it('toSlackConfig exposes the master bot with the cloud transport and env knobs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    env.SLACK_DEFAULT_CHANNEL = 'C-default';
    env.SLACK_ALLOWED_USERS = 'U1,,U2';
    const service = makeService();
    expect(service.toSlackConfig()).toBeNull();
    await service.refresh();
    expect(service.toSlackConfig()).toEqual({
      botToken: 'xoxb-master',
      appToken: '',
      signingSecret: '',
      socketMode: false,
      transport: 'cloud',
      botUserId: 'UBOT',
      defaultChannelId: 'C-default',
      allowedUserIds: ['U1', 'U2'],
    });
    expect(service.getAgents()).toEqual(CONFIG.agents);
    expect(service.getAgents()[0]).not.toBe(CONFIG.agents[0]);
  });
});

describe('periodic refresh', () => {
  it('refreshes every 10 minutes and stops cleanly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: CONFIG }));
    const service = makeService();
    service.start();
    service.start();
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(SLACK_CLOUD_CONSTANTS.CONFIG_REFRESH_INTERVAL_MS);

    intervals[0].fn();
    // refresh() reads the cache from disk before calling Cloud.
    for (let i = 0; i < 5 && fetchMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    service.stop();
    expect(intervals).toHaveLength(0);
  });
});

describe('singleton holder', () => {
  it('stores and clears the process-wide instance', () => {
    expect(getSlackCloudConfigService()).toBeNull();
    const service = makeService();
    setSlackCloudConfigService(service);
    expect(getSlackCloudConfigService()).toBe(service);
    setSlackCloudConfigService(null);
    expect(getSlackCloudConfigService()).toBeNull();
  });
});
