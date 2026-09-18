/**
 * Tests for SlackInstanceRegistryService — the registry payload, heartbeat
 * cadence (boot / team-saved / 5 min), agent sync with pending installs and
 * the primary flag (env + persisted toggle).
 *
 * @module services/slack/slack-instance-registry.service.test
 */

import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Team, TeamMember } from '../../types/index.js';
import type { StorageEvent } from '../core/storage.service.js';
import {
  SlackInstanceRegistryService,
  getSlackInstanceRegistryService,
  setSlackInstanceRegistryService,
} from './slack-instance-registry.service.js';
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

function member(name: string, role: TeamMember['role'], extra: Partial<TeamMember> = {}): TeamMember {
  return {
    id: `m-${name.toLowerCase()}`,
    name,
    sessionName: `alpha-${name.toLowerCase()}-1234`,
    role,
    systemPrompt: '',
    agentStatus: 'active',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as TeamMember;
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-alpha',
    name: 'Alpha',
    description: '',
    members: [member('Kai', 'developer', { avatar: ':computer:' }), member('Mia', 'qa'), member('Orc', 'orchestrator')],
    projectIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Team;
}

let tmpDir: string;
let fetchMock: jest.Mock;
let cloud: { connected: boolean; token: string | null; url: string | null };
let env: NodeJS.ProcessEnv;
let teams: Team[];
let queueId: string | null;
let storageListeners: Array<(event: StorageEvent) => Promise<void> | void>;
let intervals: Array<{ fn: () => void; ms: number }>;
let timeouts: Array<{ fn: () => void; ms: number }>;
let mappings: Record<string, string>;

function makeService() {
  return new SlackInstanceRegistryService({
    cloud: {
      isConnected: () => cloud.connected,
      getToken: () => cloud.token,
      getCloudUrl: () => cloud.url,
    },
    identity: { getOrCreateIdentity: async () => ({ deviceId: 'device-1', deviceName: 'steve-mbp' }) },
    sync: { getQueueId: () => queueId },
    storage: {
      getTeams: async () => teams,
      onStorageEvent: (listener) => {
        storageListeners.push(listener);
        return () => {
          storageListeners = storageListeners.filter((l) => l !== listener);
        };
      },
    },
    getTeamChannels: () => ({
      findByTeamId: (teamId: string) =>
        mappings[teamId]
          ? { teamId, slackChannelId: mappings[teamId], slackChannelName: 'x', chatChannelId: 'h', createdAt: '', autoCreated: true }
          : null,
    }),
    version: '1.16.0',
    settingsPath: path.join(tmpDir, 'slack-instance.json'),
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
    setTimeout: ((fn: () => void, ms: number) => {
      timeouts.push({ fn, ms });
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      timeouts = [];
    }) as unknown as typeof clearTimeout,
  });
}

/** Calls by method+path suffix, for readable assertions. */
function calls(): Array<{ method: string; url: string; body: any }> {
  return fetchMock.mock.calls.map(([url, init]) => ({ method: init.method, url, body: init.body === undefined ? undefined : JSON.parse(init.body) }));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-slack-reg-'));
  fetchMock = jest.fn().mockResolvedValue(jsonResponse({ success: true, data: { installUrls: [] } }));
  cloud = { connected: true, token: 'jwt-1', url: 'https://api.crewlyai.com' };
  env = {};
  teams = [team()];
  queueId = 'queue-abc';
  storageListeners = [];
  intervals = [];
  timeouts = [];
  mappings = { 'team-alpha': 'C-ALPHA' };
});

