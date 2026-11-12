/**
 * Tests for the support wiring (crewly#1558): the kill switch default and
 * an end-to-end request through the real relay + API; the agent switch
 * default and an end-to-end agent read through the real client + view.
 */

import { getDefaultSettings, type CrewlySettings } from '../../types/settings.types.js';
import type { ISupportRelayCloudSync, SupportRelayIncomingMessage } from './support-relay.service.js';
import type { ISupportClientCloudSync, SupportClientIncomingMessage } from './support-client.service.js';
import { SupportViewError } from './support-client.types.js';
import {
  agentViewsAllowed,
  cloudLoginForSupport,
  getSupportViewService,
  grantAllowed,
  setSupportViewService,
  startSupportRelay,
  startSupportView,
  supportAgentDisplayName,
} from './support.wiring.js';

jest.mock('../core/logger.service.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { LoggerService: { getInstance: () => ({ createComponentLogger: () => log }) } };
});

jest.mock('../activity/activity-log.service.js', () => ({ recordActivity: jest.fn() }));

const mockCloud = { token: 'secret-cloud-token' as string | null, url: 'https://cloud.test' as string | null };
jest.mock('../cloud/cloud-client.service.js', () => ({
  CloudClientService: { getInstance: () => ({ getToken: () => mockCloud.token, getCloudUrl: () => mockCloud.url }) },
}));

const mockMembers: Record<string, { member: { name: string } } | null> = { 'crewly-nova': { member: { name: 'Nova' } } };
jest.mock('../core/storage.service.js', () => ({
  StorageService: { getInstance: () => ({ findMemberBySessionName: async (session: string) => mockMembers[session] ?? null }) },
}));

const ENVELOPE = { grantId: 'g1', role: 'viewer' as const, includePrivate: false, granteeEmail: 'help@crewlyai.com', granteeAccountId: 'acct-b', replyQueueId: 'q-b' };

function sync() {
  const handlers: Array<(m: SupportRelayIncomingMessage) => void> = [];
  const sent: Array<{ to: string; payload: { status: number; body: unknown } }> = [];
  const s: ISupportRelayCloudSync = {
    on: (_e, h) => void handlers.push(h),
    off: () => undefined,
    sendToPeerQueueId: async (to, _t, payload) => void sent.push({ to, payload: payload as { status: number; body: unknown } }),
  };
  return { s, handlers, sent };
}

describe('grantAllowed', () => {
  it('is on by default and off only when the owner says so', () => {
    const s = getDefaultSettings();
    expect(grantAllowed(s)).toBe(true);
    expect(grantAllowed({ ...s, support: undefined })).toBe(true);
    expect(grantAllowed({ ...s, support: { allowGrantees: false, allowAgentViews: true } })).toBe(false);
  });
});