afterEach(async () => {
  setSlackInstanceRegistryService(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('payload', () => {
  it('describes the instance per the contract: device, relay queue, teams with channel + member sessions, version', async () => {
    teams.push(team({ id: 'team-beta', name: 'Beta', members: [member('Zed', 'developer')] }));
    const service = makeService();
    const payload = await service.buildPayload();
    expect(payload).toEqual({
      deviceName: 'steve-mbp',
      relayQueueId: 'queue-abc',
      primary: false,
      teams: [
        { teamId: 'team-alpha', name: 'Alpha', channelId: 'C-ALPHA', agents: ['alpha-kai-1234', 'alpha-mia-1234'] },
        { teamId: 'team-beta', name: 'Beta', agents: ['alpha-zed-1234'] },
      ],
      crewlyVersion: '1.16.0',
    });
  });

  it('reads the primary flag from CREWLY_SLACK_PRIMARY', async () => {
    env.CREWLY_SLACK_PRIMARY = '1';
    expect((await makeService().buildPayload()).primary).toBe(true);
    env.CREWLY_SLACK_PRIMARY = 'true';
    expect((await makeService().buildPayload()).primary).toBe(true);
    env.CREWLY_SLACK_PRIMARY = '0';
    expect((await makeService().buildPayload()).primary).toBe(false);
  });
});

describe('heartbeat', () => {
  it('PUTs /api/cloud/slack/instances/<device id> with the payload and a bearer', async () => {
    const service = makeService();
    expect(await service.heartbeat()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/cloud/slack/instances/device-1');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(init.body)).toMatchObject({ deviceName: 'steve-mbp', relayQueueId: 'queue-abc', crewlyVersion: '1.16.0' });
    expect(service.getInstanceId()).toBe('device-1');
    expect(service.getLastHeartbeatAt()).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('skips when not signed in to Cloud or before the relay queue exists', async () => {
    cloud.connected = false;
    expect(await makeService().heartbeat()).toBe(false);
    cloud.connected = true;
    queueId = null;
    expect(await makeService().heartbeat()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries on the short debounce while the relay queue is not registered, then stops', async () => {
    queueId = null;
    const service = makeService();
    await service.start();
    // start() heartbeats once (skipped) and scheduled a retry.
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(SLACK_CLOUD_CONSTANTS.TEAM_SAVED_DEBOUNCE_MS);

    for (let i = 0; i < SLACK_CLOUD_CONSTANTS.QUEUE_WAIT_MAX_RETRIES + 5; i++) {
      const next = timeouts.shift();
      if (!next) break;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    // Capped: no more retries queued once the budget is spent.
    expect(timeouts).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'PUT')).toHaveLength(0);

    // Queue appears → the next heartbeat goes through and the budget resets.
    queueId = 'queue-late';
    expect(await service.heartbeat()).toBe(true);
    expect(calls().at(-1)?.body.relayQueueId).toBe('queue-late');
    service.stop();
  });

  it('records Cloud failures without throwing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'nope', code: 'bad' }, 500));
    const service = makeService();
    expect(await service.heartbeat()).toBe(false);
    expect(service.getLastError()).toBe('nope');
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await service.heartbeat()).toBe(false);
    expect(service.getLastError()).toMatch(/Cloud unreachable/);
  });
});

describe('agent sync', () => {
  it('POSTs /api/cloud/slack/agents/sync with the roster and keeps the pending install links', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { installUrls: [{ agentSession: 'alpha-mia-1234', url: 'https://slack.com/oauth/x' }, { bogus: true }] } }),
    );
    const service = makeService();
    const result = await service.syncAgents();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.crewlyai.com/api/cloud/slack/agents/sync');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      teams: [
        {
          teamId: 'team-alpha',
          name: 'Alpha',
          agents: [
            { agentSession: 'alpha-kai-1234', displayName: 'Kai', avatar: ':computer:' },
            { agentSession: 'alpha-mia-1234', displayName: 'Mia' },
          ],
        },
      ],
      prune: true,
    });
    expect(result).toEqual({ installUrls: [{ agentSession: 'alpha-mia-1234', url: 'https://slack.com/oauth/x' }] });
    expect(service.getPendingInstalls()).toEqual([{ agentSession: 'alpha-mia-1234', url: 'https://slack.com/oauth/x' }]);
  });

  it('every team is synced with its full roster, channel or not', async () => {
    mappings = {};
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { installUrls: [] } }));
    await makeService().syncAgents();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).teams[0].agents.map((a: { agentSession: string }) => a.agentSession)).toEqual(['alpha-kai-1234', 'alpha-mia-1234']);
  });

  it('a deleted team loses its agents\' Slack apps (DELETE per session from the last synced roster)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { installUrls: [] } }));
    const service = makeService();
    await service.syncAgents();
    fetchMock.mockClear();
    await service.removeTeamAgents('team-alpha');
    expect(calls().map((c) => `${c.method} ${c.url.split('/api/cloud/slack')[1]}`)).toEqual([
      'DELETE /agents/alpha-kai-1234',
      'DELETE /agents/alpha-mia-1234',
    ]);
    fetchMock.mockClear();
    await service.removeTeamAgents('team-alpha'); // already forgotten
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null and keeps the previous list on failure', async () => {
    const service = makeService();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { installUrls: [{ agentSession: 'a', url: 'u' }] } }));
    await service.syncAgents();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'config_token missing', code: 'config_token' }, 409));
    expect(await service.syncAgents()).toBeNull();
    expect(service.getPendingInstalls()).toEqual([{ agentSession: 'a', url: 'u' }]);
    expect(service.getLastError()).toBe('config_token missing');
  });
});

describe('lifecycle', () => {
  it('on start: heartbeat + agent sync, then a 5-minute heartbeat interval', async () => {
    const service = makeService();
    await service.start();
    await service.start();
    const seen = calls();
    expect(seen.map((c) => `${c.method} ${c.url.split('/api/cloud/slack')[1]}`)).toEqual([
      'PUT /instances/device-1',
      'POST /agents/sync',
    ]);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(SLACK_CLOUD_CONSTANTS.REGISTRY_HEARTBEAT_INTERVAL_MS);
    expect(storageListeners).toHaveLength(1);

    intervals[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(calls()).toHaveLength(3);
    expect(calls()[2].method).toBe('PUT');

    service.stop();
    expect(intervals).toHaveLength(0);
    expect(storageListeners).toHaveLength(0);
  });

  it('a team save schedules one debounced heartbeat and one debounced agent sync (rename/remove follow through)', async () => {
    const service = makeService();
    await service.start();
    fetchMock.mockClear();

    const saved: StorageEvent = { kind: 'team-saved', team: teams[0], created: false };
    await storageListeners[0](saved);
    await storageListeners[0](saved);
    await storageListeners[0](saved);
    expect(fetchMock).not.toHaveBeenCalled();
    // One agent-sync timer + one heartbeat timer, both on the team-saved debounce.
    expect(timeouts).toHaveLength(2);
    expect(timeouts.every((t) => t.ms === SLACK_CLOUD_CONSTANTS.TEAM_SAVED_DEBOUNCE_MS)).toBe(true);

    for (const t of timeouts) t.fn();
    await new Promise((r) => setImmediate(r));
    expect(calls().map((c) => c.method).sort()).toEqual(['POST', 'PUT']);

    fetchMock.mockClear();
    timeouts = [];
    await storageListeners[0]({ kind: 'team-deleted', teamId: 'team-alpha' });
    // The roster was synced at start → the two agents' apps are deleted, then a heartbeat is scheduled.
    expect(calls().map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(timeouts).toHaveLength(1);
  });
});

describe('primary toggle', () => {
  it('persists the Settings toggle and re-registers immediately with primary:true', async () => {
    const service = makeService();
    expect(await service.isPrimary()).toBe(false);
    await service.setPrimary(true);
    expect(await service.isPrimary()).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body.primary).toBe(true);
    const onDisk = JSON.parse(await fs.readFile(path.join(tmpDir, 'slack-instance.json'), 'utf8'));
    expect(onDisk).toEqual({ version: 1, primary: true });

    // Survives a restart.
    expect(await makeService().isPrimary()).toBe(true);

    await service.setPrimary(false);
    expect(calls()[1].body.primary).toBe(false);
  });
});

describe('workspace choice', () => {
  it('is absent from the payload until chosen, then persisted and re-registered at once', async () => {
    const service = makeService();
    expect(await service.getWorkspaceId()).toBeNull();
    expect((await service.buildPayload()).slackTeamId).toBeUndefined();

    await service.setWorkspaceId('T0CLIENT');
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body.slackTeamId).toBe('T0CLIENT');
    const onDisk = JSON.parse(await fs.readFile(path.join(tmpDir, 'slack-instance.json'), 'utf8'));
    expect(onDisk).toEqual({ version: 1, primary: false, slackTeamId: 'T0CLIENT' });

    // Survives a restart and rides along with every heartbeat.
    const again = makeService();
    expect(await again.getWorkspaceId()).toBe('T0CLIENT');
    expect((await again.buildPayload()).slackTeamId).toBe('T0CLIENT');
    expect(await again.resolveInstanceId()).toBe(again.getInstanceId());
  });
});

describe('singleton holder', () => {
  it('stores and clears the process-wide instance', () => {
    expect(getSlackInstanceRegistryService()).toBeNull();
    const service = makeService();
    setSlackInstanceRegistryService(service);
    expect(getSlackInstanceRegistryService()).toBe(service);
    setSlackInstanceRegistryService(null);
  });
});