describe('startSupportRelay', () => {
  it('serves a vouched request end to end and honours the kill switch', async () => {
    const { s, handlers, sent } = sync();
    let settings: CrewlySettings = getDefaultSettings();
    startSupportRelay({
      cloudSync: s,
      chat: () => null,
      teams: async () => [{ id: 't1', name: 'T', members: [{ id: 'm', name: 'Dev', sessionName: 'a-dev', agentStatus: 'active' }] }],
      orchestrator: async () => null,
      crewlyHome: '/nonexistent-crewly-home',
      agentRegistration: () => null,
      settings: async () => settings,
      restartAgent: async () => true,
    });
    expect(handlers).toHaveLength(1);
    handlers[0]({ type: 'api_request', payload: { id: 'r1', method: 'GET', path: '/support/agents' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0].to).toBe('q-b');
    expect(sent[0].payload.status).toBe(200);
    expect(JSON.stringify(sent[0].payload.body)).toContain('a-dev');

    settings = { ...settings, support: { allowGrantees: false, allowAgentViews: true } };
    handlers[0]({ type: 'api_request', payload: { id: 'r2', method: 'GET', path: '/support/agents' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[1].payload.status).toBe(403);
  });

  it('reads recent errors from the missing service log as empty', async () => {
    const { s, handlers, sent } = sync();
    startSupportRelay({
      cloudSync: s,
      chat: () => null,
      teams: async () => [],
      orchestrator: async () => null,
      crewlyHome: '/nonexistent-crewly-home',
      agentRegistration: () => null,
      settings: async () => getDefaultSettings(),
    });
    handlers[0]({ type: 'api_request', payload: { id: 'r1', method: 'GET', path: '/support/errors' }, encrypted: false, fromDeviceName: 'q-b', supportGrant: ENVELOPE });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0].payload).toEqual({ id: 'r1', status: 200, body: { success: true, data: { source: 'service.log', lines: [] } } });
  });
});

describe('agentViewsAllowed', () => {
  it('is on by default, for a settings file that predates it, and off only when the owner says so', () => {
    const s = getDefaultSettings();
    expect(agentViewsAllowed(s)).toBe(true);
    expect(agentViewsAllowed({ ...s, support: undefined })).toBe(true);
    expect(agentViewsAllowed({ ...s, support: { allowGrantees: false } as CrewlySettings['support'] })).toBe(true);
    expect(agentViewsAllowed({ ...s, support: { allowGrantees: true, allowAgentViews: false } })).toBe(false);
  });
});

describe('cloudLoginForSupport', () => {
  afterEach(() => {
    mockCloud.token = 'secret-cloud-token';
    mockCloud.url = 'https://cloud.test';
  });

  it('reads this machine\'s Cloud login, and is null when it is not signed in', async () => {
    await expect(cloudLoginForSupport()).resolves.toEqual({ baseUrl: 'https://cloud.test', token: 'secret-cloud-token' });
    mockCloud.token = null;
    await expect(cloudLoginForSupport()).resolves.toBeNull();
    mockCloud.token = 'secret-cloud-token';
    mockCloud.url = null;
    await expect(cloudLoginForSupport()).resolves.toBeNull();
  });
});

describe('supportAgentDisplayName', () => {
  it('names the orchestrator and team members, and nobody else', async () => {
    await expect(supportAgentDisplayName('crewly-orc')).resolves.toBe('Orc');
    await expect(supportAgentDisplayName('crewly-nova')).resolves.toBe('Nova');
    await expect(supportAgentDisplayName('crewly-stranger')).resolves.toBeUndefined();
  });
});

describe('startSupportView', () => {
  const GRANTS = { success: true, data: { grants: [{ id: 'g1', status: 'active', grantorEmail: 'steve@example.com', role: 'viewer', includePrivate: false, agentAccess: true }] } };
  const MACHINES = { success: true, data: { instances: [{ instanceId: 'i1', deviceName: 'Studio Mac', relayQueueId: 'q-theirs', live: true }] } };

  function start(over: { settings?: () => Promise<CrewlySettings>; actingFor?: (session: string) => { id: string; role: string } } = {}) {
    const handlers: Array<(m: SupportClientIncomingMessage) => void> = [];
    const sent: Array<{ peer: string; data: { id: string; method: string; path: string }; agent: string }> = [];
    const cloudSync: ISupportClientCloudSync = {
      on: (_e, h) => void handlers.push(h),
      off: (_e, h) => void handlers.splice(handlers.indexOf(h), 1),
      getQueueId: () => 'q-mine',
      sendSupportAgentRequest: async (peer, data, agent) => {
        sent.push({ peer, data, agent });
        // The granted machine answers into this machine's queue.
        setTimeout(() => handlers.forEach((h) => h({ type: 'api_response', payload: { id: data.id, status: 200, body: { success: true, data: { agents: [{ name: 'Their Dev' }] } } } })), 0);
      },
    };
    const urls: string[] = [];
    const fetchImpl = jest.fn(async (url: string) => {
      urls.push(url);
      const body = url.endsWith('/instances') ? MACHINES : GRANTS;
      return { status: 200, ok: true, json: async () => body } as unknown as Response;
    });
    const noted: Array<[string, string, string]> = [];
    const written: Array<{ action: string; note?: string }> = [];
    const handle = startSupportView({
      cloudSync,
      settings: over.settings ?? (async () => getDefaultSettings()),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      actingFor: over.actingFor ?? (() => ({ id: 'owner', role: 'owner' })),
      notePrivate: (session, personId, connectorId) => void noted.push([session, personId, connectorId]),
      record: (entry) => void written.push(entry as { action: string; note?: string }),
    });
    return { handle, handlers, sent, urls, noted, written };
  }

  afterEach(() => setSupportViewService(null));

  it('reads a granted machine end to end for an agent, notes it private and logs it', async () => {
    const { handle, handlers, sent, urls, noted, written } = start();
    expect(handlers).toHaveLength(1);
    expect(getSupportViewService()).toBe(handle.view);
    const result = await handle.view.read('crewly-nova', {}, { area: 'agents' });
    expect(urls).toEqual(['https://cloud.test/api/cloud/support-grants/received', 'https://cloud.test/api/cloud/support-grants/g1/instances']);
    expect(sent).toEqual([{ peer: 'q-theirs', data: { id: expect.any(String), method: 'GET', path: '/support/agents' }, agent: 'Nova' }]);
    expect(result).toMatchObject({ grant: { id: 'g1', grantorEmail: 'steve@example.com' }, machine: { deviceName: 'Studio Mac' }, data: { agents: [{ name: 'Their Dev' }] } });
    expect(noted).toEqual([['crewly-nova', 'support:steve@example.com', 'support-access']]);
    expect(written).toEqual([expect.objectContaining({ action: 'support-view.read', note: expect.stringContaining('Agent Nova (crewly-nova) read the agents list on Studio Mac of steve@example.com') })]);
    expect(handle.client.pendingCount()).toBe(0);
    handle.client.stop();
    expect(handlers).toHaveLength(0);
  });

  it('honours the owner switch of this machine on every call', async () => {
    let settings: CrewlySettings = getDefaultSettings();
    const { handle, sent, urls } = start({ settings: async () => settings });
    await handle.view.read('crewly-nova', {}, { area: 'agents' });
    settings = { ...settings, support: { allowGrantees: true, allowAgentViews: false } };
    await expect(handle.view.read('crewly-nova', {}, { area: 'agents' })).rejects.toMatchObject({ code: 'turned_off_here', status: 403 });
    await expect(handle.view.grants('crewly-nova')).rejects.toBeInstanceOf(SupportViewError);
    expect(sent).toHaveLength(1);
    expect(urls).toHaveLength(2);
    handle.client.stop();
  });
});
